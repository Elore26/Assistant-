#!/usr/bin/env node
// ============================================
// RUN-JOB — Run a single job from CLI
// Usage: node src/run-job.mjs <job-name>
// ============================================

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const jobName = process.argv[2];
if (!jobName) {
  console.log("Usage: node src/run-job.mjs <job-name>");
  console.log("Available jobs: scrape-all, scrape-linkedin, scrape-wttj, scrape-indeed, score-jobs");
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toLocaleTimeString("fr-FR", { timeZone: "Asia/Jerusalem" })}] ${msg}`);

async function run() {
  const start = Date.now();
  log(`▶ Running: ${jobName}\n`);

  try {
    switch (jobName) {
      case "scrape-all": {
        const { scrapeAll } = await import("./jobs/scrape-all.mjs");
        await scrapeAll(log);
        break;
      }
      case "scrape-linkedin": {
        const { scrapeLinkedIn } = await import("./scrapers/linkedin.mjs");
        const jobs = await scrapeLinkedIn(log);
        log(`\nResult: ${jobs.length} jobs scraped (not synced)`);
        break;
      }
      case "scrape-wttj": {
        const { scrapeWTTJ } = await import("./scrapers/wttj.mjs");
        const jobs = await scrapeWTTJ(log);
        log(`\nResult: ${jobs.length} jobs scraped (not synced)`);
        break;
      }
      case "scrape-indeed": {
        const { scrapeIndeed } = await import("./scrapers/indeed.mjs");
        const jobs = await scrapeIndeed(log);
        log(`\nResult: ${jobs.length} jobs scraped (not synced)`);
        break;
      }
      case "score-jobs": {
        const { scoreNewJobs } = await import("./jobs/score-jobs.mjs");
        await scoreNewJobs(log);
        break;
      }
      default:
        log(`✗ Unknown job: ${jobName}`);
        process.exit(1);
    }
  } catch (e) {
    log(`✗ FATAL: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    // Close browser if open
    const { closeBrowser } = await import("./services/browser.mjs");
    await closeBrowser();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`\n✓ Done in ${elapsed}s`);
}

run();
