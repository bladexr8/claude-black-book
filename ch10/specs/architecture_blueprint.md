# NotifyHub: Architecture Blueprint

**Version:** 1.0  
**Date:** 2026-08-20  
**Status:** Draft for Review

---

## Table of Contents
1. [High-Level System Architecture](#1-high-level-system-architecture)
2. [Database Schemas](#2-database-schemas)
3. [API Specifications](#3-api-specifications)
4. [Directory Structure Map](#4-directory-structure-map)
5. [Clean Architecture Layers](#5-clean-architecture-layers)
6. [Data Flow & Separation of Concerns](#6-data-flow--separation-of-concerns)

---

## 1. High-Level System Architecture

### 1.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Internal Services (Clients)               │
│                   (Order, User, Marketing Services)              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
        ┌────────────────────────────────────────────────┐
        │         API Gateway + Request Validation        │
        │              (Auth, Rate Limit)                 │
        └────────────────┬─────────────────────────────────┘
                         │
        ┌────────────────┴─────────────────┐
        ▼                                   ▼
   ┌─────────────┐                  ┌──────────────────┐
   │   Sync API  │                  │  Event Publisher │
   │  Handlers   │                  │   (to SQS)       │
   └──────┬──────┘                  └──────┬───────────┘
          │                                 │
          ├─ Store Notification (DB)       ├─ Enqueue Message
          ├─ Generate notification_id      │
          └─ Return 202 Accepted          │
                                          ▼
                          ┌───────────────────────────┐
                          │   SQS Message Queues      │
                          ├───────────────────────────┤
                          │ • email-notifications     │
                          │ • sms-notifications       │
                          │ • push-notifications      │
                          │ • dlq-notifications       │
                          └───────┬───────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                          ▼                          ▼
   ┌─────────────┐          ┌──────────────┐         ┌──────────────┐
   │Email Handler│          │ SMS Handler  │         │Push Handler  │
   │ (Lambda)    │          │  (Lambda)    │         │  (Lambda)    │
   └──────┬──────┘          └──────┬───────┘         └──────┬───────┘
          │                        │                         │
          ├─ Fetch from provider   ├─ Fetch from provider   ├─ Fetch from provider
          ├─ Retry logic           ├─ Retry logic           ├─ Retry logic
          ├─ Rate limit check      ├─ Rate limit check      ├─ Rate limit check
          └─ Update DB status      └─ Update DB status      └─ Update DB status
                                          │
        ┌─────────────────────────────────┼─────────────────────────────┐
        ▼                                  ▼                              ▼
   ┌─────────────┐                 ┌──────────────┐             ┌──────────────┐
   │SendGrid/SES │                 │Twilio/AWS SNS│             │Firebase/AWS SNS
   │(Provider)   │                 │(Provider)    │             │(Provider)    │
   └─────────────┘                 └──────────────┘             └──────────────┘
        │
        └─ Provider Webhook Callbacks (optional async delivery status)
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                               ▼
                    ┌──────────────┐            ┌──────────────┐
                    │PostgreSQL RDS│            │  Redis Cache │
                    │(State Store) │            │ (Rate Limit) │
                    └──────────────┘            └──────────────┘
                          │
        ┌─────────────────┼──────────────────┬──────────────────┐
        │                 │                  │                  │
        ├─ Notifications  ├─ Audit Logs     ├─ DLQ Records     ├─ Batches
        └─────────────────┴──────────────────┴──────────────────┴──────────────
```

### 1.2 Core Infrastructure Components

| Component | Technology | Purpose | Ownership |
|-----------|-----------|---------|-----------|
| **API Gateway** | AWS API Gateway | HTTP(S) entry point, authentication, rate limiting | Backend |
| **Sync API Handler** | Lambda/ECS | Validate requests, persist to DB, enqueue to SQS | Backend |
| **Message Queue** | AWS SQS | Async notification dispatch, decouples API from handlers | Platform |
| **Email Handler** | Lambda | Consumes email notifications, calls SendGrid/SES | Channel Handlers |
| **SMS Handler** | Lambda | Consumes SMS notifications, calls Twilio/AWS SNS | Channel Handlers |
| **Push Handler** | Lambda | Consumes push notifications, calls Firebase/AWS SNS | Channel Handlers |
| **Primary Storage** | RDS PostgreSQL | Persistent state: notifications, audit logs, batches | Data |
| **Cache Layer** | Redis/ElastiCache | Rate limit counters, session tokens | Data |
| **Secrets** | AWS Secrets Manager | Provider API keys, encryption keys | Security |
| **Observability** | CloudWatch + X-Ray | Logs, metrics, distributed tracing | Operations |

### 1.3 Data Flow Architecture

```
REQUEST FLOW:
1. Client → API Gateway (HTTPS, auth, validate)
2. API Handler (Lambda) → PostgreSQL (INSERT notification)
3. API Handler → SQS (ENQUEUE message)
4. Return 202 Accepted {notification_id, status: pending}

PROCESSING FLOW:
1. Channel Handler (Lambda) ← SQS (DEQUEUE message)
2. Channel Handler → Redis (CHECK rate limits)
3. Channel Handler → External Provider (SEND notification)
4. On success → PostgreSQL (UPDATE status → 'sent')
5. On retryable error → SQS (RE-ENQUEUE with backoff)
6. On non-retryable error → PostgreSQL (UPDATE status → 'failed') → DLQ

QUERY FLOW:
1. Client → API Gateway → Query Handler (Lambda)
2. Query Handler → PostgreSQL (SELECT notification)
3. Return 200 OK {notification record}
```

---

## 2. Database Schemas

### 2.1 PostgreSQL Tables

#### Table: `notifications`
Core notification records with state tracking.

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID,
  recipient VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  subject VARCHAR(500),
  body TEXT NOT NULL,
  template_vars JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
  delivery_attempts INT DEFAULT 0,
  max_delivery_attempts INT DEFAULT 3,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  provider_message_id VARCHAR(255),
  provider_response JSONB,
  idempotency_key VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(idempotency_key),
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  INDEX idx_status (status),
  INDEX idx_recipient_channel (recipient, channel),
  INDEX idx_created_at (created_at),
  INDEX idx_batch_id (batch_id)
);
```

#### Table: `batches`
Track batch submission metadata.

```sql
CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_batch_id VARCHAR(255),
  total_count INT NOT NULL,
  sent_count INT DEFAULT 0,
  delivered_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  pending_count INT DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'partial_failure')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(client_batch_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);
```

#### Table: `audit_logs`
Comprehensive audit trail for compliance and debugging.

```sql
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  notification_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL
    CHECK (event_type IN ('submitted', 'sent', 'delivery_attempt', 'retry', 'failed', 'dlq', 'queried')),
  status_before VARCHAR(50),
  status_after VARCHAR(50),
  provider_name VARCHAR(100),
  provider_error TEXT,
  provider_response JSONB,
  http_status_code INT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB,
  
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  INDEX idx_notification_id (notification_id),
  INDEX idx_event_type (event_type),
  INDEX idx_timestamp (timestamp),
  PARTITION BY RANGE (timestamp) (
    PARTITION p_2026_08 VALUES FROM ('2026-08-01') TO ('2026-09-01'),
    PARTITION p_2026_09 VALUES FROM ('2026-09-01') TO ('2026-10-01'),
    PARTITION p_default VALUES FROM ('2026-10-01') TO (MAXVALUE)
  )
);
```

#### Table: `dlq_notifications`
Dead letter queue for permanently failed notifications.

```sql
CREATE TABLE dlq_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL UNIQUE,
  reason VARCHAR(255) NOT NULL,
  error_details TEXT,
  delivery_attempts INT NOT NULL,
  final_attempt_at TIMESTAMP WITH TIME ZONE,
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  resolution VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  INDEX idx_reviewed (reviewed),
  INDEX idx_created_at (created_at)
);
```

#### Table: `rate_limits`
Track per-recipient and per-channel rate limits.

```sql
CREATE TABLE rate_limits (
  id BIGSERIAL PRIMARY KEY,
  recipient VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  count INT DEFAULT 0,
  max_limit INT DEFAULT 10,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(recipient, channel, window_start),
  INDEX idx_recipient_channel (recipient, channel),
  INDEX idx_window_start (window_start)
);
```

#### Table: `api_keys`
Credentials for API authentication.

```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  rate_limit INT DEFAULT 1000,
  created_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE,
  last_used_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(client_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);
```

### 2.2 Redis Data Structures

#### Key: `rate_limit:{channel}:{recipient}:{window_hour}`
Atomic counter for per-recipient per-channel rate limiting.

```
Type: STRING (integer)
TTL: 3600 seconds (1 hour window)
Usage: Increment counter on notification submission, check against max_limit
Example: rate_limit:email:user@example.com:2026-08-20-14
```

#### Key: `session:{api_key_hash}`
Cache API key authentication.

```
Type: HASH
TTL: 300 seconds (5 minutes)
Fields: 
  - client_id: "service-a"
  - rate_limit: 1000
  - status: "active"
Usage: Fast lookups to avoid database queries on every API request
Example: session:sha256(api_key)
```

#### Key: `notifications:batch:{batch_id}:stats`
Real-time batch processing statistics.

```
Type: HASH
TTL: 86400 seconds (24 hours after batch completion)
Fields:
  - total: 500
  - sent: 450
  - failed: 50
  - pending: 0
Usage: Avoid heavy aggregation queries during batch processing
```

#### Key: `inflight:{notification_id}`
Track in-flight notifications being processed.

```
Type: STRING
TTL: 600 seconds (10 minutes, longer than max retry interval)
Value: "{handler_lambda_id}"
Usage: Prevent duplicate processing if Lambda executes twice
```

---

## 3. API Specifications

### 3.1 Request/Response JSON Schemas

#### POST /notifications - Submit Single Notification

**Request Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["recipient", "channel", "body"],
  "properties": {
    "recipient": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$|^\\+?[1-9]\\d{1,14}$",
      "description": "Email address or phone number (E.164 format for SMS)"
    },
    "channel": {
      "type": "string",
      "enum": ["email", "sms", "push"],
      "description": "Notification channel"
    },
    "subject": {
      "type": "string",
      "maxLength": 500,
      "description": "Email subject (required for email channel)"
    },
    "body": {
      "type": "string",
      "maxLength": 5000,
      "description": "Message body with optional {{variable}} placeholders"
    },
    "template_vars": {
      "type": "object",
      "additionalProperties": {
        "type": ["string", "number", "boolean"]
      },
      "description": "Variables for template substitution"
    },
    "idempotency_key": {
      "type": "string",
      "maxLength": 255,
      "description": "Optional key for deduplication"
    },
    "metadata": {
      "type": "object",
      "additionalProperties": true,
      "description": "Custom metadata (audit purposes only)"
    }
  },
  "additionalProperties": false
}
```

**Response Schema (202 Accepted):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["notification_id", "status", "created_at"],
  "properties": {
    "notification_id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique identifier for tracking"
    },
    "status": {
      "type": "string",
      "enum": ["pending"],
      "description": "Initial status is always pending"
    },
    "created_at": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp"
    }
  }
}
```

#### POST /notifications/batch - Submit Batch Notifications

**Request Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["notifications"],
  "properties": {
    "client_batch_id": {
      "type": "string",
      "maxLength": 255,
      "description": "Optional client-provided batch identifier"
    },
    "notifications": {
      "type": "array",
      "minItems": 1,
      "maxItems": 5000,
      "items": {
        "type": "object",
        "required": ["recipient", "channel", "body"],
        "properties": {
          "recipient": { "type": "string" },
          "channel": { "type": "string", "enum": ["email", "sms", "push"] },
          "subject": { "type": "string" },
          "body": { "type": "string" },
          "template_vars": { "type": "object" },
          "idempotency_key": { "type": "string" }
        }
      }
    }
  },
  "additionalProperties": false
}
```

**Response Schema (202 Accepted):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["batch_id", "submitted", "notification_ids"],
  "properties": {
    "batch_id": {
      "type": "string",
      "format": "uuid",
      "description": "Batch identifier"
    },
    "submitted": {
      "type": "integer",
      "minimum": 0,
      "description": "Number of notifications accepted"
    },
    "notification_ids": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "description": "IDs of accepted notifications"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    }
  }
}
```

#### GET /notifications/{notification_id} - Query Single Notification Status

**Response Schema (200 OK):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["notification_id", "status", "created_at"],
  "properties": {
    "notification_id": { "type": "string", "format": "uuid" },
    "recipient": { "type": "string" },
    "channel": { "type": "string", "enum": ["email", "sms", "push"] },
    "status": {
      "type": "string",
      "enum": ["pending", "sent", "delivered", "failed", "bounced"]
    },
    "delivery_attempts": { "type": "integer" },
    "max_delivery_attempts": { "type": "integer" },
    "last_attempt_at": { "type": ["string", "null"], "format": "date-time" },
    "last_error": { "type": ["string", "null"] },
    "provider_message_id": { "type": ["string", "null"] },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```

#### GET /notifications/batch/{batch_id} - Query Batch Status

**Response Schema (200 OK):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["batch_id", "total_count"],
  "properties": {
    "batch_id": { "type": "string", "format": "uuid" },
    "total_count": { "type": "integer" },
    "sent_count": { "type": "integer" },
    "delivered_count": { "type": "integer" },
    "failed_count": { "type": "integer" },
    "pending_count": { "type": "integer" },
    "status": {
      "type": "string",
      "enum": ["pending", "processing", "completed", "partial_failure"]
    },
    "created_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": ["string", "null"], "format": "date-time" },
    "notifications": {
      "type": "array",
      "maxItems": 100,
      "items": { "$ref": "#/definitions/NotificationRecord" }
    }
  },
  "definitions": {
    "NotificationRecord": {
      "type": "object",
      "properties": {
        "notification_id": { "type": "string" },
        "status": { "type": "string" }
      }
    }
  }
}
```

#### GET /dlq - Inspect Dead Letter Queue

**Response Schema (200 OK):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "dlq_size": { "type": "integer" },
    "page": { "type": "integer" },
    "page_size": { "type": "integer" },
    "total_pages": { "type": "integer" },
    "notifications": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "notification_id": { "type": "string", "format": "uuid" },
          "recipient": { "type": "string" },
          "channel": { "type": "string" },
          "reason": { "type": "string" },
          "error_details": { "type": "string" },
          "delivery_attempts": { "type": "integer" },
          "final_attempt_at": { "type": "string", "format": "date-time" },
          "reviewed": { "type": "boolean" }
        }
      }
    }
  }
}
```

### 3.2 Error Response Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["error_code", "message"],
  "properties": {
    "error_code": {
      "type": "string",
      "enum": [
        "invalid_request",
        "invalid_channel",
        "rate_limit_exceeded",
        "authentication_failed",
        "authorization_failed",
        "resource_not_found",
        "idempotency_conflict",
        "internal_error",
        "service_unavailable"
      ]
    },
    "message": { "type": "string" },
    "details": {
      "type": "object",
      "additionalProperties": true,
      "description": "Additional error context"
    },
    "request_id": {
      "type": "string",
      "description": "Unique ID for debugging (X-Request-ID)"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    }
  }
}
```

---

## 4. Directory Structure Map

```
notifyhub/
├── README.md                           # Project overview
├── Makefile                            # Build and deploy targets
├── docker-compose.yml                  # Local development environment
├── .env.example                        # Environment template
│
├── src/
│   ├── common/
│   │   ├── config/
│   │   │   ├── __init__.py
│   │   │   ├── app_config.py          # Centralized configuration
│   │   │   └── logger.py              # Structured logging setup
│   │   │
│   │   ├── domain/
│   │   │   ├── __init__.py
│   │   │   ├── models.py              # Core domain entities (Notification, Batch, etc.)
│   │   │   ├── enums.py               # Enumerations (ChannelType, Status, etc.)
│   │   │   └── exceptions.py          # Custom exception hierarchy
│   │   │
│   │   ├── ports/
│   │   │   ├── __init__.py
│   │   │   ├── repository.py          # Abstract data access ports
│   │   │   ├── queue.py               # Abstract message queue port
│   │   │   ├── cache.py               # Abstract cache port
│   │   │   ├── provider.py            # Abstract provider port
│   │   │   └── logger.py              # Abstract logger port
│   │   │
│   │   └── utils/
│   │       ├── __init__.py
│   │       ├── validators.py          # Input validation logic
│   │       ├── template_engine.py     # Simple variable substitution
│   │       ├── idempotency.py         # Idempotency key handling
│   │       └── error_mapper.py        # Provider error → domain error mapping
│   │
│   ├── api/
│   │   ├── __init__.py
│   │   ├── app.py                     # Flask/FastAPI app initialization
│   │   ├── middleware/
│   │   │   ├── __init__.py
│   │   │   ├── auth.py                # API key authentication
│   │   │   ├── rate_limit.py          # API-level rate limiting
│   │   │   ├── error_handler.py       # Global exception handling
│   │   │   └── request_logger.py      # Request/response logging
│   │   │
│   │   ├── routes/
│   │   │   ├── __init__.py
│   │   │   ├── notifications.py       # POST /notifications, GET /notifications/{id}
│   │   │   ├── batches.py             # POST /notifications/batch, GET /batch/{id}
│   │   │   ├── dlq.py                 # GET /dlq
│   │   │   └── health.py              # GET /health, GET /ready
│   │   │
│   │   └── schemas/
│   │       ├── __init__.py
│   │       ├── requests.py            # Pydantic/Marshmallow request schemas
│   │       └── responses.py           # Pydantic/Marshmallow response schemas
│   │
│   ├── application/
│   │   ├── __init__.py
│   │   ├── usecases/
│   │   │   ├── __init__.py
│   │   │   ├── submit_notification.py # Submit single notification
│   │   │   ├── submit_batch.py        # Submit batch of notifications
│   │   │   ├── query_notification.py  # Query notification status
│   │   │   ├── query_batch.py         # Query batch status
│   │   │   ├── inspect_dlq.py         # Retrieve DLQ notifications
│   │   │   └── process_notification.py # Channel handler orchestration
│   │   │
│   │   ├── dto/
│   │   │   ├── __init__.py
│   │   │   ├── input.py               # Input DTOs (from API)
│   │   │   ├── output.py              # Output DTOs (to API)
│   │   │   └── internal.py            # Internal DTOs (between layers)
│   │   │
│   │   └── services/
│   │       ├── __init__.py
│   │       ├── rate_limiter.py        # Rate limiting logic
│   │       ├── notification_svc.py    # Notification orchestration
│   │       └── audit_svc.py           # Audit logging service
│   │
│   ├── adapters/
│   │   ├── __init__.py
│   │   │
│   │   ├── repositories/
│   │   │   ├── __init__.py
│   │   │   ├── postgres/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── notification_repository.py
│   │   │   │   ├── batch_repository.py
│   │   │   │   ├── audit_repository.py
│   │   │   │   ├── dlq_repository.py
│   │   │   │   └── migrations.py      # Alembic migrations
│   │   │   │
│   │   │   └── __init__.py
│   │   │
│   │   ├── queue/
│   │   │   ├── __init__.py
│   │   │   ├── sqs_adapter.py         # SQS implementation
│   │   │   ├── message_serializer.py  # Message encoding/decoding
│   │   │   └── queue_config.py        # Queue initialization
│   │   │
│   │   ├── cache/
│   │   │   ├── __init__.py
│   │   │   ├── redis_adapter.py       # Redis implementation
│   │   │   └── cache_config.py        # Connection pooling
│   │   │
│   │   ├── providers/
│   │   │   ├── __init__.py
│   │   │   ├── base_provider.py       # Abstract provider class
│   │   │   ├── sendgrid_adapter.py    # SendGrid email implementation
│   │   │   ├── ses_adapter.py         # AWS SES email implementation
│   │   │   ├── twilio_adapter.py      # Twilio SMS implementation
│   │   │   ├── sns_adapter.py         # AWS SNS SMS/push implementation
│   │   │   ├── firebase_adapter.py    # Firebase push implementation
│   │   │   └── provider_config.py     # Provider initialization
│   │   │
│   │   ├── logger/
│   │   │   ├── __init__.py
│   │   │   ├── cloudwatch_logger.py   # CloudWatch logging
│   │   │   └── json_formatter.py      # JSON structured logs
│   │   │
│   │   └── secrets/
│   │       ├── __init__.py
│   │       └── aws_secrets.py         # AWS Secrets Manager integration
│   │
│   ├── handlers/
│   │   ├── __init__.py
│   │   ├── email_handler.py           # Email channel Lambda handler
│   │   ├── sms_handler.py             # SMS channel Lambda handler
│   │   ├── push_handler.py            # Push channel Lambda handler
│   │   └── handler_utils.py           # Shared handler utilities
│   │
│   └── __init__.py
│
├── tests/
│   ├── __init__.py
│   ├── conftest.py                    # Pytest fixtures and setup
│   │
│   ├── unit/
│   │   ├── __init__.py
│   │   ├── test_domain_models.py
│   │   ├── test_validators.py
│   │   ├── test_template_engine.py
│   │   ├── test_rate_limiter.py
│   │   ├── test_idempotency.py
│   │   ├── test_error_mapper.py
│   │   │
│   │   ├── application/
│   │   │   ├── __init__.py
│   │   │   ├── test_submit_notification.py
│   │   │   ├── test_submit_batch.py
│   │   │   ├── test_query_notification.py
│   │   │   └── test_process_notification.py
│   │   │
│   │   ├── api/
│   │   │   ├── __init__.py
│   │   │   ├── test_notification_routes.py
│   │   │   ├── test_batch_routes.py
│   │   │   ├── test_auth_middleware.py
│   │   │   └── test_error_handling.py
│   │   │
│   │   └── adapters/
│   │       ├── __init__.py
│   │       ├── test_postgres_repository.py
│   │       ├── test_sqs_adapter.py
│   │       ├── test_redis_cache.py
│   │       └── test_provider_adapters.py
│   │
│   ├── integration/
│   │   ├── __init__.py
│   │   ├── test_notification_flow.py  # End-to-end flows
│   │   ├── test_retry_logic.py        # Retry and backoff
│   │   ├── test_rate_limiting.py      # Rate limit enforcement
│   │   ├── test_dlq_flow.py           # Dead letter queue
│   │   └── test_batch_submission.py
│   │
│   └── fixtures/
│       ├── __init__.py
│       ├── factories.py               # Test data factories
│       ├── mock_providers.py          # Mock external providers
│       └── test_data.py               # Hardcoded test datasets
│
├── infra/
│   ├── terraform/
│   │   ├── main.tf                    # Main Terraform configuration
│   │   ├── variables.tf               # Input variables
│   │   ├── outputs.tf                 # Output values
│   │   │
│   │   ├── modules/
│   │   │   ├── api_gateway/
│   │   │   │   ├── main.tf
│   │   │   │   ├── variables.tf
│   │   │   │   └── outputs.tf
│   │   │   ├── lambda/
│   │   │   │   ├── main.tf
│   │   │   │   └── variables.tf
│   │   │   ├── sqs/
│   │   │   │   ├── main.tf
│   │   │   │   └── variables.tf
│   │   │   ├── rds/
│   │   │   │   ├── main.tf
│   │   │   │   └── variables.tf
│   │   │   ├── redis/
│   │   │   │   ├── main.tf
│   │   │   │   └── variables.tf
│   │   │   ├── iam/
│   │   │   │   ├── main.tf
│   │   │   │   └── variables.tf
│   │   │   └── monitoring/
│   │   │       ├── main.tf
│   │   │       └── variables.tf
│   │   │
│   │   └── environments/
│   │       ├── dev.tfvars
│   │       ├── staging.tfvars
│   │       └── prod.tfvars
│   │
│   ├── docker/
│   │   ├── Dockerfile.api             # API handler container
│   │   ├── Dockerfile.handlers        # Channel handlers container
│   │   └── Dockerfile.migrations      # Database migrations container
│   │
│   └── k8s/ (optional for future)
│       ├── namespace.yaml
│       ├── configmap.yaml
│       ├── secrets.yaml
│       ├── deployment.yaml
│       └── service.yaml
│
├── docs/
│   ├── ARCHITECTURE.md                # Architecture overview
│   ├── API.md                         # API documentation
│   ├── DEPLOYMENT.md                  # Deployment guide
│   ├── TROUBLESHOOTING.md             # Troubleshooting guide
│   ├── RUNBOOK.md                     # Operational runbook
│   └── CONTRIBUTING.md                # Contribution guidelines
│
├── scripts/
│   ├── local_setup.sh                 # Local development setup
│   ├── db_migrate.sh                  # Database migration script
│   ├── load_test.sh                   # Load testing script
│   ├── health_check.sh                # Health check script
│   └── seed_data.sh                   # Seed test data
│
├── requirements.txt                    # Python dependencies
├── Dockerfile                         # Main application Dockerfile
├── .dockerignore
├── .gitignore
├── .github/
│   └── workflows/
│       ├── test.yml                   # Unit/integration test CI
│       ├── deploy.yml                 # Deployment CI/CD
│       └── security.yml               # Security scanning
│
└── pyproject.toml                     # Python project metadata
```

---

## 5. Clean Architecture Layers

### 5.1 Layer Descriptions

**Layer 0: Domain (Innermost)**
- Pure business logic, no external dependencies
- Contains domain models, value objects, enums, exceptions
- Tests run instantly, no DB or network access
- Files: `common/domain/` and `common/exceptions.py`

**Layer 1: Application (Orchestration)**
- Use cases that coordinate domain logic with external systems
- Input/output DTOs define adapter contracts
- No knowledge of HTTP, database specifics, or provider implementations
- Files: `application/usecases/`, `application/services/`, `application/dto/`

**Layer 2: Ports & Adapters (Interfaces)**
- Abstract interfaces that decouple application from technology
- Repository ports (how to store data)
- Queue ports (how to send async messages)
- Cache ports (how to cache)
- Provider ports (how to integrate with external services)
- Files: `common/ports/`

**Layer 3: Adapters (Outermost)**
- Concrete implementations of ports
- PostgreSQL repositories, SQS queue, Redis cache, SendGrid/Twilio/Firebase providers
- Lambda handlers that invoke use cases
- API routes that expose use cases via HTTP
- Files: `adapters/`, `api/`, `handlers/`

### 5.2 Dependency Flow

```
┌─────────────────────────────────────────────────────────┐
│ External: API Clients, AWS Services, External Providers │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌──────────────────────────┐ ┌─────────────────────┐
│   API Routes (HTTP)      │ │  Lambda Handlers    │
│   - /notifications       │ │  - email_handler.py │
│   - /notifications/batch │ │  - sms_handler.py   │
│   - /dlq                 │ │  - push_handler.py  │
└──────────┬───────────────┘ └──────────┬──────────┘
           │                            │
           └────────────────┬───────────┘
                            ▼
              ┌─────────────────────────────┐
              │  Application Layer (Use Cases)
              │  ├─ submit_notification.py  │
              │  ├─ query_notification.py   │
              │  ├─ process_notification.py │
              │  ├─ rate_limiter.py         │
              │  └─ audit_svc.py            │
              └──────────────┬──────────────┘
                             │
         ┌───────────────────┴───────────────────┐
         ▼                                       ▼
    ┌──────────────────┐          ┌──────────────────────┐
    │  Domain Layer    │          │   Ports/Interfaces   │
    │  ├─ models.py    │          │  ├─ repository.py    │
    │  ├─ enums.py     │          │  ├─ queue.py         │
    │  └─ exceptions.py│          │  ├─ cache.py         │
    │                  │          │  ├─ provider.py      │
    │  (Pure business  │          │  └─ logger.py        │
    │   logic, zero    │          │  (Interfaces only,   │
    │   external deps) │          │   no implementation) │
    └──────────────────┘          └──────────────────────┘
                                           │
         ┌─────────────────────────────────┴──────────────┐
         ▼                                                 ▼
    ┌──────────────────────┐              ┌────────────────────────────┐
    │ Data Adapters        │              │ External Integrations      │
    │ ├─ postgres_repo.py  │              │ ├─ sendgrid_adapter.py     │
    │ ├─ sqs_adapter.py    │              │ ├─ twilio_adapter.py       │
    │ └─ redis_cache.py    │              │ ├─ firebase_adapter.py     │
    │                      │              │ ├─ cloudwatch_logger.py    │
    │                      │              │ └─ aws_secrets.py          │
    └──────────────────────┘              └────────────────────────────┘
```

### 5.3 Concrete Implementation Example: Submit Notification

```
1. HTTP Request arrives at API Gateway
   ▼
2. api/routes/notifications.py::post_notification()
   - Deserialize JSON → request schema
   - Call use case
   ▼
3. application/usecases/submit_notification.py::submit()
   - Create domain model: Notification()
   - Call rate limiter (application service)
   - Call repository (via port)
   - Call queue (via port)
   - Call audit logger (via port)
   ▼
4. adapters/repositories/postgres/notification_repository.py::save()
   - Execute SQL INSERT
   - Return notification_id
   ▼
5. adapters/queue/sqs_adapter.py::enqueue()
   - Serialize to JSON
   - Send to SQS queue
   ▼
6. Return 202 Accepted with notification_id
```

---

## 6. Data Flow & Separation of Concerns

### 6.1 Request Path (Synchronous)

```
CLIENT REQUEST → API Gateway (auth, validate) → API Handler Lambda

API Handler Lambda:
  1. Extract request body
  2. Validate JSON schema (api/schemas/requests.py)
  3. Convert to Input DTO (application/dto/input.py)
  4. Call use case: submit_notification(input_dto)
  
Use Case (submit_notification):
  1. Create domain model: Notification(recipient, channel, body, vars)
  2. Validate domain invariants (no business logic at API level)
  3. Check rate limits (via rate_limiter service)
  4. Call repository.save(notification) → Returns notification_id
  5. Call queue.enqueue(notification) → Schedules async processing
  6. Create Output DTO: SubmitResponse(notification_id, status)
  7. Return to API handler
  
API Handler:
  1. Convert Output DTO to response schema (api/schemas/responses.py)
  2. Return 202 Accepted {notification_id, status, created_at}
  3. No business logic here—pure HTTP serialization

Response → API Gateway → CLIENT (202 Accepted)
```

### 6.2 Processing Path (Asynchronous)

```
SQS Message → Lambda Event → Handler Lambda (channel specific)

Channel Handler Lambda (e.g., email_handler.py):
  1. Deserialize message from queue
  2. Extract notification_id, recipient, body, template_vars
  3. Call use case: process_notification(notification_id)
  
Use Case (process_notification):
  1. Fetch notification from repository (status = pending)
  2. Render template: substitute {{variables}} in body
  3. Check rate limits: recipient + channel
  4. If rate limit exceeded → Re-enqueue with backoff, return
  5. Fetch provider credentials from secrets manager
  6. Call provider: provider.send(recipient, subject, body)
  
Provider Adapter (e.g., sendgrid_adapter.py):
  1. Convert domain notification to provider-specific request
  2. Call SendGrid API
  3. Map provider response to domain result: ProviderResult(success, provider_id, error)
  4. Return result to use case
  
Use Case resumes:
  5. On success:
     - Update notification status → 'sent'
     - Record provider_message_id
     - Log to audit log (audit_svc)
  6. On retryable error (5xx, timeout):
     - Increment delivery_attempts
     - Calculate backoff (1s, 4s, 16s)
     - Re-enqueue message with visibility timeout
  7. On non-retryable error (4xx):
     - Update notification status → 'failed'
     - Move to DLQ (dlq_repository.save)
     - Log error details to audit log
  8. Update notification in repository
  
Handler:
  1. Return success to SQS (message deleted from queue)
  2. On handler exception → message visibility timeout → auto-retry by SQS
```

### 6.3 Layer Boundaries

| Boundary | Rule | Rationale |
|----------|------|-----------|
| **Domain ↔ Application** | Domain has no imports from application or adapters | Domain is testable in isolation, reusable |
| **Application ↔ Ports** | Application imports abstract ports (interfaces), never concrete adapters | Swap implementations without touching use cases |
| **Ports ↔ Adapters** | Adapters inherit/implement ports, provide concrete implementations | Multiple providers per channel, zero impact on business logic |
| **API ↔ Application** | API routes import use cases, never application business logic | API is thin, use cases are framework-agnostic |
| **Application ↔ API Schemas** | Routes validate against schemas before calling use cases | Input validation at boundaries |

---

## 7. Design Patterns & Principles

### 7.1 Patterns Used

| Pattern | Where | Why |
|---------|-------|-----|
| **Repository** | `adapters/repositories/` | Abstract data access, testable |
| **Adapter** | `adapters/providers/`, `adapters/queue/`, `adapters/cache/` | Plug-and-play external services |
| **Factory** | `tests/fixtures/factories.py` | Reusable test data creation |
| **Strategy** | `adapters/providers/base_provider.py` | Multiple provider implementations per channel |
| **Decorator** | `api/middleware/` | Cross-cutting concerns (auth, logging, rate limiting) |
| **Observer** | Audit logging | Track state changes without coupling |

### 7.2 SOLID Principles

- **S**ingle Responsibility: Each class has one reason to change (repo handles DB, provider handles API)
- **O**pen/Closed: Add new providers without modifying existing code (inherit base_provider)
- **L**iskov Substitution: All email providers interchangeable (SendGrid, SES have same interface)
- **I**nterface Segregation: Ports split by concern (RepositoryPort, QueuePort, ProviderPort)
- **D**ependency Inversion: Application depends on ports (abstractions), not adapters (implementations)

---

**Next Steps:**
1. Review layer structure for alignment with team standards
2. Finalize technology choices (Flask vs FastAPI, PostgreSQL version, etc.)
3. Create detailed API contracts (OpenAPI/Swagger specification)
4. Begin implementation with MVP scope (email channel only)

