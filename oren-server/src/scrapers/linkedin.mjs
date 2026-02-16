// ============================================
// LINKEDIN PUBLIC JOB SCRAPER
// No login required — scrapes public search pages
// ============================================

import { newPage } from "../services/browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCHES = [
  // Israel
  { query: "Account Executive SaaS", location: "Tel Aviv, Israel", region: "israel", role_type: "AE" },
  { query: "SDR SaaS", location: "Israel", region: "israel", role_type: "SDR" },
  { query: "Sales Development Representative", location: "Tel Aviv, Israel", region: "israel", role_type: "SDR" },
  { query: "Business Development SaaS", location: "Israel", region: "israel", role_type: "BDR" },
  // France
  { query: "Account Executive SaaS", location: "Paris, France", region: "france", role_type: "AE" },
  { query: "SDR SaaS", location: "Paris, France", region: "france", role_type: "SDR" },
  { query: "Commercial SaaS B2B", location: "France", region: "france", role_type: "AE" },
];

function buildUrl(search) {
  const params = new URLSearchParams({
    keywords: search.query,
    location: search.location,
    f_TPR: "r604800", // past week
    sortBy: "DD",
    position: "1",
    pageNum: "0",
  });
  return `https://www.linkedin.com/jobs/search/?${params}`;
}

async function scrapePage(page, search, log) {
  const url = buildUrl(search);
  log(`  → ${search.query} | ${search.location}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".base-card, .job-search-card, .jobs-search__results-list li", {
      timeout: 10000,
    }).catch(() => {});

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(500);
    }

    const jobs = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll(
        ".base-card, .job-search-card, .jobs-search__results-list > li"
      );

      for (const card of Array.from(cards).slice(0, 15)) {
        try {
          const titleEl = card.querySelector(
            ".base-search-card__title, .base-card__full-link, h3.base-search-card__title"
          );
          const title = titleEl?.textContent?.trim() || "";

          const companyEl = card.querySelector(
            ".base-search-card__subtitle, h4.base-search-card__subtitle"
          );
          const company = companyEl?.textContent?.trim() || "";

          const locEl = card.querySelector(
            ".job-search-card__location, .base-search-card__metadata span"
          );
          const location = locEl?.textContent?.trim() || "";

          const linkEl = card.querySelector("a.base-card__full-link, a[href*='/jobs/view/']");
          let jobUrl = linkEl?.href || "";
          if (jobUrl.includes("?")) jobUrl = jobUrl.split("?")[0];

          const dateEl = card.querySelector("time, .job-search-card__listdate");
          const datePosted = dateEl?.getAttribute("datetime") || "";

          if (title && jobUrl) {
            results.push({ title, company, location, job_url: jobUrl, date_posted: datePosted });
          }
        } catch (_) {}
      }
      return results;
    });

    log(`    ${jobs.length} offres`);
    return jobs.map((j) => ({
      ...j,
      source: "linkedin",
      region: search.region,
      role_type: search.role_type,
      date_posted: j.date_posted ? new Date(j.date_posted).toISOString() : new Date().toISOString(),
    }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

export async function scrapeLinkedIn(log = console.log) {
  log("\n🔗 LINKEDIN — Scraping public pages");
  const page = await newPage();
  const allJobs = [];
  const delay = parseInt(process.env.SCRAPE_DELAY_MS || "3000");

  try {
    for (let i = 0; i < SEARCHES.length; i++) {
      const jobs = await scrapePage(page, SEARCHES[i], log);
      allJobs.push(...jobs);
      if (i < SEARCHES.length - 1) {
        await sleep(delay + Math.random() * 2000);
      }
    }
  } finally {
    await page.close();
  }

  log(`  Total LinkedIn: ${allJobs.length}`);
  return allJobs;
}
