// ============================================
// OREN AGENT SYSTEM — Shared Scorecard Module
// EOS-inspired: 10 key metrics on 1 page
// Reused by weekly-planning + telegram-bot /scorecard
// ============================================

import { escHTML } from "./telegram.ts";

export interface ScorecardMetric {
  emoji: string;
  label: string;
  actual: number | string;
  goal: number | string;
  status: "green" | "yellow" | "red";
}

export interface ScorecardData {
  weekStart: string;
  weekEnd: string;
  metrics: ScorecardMetric[];
}

function statusIcon(s: "green" | "yellow" | "red"): string {
  return s === "green" ? "🟢" : s === "yellow" ? "🟡" : "🔴";
}

function evalStatus(actual: number, goal: number, direction: "up" | "down" = "up"): "green" | "yellow" | "red" {
  if (direction === "down") {
    // Lower is better (expenses, weight)
    if (actual <= goal) return "green";
    if (actual <= goal * 1.2) return "yellow";
    return "red";
  }
  // Higher is better
  if (actual >= goal) return "green";
  if (actual >= goal * 0.7) return "yellow";
  return "red";
}

/**
 * Build the OREN Scorecard from Supabase data.
 * Fetches all metrics and returns structured data.
 */
export async function buildScorecard(
  supabase: any,
  weekStart: string,
  weekEnd: string,
): Promise<ScorecardData> {
  // Fetch all data in parallel
  const [
    jobAppsRes, jobInterviewsRes,
    leadsRes, leadsConvertedRes,
    tasksRes, tasksDoneRes,
    workoutsRes, studyRes,
    financeExpRes, financeIncRes,
    healthWeightRes, scoreBriefingsRes,
  ] = await Promise.all([
    // Career: applications this week
    supabase.from("job_listings").select("id")
      .eq("status", "applied").gte("applied_date", weekStart).lte("applied_date", weekEnd),
    // Career: interviews
    supabase.from("job_listings").select("id")
      .eq("status", "interview"),
    // HiGrow: leads contacted
    supabase.from("leads").select("id")
      .gte("last_contact_date", weekStart + "T00:00:00").lte("last_contact_date", weekEnd + "T23:59:59"),
    // HiGrow: converted clients
    supabase.from("leads").select("id")
      .eq("status", "converted"),
    // Tasks: all this week
    supabase.from("tasks").select("id, status")
      .gte("due_date", weekStart).lte("due_date", weekEnd),
    // Tasks: completed this week
    supabase.from("tasks").select("id")
      .eq("status", "completed").gte("updated_at", weekStart + "T00:00:00"),
    // Health: workouts
    supabase.from("health_logs").select("id")
      .eq("log_type", "workout").gte("log_date", weekStart).lte("log_date", weekEnd),
    // Learning: study sessions
    supabase.from("study_sessions").select("duration_minutes")
      .gte("session_date", weekStart).lte("session_date", weekEnd),
    // Finance: expenses
    supabase.from("finance_logs").select("amount")
      .eq("transaction_type", "expense").gte("transaction_date", weekStart).lte("transaction_date", weekEnd),
    // Finance: income
    supabase.from("finance_logs").select("amount")
      .eq("transaction_type", "income").gte("transaction_date", weekStart).lte("transaction_date", weekEnd),
    // Health: latest weight
    supabase.from("health_logs").select("value")
      .eq("log_type", "weight").order("log_date", { ascending: false }).limit(1),
    // Briefings: evening scores
    supabase.from("briefings").select("content")
      .eq("briefing_type", "evening").gte("briefing_date", weekStart).lte("briefing_date", weekEnd),
  ]);

  const jobApps = jobAppsRes.data?.length || 0;
  const jobInterviews = jobInterviewsRes.data?.length || 0;
  const leadsContacted = leadsRes.data?.length || 0;
  const leadsConverted = leadsConvertedRes.data?.length || 0;
  const allTasks = tasksRes.data || [];
  const tasksDone = tasksDoneRes.data?.length || 0;
  const totalTasks = allTasks.length || 1;
  const completionRate = Math.round((tasksDone / totalTasks) * 100);
  const workoutDays = new Set((workoutsRes.data || []).map((w: any) => w.log_date)).size;
  const studyHours = ((studyRes.data || []).reduce((s: number, l: any) => s + (l.duration_minutes || 0), 0) / 60);
  const totalExpenses = (financeExpRes.data || []).reduce((s: number, f: any) => s + Number(f.amount), 0);
  const totalIncome = (financeIncRes.data || []).reduce((s: number, f: any) => s + Number(f.amount), 0);
  const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0;
  const latestWeight = healthWeightRes.data?.[0]?.value ? Number(healthWeightRes.data[0].value) : null;

  // Calculate avg daily score from evening briefings
  const briefings = scoreBriefingsRes.data || [];
  let avgScore = 0;
  if (briefings.length > 0) {
    // Try to extract score from content (pattern: "Score: X/12" or "Score: X/Y")
    let totalScore = 0;
    let count = 0;
    for (const b of briefings) {
      const match = (b.content || "").match(/Score[:\s]+(\d+)\/(\d+)/);
      if (match) {
        totalScore += Number(match[1]);
        count++;
      }
    }
    avgScore = count > 0 ? Math.round((totalScore / count) * 10) / 10 : 0;
  }

  const metrics: ScorecardMetric[] = [
    { emoji: "💼", label: "Candidatures", actual: jobApps, goal: 5, status: evalStatus(jobApps, 5) },
    { emoji: "💼", label: "Interviews", actual: jobInterviews, goal: 1, status: evalStatus(jobInterviews, 1) },
    { emoji: "🚀", label: "Leads contactés", actual: leadsContacted, goal: 10, status: evalStatus(leadsContacted, 10) },
    { emoji: "🚀", label: "Clients convertis", actual: leadsConverted, goal: 2, status: evalStatus(leadsConverted, 2) },
    { emoji: "📋", label: "Taux complétion", actual: `${completionRate}%`, goal: "80%", status: evalStatus(completionRate, 80) },
    { emoji: "🏋️", label: "Workouts", actual: workoutDays, goal: 5, status: evalStatus(workoutDays, 5) },
    { emoji: "📚", label: "Heures étude", actual: `${studyHours.toFixed(1)}h`, goal: "5h", status: evalStatus(studyHours, 5) },
    { emoji: "💰", label: "Épargne", actual: `${savingsRate}%`, goal: "20%", status: evalStatus(savingsRate, 20) },
    { emoji: "⚖️", label: "Poids", actual: latestWeight !== null ? `${latestWeight}` : "?", goal: "70", status: latestWeight !== null ? evalStatus(latestWeight, 70, "down") : "yellow" },
    { emoji: "🔥", label: "Score moyen", actual: avgScore > 0 ? avgScore : "?", goal: 8, status: typeof avgScore === "number" && avgScore > 0 ? evalStatus(avgScore, 8) : "yellow" },
  ];

  return { weekStart, weekEnd, metrics };
}

/**
 * Format scorecard as Telegram HTML message
 */
export function formatScorecardHTML(data: ScorecardData): string {
  let msg = `<b>📊 SCORECARD</b> — Semaine du ${data.weekStart.substring(5)} au ${data.weekEnd.substring(5)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `                    Actual  Goal  Status\n`;

  for (const m of data.metrics) {
    const actual = String(m.actual).padEnd(6);
    const goal = String(m.goal).padEnd(6);
    msg += `${m.emoji} ${escHTML(m.label.padEnd(16))} ${actual} ${goal} ${statusIcon(m.status)}\n`;
  }

  // Summary line
  const greens = data.metrics.filter(m => m.status === "green").length;
  const reds = data.metrics.filter(m => m.status === "red").length;
  msg += `\n${greens}/10 on track · ${reds} off track`;

  return msg;
}
