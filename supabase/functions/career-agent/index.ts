import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { robustFetch, robustFetchJSON, rateLimitedBatch } from "../_shared/robust-fetch.ts";
import { getIsraelNow, todayStr, dateStr, weekStart } from "../_shared/timezone.ts";
import { callOpenAI } from "../_shared/openai.ts";
import { sendTG } from "../_shared/telegram.ts";

// Types
interface JobListing {
  id: string;
  title: string;
  company: string;
  location?: string;
  job_url: string;
  status: "new" | "applied" | "interview" | "offer" | "rejected";
  applied_date: string | null;
  notes: string;
  created_at: string;
  cover_letter_snippet?: string;
  last_followed_up?: string | null;
}

interface CareerTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  due_date: string | null;
  category: string;
  notes: string;
}

interface PipelineData {
  new: number;
  applied: number;
  interview: number;
  offer: number;
  rejected: number;
}

interface AgentResponse {
  success: boolean;
  type: string;
  pipeline: PipelineData;
  followups_needed: number;
  timestamp: string;
  message?: string;
  error?: string;
}

// Timezone, OpenAI, Telegram imported from _shared modules above

// Helper: Check if today is Sunday (Israel time)
function isSunday(): boolean {
  return getIsraelNow().getDay() === 0;
}

// Helper: Calculate days remaining until deadline
function daysUntilDeadline(deadlineStr: string | null): { days: number; badge: string } {
  if (!deadlineStr) return { days: -1, badge: "📅" };

  const istDate = getIsraelNow();
  const deadline = new Date(deadlineStr + "T23:59:59");
  const diffMs = deadline.getTime() - istDate.getTime();
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let badge = "📅";
  if (days <= 0) {
    badge = "🔴"; // overdue
  } else if (days <= 30) {
    badge = "🔴"; // critical (less than 30 days)
  } else if (days <= 60) {
    badge = "🟡"; // warning (30-60 days)
  } else {
    badge = "🟢"; // on track (more than 60 days)
  }

  return { days, badge };
}

// Helper: Format date for display
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

// callOpenAI imported from _shared/openai.ts

// Helper: Calculate days since a date
function daysSince(dateString: string | null): number {
  if (!dateString) return 0;
  const istNow = getIsraelNow();
  const jobDate = new Date(dateString);
  const diffMs = istNow.getTime() - jobDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Helper: Generate cover letter snippet for a job
async function generateCoverLetterSnippet(job: ParsedJob): Promise<string> {
  const systemPrompt = `Tu es expert en candidature AE/SDR tech/SaaS. Oren est Account Executive bilingue FR/EN basé en Israël. Génère 2-3 phrases percutantes et personnalisées pour une lettre de motivation pour ce poste. Style: direct, orienté résultats, avec des métriques concrètes.`;
  const userContent = `${job.title} chez ${job.company} (${job.location || "location non spécifiée"})`;

  const snippet = await callOpenAI(systemPrompt, userContent, 200);
  return snippet || "";
}

// sendTG imported from _shared/telegram.ts

// Query: Get application follow-ups needed (applied 3+ days ago)
async function getFollowupsNeeded(supabase: any): Promise<JobListing[]> {
  try {
    const istDate = getIsraelNow();
    const threeDaysAgo = new Date(istDate.getTime() - 3 * 24 * 60 * 60 * 1000);
    const threeDaysAgoStr = threeDaysAgo.toISOString().split("T")[0];

    const { data, error } = await supabase
      .from("job_listings")
      .select("*")
      .eq("status", "applied")
      .lte("applied_date", threeDaysAgoStr);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error fetching followups:", error);
    return [];
  }
}

// Helper: Create followup tasks for jobs applied >5 days ago
async function createFollowupTasks(supabase: any): Promise<number> {
  try {
    const istDate = getIsraelNow();
    const fiveDaysAgo = new Date(istDate.getTime() - 5 * 24 * 60 * 60 * 1000);
    const fiveDaysAgoStr = fiveDaysAgo.toISOString().split("T")[0];
    const today = todayStr();

    // Find all "applied" jobs where applied_date is more than 5 days ago
    // AND (last_followed_up IS NULL OR last_followed_up < 5 days ago)
    const { data: jobsNeedingFollowup, error: jobError } = await supabase
      .from("job_listings")
      .select("id, title, company, applied_date, last_followed_up")
      .eq("status", "applied")
      .lte("applied_date", fiveDaysAgoStr);

    if (jobError) throw jobError;

    let tasksCreated = 0;

    for (const job of jobsNeedingFollowup || []) {
      // Check if we already followed up recently (within 5 days)
      if (job.last_followed_up) {
        const lastFollowupDate = new Date(job.last_followed_up);
        const daysSinceFollowup = Math.floor(
          (istDate.getTime() - lastFollowupDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysSinceFollowup < 5) continue;
      }

      // Check if a task with this linked_entity_id already exists
      const { data: existingTask } = await supabase
        .from("tasks")
        .select("id")
        .eq("linked_entity_id", job.id)
        .eq("linked_entity_type", "job_listing")
        .limit(1);

      if (existingTask && existingTask.length > 0) {
        continue; // Task already exists
      }

      // Create the followup task
      const taskTitle = `Relancer ${job.company} — ${job.title}`;
      const { error: insertError } = await supabase.from("tasks").insert({
        title: taskTitle,
        domain: "career",
        priority: 2, // high priority
        due_date: today,
        linked_entity_id: job.id,
        linked_entity_type: "job_listing",
        status: "pending",
        agent_type: "career",
      });

      if (!insertError) {
        tasksCreated++;

        // Update last_followed_up on the job
        await supabase
          .from("job_listings")
          .update({ last_followed_up: today })
          .eq("id", job.id);
      }
    }

    return tasksCreated;
  } catch (error) {
    console.error("Error creating followup tasks:", error);
    return 0;
  }
}

// Query: Get interview prep jobs
async function getInterviewPrep(supabase: any): Promise<JobListing[]> {
  try {
    const { data, error } = await supabase
      .from("job_listings")
      .select("*")
      .eq("status", "interview");

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error fetching interview prep:", error);
    return [];
  }
}

// Query: Get pipeline summary
async function getPipelineSummary(supabase: any): Promise<PipelineData> {
  try {
    const { data, error } = await supabase
      .from("job_listings")
      .select("status");

    if (error) throw error;

    const pipeline: PipelineData = {
      new: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
    };

    if (data) {
      data.forEach((job: any) => {
        const status = job.status as keyof PipelineData;
        if (status in pipeline) {
          pipeline[status]++;
        }
      });
    }

    return pipeline;
  } catch (error) {
    console.error("Error fetching pipeline summary:", error);
    return { new: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  }
}

// Query: Get overdue/high-priority career tasks
async function getCareerTaskAlerts(supabase: any): Promise<CareerTask[]> {
  try {
    const today = todayStr();
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "done")
      .or(`priority.lte.2,due_date.lt.${today}`);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error fetching career task alerts:", error);
    return [];
  }
}

// Query: Get weekly career report (Sunday only)
async function getWeeklyCareerReport(supabase: any): Promise<any> {
  try {
    const weekStart = weekStart();
    const today = todayStr();

    const { data: applicationsThisWeek, error: appError } = await supabase
      .from("job_listings")
      .select("*")
      .gte("applied_date", weekStart)
      .lte("applied_date", today)
      .eq("status", "applied");

    if (appError) throw appError;

    const { data: interviewsThisWeek, error: intError } = await supabase
      .from("job_listings")
      .select("*")
      .gte("created_at", weekStart)
      .lte("created_at", today)
      .eq("status", "interview");

    if (intError) throw intError;

    const { data: offersThisWeek, error: offError } = await supabase
      .from("job_listings")
      .select("*")
      .gte("created_at", weekStart)
      .lte("created_at", today)
      .eq("status", "offer");

    if (offError) throw offError;

    const applicationsCount = applicationsThisWeek?.length || 0;
    const interviewsCount = interviewsThisWeek?.length || 0;
    const offersCount = offersThisWeek?.length || 0;
    const conversionRate = applicationsCount > 0 ? ((interviewsCount / applicationsCount) * 100).toFixed(1) : "0";

    return {
      week_start: weekStart,
      applications_sent: applicationsCount,
      interviews_scheduled: interviewsCount,
      offers_received: offersCount,
      conversion_rate: `${conversionRate}%`,
    };
  } catch (error) {
    console.error("Error fetching weekly report:", error);
    return null;
  }
}

// Format and send follow-up alerts
async function sendFollowupAlerts(followups: JobListing[]): Promise<boolean> {
  if (followups.length === 0) return true;

  let message = "CAREER — Follow-ups\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n\n";
  message += "Relances a faire:\n\n";
  followups.slice(0, 3).forEach((job: JobListing) => {
    const daysAgo = daysSince(job.applied_date);
    message += `— ${job.company} · ${job.title} · ${daysAgo} jours\n`;
  });

  if (followups.length > 3) {
    message += `\n(+${followups.length - 3} more)`;
  }

  // AI follow-up templates removed — saves ~500 tokens/day, templates are repetitive

  return await sendTG(message);
}

// Format and send interview prep alerts
async function sendInterviewAlerts(interviews: JobListing[]): Promise<boolean> {
  if (interviews.length === 0) return true;

  let message = "CAREER — Interviews\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n\n";
  message += "Preparation Required:\n\n";
  interviews.slice(0, 3).forEach((job: JobListing) => {
    message += `— ${job.company} · ${job.title}\n`;
  });

  // AI prep tips removed — prep tasks are auto-created with specific actions (research, STAR stories, pitch)

  return await sendTG(message);
}

// Format and send pipeline summary
async function sendPipelineSummary(pipeline: PipelineData): Promise<boolean> {
  const message = `CAREER — Pipeline\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `New ${pipeline.new} · Applied ${pipeline.applied} · Interview ${pipeline.interview} · Offer ${pipeline.offer}`;

  return await sendTG(message);
}

// Format and send task alerts
async function sendTaskAlerts(tasks: CareerTask[]): Promise<boolean> {
  if (tasks.length === 0) return true;

  let message = "CAREER — Tasks\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n\n";
  const today = todayStr();

  const overdueTasks = tasks.filter((t) => t.due_date && t.due_date < today);
  const highPriorityTasks = tasks.filter((t) => t.priority === "high" && (!t.due_date || t.due_date >= today));

  if (overdueTasks.length > 0) {
    message += "Overdue:\n";
    overdueTasks.slice(0, 2).forEach((task) => {
      message += `— ${task.title} · ${formatDate(task.due_date!)}\n`;
    });
    message += "\n";
  }

  if (highPriorityTasks.length > 0) {
    message += "High Priority:\n";
    highPriorityTasks.slice(0, 2).forEach((task) => {
      message += `— ${task.title}`;
      if (task.due_date) message += ` · ${formatDate(task.due_date)}`;
      message += "\n";
    });
  }

  return await sendTG(message);
}

// Format and send weekly report
async function sendWeeklyReport(report: any): Promise<boolean> {
  let message = `CAREER — Weekly\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Applications  ${report.applications_sent}\n` +
    `Interviews    ${report.interviews_scheduled}\n` +
    `Offers        ${report.offers_received}\n` +
    `Conversion    ${report.conversion_rate}`;

  // AI weekly strategy removed — evening-review already provides cross-domain AI coaching

  return await sendTG(message);
}

// =============================================
// JSEARCH API JOB SCRAPING (RapidAPI)
// =============================================

const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY") || "";

interface JSearchQuery {
  query: string;
  country: string;
  region: "israel" | "france";
  role_type: "AE" | "SDR" | "BDR" | "other";
}

const JOB_SEARCHES: JSearchQuery[] = [
  // Israel — no country filter (JSearch has poor IL coverage with filter)
  { query: "Account Executive SaaS Tel Aviv", country: "", region: "israel", role_type: "AE" },
  { query: "SDR SaaS Israel", country: "", region: "israel", role_type: "SDR" },
  { query: "Sales Representative SaaS Tel Aviv", country: "", region: "israel", role_type: "SDR" },
  // France
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
      query: search.query,
      page: "1",
      num_pages: "1",
      date_posted: "month",
    });
    if (search.country) {
      params.set("country", search.country);
    }

    const url = `https://jsearch.p.rapidapi.com/search?${params}`;
    const resp = await robustFetch(url, {
      timeoutMs: 12000,
      retries: 2,
      retryDelayMs: 1500,
      init: {
        headers: {
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
        },
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`JSearch failed [${search.query}]: ${resp.status} — ${body.slice(0, 200)}`);
      return { jobs: [], search };
    }

    const json = await resp.json();
    return { jobs: parseJSearchResults(json), search };
  } catch (e) {
    console.error(`JSearch error [${search.query}]:`, e);
    return { jobs: [], search };
  }
}

async function scrapeJobBoards(supabase: any): Promise<{ newJobs: number; details: string[]; errors: string[] }> {
  let totalNew = 0;
  const details: string[] = [];
  const errors: string[] = [];

  if (!RAPIDAPI_KEY) {
    console.error("RAPIDAPI_KEY not set");
    return { newJobs: 0, details: [], errors: ["Config manquante: RAPIDAPI_KEY"] };
  }

  // Rate-limited sequential fetching (300ms between requests to respect API limits)
  const results = await rateLimitedBatch(
    JOB_SEARCHES,
    (s) => fetchOneSearch(s),
    300,
  );

  // Pre-fetch existing URLs for batch duplicate check (avoids N+1 queries)
  const allJobUrls = results.flatMap(r => r.jobs.map(j => j.job_url));
  const existingUrls = new Set<string>();
  if (allJobUrls.length > 0) {
    try {
      // Check in batches of 50 to avoid query limits
      for (let i = 0; i < allJobUrls.length; i += 50) {
        const batch = allJobUrls.slice(i, i + 50);
        const { data: existing } = await supabase
          .from("job_listings")
          .select("job_url")
          .in("job_url", batch);
        if (existing) {
          existing.forEach((e: any) => existingUrls.add(e.job_url));
        }
      }
    } catch (e) {
      console.error("Duplicate check error:", e);
    }
  }

  // Also check by company+title combo to catch reposted jobs with different URLs
  const existingCompanyTitles = new Set<string>();
  try {
    const { data: recentJobs } = await supabase
      .from("job_listings")
      .select("company, title")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (recentJobs) {
      recentJobs.forEach((j: any) => existingCompanyTitles.add(`${j.company}|||${j.title}`.toLowerCase()));
    }
  } catch (_) {}

  let totalScraped = 0;
  for (const { jobs, search } of results) {
    totalScraped += jobs.length;
    for (const job of jobs) {
      // Skip duplicates by URL
      if (existingUrls.has(job.job_url)) continue;

      // Skip duplicates by company+title
      const companyTitleKey = `${job.company}|||${job.title}`.toLowerCase();
      if (existingCompanyTitles.has(companyTitleKey)) continue;

      // Cover letter generated on-demand when user applies (not on scrape — saves OpenAI costs)

      // Insert new job
      const { error } = await supabase.from("job_listings").insert({
        title: job.title,
        company: job.company,
        location: job.location || (search.region === "israel" ? "Israel" : "France"),
        job_url: job.job_url,
        source: "jsearch",
        role_type: search.role_type,
        region: search.region,
        status: "new",
        date_posted: job.date_posted,
        cover_letter_snippet: null,
      });

      if (!error) {
        totalNew++;
        existingUrls.add(job.job_url);
        existingCompanyTitles.add(companyTitleKey);
        if (details.length < 8) {
          details.push(`${search.role_type} · ${job.company} · ${search.region === "israel" ? "IL" : "FR"}`);
        }
      }
    }
  }

  console.log(`[Career] Scraped ${totalScraped} jobs across ${JOB_SEARCHES.length} searches, ${totalNew} new`);
  return { newJobs: totalNew, details, errors };
}

// Main handler
serve(async (req: Request) => {
  try {
    // Verify request is from Supabase (optional - adjust based on your security needs)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing Supabase configuration",
          type: "error",
          pipeline: { new: 0, applied: 0, interview: 0, offer: 0, rejected: 0 },
          followups_needed: 0,
          timestamp: todayStr(),
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // --- Deduplication: skip if already ran today ---
    const todayDate = todayStr();
    try {
      const { data: alreadyRan } = await supabase.from("health_logs")
        .select("id").eq("log_type", "career_agent_run").eq("log_date", todayDate).limit(1);
      if (alreadyRan && alreadyRan.length > 0) {
        console.log(`[Career] Already ran today (${todayDate}), skipping duplicate`);
        return new Response(JSON.stringify({
          success: true, type: "skipped_duplicate", timestamp: todayDate,
        }), { headers: { "Content-Type": "application/json" } });
      }
    } catch (_) {}
    // Mark as ran today
    try {
      await supabase.from("health_logs").insert({
        log_type: "career_agent_run", log_date: todayDate, notes: "dedup marker",
      });
    } catch (_) {}

    const signals = getSignalBus("career");

    // 0. Scrape job boards first
    const scrapeResult = await scrapeJobBoards(supabase);

    // Get pipeline data (after scraping so counts are up to date)
    const pipeline = await getPipelineSummary(supabase);

    // Auto-update career goal metric + sync with career rock
    try {
      const totalApplied = pipeline.applied + pipeline.interview + pipeline.offer;
      const [goalRes, rockRes] = await Promise.all([
        supabase.from("goals").select("id, metric_target")
          .eq("domain", "career").eq("status", "active").limit(1),
        supabase.from("rocks").select("id, title, measurable_target")
          .eq("domain", "career").in("current_status", ["on_track", "off_track"]).limit(1),
      ]);
      if (goalRes.data && goalRes.data.length > 0) {
        await supabase.from("goals").update({ metric_current: totalApplied }).eq("id", goalRes.data[0].id);
      }
      // Sync rock: update progress notes + status based on pipeline
      if (rockRes.data && rockRes.data.length > 0) {
        const rock = rockRes.data[0];
        const hasInterviews = pipeline.interview > 0;
        const newStatus = hasInterviews ? "on_track" : (totalApplied >= 10 ? "on_track" : "off_track");
        await supabase.from("rocks").update({
          progress_notes: `${totalApplied} candidatures, ${pipeline.interview} entretiens, ${pipeline.offer} offres`,
          current_status: newStatus, updated_at: new Date().toISOString(),
        }).eq("id", rock.id);
      }
    } catch (_) {}

    // Auto-create followup tasks for jobs applied >5 days ago (without recent followup)
    const followupTasksCreated = await createFollowupTasks(supabase);

    // --- Inter-Agent Signals ---
    try {
      // Emit skill gaps from job descriptions
      const allDescs = (scrapeResult?.details || []).map((d: any) => (d.toString() || "").toLowerCase()).join(" ");
      const skillKeywords: Record<string, string[]> = {
        "salesforce": ["salesforce", "sfdc", "crm"],
        "hubspot": ["hubspot"],
        "english": ["english", "anglais", "fluent english"],
        "hebrew": ["hebrew", "hébreu", "עברית"],
        "negotiation": ["negotiation", "négociation", "closing"],
        "cold_calling": ["cold call", "prospection", "outbound"],
      };

      for (const [skill, keywords] of Object.entries(skillKeywords)) {
        const count = keywords.filter(kw => allDescs.includes(kw)).length;
        if (count > 0) {
          const pct = Math.round((count / Math.max(scrapeResult?.details?.length || 1, 1)) * 100);
          if (pct >= 20) {
            await signals.emit("skill_gap", `${skill} demandé dans ~${pct}% des offres`, {
              skill, percentage: pct, jobCount: scrapeResult?.newJobs || 0,
            }, { target: "learning", priority: 3, ttlHours: 48 });
          }
        }
      }

      // Check for interviews → signal urgency to learning
      const { data: interviewsList } = await supabase.from("job_listings")
        .select("id, title, company").eq("status", "interview").limit(5);
      if (interviewsList && interviewsList.length > 0) {
        await signals.emit("interview_scheduled", `${interviewsList.length} interview(s) en cours`, {
          count: interviewsList.length,
          companies: interviewsList.map((i: any) => i.company),
        }, { target: "learning", priority: 1, ttlHours: 72 });
      }

      // Rejection pattern analysis
      const { data: recentRejections } = await supabase.from("job_listings")
        .select("company, title").eq("status", "rejected")
        .gte("updated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
      if (recentRejections && recentRejections.length >= 3) {
        await signals.emit("rejection_pattern", `${recentRejections.length} rejets en 14j`, {
          count: recentRejections.length,
          companies: recentRejections.map((r: any) => r.company),
        }, { priority: 2, ttlHours: 48 });
      }
    } catch (sigErr) {
      console.error("[Signals] Career error:", sigErr);
    }

    // Get follow-ups needed
    const followups = await getFollowupsNeeded(supabase);
    const followupsNeeded = followups.length;

    // Get interview prep jobs
    const interviews = await getInterviewPrep(supabase);

    // Get career task alerts
    const taskAlerts = await getCareerTaskAlerts(supabase);

    // Send alerts
    let alertsSent: string[] = [];

    // 1. Send job scan results + pipeline (combined message)
    {
      let msg = `<b>CAREER — Scan</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
      if (scrapeResult.errors && scrapeResult.errors.length > 0) {
        msg += `⚠️ ${scrapeResult.errors.join(", ")}\n`;
      }
      if (scrapeResult.newJobs > 0) {
        msg += `<b>${scrapeResult.newJobs}</b> nouvelles offres\n\n`;
        scrapeResult.details.forEach(d => { msg += `${d}\n`; });
        if (scrapeResult.newJobs > scrapeResult.details.length) {
          msg += `(+${scrapeResult.newJobs - scrapeResult.details.length} autres)\n`;
        }
      } else {
        msg += `Aucune nouvelle offre\n`;
      }
      const totalActive = pipeline.applied + pipeline.interview + pipeline.offer;
      const interviewRate = pipeline.applied > 0 ? Math.round((pipeline.interview / pipeline.applied) * 100) : 0;
      msg += `\n<b>Pipeline</b>  New ${pipeline.new} · Applied ${pipeline.applied} · Interview ${pipeline.interview} · Offer ${pipeline.offer}`;
      msg += `\nConversion → interview: ${interviewRate}%`;
      msg += `\nTotal candidatures actives: ${totalActive}`;

      // Add urgency badge from career goal deadline
      try {
        const { data: careerGoal } = await supabase
          .from("goals")
          .select("deadline")
          .eq("domain", "career")
          .eq("status", "active")
          .limit(1);

        if (careerGoal && careerGoal.length > 0 && careerGoal[0].deadline) {
          const { days, badge } = daysUntilDeadline(careerGoal[0].deadline);
          if (days > 0) {
            msg += `\n\n${badge} <b>DEADLINE</b>: ${days} jours restants`;
          }
        }
      } catch (_) {}

      // AI daily tip removed — morning briefing chief-of-staff already provides daily priorities

      await sendTG(msg);
      alertsSent.push("scan_pipeline");
    }

    // 1b. POSTULE AUJOURD'HUI — Top 3 job recommendations
    try {
      const { data: newJobs } = await supabase.from("job_listings")
        .select("id, title, company, location, role_type, region, date_posted, job_url")
        .eq("status", "new")
        .order("date_posted", { ascending: false })
        .limit(20);

      if (newJobs && newJobs.length > 0) {
        // Score by: freshness, role match (AE > SDR), region preference (Israel > France)
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
        const top3 = scored.slice(0, 3);

        let recMsg = `<b>🎯 POSTULE AUJOURD'HUI</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
        const applyButtons: any[][] = [];
        for (let i = 0; i < top3.length; i++) {
          const job = top3[i];
          const num = ["1️⃣", "2️⃣", "3️⃣"][i];
          const loc = job.location ? ` · ${job.location}` : "";
          recMsg += `${num} <b>${job.title}</b> @ ${job.company}${loc}\n`;
          if (job.job_url) recMsg += `    → ${job.job_url}\n`;
          // Auto-generate cover letter snippet if not already cached
          if (!job.cover_letter_snippet) {
            try {
              const snippet = await generateCoverLetterSnippet(job);
              if (snippet) {
                await supabase.from("job_listings").update({ cover_letter_snippet: snippet }).eq("id", job.id);
                recMsg += `    <i>📝 ${snippet.substring(0, 150)}...</i>\n`;
              }
            } catch (_) {}
          } else {
            recMsg += `    <i>📝 ${job.cover_letter_snippet.substring(0, 150)}...</i>\n`;
          }
          recMsg += `\n`;
          // Add 1-click buttons: Apply + Skip
          applyButtons.push([
            { text: `✅ Postulé ${job.company.substring(0, 12)}`, callback_data: `job_applied_${job.id}` },
            { text: `⏭ Skip`, callback_data: `job_skip_${job.id}` },
            { text: `📝 Lettre`, callback_data: `job_cover_${job.id}` },
          ]);
        }
        recMsg += `<i>${newJobs.length - 3 > 0 ? `+${newJobs.length - 3} autres offres en attente` : "Postule maintenant, chaque candidature compte."}</i>`;

        await sendTG(recMsg, { buttons: applyButtons });
        alertsSent.push("apply_recommendations");
      }
    } catch (e) { console.error("Apply recommendations error:", e); }

    // 2. Send follow-up reminders
    if (followupsNeeded > 0) {
      const sent = await sendFollowupAlerts(followups);
      if (sent) alertsSent.push("follow_up_alerts");
    }

    // 3. Send interview prep reminders + auto-create prep tasks
    if (interviews.length > 0) {
      const sent = await sendInterviewAlerts(interviews);
      if (sent) alertsSent.push("interview_alerts");

      // 3b. Auto-create prep tasks for each interview job
      try {
        for (const job of interviews) {
          // Check if prep tasks already exist for this job
          const { data: existingPrep } = await supabase.from("tasks")
            .select("id").eq("context", `interview_prep_${job.id}`)
            .limit(1);

          if (existingPrep && existingPrep.length > 0) continue;

          const today = todayStr();
          const prepTasks = [
            { title: `🔍 Research ${job.company} — produit, culture, actualité`, priority: 1, duration: 30 },
            { title: `📝 Préparer STAR stories pour ${job.title} @ ${job.company}`, priority: 1, duration: 45 },
            { title: `🗣 Pratiquer pitch en anglais (${job.company})`, priority: 2, duration: 20 },
            { title: `📋 Lister questions pour interviewer (${job.company})`, priority: 2, duration: 15 },
          ];

          for (const task of prepTasks) {
            await supabase.from("tasks").insert({
              title: task.title,
              status: "pending",
              priority: task.priority,
              agent_type: "career",
              due_date: today,
              duration_minutes: task.duration,
              context: `interview_prep_${job.id}`,
              created_at: new Date().toISOString(),
            });
          }

          // Emit signal for learning-agent to prioritize English/interview skills
          try {
            const signals = getSignalBus("career");
            await signals.emit("interview_scheduled", `Interview ${job.title} @ ${job.company}`, {
              jobId: job.id, company: job.company, title: job.title,
              companies: [job.company],
            }, { priority: 1, ttlHours: 72 });
          } catch (_) {}

          alertsSent.push(`interview_prep_${job.company}`);
        }
      } catch (e) { console.error("Interview prep tasks error:", e); }
    }

    // 4. Send task alerts
    if (taskAlerts.length > 0) {
      const sent = await sendTaskAlerts(taskAlerts);
      if (sent) alertsSent.push("task_alerts");
    }

    // 5. Send weekly report on Sunday
    let weeklyReportSent = false;
    if (isSunday()) {
      const weeklyReport = await getWeeklyCareerReport(supabase);
      if (weeklyReport) {
        const sent = await sendWeeklyReport(weeklyReport);
        if (sent) {
          alertsSent.push("weekly_report");
          weeklyReportSent = true;
        }
      }
    }

    const response: AgentResponse = {
      success: true,
      type: "career_agent_daily",
      pipeline,
      followups_needed: followupsNeeded,
      timestamp: todayStr(),
      message: `Career agent completed. Created ${followupTasksCreated} followup task(s). Sent ${alertsSent.length} alerts: ${alertsSent.join(", ")}${weeklyReportSent ? " (including weekly report)" : ""}`,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Career Agent Error:", error);

    const response: AgentResponse = {
      success: false,
      type: "career_agent_error",
      pipeline: { new: 0, applied: 0, interview: 0, offer: 0, rejected: 0 },
      followups_needed: 0,
      timestamp: todayStr(),
      error: error instanceof Error ? error.message : "Unknown error",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
