#!/usr/bin/env node
// ============================================
// OREN LOCAL SCRAPER — Main entry point
// Runs on old Mac via launchd cron
// Scrapes LinkedIn + WTTJ → Supabase
// ============================================

import { chromium } from "playwright";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { appendFileSync, mkdirSync, existsSync } from "fs";

// Load .env from the local-scraper directory
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import { scrapeLinkedIn } from "./scrapers/linkedin.mjs";
import { scrapeWTTJ } from "./scrapers/wttj.mjs";
import { syncToSupabase } from "./sync.mjs";

// --- Logging ---
const LOG_DIR = join(__dirname, "..", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const today = new Date().toISOString().split("T")[0];
const logFile = join(LOG_DIR, `scrape-${today}.log`);

function log(msg) {
  const timestamp = new Date().toLocaleTimeString("fr-FR", { timeZone: "Asia/Jerusalem" });
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch (_) {}
}

// --- Parse CLI args ---
const args = process.argv.slice(2);
const sourceFilter = args.includes("--source")
  ? args[args.indexOf("--source") + 1]
  : null; // "linkedin", "wttj", or null (both)

// --- Main ---
async function main() {
  const startTime = Date.now();
  log("========================================");
  log(`OREN SCRAPER — ${new Date().toLocaleDateString("fr-FR", { timeZone: "Asia/Jerusalem" })}`);
  log("========================================");

  const headless = process.env.SCRAPE_HEADLESS !== "false";
  log(`Mode: ${headless ? "headless" : "visible"} | Source: ${sourceFilter || "toutes"}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    const allJobs = [];

    // --- LinkedIn ---
    if (!sourceFilter || sourceFilter === "linkedin") {
      try {
        const linkedinJobs = await scrapeLinkedIn(browser, log);
        allJobs.push(...linkedinJobs);
      } catch (e) {
        log(`✗ LinkedIn scraper crashed: ${e.message}`);
      }
    }

    // --- WTTJ ---
    if (!sourceFilter || sourceFilter === "wttj") {
      try {
        const wttjJobs = await scrapeWTTJ(browser, log);
        allJobs.push(...wttjJobs);
      } catch (e) {
        log(`✗ WTTJ scraper crashed: ${e.message}`);
      }
    }

    // --- Deduplicate locally before sync ---
    const seen = new Set();
    const uniqueJobs = allJobs.filter((j) => {
      const key = j.job_url || `${j.company}|||${j.title}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log(`\nTotal scrapé: ${allJobs.length} | Unique: ${uniqueJobs.length}`);

    // --- Sync to Supabase ---
    if (uniqueJobs.length > 0) {
      const result = await syncToSupabase(uniqueJobs, log);
      log(`\n✅ TERMINÉ — ${result.inserted} nouvelles offres ajoutées`);
    } else {
      log("\n⚠ Aucune offre trouvée — vérifier les sélecteurs");
    }
  } catch (e) {
    log(`✗ ERREUR FATALE: ${e.message}`);
    log(e.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\nDurée: ${elapsed}s`);
    log("========================================\n");
  }
}

main();
