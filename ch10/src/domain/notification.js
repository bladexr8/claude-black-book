/**
 * Notification domain model and enums
 * Pure business logic with zero external dependencies
 */

// Enumerations
const ChannelType = Object.freeze({
  EMAIL: 'email',
  SMS: 'sms',
  PUSH: 'push',
});

const NotificationStatus = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  BOUNCED: 'bounced',
});

// Custom domain exceptions
class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

class InvalidNotificationError extends DomainError {
  constructor(message) {
    super(message);
    this.name = 'InvalidNotificationError';
  }
}

class InvalidChannelError extends DomainError {
  constructor(channel) {
    super(`Invalid channel: ${channel}. Must be one of: ${Object.values(ChannelType).join(', ')}`);
    this.name = 'InvalidChannelError';
  }
}

class InvalidRecipientError extends DomainError {
  constructor(recipient, channel) {
    super(`Invalid recipient '${recipient}' for channel '${channel}'`);
    this.name = 'InvalidRecipientError';
  }
}

class InvalidStateTransitionError extends DomainError {
  constructor(currentStatus, targetStatus) {
    super(`Cannot transition from '${currentStatus}' to '${targetStatus}'`);
    this.name = 'InvalidStateTransitionError';
  }
}

// Validators
class NotificationValidator {
  static isValidEmail(email) {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  }

  static isValidPhoneNumber(phone) {
    // E.164 format: +1 to +999 country code, 10-14 digits
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    return phoneRegex.test(phone.replace(/[\s-]/g, ''));
  }

  static isValidRecipient(recipient, channel) {
    switch (channel) {
      case ChannelType.EMAIL:
        return NotificationValidator.isValidEmail(recipient);
      case ChannelType.SMS:
        return NotificationValidator.isValidPhoneNumber(recipient);
      case ChannelType.PUSH:
        // Push notifications require a device token (non-empty string)
        return typeof recipient === 'string' && recipient.trim().length > 0;
      default:
        return false;
    }
  }

  static isValidChannel(channel) {
    return Object.values(ChannelType).includes(channel);
  }
}

// State transition rules
const VALID_TRANSITIONS = Object.freeze({
  [NotificationStatus.PENDING]: [
    NotificationStatus.SENT,
    NotificationStatus.FAILED,
    NotificationStatus.BOUNCED,
  ],
  [NotificationStatus.SENT]: [NotificationStatus.DELIVERED, NotificationStatus.BOUNCED],
  [NotificationStatus.DELIVERED]: [],
  [NotificationStatus.FAILED]: [],
  [NotificationStatus.BOUNCED]: [],
});

/**
 * Notification Domain Entity
 *
 * Represents a notification to be delivered to a recipient via a specific channel.
 * Encapsulates validation, state transitions, and retry logic.
 *
 * Core invariants:
 * - recipient must be valid for the channel
 * - status must follow valid state transitions
 * - delivery_attempts must not exceed max_delivery_attempts
 * - template_vars must be a plain object (shallow)
 */
class Notification {
  constructor(props) {
    this.validateProps(props);

    this.id = props.id || this.generateId();
    this.batchId = props.batch_id || null;
    this.recipient = props.recipient;
    this.channel = props.channel;
    this.subject = props.subject || null;
    this.body = props.body;
    this.templateVars = props.template_vars || {};
    this.status = props.status || NotificationStatus.PENDING;
    this.deliveryAttempts = props.delivery_attempts || 0;
    this.maxDeliveryAttempts = props.max_delivery_attempts || 3;
    this.lastAttemptAt = props.last_attempt_at || null;
    this.lastError = props.last_error || null;
    this.providerMessageId = props.provider_message_id || null;
    this.providerResponse = props.provider_response || null;
    this.idempotencyKey = props.idempotency_key || null;
    this.createdAt = props.created_at || new Date().toISOString();
    this.updatedAt = props.updated_at || new Date().toISOString();
    this.deletedAt = props.deleted_at || null;
  }

  validateProps(props) {
    if (!props || typeof props !== 'object') {
      throw new InvalidNotificationError('Props must be a non-null object');
    }

    if (!props.recipient || typeof props.recipient !== 'string') {
      throw new InvalidNotificationError('Recipient is required and must be a string');
    }

    if (!props.channel || typeof props.channel !== 'string') {
      throw new InvalidNotificationError('Channel is required and must be a string');
    }

    if (!NotificationValidator.isValidChannel(props.channel)) {
      throw new InvalidChannelError(props.channel);
    }

    if (!NotificationValidator.isValidRecipient(props.recipient, props.channel)) {
      throw new InvalidRecipientError(props.recipient, props.channel);
    }

    if (!props.body || typeof props.body !== 'string') {
      throw new InvalidNotificationError('Body is required and must be a string');
    }

    if (props.body.length === 0 || props.body.length > 5000) {
      throw new InvalidNotificationError('Body must be between 1 and 5000 characters');
    }

    if (props.channel === ChannelType.EMAIL) {
      if (!props.subject || typeof props.subject !== 'string') {
        throw new InvalidNotificationError('Subject is required for email channel');
      }
      if (props.subject.length === 0 || props.subject.length > 500) {
        throw new InvalidNotificationError('Subject must be between 1 and 500 characters');
      }
    }

    if (props.template_vars && typeof props.template_vars !== 'object') {
      throw new InvalidNotificationError('Template vars must be a plain object');
    }

    if (props.idempotency_key && typeof props.idempotency_key !== 'string') {
      throw new InvalidNotificationError('Idempotency key must be a string');
    }

    if (props.delivery_attempts !== undefined && props.delivery_attempts < 0) {
      throw new InvalidNotificationError('Delivery attempts cannot be negative');
    }

    if (props.max_delivery_attempts !== undefined && props.max_delivery_attempts < 1) {
      throw new InvalidNotificationError('Max delivery attempts must be at least 1');
    }
  }

  generateId() {
    // Simple UUID v4 implementation (alternative: use uuid package)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // State transition methods
  markSent(providerMessageId, providerResponse = null) {
    this.canTransitionTo(NotificationStatus.SENT);
    this.status = NotificationStatus.SENT;
    this.providerMessageId = providerMessageId;
    this.providerResponse = providerResponse;
    this.lastAttemptAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    return this;
  }

  markDelivered() {
    this.canTransitionTo(NotificationStatus.DELIVERED);
    this.status = NotificationStatus.DELIVERED;
    this.updatedAt = new Date().toISOString();
    return this;
  }

  markFailed(error, providerResponse = null) {
    if (typeof error !== 'string') {
      throw new InvalidNotificationError('Error must be a string');
    }
    this.canTransitionTo(NotificationStatus.FAILED);
    this.status = NotificationStatus.FAILED;
    this.lastError = error;
    this.providerResponse = providerResponse;
    this.lastAttemptAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    return this;
  }

  markBounced(error = null) {
    this.canTransitionTo(NotificationStatus.BOUNCED);
    this.status = NotificationStatus.BOUNCED;
    if (error) {
      this.lastError = error;
    }
    this.lastAttemptAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    return this;
  }

  recordAttempt(error = null, providerResponse = null) {
    if (this.deliveryAttempts >= this.maxDeliveryAttempts) {
      throw new DomainError(
        `Cannot record attempt: max retries (${this.maxDeliveryAttempts}) exceeded`
      );
    }
    this.deliveryAttempts += 1;
    this.lastAttemptAt = new Date().toISOString();
    if (error) {
      this.lastError = error;
    }
    if (providerResponse) {
      this.providerResponse = providerResponse;
    }
    this.updatedAt = new Date().toISOString();
    return this;
  }

  canTransitionTo(targetStatus) {
    const validTargets = VALID_TRANSITIONS[this.status];
    if (!validTargets || !validTargets.includes(targetStatus)) {
      throw new InvalidStateTransitionError(this.status, targetStatus);
    }
  }

  // Query methods
  isPending() {
    return this.status === NotificationStatus.PENDING;
  }

  isSent() {
    return this.status === NotificationStatus.SENT;
  }

  isDelivered() {
    return this.status === NotificationStatus.DELIVERED;
  }

  isFailed() {
    return this.status === NotificationStatus.FAILED;
  }

  isBounced() {
    return this.status === NotificationStatus.BOUNCED;
  }

  isTerminalState() {
    return [
      NotificationStatus.DELIVERED,
      NotificationStatus.FAILED,
      NotificationStatus.BOUNCED,
    ].includes(this.status);
  }

  canRetry() {
    return this.deliveryAttempts < this.maxDeliveryAttempts && !this.isTerminalState();
  }

  getBackoffDelayMs() {
    // Exponential backoff: 1s, 4s, 16s
    const backoffs = [1000, 4000, 16000];
    if (this.deliveryAttempts >= backoffs.length) {
      return backoffs[backoffs.length - 1];
    }
    return backoffs[this.deliveryAttempts] || 1000;
  }

  toJSON() {
    return {
      id: this.id,
      batch_id: this.batchId,
      recipient: this.recipient,
      channel: this.channel,
      subject: this.subject,
      body: this.body,
      template_vars: this.templateVars,
      status: this.status,
      delivery_attempts: this.deliveryAttempts,
      max_delivery_attempts: this.maxDeliveryAttempts,
      last_attempt_at: this.lastAttemptAt,
      last_error: this.lastError,
      provider_message_id: this.providerMessageId,
      provider_response: this.providerResponse,
      idempotency_key: this.idempotencyKey,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      deleted_at: this.deletedAt,
    };
  }

  static fromJSON(json) {
    return new Notification(json);
  }
}

module.exports = {
  Notification,
  ChannelType,
  NotificationStatus,
  NotificationValidator,
  DomainError,
  InvalidNotificationError,
  InvalidChannelError,
  InvalidRecipientError,
  InvalidStateTransitionError,
};
