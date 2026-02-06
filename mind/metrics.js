/**
 * Real-time analytics and metrics for Laura.
 * Tracks what she's doing right now (activity) and speed/latency metrics for analytical purposes.
 */

const os = require('os');
const ROLLING_SIZE = 30;
const RATE_WINDOW_MS = 60000;

class Metrics {
  constructor() {
    this.currentActivity = { phase: 'idle', detail: null, since: Date.now() };
    this.actionTimestamps = [];
    this.thoughtTimestamps = [];
    this.decideTimings = [];
    this.actionTimings = [];
    this.tickTimings = [];
  }

  /** Get current resource usage for throttling (memory in MB). */
  getResourceUsage() {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss || 0) / 1024 / 1024;
    const heapMB = (mem.heapUsed || 0) / 1024 / 1024;
    return { rssMB, heapMB, systemFreeMem: os.freemem(), systemTotalMem: os.totalmem() };
  }

  /** Set what she's doing right now. Phase: tick, decide, execute, reflect, idle, error. */
  setActivity(phase, detail = null) {
    this.currentActivity = {
      phase: String(phase),
      detail: detail != null ? String(detail) : null,
      since: Date.now(),
    };
  }

  /** Record a latency sample (ms). Keeps last ROLLING_SIZE per key. */
  recordTiming(name, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    const key = name === 'decide_ms' ? 'decideTimings' : name === 'action_ms' ? 'actionTimings' : name === 'tick_ms' ? 'tickTimings' : null;
    if (!key) return;
    const arr = this[key];
    arr.push(Math.max(0, ms));
    if (arr.length > ROLLING_SIZE) arr.shift();
  }

  /** Record that an action/thought completed (for rate: actions per minute, thoughts per minute). */
  recordCount(name) {
    const now = Date.now();
    if (name === 'action' || name === 'thought') {
      this.actionTimestamps.push(now);
      this.thoughtTimestamps.push(now);
      if (this.actionTimestamps.length > 200) {
        this.actionTimestamps = this.actionTimestamps.slice(-100);
        this.thoughtTimestamps = this.thoughtTimestamps.slice(-100);
      }
    }
  }

  /** Get current activity for display. */
  getCurrentActivity() {
    return { ...this.currentActivity };
  }

  /** Get full metrics: activity + speeds + latencies. */
  getMetrics() {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    const actionsInWindow = this.actionTimestamps.filter((t) => t >= cutoff).length;
    const thoughtsInWindow = this.thoughtTimestamps.filter((t) => t >= cutoff).length;
    const actionsPerMinute = (actionsInWindow / RATE_WINDOW_MS) * 60000;
    const thoughtsPerMinute = (thoughtsInWindow / RATE_WINDOW_MS) * 60000;

    const avg = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
    const last = (arr) => (arr.length === 0 ? null : arr[arr.length - 1]);

    return {
      activity: this.getCurrentActivity(),
      speed: {
        actionsPerMinute: Math.round(actionsPerMinute * 10) / 10,
        thoughtsPerMinute: Math.round(thoughtsPerMinute * 10) / 10,
        actionsInLastMinute: actionsInWindow,
        thoughtsInLastMinute: thoughtsInWindow,
      },
      latency: {
        avgDecideMs: avg(this.decideTimings) != null ? Math.round(avg(this.decideTimings)) : null,
        avgActionMs: avg(this.actionTimings) != null ? Math.round(avg(this.actionTimings)) : null,
        avgTickMs: avg(this.tickTimings) != null ? Math.round(avg(this.tickTimings)) : null,
        lastDecideMs: last(this.decideTimings),
        lastActionMs: last(this.actionTimings),
        lastTickMs: last(this.tickTimings),
      },
      counts: {
        decideSamples: this.decideTimings.length,
        actionSamples: this.actionTimings.length,
      },
      resource: this.getResourceUsage(),
    };
  }
}

module.exports = Metrics;
