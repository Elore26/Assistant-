// ============================================
// JOB: SCORE NEW JOBS — AI-powered ranking
// Scores unscored jobs based on Oren's profile
// Uses OpenAI gpt-4o-mini for cost efficiency
// ============================================

import { getSupabase } from "../services/supabase.mjs";
import { notifyTelegram } from "../services/telegram-notify.mjs";

// Oren's ideal job profile — used for scoring
const OREN_PROFILE = `
Oren Elkayam — Sales professional targeting SaaS B2B roles
- Target roles: Account Executive (AE), SDR, BDR in SaaS/tech companies
- Preferred locations: Tel Aviv (Israel), Paris (France), Remote
- Languages: French (native), Hebrew (fluent), English (professional)
- Experience: B2B sales, SaaS, startups, tech
- Preferences:
  - Strong preference for Series A-C startups over large corporations
  - SaaS/tech product is a must
  - Commission-based comp structure preferred
  - Growth-stage companies with clear career path
  - International teams are a plus
- Red flags: pure cold-calling agencies, MLM, insurance, non-tech
`;

async function scoreWithAI(jobs) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jobs.map((j) => ({ ...j, score: 50, score_reason: "No API key" }));

  const jobList = jobs.map((j, i) => `[${i}] ${j.title} @ ${j.company} — ${j.location} (${j.source})`).join("\n");

  const prompt = `You are a job relevance scorer. Given the candidate profile and job listings, score each job from 0-100.

CANDIDATE PROFILE:
${OREN_PROFILE}

JOB LISTINGS:
${jobList}

For each job, return a JSON array with objects: { "index": number, "score": number, "reason": "1 short sentence" }
Score guidelines:
- 80-100: Perfect match (SaaS, right role, right location, startup)
- 60-79: Good match (some criteria met)
- 40-59: Partial match (role OK but company/sector unclear)
- 20-39: Weak match (wrong sector or location mismatch)
- 0-19: Not relevant (insurance, MLM, non-tech)

Return ONLY the JSON array, no other text.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "[]";

    // Parse JSON — handle markdown code blocks
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const scores = JSON.parse(jsonStr);

    return jobs.map((job, i) => {
      const s = scores.find((sc) => sc.index === i);
      return {
        ...job,
        score: s?.score ?? 50,
        score_reason: s?.reason ?? "Could not score",
      };
    });
  } catch (e) {
    console.error(`Score AI error: ${e.message}`);
    return jobs.map((j) => ({ ...j, score: 50, score_reason: `AI error: ${e.message}` }));
  }
}

export async function scoreNewJobs(log) {
  const supabase = getSupabase();

  // Fetch unscored jobs (status = "new", no score yet)
  const { data: unscoredJobs, error } = await supabase
    .from("job_listings")
    .select("*")
    .eq("status", "new")
    .is("score", null)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    log(`✗ Fetch error: ${error.message}`);
    return { scored: 0 };
  }

  if (!unscoredJobs || unscoredJobs.length === 0) {
    log("No unscored jobs found");
    return { scored: 0 };
  }

  log(`📊 Scoring ${unscoredJobs.length} new jobs...`);

  // Score in batches of 15 (fits in one API call)
  let scored = 0;
  const topJobs = [];

  for (let i = 0; i < unscoredJobs.length; i += 15) {
    const batch = unscoredJobs.slice(i, i + 15);
    const scoredBatch = await scoreWithAI(batch);

    for (const job of scoredBatch) {
      const { error: updateErr } = await supabase
        .from("job_listings")
        .update({
          score: job.score,
          score_reason: job.score_reason,
        })
        .eq("id", job.id);

      if (updateErr) {
        log(`  ✗ Update ${job.id}: ${updateErr.message}`);
      } else {
        scored++;
        const emoji = job.score >= 80 ? "🔥" : job.score >= 60 ? "👍" : "➖";
        log(`  ${emoji} ${job.score}/100 — ${job.title} @ ${job.company} — ${job.score_reason}`);
        if (job.score >= 75) topJobs.push(job);
      }
    }
  }

  // Notify Oren about top matches
  if (topJobs.length > 0) {
    const msg = [
      `🎯 *${topJobs.length} offre(s) top trouvée(s)!*\n`,
      ...topJobs.map(
        (j) => `*${j.score}/100* — ${j.title}\n${j.company} · ${j.location}\n${j.score_reason}\n🔗 ${j.job_url}`
      ),
    ].join("\n\n");
    await notifyTelegram(msg).catch(() => {});
  }

  log(`\n✅ Scored: ${scored} | Top matches (≥75): ${topJobs.length}`);
  return { scored, topMatches: topJobs.length };
}
