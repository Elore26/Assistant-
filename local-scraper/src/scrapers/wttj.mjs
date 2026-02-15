// ============================================
// WELCOME TO THE JUNGLE (WTTJ) JOB SCRAPER
// Scrapes WTTJ search pages using Playwright
// WTTJ has good SaaS/tech coverage in France
// ============================================

import { WTTJ_SEARCHES, PAGE_DELAY_MS, MAX_RESULTS_PER_SEARCH } from "../config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build WTTJ search URL
 * Format: https://www.welcometothejungle.com/fr/jobs?query=...&refinementList[office.country_code][]=FR
 */
function buildSearchUrl(search) {
  const params = new URLSearchParams({
    query: search.query,
    page: "1",
    aroundQuery: search.location,
  });
  // WTTJ uses refinementList for contract type
  if (search.contract) {
    params.append("refinementList[contract_type][]", search.contract.toLowerCase());
  }
  return `https://www.welcometothejungle.com/fr/jobs?${params}`;
}

/**
 * Scrape job listings from a single WTTJ search page
 */
async function scrapePage(page, search, log) {
  const url = buildSearchUrl(search);
  log(`  → ${search.query} | ${search.location}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for job cards
    await page.waitForSelector("[data-testid='search-results-list-item-wrapper'], article, .ais-Hits-item, [class*='SearchResults'] li, [class*='JobCard']", {
      timeout: 10000,
    }).catch(() => {});

    // Let page render fully
    await sleep(2000);

    // Scroll to load lazy content
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(400);
    }

    // Extract job data
    const jobs = await page.evaluate((maxResults) => {
      const results = [];
      // WTTJ uses various selectors depending on version
      const cards = document.querySelectorAll(
        "[data-testid='search-results-list-item-wrapper'], article[class*='Card'], .ais-Hits-item, li[class*='result']"
      );

      for (const card of Array.from(cards).slice(0, maxResults)) {
        try {
          // Title — usually in an <a> or <h3>/<h4> tag
          const titleEl = card.querySelector(
            "h3, h4, [data-testid='job-card-title'], a[href*='/jobs/'] span, [class*='title']"
          );
          const title = titleEl?.textContent?.trim() || "";

          // Company
          const companyEl = card.querySelector(
            "[data-testid='job-card-company-name'], span[class*='company'], [class*='Organization'] span"
          );
          const company = companyEl?.textContent?.trim() || "";

          // Location
          const locEl = card.querySelector(
            "[data-testid='job-card-location'], span[class*='location'], [class*='Location']"
          );
          const location = locEl?.textContent?.trim() || "";

          // URL — WTTJ job links contain /fr/companies/xxx/jobs/yyy
          const linkEl = card.querySelector("a[href*='/jobs/']");
          let jobUrl = linkEl?.href || "";
          // Ensure full URL
          if (jobUrl && !jobUrl.startsWith("http")) {
            jobUrl = `https://www.welcometothejungle.com${jobUrl}`;
          }

          // Contract type
          const contractEl = card.querySelector(
            "[data-testid='job-card-contract-type'], span[class*='contract']"
          );
          const contract = contractEl?.textContent?.trim() || "";

          if (title && (jobUrl || company)) {
            results.push({ title, company, location, job_url: jobUrl, contract });
          }
        } catch (_) {}
      }
      return results;
    }, MAX_RESULTS_PER_SEARCH);

    log(`    ${jobs.length} offres trouvées`);
    return jobs.map((j) => ({
      ...j,
      source: "wttj",
      region: search.region,
      role_type: search.role_type,
      date_posted: new Date().toISOString(),
    }));
  } catch (e) {
    log(`    ✗ Erreur: ${e.message}`);
    return [];
  }
}

/**
 * Run all WTTJ searches
 */
export async function scrapeWTTJ(browser, log = console.log) {
  log("\n🌴 WTTJ — Scraping Welcome to the Jungle");
  const allJobs = [];
  const page = await browser.newPage();

  // Set French locale headers
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9",
  });

  for (let i = 0; i < WTTJ_SEARCHES.length; i++) {
    const search = WTTJ_SEARCHES[i];
    const jobs = await scrapePage(page, search, log);
    allJobs.push(...jobs);

    if (i < WTTJ_SEARCHES.length - 1) {
      await sleep(PAGE_DELAY_MS + Math.random() * 2000);
    }
  }

  await page.close();
  log(`  Total WTTJ: ${allJobs.length} offres`);
  return allJobs;
}
