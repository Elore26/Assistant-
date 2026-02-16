// ============================================
// SCRAPER CONFIG — Search queries for LinkedIn & WTTJ
// ============================================

export const LINKEDIN_SEARCHES = [
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

export const WTTJ_SEARCHES = [
  // WTTJ is strong in France
  { query: "Account Executive", contract: "CDI", location: "Paris", region: "france", role_type: "AE" },
  { query: "SDR", contract: "CDI", location: "Paris", region: "france", role_type: "SDR" },
  { query: "Business Developer SaaS", contract: "CDI", location: "Paris", region: "france", role_type: "BDR" },
  { query: "Commercial B2B SaaS", contract: "CDI", location: "France", region: "france", role_type: "AE" },
  // WTTJ also has Israel/remote
  { query: "Account Executive", contract: "CDI", location: "Tel Aviv", region: "israel", role_type: "AE" },
  { query: "Sales SaaS", contract: "CDI", location: "Israel", region: "israel", role_type: "SDR" },
];

// Delay between page loads (ms) — be gentle with the sites
export const PAGE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || "3000");

// Max results per search query
export const MAX_RESULTS_PER_SEARCH = 10;
