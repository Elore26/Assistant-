// ============================================
// SCHEDULER — Cron-like task runner
// Checks every minute if a job needs to run
// ============================================

export class Scheduler {
  constructor(serverState, logger) {
    this.serverState = serverState;
    this.logger = logger;
    this.jobs = new Map(); // name → { fn, options }
    this.timers = [];
    this.running = new Set(); // prevent overlap
  }

  register(name, fn, options = {}) {
    this.jobs.set(name, { fn, options });
    this.logger.info(`  📋 Registered: ${name} — ${options.description || ""}`);
  }

  start() {
    // Check every 60 seconds which jobs to run
    const cronCheck = setInterval(() => this._checkCron(), 60_000);
    this.timers.push(cronCheck);

    // Interval-based jobs
    for (const [name, { options }] of this.jobs) {
      if (options.intervalMinutes) {
        const interval = setInterval(
          () => this.runJob(name),
          options.intervalMinutes * 60_000
        );
        this.timers.push(interval);
      }
    }

    this.logger.info("⏰ Scheduler started");
  }

  stop() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.logger.info("⏰ Scheduler stopped");
  }

  _checkCron() {
    const now = new Date();
    // Get current time in Israel timezone
    const israelTime = now.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }); // "07:30"

    for (const [name, { options }] of this.jobs) {
      if (!options.cron) continue;
      const tz = options.timezone || "Asia/Jerusalem";
      const currentTime = now.toLocaleTimeString("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      if (options.cron.includes(currentTime)) {
        this.runJob(name);
      }
    }
  }

  async runJob(name) {
    const job = this.jobs.get(name);
    if (!job) return;

    // Prevent overlapping runs
    if (this.running.has(name)) {
      this.logger.warn(`⏭ ${name} already running, skipping`);
      return;
    }

    this.running.add(name);
    const startTime = Date.now();
    const jobLog = (msg) => this.logger.info(`[${name}] ${msg}`);

    this.logger.info(`▶ ${name} — starting`);
    this.serverState.lastJobs[name] = {
      ranAt: new Date().toISOString(),
      status: "running",
    };

    try {
      const result = await job.fn(jobLog);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      this.serverState.lastJobs[name] = {
        ranAt: new Date().toISOString(),
        status: "success",
        duration: `${duration}s`,
        result: result || null,
      };
      this.logger.info(`✓ ${name} — done in ${duration}s`);
    } catch (err) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.serverState.lastJobs[name] = {
        ranAt: new Date().toISOString(),
        status: "error",
        duration: `${duration}s`,
        error: err.message,
      };
      this.logger.error(`✗ ${name} — failed: ${err.message}`);
      this.serverState.errors.push({
        at: new Date().toISOString(),
        job: name,
        error: err.message,
      });
      if (this.serverState.errors.length > 50) this.serverState.errors.shift();
    } finally {
      this.running.delete(name);
    }
  }
}
