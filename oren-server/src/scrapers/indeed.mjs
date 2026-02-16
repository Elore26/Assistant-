// ============================================
// INDEED JOB SCRAPER — New source
// Public search pages, no login required
// Covers Israel (il.indeed.com) + France (fr.indeed.com)
// ============================================

import { newPage } from "../services/browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCHES = [
  // Israel
  { query: "Account Executive SaaS", location: "Tel Aviv", domain: "il.indeed.com", region: "israel", role_type: "AE" },
  { query: "SDR SaaS", location: "Israel", domain: "il.indeed.com", region: "israel", role_type: "SDR" },
  { query: "Business Development SaaS", location: "Tel Aviv", domain: "il.indeed.com", region: "israel", role_type: "BDR" },
  // France
  { query: "Account Executive SaaS", location: "Paris", domain: "fr.indeed.com", region: "france", role_type: "AE" },
  { query: "SDR SaaS", location: "Paris", domain: "fr.indeed.com", region: "france", role_type: "SDR" },
  { query: "Commercial B2B SaaS", location: "Paris", domain: "fr.indeed.com", region: "france", role_type: "AE" },
  { query: "Business Developer", location: "France", domain: "fr.indeed.com", region: "france", role_type: "BDR" },
];

function buildUrl(search) {
  const params = new URLSearchParams({
    q: search.query,
    l: search.location,
    fromage: "7",  // last 7 days
    sort: "date",
  });
  return `https://${search.domain}/jobs?${params}`;
}

async function scrapePage(page, search, log) {
  const url = buildUrl(search);
  log(`  → ${search.query} | ${search.location} (${search.domain})`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Indeed uses various card selectors
    await page.waitForSelector(
      ".job_seen_beacon, .jobsearch-ResultsList > li, .result, [data-testid='job-result']",
      { timeout: 10000 }
    ).catch(() => {});

    await sleep(2000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(400);
    }

    const domain = search.domain;
    const jobs = await page.evaluate((baseDomain) => {
      const results = [];
      const cards = document.querySelectorAll(
        ".job_seen_beacon, .jobsearch-ResultsList > li, .result, [data-testid='job-result'], .tapItem"
      );

      for (const card of Array.from(cards).slice(0, 15)) {
        try {
          // Title
          const titleEl = card.querySelector(
            "h2.jobTitle a, .jobTitle > a, a[data-jk], .jcs-JobTitle, h2 a span"
          );
          const title = titleEl?.textContent?.trim() || "";

          // Company
          const companyEl = card.querySelector(
            "[data-testid='company-name'], .companyName, .company, span.css-1x7z1ps"
          );
          const company = companyEl?.textContent?.trim() || "";

          // Location
          const locEl = card.querySelector(
            "[data-testid='text-location'], .companyLocation, .resultContent .css-1restlb"
          );
          const location = locEl?.textContent?.trim() || "";

          // URL — Indeed uses data-jk attribute for job IDs
          const linkEl = card.querySelector("a[data-jk], h2.jobTitle a, .jcs-JobTitle a");
          let jobUrl = "";
          const jk = linkEl?.getAttribute("data-jk") || card.getAttribute("data-jk");
          if (jk) {
            jobUrl = `https://${baseDomain}/viewjob?jk=${jk}`;
          } else if (linkEl?.href) {
            jobUrl = linkEl.href;
            if (!jobUrl.startsWith("http")) {
              jobUrl = `https://${baseDomain}${jobUrl}`;
            }
          }

          // Date
          const dateEl = card.querySelector(".date, .myJobsStateDate, span.css-qvloho");
          const dateText = dateEl?.textContent?.trim() || "";

          if (title && (jobUrl || company)) {
            results.push({ title, company, location, job_url: jobUrl, date_text: dateText });
          }
        } catch (_) {}
      }
      return results;
    }, domain);

    log(`    ${jobs.length} offres`);
    return jobs.map((j) => ({
      ...j,
      source: "indeed",
      region: search.region,
      role_type: search.role_type,
      date_posted: new Date().toISOString(),
    }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

export async function scrapeIndeed(log = console.log) {
  log("\n🔍 INDEED — Scraping job listings");
  const page = await newPage();
  const allJobs = [];
  const delay = parseInt(process.env.SCRAPE_DELAY_MS || "3000");

  try {
    for (let i = 0; i < SEARCHES.length; i++) {
      const jobs = await scrapePage(page, SEARCHES[i], log);
      allJobs.push(...jobs);
      if (i < SEARCHES.length - 1) {
        // Indeed is stricter — longer delay
        await sleep(delay + Math.random() * 3000);
      }
    }
  } finally {
    await page.close();
  }

  log(`  Total Indeed: ${allJobs.length}`);
  return allJobs;
}
