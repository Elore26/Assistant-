#!/usr/bin/env node
// ============================================
// OREN SERVER — 24/7 Mac daemon
// Handles everything Supabase can't:
//   - Job scraping (Playwright)
//   - Job scoring (OpenAI)
//   - Scheduled tasks (cron-like)
//   - Health monitoring
//   - Telegram alerts for server events
// ============================================

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import { Scheduler } from "./scheduler.mjs";
import { logger } from "./logger.mjs";
import { notifyTelegram } from "./services/telegram-notify.mjs";

const PORT = parseInt(process.env.SERVER_PORT || "7600");

// ─── Server state ───
const serverState = {
  startedAt: new Date().toISOString(),
  lastJobs: {},   // { jobName: { ranAt, status, duration, result } }
  errors: [],     // last 50 errors
};

// ─── Health check HTTP server ───
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      startedAt: serverState.startedAt,
      lastJobs: serverState.lastJobs,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      recentErrors: serverState.errors.slice(-5),
    }));
    return;
  }

  if (url.pathname === "/jobs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(serverState.lastJobs, null, 2));
    return;
  }

  if (url.pathname === "/run" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { job } = JSON.parse(body);
        if (!scheduler.jobs.has(job)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Job '${job}' not found` }));
          return;
        }
        // Run async, respond immediately
        scheduler.runJob(job).catch(() => {});
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "started", job }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── Scheduler ───
const scheduler = new Scheduler(serverState, logger);

// Register all jobs
async function registerJobs() {
  // Scraping: 7h30 + 13h00 + 18h00 (Israel time)
  const { scrapeAll } = await import("./jobs/scrape-all.mjs");
  scheduler.register("scrape-all", scrapeAll, {
    cron: ["07:30", "13:00", "18:00"],
    timezone: "Asia/Jerusalem",
    description: "Scrape LinkedIn + WTTJ + Indeed → Supabase",
  });

  // Job scoring: runs after each scrape + once at 20h00
  const { scoreNewJobs } = await import("./jobs/score-jobs.mjs");
  scheduler.register("score-jobs", scoreNewJobs, {
    cron: ["08:00", "13:30", "18:30", "20:00"],
    timezone: "Asia/Jerusalem",
    description: "Score & rank new job listings with AI",
  });

  // Health ping: every 30 minutes — log that server is alive
  scheduler.register("heartbeat", async (log) => {
    log("💓 Server alive");
  }, {
    intervalMinutes: 30,
    description: "Heartbeat check",
  });
}

// ─── Start ───
async function start() {
  logger.info("========================================");
  logger.info("  OREN SERVER — Starting up");
  logger.info("========================================");

  await registerJobs();
  scheduler.start();

  server.listen(PORT, () => {
    logger.info(`Health endpoint: http://localhost:${PORT}/health`);
    logger.info(`Registered jobs: ${[...scheduler.jobs.keys()].join(", ")}`);
    logger.info("========================================\n");
  });

  // Notify Telegram that server started
  await notifyTelegram(`🖥️ *Oren Server démarré*\nPort: ${PORT}\nJobs: ${scheduler.jobs.size}`).catch(() => {});
}

// ─── Graceful shutdown ───
async function shutdown(signal) {
  logger.info(`\n${signal} received — shutting down...`);
  scheduler.stop();
  server.close();
  await notifyTelegram("🔴 Oren Server arrêté").catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught: ${err.message}`);
  serverState.errors.push({ at: new Date().toISOString(), error: err.message });
  if (serverState.errors.length > 50) serverState.errors.shift();
});

start();
