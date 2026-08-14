# SysPulse

A beautiful, real-time system metrics dashboard for the terminal built with Node.js.

## Features

- **Real-time CPU Monitoring**: Current, average, and peak CPU usage with visual progress bars
- **Memory Usage**: Visual representation of RAM usage with detailed breakdown
- **System Uptime**: Display of system uptime in days, hours, minutes, and seconds
- **System Information**: Hostname, platform, CPU core count, and load averages
- **Color-coded Metrics**: Green (good) → Yellow (warning) → Red (critical) for easy interpretation
- **Refreshes Every Second**: Live updates without being overwhelming

## Installation

1. Navigate to the syspulse directory:
```bash
cd syspulse
```

2. Install dependencies:
```bash
npm install
```

## Usage

Start the dashboard:

```bash
npm start
```

Or run directly:

```bash
node index.js
```

Press `Ctrl+C` to exit the dashboard.

## What It Shows

### CPU Usage
- **Current**: Real-time CPU usage with visual bar chart
- **Average**: Average CPU usage over the last 60 seconds
- **Peak**: Maximum CPU usage over the last 60 seconds

### Memory Usage
- **Current**: Real-time memory usage percentage and visual bar
- **Details**: Used memory vs total memory in human-readable format (KB, MB, GB)

### System Uptime
- Total system uptime since last restart in days, hours, minutes, and seconds

### System Information
- **Hostname**: Computer name
- **Platform**: Operating system (darwin, linux, win32, etc.)
- **CPU Cores**: Number of available CPU cores
- **Load Average**: 1-minute, 5-minute, and 15-minute load averages

## Color Coding

- **Green**: Normal usage (0-49%)
- **Yellow**: Elevated usage (50-74%)
- **Red**: High usage (75-100%)

## Performance

SysPulse is lightweight and updates every second, consuming minimal system resources itself. It's safe to leave running in a terminal window for monitoring.

## License

MIT
