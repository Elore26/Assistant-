// ============================================
// WELCOME TO THE JUNGLE (WTTJ) SCRAPER
// Strong coverage in France for SaaS/tech
// ============================================

import { newPage } from "../services/browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCHES = [
  { query: "Account Executive", contract: "CDI", location: "Paris", region: "france", role_type: "AE" },
  { query: "SDR", contract: "CDI", location: "Paris", region: "france", role_type: "SDR" },
  { query: "Business Developer SaaS", contract: "CDI", location: "Paris", region: "france", role_type: "BDR" },
  { query: "Commercial B2B SaaS", contract: "CDI", location: "France", region: "france", role_type: "AE" },
  { query: "Account Executive", contract: "CDI", location: "Tel Aviv", region: "israel", role_type: "AE" },
  { query: "Sales SaaS", contract: "CDI", location: "Israel", region: "israel", role_type: "SDR" },
];

function buildUrl(search) {
  const params = new URLSearchParams({
    query: search.query,
    page: "1",
    aroundQuery: search.location,
  });
  if (search.contract) {
    params.append("refinementList[contract_type][]", search.contract.toLowerCase());
  }
  return `https://www.welcometothejungle.com/fr/jobs?${params}`;
}

async function scrapePage(page, search, log) {
  const url = buildUrl(search);
  log(`  → ${search.query} | ${search.location}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(
      "[data-testid='search-results-list-item-wrapper'], article, .ais-Hits-item",
      { timeout: 10000 }
    ).catch(() => {});

    await sleep(2000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(400);
    }

    const jobs = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll(
        "[data-testid='search-results-list-item-wrapper'], article[class*='Card'], .ais-Hits-item, li[class*='result']"
      );

      for (const card of Array.from(cards).slice(0, 15)) {
        try {
          const titleEl = card.querySelector("h3, h4, [data-testid='job-card-title'], a[href*='/jobs/'] span");
          const title = titleEl?.textContent?.trim() || "";

          const companyEl = card.querySelector("[data-testid='job-card-company-name'], span[class*='company']");
          const company = companyEl?.textContent?.trim() || "";

          const locEl = card.querySelector("[data-testid='job-card-location'], span[class*='location']");
          const location = locEl?.textContent?.trim() || "";

          const linkEl = card.querySelector("a[href*='/jobs/']");
          let jobUrl = linkEl?.href || "";
          if (jobUrl && !jobUrl.startsWith("http")) {
            jobUrl = `https://www.welcometothejungle.com${jobUrl}`;
          }

          const contractEl = card.querySelector("[data-testid='job-card-contract-type']");
          const contract = contractEl?.textContent?.trim() || "";

          if (title && (jobUrl || company)) {
            results.push({ title, company, location, job_url: jobUrl, contract });
          }
        } catch (_) {}
      }
      return results;
    });

    log(`    ${jobs.length} offres`);
    return jobs.map((j) => ({
      ...j,
      source: "wttj",
      region: search.region,
      role_type: search.role_type,
      date_posted: new Date().toISOString(),
    }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

export async function scrapeWTTJ(log = console.log) {
  log("\n🌴 WTTJ — Scraping Welcome to the Jungle");
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

  log(`  Total WTTJ: ${allJobs.length}`);
  return allJobs;
}
