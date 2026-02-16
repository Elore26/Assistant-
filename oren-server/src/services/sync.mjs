// ============================================
// SYNC TO SUPABASE — Deduplicate & insert jobs
// Same dedup logic as career-agent
// ============================================

import { getSupabase } from "./supabase.mjs";

export async function syncToSupabase(jobs, log = console.log) {
  const supabase = getSupabase();
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  // --- Pre-fetch existing URLs ---
  const allUrls = jobs.map((j) => j.job_url).filter(Boolean);
  const existingUrls = new Set();

  if (allUrls.length > 0) {
    try {
      for (let i = 0; i < allUrls.length; i += 50) {
        const batch = allUrls.slice(i, i + 50);
        const { data } = await supabase
          .from("job_listings")
          .select("job_url")
          .in("job_url", batch);
        if (data) data.forEach((e) => existingUrls.add(e.job_url));
      }
    } catch (e) {
      log(`  ⚠ URL check error: ${e.message}`);
    }
  }

  // --- Pre-fetch existing company+title (30 days) ---
  const existingKeys = new Set();
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("job_listings")
      .select("company, title")
      .gte("created_at", thirtyDaysAgo);
    if (data) data.forEach((j) => existingKeys.add(`${j.company}|||${j.title}`.toLowerCase()));
  } catch (_) {}

  log(`\n📤 SYNC — ${jobs.length} jobs to check`);
  log(`  Existing URLs: ${existingUrls.size} | Existing titles: ${existingKeys.size}`);

  // --- Insert new jobs ---
  const newJobs = [];
  for (const job of jobs) {
    if (!job.job_url) { duplicates++; continue; }
    if (existingUrls.has(job.job_url)) { duplicates++; continue; }
    const key = `${job.company || ""}|||${job.title || ""}`.toLowerCase();
    if (existingKeys.has(key)) { duplicates++; continue; }
    newJobs.push(job);
    existingUrls.add(job.job_url);
    existingKeys.add(key);
  }

  // Batch insert (50 at a time)
  for (let i = 0; i < newJobs.length; i += 50) {
    const batch = newJobs.slice(i, i + 50).map((job) => ({
      title: job.title,
      company: job.company || "Unknown",
      location: job.location || (job.region === "israel" ? "Israel" : "France"),
      job_url: job.job_url,
      source: job.source,
      role_type: job.role_type,
      region: job.region,
      status: "new",
      date_posted: job.date_posted || new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("job_listings")
      .insert(batch)
      .select("id");

    if (error) {
      // If batch fails, fall back to one-by-one
      for (const row of batch) {
        const { error: singleErr } = await supabase.from("job_listings").insert(row);
        if (singleErr) {
          if (singleErr.code === "23505") duplicates++;
          else { log(`  ✗ ${singleErr.message}`); errors++; }
        } else {
          inserted++;
          log(`  ✓ ${row.role_type} · ${row.company} · ${row.source}`);
        }
      }
    } else {
      inserted += batch.length;
      batch.forEach((r) => log(`  ✓ ${r.role_type} · ${r.company} · ${r.source}`));
    }
  }

  log(`\n  Result: ${inserted} new, ${duplicates} duplicates, ${errors} errors`);
  return { inserted, duplicates, errors };
}
