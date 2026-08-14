#!/usr/bin/env node

const os = require('os');
const chalk = require('chalk');

class SysPulse {
  constructor() {
    this.cpuUsageHistory = [];
    this.maxHistory = 60;
    this.updateInterval = 1000;
    this.lastCpuInfo = os.cpus();
    this.lastUpdateTime = process.hrtime.bigint();
  }

  getCpuUsage() {
    const cpus = os.cpus();
    const currentTime = process.hrtime.bigint();
    const timeDiff = currentTime - this.lastUpdateTime;

    if (timeDiff < 100000000n) return null;

    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu, index) => {
      const lastCpu = this.lastCpuInfo[index];
      for (const type in cpu.times) {
        totalTick += cpu.times[type] - lastCpu.times[type];
      }
      totalIdle += cpu.times.idle - lastCpu.times.idle;
    });

    const usage = 100 - ~~(100 * totalIdle / totalTick) || 0;
    this.lastCpuInfo = cpus;
    this.lastUpdateTime = currentTime;

    return Math.max(0, Math.min(100, usage));
  }

  getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const percentage = (usedMem / totalMem) * 100;

    return {
      used: this.formatBytes(usedMem),
      total: this.formatBytes(totalMem),
      percentage: percentage.toFixed(1)
    };
  }

  getUptime() {
    const uptime = os.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    return { days, hours, minutes, seconds };
  }

  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  createBar(percentage, width = 30) {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    return bar;
  }

  getColoredPercentage(percentage) {
    const percent = parseFloat(percentage);
    const formatted = percent.toFixed(1);
    if (percent < 50) return chalk.green(formatted);
    if (percent < 75) return chalk.yellow(formatted);
    return chalk.red(formatted);
  }

  clear() {
    console.clear();
  }

  render() {
    this.clear();

    const cpuUsage = this.getCpuUsage();
    const memoryUsage = this.getMemoryUsage();
    const uptime = this.getUptime();

    // Header
    console.log(chalk.cyan.bold('\n  ⚡ SysPulse - System Metrics Dashboard\n'));
    console.log(chalk.gray.dim('─'.repeat(50)));

    // CPU Section
    console.log(chalk.blue.bold('\n  CPU Usage'));
    if (cpuUsage !== null) {
      this.cpuUsageHistory.push(cpuUsage);
      if (this.cpuUsageHistory.length > this.maxHistory) {
        this.cpuUsageHistory.shift();
      }

      const currentCpu = cpuUsage.toFixed(1);
      const avgCpu = (this.cpuUsageHistory.reduce((a, b) => a + b, 0) / this.cpuUsageHistory.length).toFixed(1);
      const maxCpu = Math.max(...this.cpuUsageHistory).toFixed(1);

      console.log(chalk.gray('  Current') + ' │ ' + this.createBar(cpuUsage) + ' │ ' + this.getColoredPercentage(cpuUsage) + '%');
      console.log(chalk.gray('  Average') + ' │ ' + this.getColoredPercentage(avgCpu) + '%');
      console.log(chalk.gray('  Peak   ') + ' │ ' + this.getColoredPercentage(maxCpu) + '%');
    }

    // Memory Section
    console.log(chalk.blue.bold('\n  Memory Usage'));
    console.log(chalk.gray('  Current') + ' │ ' + this.createBar(parseFloat(memoryUsage.percentage)) + ' │ ' + this.getColoredPercentage(memoryUsage.percentage) + '%');
    console.log(chalk.gray('  Details ') + ' │ ' + memoryUsage.used + ' / ' + memoryUsage.total);

    // Uptime Section
    console.log(chalk.blue.bold('\n  System Uptime'));
    const uptimeStr = `${uptime.days}d ${uptime.hours}h ${uptime.minutes}m ${uptime.seconds}s`;
    console.log(chalk.gray('  ' + uptimeStr));

    // System Info Section
    console.log(chalk.blue.bold('\n  System Information'));
    console.log(chalk.gray('  Hostname   │ ') + chalk.white(os.hostname()));
    console.log(chalk.gray('  Platform   │ ') + chalk.white(os.platform()));
    console.log(chalk.gray('  CPU Cores  │ ') + chalk.white(os.cpus().length));
    console.log(chalk.gray('  Load Avg   │ ') + chalk.white(os.loadavg().map(x => x.toFixed(2)).join(', ')));

    // Footer
    console.log(chalk.gray.dim('\n' + '─'.repeat(50)));
    console.log(chalk.gray('  Press Ctrl+C to exit • Updated every ' + (this.updateInterval / 1000) + 's'));
    console.log();
  }

  start() {
    this.render();
    setInterval(() => this.render(), this.updateInterval);
  }
}

const pulse = new SysPulse();
pulse.start();
