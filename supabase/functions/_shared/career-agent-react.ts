// ============================================
// OREN AGENT SYSTEM — Career Agent (ReAct)
// Agentic version: reasons about career strategy
// instead of following hardcoded if/else rules
// ============================================
//
// MIGRATION NOTES:
// - Original career-agent.ts used hardcoded rules for each decision
// - This version uses ReAct loop: the LLM decides what data to gather
//   and what actions to take based on reasoning
// - Job scraping remains deterministic (API calls)
// - Signal emission, follow-ups, strategy are now agent-driven
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runReActAgent, type AgentConfig, type AgentResult } from "./react-agent.ts";
import { registry } from "./tool-registry.ts";
import { getGuardrails } from "./agent-guardrails.ts";
import { getSignalBus } from "./agent-signals.ts";
import { robustFetch, rateLimitedBatch } from "./robust-fetch.ts";
import { callOpenAI } from "./openai.ts";
import { sendTG, escHTML } from "./telegram.ts";
import { getIsraelNow, todayStr, weekStart } from "./timezone.ts";

// ─── Career-Specific Tools ───────────────────────────────────────────
// These are registered in addition to the shared tools from tool-registry

registry.register(
  {
    name: "scrape_job_boards",
    description: "Scrape job boards (JSearch API) for new SaaS/tech positions in Israel and France. Returns new jobs found.",
    category: "external",
    tier: "auto",
    allowedAgents: ["career"],
    parameters: [],
  },
  async (_args, ctx) => {
    const result = await scrapeJobBoards(ctx.supabase);
    return { success: true, data: result };
  }
);

registry.register(
  {
    name: "get_pipeline_summary",
    description: "Get the current career pipeline: counts by status (new, applied, interview, offer, rejected).",
    category: "data",
    tier: "auto",
    allowedAgents: ["career", "morning-briefing", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { data, error } = await ctx.supabase.from("job_listings").select("status");
    if (error) return { success: false, error: error.message };
    const pipeline = { new: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
    (data || []).forEach((j: any) => {
      if (j.status in pipeline) pipeline[j.status as keyof typeof pipeline]++;
    });
    const totalActive = pipeline.applied + pipeline.interview + pipeline.offer;
    const interviewRate = pipeline.applied > 0 ? Math.round((pipeline.interview / pipeline.applied) * 100) : 0;
    return { success: true, data: { ...pipeline, totalActive, interviewRate } };
  }
);

registry.register(
  {
    name: "get_followups_needed",
    description: "Find jobs that were applied to 3+ days ago and need follow-up. Returns list of jobs needing relance.",
    category: "data",
    tier: "auto",
    allowedAgents: ["career"],
    parameters: [],
  },
  async (_args, ctx) => {
    const istDate = getIsraelNow();
    const threeDaysAgo = new Date(istDate.getTime() - 3 * 86400000).toISOString().split("T")[0];
    const { data, error } = await ctx.supabase.from("job_listings")
      .select("id, title, company, applied_date, last_followed_up")
      .eq("status", "applied")
      .lte("applied_date", threeDaysAgo);
    if (error) return { success: false, error: error.message };
    return { success: true, data: data || [] };
  }
);

registry.register(
  {
    name: "create_followup_tasks",
    description: "Auto-create follow-up tasks for jobs applied 5+ days ago that haven't been followed up recently.",
    category: "action",
    tier: "auto",
    allowedAgents: ["career"],
    parameters: [],
  },
  async (_args, ctx) => {
    const result = await createFollowupTasks(ctx.supabase);
    return { success: true, data: { tasksCreated: result } };
  }
);

registry.register(
  {
    name: "get_top_jobs_to_apply",
    description: "Get the top 3 recommended jobs to apply to today, scored by freshness, role match, and region preference.",
    category: "data",
    tier: "auto",
    allowedAgents: ["career"],
    parameters: [
      { name: "limit", type: "number", description: "Number of jobs (default 3)", required: false },
    ],
  },
  async (args, ctx) => {
    const limit = args.limit || 3;
    const { data: newJobs } = await ctx.supabase.from("job_listings")
      .select("id, title, company, location, role_type, region, date_posted, job_url, cover_letter_snippet")
      .eq("status", "new")
      .order("date_posted", { ascending: false })
      .limit(20);

    if (!newJobs || newJobs.length === 0) return { success: true, data: { jobs: [], totalNew: 0 } };

    // Score jobs
    const scored = newJobs.map((job: any) => {
      let score = 0;
      const daysOld = Math.floor((Date.now() - new Date(job.date_posted || Date.now()).getTime()) / 86400000);
      score += Math.max(0, 10 - daysOld);
      if (/account.executive|ae\b/i.test(job.role_type || job.title)) score += 5;
      else if (/sdr|sales.dev/i.test(job.role_type || job.title)) score += 3;
      if (job.region === "israel" || /israel|tel.?aviv/i.test(job.location || "")) score += 3;
      return { ...job, _score: score };
    });
    scored.sort((a: any, b: any) => b._score - a._score);

    return { success: true, data: { jobs: scored.slice(0, limit), totalNew: newJobs.length } };
  }
);

registry.register(
  {
    name: "generate_cover_letter",
    description: "Generate a cover letter snippet for a specific job using AI.",
    category: "analysis",
    tier: "auto",
    allowedAgents: ["career", "telegram-bot"],
    parameters: [
      { name: "job_title", type: "string", description: "Job title", required: true },
      { name: "company", type: "string", description: "Company name", required: true },
      { name: "location", type: "string", description: "Job location", required: false },
      { name: "job_id", type: "string", description: "Job ID to cache the snippet", required: false },
    ],
  },
  async (args, ctx) => {
    const snippet = await callOpenAI(
      `Tu es expert en candidature AE/SDR tech/SaaS. Oren est Account Executive bilingue FR/EN basé en Israël. Génère 2-3 phrases percutantes et personnalisées pour une lettre de motivation. Style: direct, orienté résultats, avec des métriques concrètes.`,
      `${args.job_title} chez ${args.company} (${args.location || "location non spécifiée"})`,
      200
    );
    if (!snippet) return { success: false, error: "AI returned empty" };
    // Cache if job_id provided
    if (args.job_id) {
      await ctx.supabase.from("job_listings")
        .update({ cover_letter_snippet: snippet })
        .eq("id", args.job_id);
    }
    return { success: true, data: { snippet } };
  }
);

registry.register(
  {
    name: "get_weekly_career_report",
    description: "Get weekly career metrics: applications sent, interviews scheduled, offers, conversion rate.",
    category: "data",
    tier: "auto",
    allowedAgents: ["career", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const ws = weekStart();
    const today = todayStr();
    const [apps, interviews, offers] = await Promise.all([
      ctx.supabase.from("job_listings").select("*").gte("applied_date", ws).lte("applied_date", today).eq("status", "applied"),
      ctx.supabase.from("job_listings").select("*").gte("created_at", ws).eq("status", "interview"),
      ctx.supabase.from("job_listings").select("*").gte("created_at", ws).eq("status", "offer"),
    ]);
    const appsCount = apps.data?.length || 0;
    const intCount = interviews.data?.length || 0;
    const offCount = offers.data?.length || 0;
    const rate = appsCount > 0 ? Math.round((intCount / appsCount) * 100) : 0;
    return {
      success: true,
      data: {
        week_start: ws,
        applications_sent: appsCount,
        interviews_scheduled: intCount,
        offers_received: offCount,
        conversion_rate: `${rate}%`,
      }
    };
  }
);

// ─── Deterministic functions (kept from original) ─────────────────────

const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY") || "";

interface JSearchQuery {
  query: string;
  country: string;
  region: "israel" | "france";
  role_type: "AE" | "SDR" | "BDR" | "other";
}

const JOB_SEARCHES: JSearchQuery[] = [
  { query: "Account Executive SaaS Tel Aviv", country: "", region: "israel", role_type: "AE" },
  { query: "SDR SaaS Israel", country: "", region: "israel", role_type: "SDR" },
  { query: "Sales Representative SaaS Tel Aviv", country: "", region: "israel", role_type: "SDR" },
  { query: "Account Executive SaaS Paris", country: "", region: "france", role_type: "AE" },
  { query: "SDR SaaS Paris France", country: "", region: "france", role_type: "SDR" },
  { query: "Business Development Representative SaaS France", country: "", region: "france", role_type: "BDR" },
];

interface ParsedJob {
  title: string;
  company: string;
  location: string;
  job_url: string;
  date_posted: string;
}

function parseJSearchResults(json: any): ParsedJob[] {
  const items: ParsedJob[] = [];
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

async function fetchOneSearch(search: JSearchQuery): Promise<{ jobs: ParsedJob[]; search: JSearchQuery }> {
  try {
    const params = new URLSearchParams({
      query: search.query, page: "1", num_pages: "1", date_posted: "month",
    });
    if (search.country) params.set("country", search.country);
    const url = `https://jsearch.p.rapidapi.com/search?${params}`;
    const resp = await robustFetch(url, {
      timeoutMs: 12000, retries: 2, retryDelayMs: 1500,
      init: { headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" } },
    });
    if (!resp.ok) return { jobs: [], search };
    const json = await resp.json();
    return { jobs: parseJSearchResults(json), search };
  } catch { return { jobs: [], search }; }
}

async function scrapeJobBoards(supabase: any): Promise<{ newJobs: number; details: string[]; errors: string[] }> {
  let totalNew = 0;
  const details: string[] = [];
  const errors: string[] = [];
  if (!RAPIDAPI_KEY) return { newJobs: 0, details: [], errors: ["Config manquante: RAPIDAPI_KEY"] };

  const results = await rateLimitedBatch(JOB_SEARCHES, (s) => fetchOneSearch(s), 300);

  const allJobUrls = results.flatMap(r => r.jobs.map(j => j.job_url));
  const existingUrls = new Set<string>();
  if (allJobUrls.length > 0) {
    for (let i = 0; i < allJobUrls.length; i += 50) {
      const batch = allJobUrls.slice(i, i + 50);
      const { data: existing } = await supabase.from("job_listings").select("job_url").in("job_url", batch);
      if (existing) existing.forEach((e: any) => existingUrls.add(e.job_url));
    }
  }

  const existingCompanyTitles = new Set<string>();
  try {
    const { data: recentJobs } = await supabase.from("job_listings")
      .select("company, title").gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    if (recentJobs) recentJobs.forEach((j: any) => existingCompanyTitles.add(`${j.company}|||${j.title}`.toLowerCase()));
  } catch {}

  for (const { jobs, search } of results) {
    for (const job of jobs) {
      if (existingUrls.has(job.job_url)) continue;
      const key = `${job.company}|||${job.title}`.toLowerCase();
      if (existingCompanyTitles.has(key)) continue;
      const { error } = await supabase.from("job_listings").insert({
        title: job.title, company: job.company,
        location: job.location || (search.region === "israel" ? "Israel" : "France"),
        job_url: job.job_url, source: "jsearch", role_type: search.role_type,
        region: search.region, status: "new", date_posted: job.date_posted,
      });
      if (!error) {
        totalNew++;
        existingUrls.add(job.job_url);
        existingCompanyTitles.add(key);
        if (details.length < 8) details.push(`${search.role_type} · ${job.company} · ${search.region === "israel" ? "IL" : "FR"}`);
      }
    }
  }
  return { newJobs: totalNew, details, errors };
}

async function createFollowupTasks(supabase: any): Promise<number> {
  const istDate = getIsraelNow();
  const fiveDaysAgo = new Date(istDate.getTime() - 5 * 86400000).toISOString().split("T")[0];
  const today = todayStr();

  const { data: jobsNeedingFollowup } = await supabase.from("job_listings")
    .select("id, title, company, applied_date, last_followed_up")
    .eq("status", "applied").lte("applied_date", fiveDaysAgo);

  let created = 0;
  for (const job of jobsNeedingFollowup || []) {
    if (job.last_followed_up) {
      const daysSince = Math.floor((istDate.getTime() - new Date(job.last_followed_up).getTime()) / 86400000);
      if (daysSince < 5) continue;
    }
    const { data: existing } = await supabase.from("tasks")
      .select("id").eq("linked_entity_id", job.id).eq("linked_entity_type", "job_listing").limit(1);
    if (existing?.length) continue;

    const { error } = await supabase.from("tasks").insert({
      title: `Relancer ${job.company} — ${job.title}`,
      domain: "career", priority: 2, due_date: today,
      linked_entity_id: job.id, linked_entity_type: "job_listing",
      status: "pending", agent_type: "career",
    });
    if (!error) {
      created++;
      await supabase.from("job_listings").update({ last_followed_up: today }).eq("id", job.id);
    }
  }
  return created;
}

// ─── Main Handler: ReAct Career Agent ─────────────────────────────────

export async function runCareerAgent(): Promise<AgentResult> {
  const guardrails = getGuardrails();

  // Pre-flight check
  const canRun = await guardrails.canRun("career");
  if (!canRun.allowed) {
    return {
      success: false,
      output: `Career agent blocked: ${canRun.reason}`,
      trace: [],
      totalToolCalls: 0,
      totalLoops: 0,
      durationMs: 0,
      stoppedByGuardrail: true,
      guardrailReason: canRun.reason,
    };
  }

  const isSunday = getIsraelNow().getDay() === 0;

  const agentConfig: AgentConfig = {
    name: "career",
    role: `Tu es l'agent carrière d'Oren — un Account Executive / SDR bilingue FR/EN basé en Israël, cherchant un poste SaaS/tech (salaire cible: 25k₪+).

Tu es STRATÉGIQUE, pas juste un bot de notifications. Tu analyses les données, identifies des patterns, et prends des décisions intelligentes.

Ton style:
- Direct et orienté action
- Tu donnes des conseils SPÉCIFIQUES (pas de généralités)
- Tu identifies les problèmes avant qu'ils ne deviennent critiques
- Tu émets des signaux aux autres agents quand tu détectes quelque chose d'important`,

    goal: `Exécuter le cycle quotidien de l'agent carrière:

1. SCRAPE: Lance le scraping des job boards pour trouver de nouvelles offres
2. ANALYZE: Récupère le pipeline actuel et analyse la situation
3. FOLLOWUPS: Identifie les relances nécessaires et crée les tâches
4. RECOMMEND: Identifie les top jobs pour postuler aujourd'hui
5. STRATEGY: Analyse les patterns (rejections, conversions) et adapte la stratégie
6. SIGNAL: Émet les signaux pertinents aux autres agents (skill_gap → learning, interview_scheduled → morning)
7. REPORT: Envoie un résumé Telegram avec les actions prioritaires${isSunday ? "\n8. WEEKLY: C'est dimanche — génère aussi le rapport hebdomadaire" : ""}

IMPORTANT: N'envoie PAS de message Telegram à chaque étape. Accumule les informations et envoie UN seul rapport final structuré.`,

    context: `Date: ${todayStr()} (${["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][getIsraelNow().getDay()]})
Heure: ${getIsraelNow().toTimeString().slice(0, 5)} IST
${isSunday ? "C'est dimanche → rapport hebdomadaire en plus" : ""}`,

    maxLoops: 6,
    maxToolCalls: 20,
    maxTokensPerLoop: 1000,
    model: "gpt-4o-mini",
    temperature: 0.3,

    onBeforeToolCall: async (tool, args) => {
      const check = guardrails.canUseTool(tool);
      if (!check.allowed) {
        console.warn(`[Career] Tool blocked: ${tool}`);
        return false;
      }
      // For gated tools (send_telegram), auto-approve within career agent context
      // In production, this could route to a Telegram approval button
      return true;
    },

    onLoopComplete: async (loop) => {
      console.log(
        `[Career] Loop ${loop.loopNumber}: ` +
        `${loop.toolCalls.length} tools (${loop.toolCalls.map(t => t.tool).join(", ")})`
      );
    },
  };

  const result = await runReActAgent(agentConfig);

  // Record usage in guardrails
  const estimatedTokens = result.totalLoops * 2000; // rough estimate
  await guardrails.recordUsage("career", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

  return result;
}

// ─── HTTP Handler (Edge Function) ─────────────────────────────────────

serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ success: false, error: "Missing config" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Dedup check
    const todayDate = todayStr();
    const { data: alreadyRan } = await supabase.from("health_logs")
      .select("id").eq("log_type", "career_agent_run").eq("log_date", todayDate).limit(1);
    if (alreadyRan?.length) {
      return new Response(JSON.stringify({ success: true, type: "skipped_duplicate" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    await supabase.from("health_logs").insert({ log_type: "career_agent_run", log_date: todayDate, notes: "react-v2" });

    // Run the ReAct agent
    const result = await runCareerAgent();

    // If the agent generated output, send it via Telegram
    if (result.output && result.success) {
      const report = formatAgentReport(result);
      await sendTG(report);
    }

    return new Response(JSON.stringify({
      success: result.success,
      type: "career_agent_react",
      output: result.output?.slice(0, 500),
      loops: result.totalLoops,
      toolCalls: result.totalToolCalls,
      durationMs: result.durationMs,
      timestamp: todayDate,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Career Agent Error:", error);
    return new Response(JSON.stringify({
      success: false, error: error instanceof Error ? error.message : "Unknown error",
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// ─── Report Formatter ─────────────────────────────────────────────────

function formatAgentReport(result: AgentResult): string {
  let report = `<b>🤖 CAREER AGENT — ReAct</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Agent's conclusion
  report += escHTML(result.output.slice(0, 3000));

  // Execution metadata
  report += `\n\n<i>⚡ ${result.totalLoops} loops · ${result.totalToolCalls} tools · ${Math.round(result.durationMs / 1000)}s</i>`;

  if (result.stoppedByGuardrail) {
    report += `\n⚠️ ${escHTML(result.guardrailReason || "Guardrail triggered")}`;
  }

  return report;
}
