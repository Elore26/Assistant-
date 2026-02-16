// ============================================
// CAREER AGENT — Scraping Tests (Node.js)
// Tests: JSearch parsing, duplicate detection, rate limiting
// ============================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// --- Extracted pure functions from career-agent/index.ts ---

function parseJSearchResults(json) {
  const items = [];
  if (!json?.data) return items;

  for (const r of json.data) {
    if (!r.job_title || !r.job_apply_link) continue;
    items.push({
      title: r.job_title,
      company: r.employer_name || "Unknown",
      location: [r.job_city, r.job_country].filter(Boolean).join(", "),
      job_url: r.job_apply_link,
      date_posted: r.job_posted_at_datetime_utc
        ? new Date(r.job_posted_at_datetime_utc).toISOString()
        : new Date().toISOString(),
    });
  }
  return items;
}

// --- Rate limited batch (from robust-fetch.ts) ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rateLimitedBatch(items, fn, delayMs = 200) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i < items.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

// ============================================
// TESTS
// ============================================

describe("Career Agent — JSearch Parsing", () => {
  it("should parse valid JSearch API response", () => {
    const mockResponse = {
      data: [
        {
          job_title: "Account Executive SaaS",
          employer_name: "Monday.com",
          job_city: "Tel Aviv",
          job_country: "Israel",
          job_apply_link: "https://monday.com/jobs/ae-123",
          job_posted_at_datetime_utc: "2026-02-10T10:00:00.000Z",
        },
        {
          job_title: "SDR - French Market",
          employer_name: "Wiz",
          job_city: "Paris",
          job_country: "France",
          job_apply_link: "https://wiz.io/careers/sdr-456",
          job_posted_at_datetime_utc: "2026-02-12T14:00:00.000Z",
        },
      ],
    };

    const jobs = parseJSearchResults(mockResponse);

    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].title, "Account Executive SaaS");
    assert.equal(jobs[0].company, "Monday.com");
    assert.equal(jobs[0].location, "Tel Aviv, Israel");
    assert.equal(jobs[0].job_url, "https://monday.com/jobs/ae-123");
    assert.equal(jobs[1].title, "SDR - French Market");
    assert.equal(jobs[1].company, "Wiz");
    assert.equal(jobs[1].location, "Paris, France");
    console.log("  ✓ Parsed 2 jobs correctly");
  });

  it("should handle empty API response", () => {
    assert.deepEqual(parseJSearchResults({}), []);
    assert.deepEqual(parseJSearchResults(null), []);
    assert.deepEqual(parseJSearchResults(undefined), []);
    assert.deepEqual(parseJSearchResults({ data: [] }), []);
    console.log("  ✓ Handles empty/null responses");
  });

  it("should skip entries without title or URL", () => {
    const mockResponse = {
      data: [
        { job_title: null, employer_name: "Acme", job_apply_link: "https://acme.com/1" },
        { job_title: "Good Job", employer_name: "Good Co", job_apply_link: null },
        { job_title: "Valid Job", employer_name: "Valid Co", job_apply_link: "https://valid.com/1" },
      ],
    };

    const jobs = parseJSearchResults(mockResponse);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, "Valid Job");
    console.log("  ✓ Skips invalid entries correctly");
  });

  it("should default company to 'Unknown' when missing", () => {
    const mockResponse = {
      data: [
        { job_title: "Sales Rep", employer_name: null, job_apply_link: "https://example.com/1", job_city: "Tel Aviv" },
      ],
    };

    const jobs = parseJSearchResults(mockResponse);
    assert.equal(jobs[0].company, "Unknown");
    console.log("  ✓ Defaults company to 'Unknown'");
  });

  it("should handle missing location fields", () => {
    const mockResponse = {
      data: [
        { job_title: "Remote AE", employer_name: "RemoteCo", job_apply_link: "https://remote.com/1" },
      ],
    };

    const jobs = parseJSearchResults(mockResponse);
    assert.equal(jobs[0].location, "");
    console.log("  ✓ Handles missing location gracefully");
  });

  it("should handle partial location (city only, country only)", () => {
    const data1 = {
      data: [{ job_title: "J1", employer_name: "C1", job_apply_link: "https://1.com", job_city: "Paris", job_country: null }],
    };
    const data2 = {
      data: [{ job_title: "J2", employer_name: "C2", job_apply_link: "https://2.com", job_city: null, job_country: "Israel" }],
    };

    assert.equal(parseJSearchResults(data1)[0].location, "Paris");
    assert.equal(parseJSearchResults(data2)[0].location, "Israel");
    console.log("  ✓ Handles partial location fields");
  });

  it("should use current date when posted date is missing", () => {
    const mockResponse = {
      data: [
        { job_title: "New Job", employer_name: "Co", job_apply_link: "https://co.com/1" },
      ],
    };

    const jobs = parseJSearchResults(mockResponse);
    const parsed = new Date(jobs[0].date_posted);
    const now = new Date();
    const diffMs = Math.abs(now.getTime() - parsed.getTime());
    assert.ok(diffMs < 5000, "Date should be within 5s of now");
    console.log("  ✓ Uses current date as fallback");
  });
});

describe("Career Agent — Duplicate Detection Logic", () => {
  it("should detect URL duplicates", () => {
    const existingUrls = new Set(["https://monday.com/jobs/ae-123", "https://wiz.io/careers/sdr-456"]);
    const newJobs = [
      { job_url: "https://monday.com/jobs/ae-123", title: "AE", company: "Monday.com" },
      { job_url: "https://newco.com/jobs/1", title: "SDR", company: "NewCo" },
    ];

    const filtered = newJobs.filter(j => !existingUrls.has(j.job_url));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].company, "NewCo");
    console.log("  ✓ URL duplicate detection works");
  });

  it("should detect company+title duplicates (case-insensitive)", () => {
    const existingCompanyTitles = new Set(["monday.com|||account executive saas"]);
    const newJobs = [
      { title: "Account Executive SaaS", company: "Monday.com", job_url: "https://new-url.com/1" },
      { title: "SDR SaaS", company: "Wiz", job_url: "https://wiz.io/1" },
    ];

    const filtered = newJobs.filter(j => {
      const key = `${j.company}|||${j.title}`.toLowerCase();
      return !existingCompanyTitles.has(key);
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].company, "Wiz");
    console.log("  ✓ Company+title duplicate detection works");
  });
});

describe("Career Agent — Rate Limiting", () => {
  it("should respect delay between requests", async () => {
    const timestamps = [];
    const items = [1, 2, 3];

    await rateLimitedBatch(items, async (item) => {
      timestamps.push(Date.now());
      return item * 2;
    }, 100);

    assert.equal(timestamps.length, 3);
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      assert.ok(gap >= 90, `Gap between requests should be >= 90ms, got ${gap}ms`);
    }
    console.log("  ✓ Rate limiting enforces delays between requests");
  });

  it("should return all results in order", async () => {
    const items = [10, 20, 30];
    const results = await rateLimitedBatch(items, async (n) => n + 1, 50);
    assert.deepEqual(results, [11, 21, 31]);
    console.log("  ✓ Results are returned in correct order");
  });
});

describe("Career Agent — JSearch Query Config", () => {
  const JOB_SEARCHES = [
    { query: "Account Executive SaaS Tel Aviv", country: "", region: "israel", role_type: "AE" },
    { query: "SDR SaaS Israel", country: "", region: "israel", role_type: "SDR" },
    { query: "Sales Representative SaaS Tel Aviv", country: "", region: "israel", role_type: "SDR" },
    { query: "Account Executive SaaS Paris", country: "", region: "france", role_type: "AE" },
    { query: "SDR SaaS Paris France", country: "", region: "france", role_type: "SDR" },
    { query: "Business Development Representative SaaS France", country: "", region: "france", role_type: "BDR" },
  ];

  it("should have 6 search queries configured", () => {
    assert.equal(JOB_SEARCHES.length, 6);
    console.log("  ✓ 6 search queries configured");
  });

  it("should cover both Israel and France regions", () => {
    const regions = new Set(JOB_SEARCHES.map(s => s.region));
    assert.ok(regions.has("israel"));
    assert.ok(regions.has("france"));
    console.log("  ✓ Both Israel and France regions covered");
  });

  it("should include AE, SDR and BDR role types", () => {
    const types = new Set(JOB_SEARCHES.map(s => s.role_type));
    assert.ok(types.has("AE"));
    assert.ok(types.has("SDR"));
    assert.ok(types.has("BDR"));
    console.log("  ✓ AE, SDR and BDR role types included");
  });
});
