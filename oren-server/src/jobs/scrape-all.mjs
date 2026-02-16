// ============================================
// JOB: SCRAPE ALL — LinkedIn + WTTJ + Indeed
// Runs 3x/day, deduplicates, syncs to Supabase
// ============================================

import { scrapeLinkedIn } from "../scrapers/linkedin.mjs";
import { scrapeWTTJ } from "../scrapers/wttj.mjs";
import { scrapeIndeed } from "../scrapers/indeed.mjs";
import { syncToSupabase } from "../services/sync.mjs";
import { closeBrowser } from "../services/browser.mjs";
import { notifyTelegram } from "../services/telegram-notify.mjs";

export async function scrapeAll(log) {
  const allJobs = [];

  // --- Run each scraper, catch individually so one failure doesn't kill all ---
  try {
    const linkedinJobs = await scrapeLinkedIn(log);
    allJobs.push(...linkedinJobs);
  } catch (e) {
    log(`✗ LinkedIn crashed: ${e.message}`);
  }

  try {
    const wttjJobs = await scrapeWTTJ(log);
    allJobs.push(...wttjJobs);
  } catch (e) {
    log(`✗ WTTJ crashed: ${e.message}`);
  }

  try {
    const indeedJobs = await scrapeIndeed(log);
    allJobs.push(...indeedJobs);
  } catch (e) {
    log(`✗ Indeed crashed: ${e.message}`);
  }

  // Close browser to free memory
  await closeBrowser();

  // --- Deduplicate locally ---
  const seen = new Set();
  const uniqueJobs = allJobs.filter((j) => {
    const key = j.job_url || `${j.company}|||${j.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log(`\nTotal scrapé: ${allJobs.length} | Unique: ${uniqueJobs.length}`);

  if (uniqueJobs.length === 0) {
    log("⚠ Aucune offre trouvée");
    return { scraped: 0, inserted: 0 };
  }

  // --- Sync to Supabase ---
  const result = await syncToSupabase(uniqueJobs, log);

  // --- Notify Telegram ---
  const summary = [
    `📊 *Scraping terminé*`,
    `LinkedIn: ${allJobs.filter((j) => j.source === "linkedin").length}`,
    `WTTJ: ${allJobs.filter((j) => j.source === "wttj").length}`,
    `Indeed: ${allJobs.filter((j) => j.source === "indeed").length}`,
    `Unique: ${uniqueJobs.length}`,
    `✅ Nouvelles: ${result.inserted} | ♻️ Doublons: ${result.duplicates}`,
  ].join("\n");
  await notifyTelegram(summary).catch(() => {});

  return { scraped: uniqueJobs.length, ...result };
}
