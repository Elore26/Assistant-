// ============================================
// SUPABASE SYNC — Deduplicate & insert new jobs
// Same dedup logic as career-agent (URL + company+title)
// ============================================

import { createClient } from "@supabase/supabase-js";

/**
 * Sync scraped jobs to Supabase with deduplication
 * @param {Array} jobs - Scraped job listings
 * @param {Function} log - Logger function
 * @returns {{ inserted: number, duplicates: number, errors: number }}
 */
export async function syncToSupabase(jobs, log = console.log) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    log("  ✗ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant dans .env");
    return { inserted: 0, duplicates: 0, errors: 1 };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  // --- Pre-fetch existing URLs for batch duplicate check ---
  const allUrls = jobs.map((j) => j.job_url).filter(Boolean);
  const existingUrls = new Set();

  if (allUrls.length > 0) {
    try {
      for (let i = 0; i < allUrls.length; i += 50) {
        const batch = allUrls.slice(i, i + 50);
        const { data: existing } = await supabase
          .from("job_listings")
          .select("job_url")
          .in("job_url", batch);
        if (existing) {
          existing.forEach((e) => existingUrls.add(e.job_url));
        }
      }
    } catch (e) {
      log(`  ⚠ Erreur vérification doublons URL: ${e.message}`);
    }
  }

  // --- Pre-fetch existing company+title combos (30 days) ---
  const existingCompanyTitles = new Set();
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentJobs } = await supabase
      .from("job_listings")
      .select("company, title")
      .gte("created_at", thirtyDaysAgo);
    if (recentJobs) {
      recentJobs.forEach((j) =>
        existingCompanyTitles.add(`${j.company}|||${j.title}`.toLowerCase())
      );
    }
  } catch (_) {}

  log(`\n📤 SYNC — ${jobs.length} offres à vérifier`);
  log(`  Doublons URL existants: ${existingUrls.size}`);
  log(`  Doublons titre existants: ${existingCompanyTitles.size}`);

  // --- Insert new jobs ---
  for (const job of jobs) {
    // Skip if no URL
    if (!job.job_url) {
      duplicates++;
      continue;
    }

    // Check URL duplicate
    if (existingUrls.has(job.job_url)) {
      duplicates++;
      continue;
    }

    // Check company+title duplicate
    const companyTitleKey = `${job.company || ""}|||${job.title || ""}`.toLowerCase();
    if (existingCompanyTitles.has(companyTitleKey)) {
      duplicates++;
      continue;
    }

    // Insert
    const { error } = await supabase.from("job_listings").insert({
      title: job.title,
      company: job.company || "Unknown",
      location: job.location || (job.region === "israel" ? "Israel" : "France"),
      job_url: job.job_url,
      source: job.source, // "linkedin" or "wttj"
      role_type: job.role_type,
      region: job.region,
      status: "new",
      date_posted: job.date_posted || new Date().toISOString(),
    });

    if (error) {
      // Could be a unique constraint violation (race condition)
      if (error.code === "23505") {
        duplicates++;
      } else {
        log(`  ✗ Erreur insert: ${error.message}`);
        errors++;
      }
    } else {
      inserted++;
      existingUrls.add(job.job_url);
      existingCompanyTitles.add(companyTitleKey);
      log(`  ✓ ${job.role_type} · ${job.company} · ${job.source} · ${job.region === "israel" ? "IL" : "FR"}`);
    }
  }

  log(`\n  Résultat: ${inserted} nouvelles, ${duplicates} doublons, ${errors} erreurs`);
  return { inserted, duplicates, errors };
}
