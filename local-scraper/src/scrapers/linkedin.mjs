// ============================================
// LINKEDIN PUBLIC JOB SCRAPER
// Scrapes public LinkedIn job search pages (no login required)
// Uses Playwright headless browser
// ============================================

import { LINKEDIN_SEARCHES, PAGE_DELAY_MS, MAX_RESULTS_PER_SEARCH } from "../config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build LinkedIn public job search URL
 * LinkedIn public search: https://www.linkedin.com/jobs/search/?keywords=...&location=...&f_TPR=r604800
 * f_TPR=r604800 = past week (7 days in seconds)
 * f_TPR=r2592000 = past month
 */
function buildSearchUrl(search) {
  const params = new URLSearchParams({
    keywords: search.query,
    location: search.location,
    f_TPR: "r604800", // past week
    sortBy: "DD",      // date posted (most recent)
    position: "1",
    pageNum: "0",
  });
  return `https://www.linkedin.com/jobs/search/?${params}`;
}

/**
 * Scrape job listings from a single LinkedIn search page
 */
async function scrapePage(page, search, log) {
  const url = buildSearchUrl(search);
  log(`  → ${search.query} | ${search.location}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for job cards to appear (public page uses specific selectors)
    await page.waitForSelector(".base-card, .job-search-card, .jobs-search__results-list li", {
      timeout: 10000,
    }).catch(() => {});

    // Scroll down to load more results
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(500);
    }

    // Extract job data from the page
    const jobs = await page.evaluate((maxResults) => {
      const results = [];
      // LinkedIn public pages use different selectors - try multiple
      const cards = document.querySelectorAll(
        ".base-card, .job-search-card, .jobs-search__results-list > li"
      );

      for (const card of Array.from(cards).slice(0, maxResults)) {
        try {
          // Title
          const titleEl = card.querySelector(
            ".base-search-card__title, .base-card__full-link, h3.base-search-card__title, .job-search-card__title"
          );
          const title = titleEl?.textContent?.trim() || "";

          // Company
          const companyEl = card.querySelector(
            ".base-search-card__subtitle, h4.base-search-card__subtitle, .job-search-card__subtitle"
          );
          const company = companyEl?.textContent?.trim() || "";

          // Location
          const locEl = card.querySelector(
            ".job-search-card__location, .base-search-card__metadata span"
          );
          const location = locEl?.textContent?.trim() || "";

          // URL
          const linkEl = card.querySelector("a.base-card__full-link, a[href*='/jobs/view/']");
          let jobUrl = linkEl?.href || "";
          // Clean tracking params
          if (jobUrl.includes("?")) jobUrl = jobUrl.split("?")[0];

          // Date
          const dateEl = card.querySelector("time, .job-search-card__listdate");
          const datePosted = dateEl?.getAttribute("datetime") || "";

          if (title && jobUrl) {
            results.push({ title, company, location, job_url: jobUrl, date_posted: datePosted });
          }
        } catch (_) {}
      }
      return results;
    }, MAX_RESULTS_PER_SEARCH);

    log(`    ${jobs.length} offres trouvées`);
    return jobs.map((j) => ({
      ...j,
      source: "linkedin",
      region: search.region,
      role_type: search.role_type,
      date_posted: j.date_posted ? new Date(j.date_posted).toISOString() : new Date().toISOString(),
    }));
  } catch (e) {
    log(`    ✗ Erreur: ${e.message}`);
    return [];
  }
}

/**
 * Run all LinkedIn searches
 */
export async function scrapeLinkedIn(browser, log = console.log) {
  log("\n🔗 LINKEDIN — Scraping public job pages");
  const allJobs = [];
  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  for (let i = 0; i < LINKEDIN_SEARCHES.length; i++) {
    const search = LINKEDIN_SEARCHES[i];
    const jobs = await scrapePage(page, search, log);
    allJobs.push(...jobs);

    // Delay between searches to avoid rate limiting
    if (i < LINKEDIN_SEARCHES.length - 1) {
      await sleep(PAGE_DELAY_MS + Math.random() * 2000);
    }
  }

  await page.close();
  log(`  Total LinkedIn: ${allJobs.length} offres`);
  return allJobs;
}
