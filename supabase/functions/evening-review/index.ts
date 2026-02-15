// ============================================
// OREN AGENT SYSTEM — Evening Review V2
// Bilan quotidien complet avec tendances, prédictions, streaks
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";

// --- Israel timezone ---
function getIsraelDate(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}
function getIsraelDateStr(): string {
  const d = getIsraelDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  const d = new Date(getIsraelDate().getTime() - n * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAYS_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

const DOMAIN_EMOJIS: Record<string, string> = {
  career: "💼", finance: "💰", health: "🏋️", higrow: "🚀",
  trading: "📈", learning: "📚", personal: "🏠",
};

const TOMORROW_SCHEDULE: Record<number, string> = {
  0: "Dimanche — Journée longue (09:30-19:30) · Legs 06:30",
  1: "Lundi — Journée courte (09:30-15:30) · Push 17:00",
  2: "Mardi — Journée courte (09:30-15:30) · Pull 17:00",
  3: "Mercredi — Journée courte (09:30-15:30) · Legs 17:00",
  4: "Jeudi — Journée tardive (12:00-19:30) · Cardio 07:00",
  5: "Vendredi — Variable · Push 09:00",
  6: "Samedi — OFF · Repos actif",
};

// --- OpenAI ---
async function callOpenAI(systemPrompt: string, userContent: string, maxTokens = 600): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return "";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0.7, max_tokens: maxTokens,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) { console.error("OpenAI error:", e); return ""; }
}

// --- Telegram ---
async function sendTelegram(text: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  let r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (r.ok) return true;
  // Fallback plain text
  r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.replace(/<[^>]*>/g, "") }),
  });
  return r.ok;
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Progress bar visual ---
function progressBar(current: number, target: number, width = 10, start?: number, direction?: string): string {
  let ratio: number;
  if (direction === 'decrease' && start !== undefined && start > target) {
    ratio = Math.max(0, Math.min(1, (start - current) / (start - target)));
  } else {
    ratio = Math.min(current / Math.max(target, 1), 1);
  }
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty) + ` ${Math.round(ratio * 100)}%`;
}

// --- Trend arrow ---
function trend(today: number, weekAvg: number): string {
  if (today > weekAvg * 1.1) return "↑";
  if (today < weekAvg * 0.9) return "↓";
  return "→";
}

// ============================================
// MAIN HANDLER
// ============================================
serve(async (_req: Request) => {
  try {
    const signals = getSignalBus("evening-review");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelDate();
    const day = now.getDay();
    const todayStr = getIsraelDateStr();
    const dayName = DAYS_FR[day];
    const weekAgoStr = daysAgo(7);

    // Saturday: skip
    if (day === 6) {
      return new Response(JSON.stringify({ success: true, type: "off" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    const LINE = "━━━━━━━━━━━━━━━━━━━━";

    // ============================================
    // FETCH ALL DATA (today + 7 days for trends)
    // ============================================
    const [
      todayCompletedRes, allPendingRes, financeRes, finance7dRes,
      healthRes, health7dRes, learningRes, learning7dRes,
      signalsRes, leadsRes, leads7dRes, goalsRes,
      weekTasksRes
    ] = await Promise.all([
      // Today's completed tasks
      supabase.from("tasks").select("title, status, updated_at, agent_type")
        .eq("status", "completed").gte("updated_at", todayStr + "T00:00:00"),
      // Pending tasks
      supabase.from("tasks").select("id, title, priority, due_date, agent_type")
        .in("status", ["pending", "in_progress"]).order("priority"),
      // Today's finance
      supabase.from("finance_logs").select("transaction_type, amount, category")
        .eq("transaction_date", todayStr),
      // 7-day finance
      supabase.from("finance_logs").select("transaction_type, amount, transaction_date")
        .gte("transaction_date", weekAgoStr).lte("transaction_date", todayStr),
      // Today's health
      supabase.from("health_logs").select("log_type, workout_type, duration_minutes, value")
        .eq("log_date", todayStr),
      // 7-day health (workouts + weight)
      supabase.from("health_logs").select("log_type, workout_type, duration_minutes, value, log_date")
        .gte("log_date", weekAgoStr).lte("log_date", todayStr),
      // Today's learning
      supabase.from("study_sessions").select("topic, duration_minutes")
        .eq("session_date", todayStr),
      // 7-day learning
      supabase.from("study_sessions").select("duration_minutes, session_date")
        .gte("session_date", weekAgoStr).lte("session_date", todayStr),
      // Active signals
      supabase.from("trading_signals").select("symbol, signal_type, confidence, notes")
        .eq("status", "active"),
      // Today's leads contacted
      supabase.from("leads").select("name, status")
        .gte("last_contact_date", todayStr + "T00:00:00").lte("last_contact_date", todayStr + "T23:59:59"),
      // 7-day leads
      supabase.from("leads").select("name, status, last_contact_date")
        .gte("last_contact_date", weekAgoStr + "T00:00:00"),
      // Goals
      supabase.from("goals").select("domain, title, metric_current, metric_target, metric_unit, metric_start, direction, deadline, daily_actions, priority")
        .eq("status", "active").order("priority"),
      // 7-day completed tasks for streak
      supabase.from("tasks").select("status, updated_at")
        .eq("status", "completed").gte("updated_at", weekAgoStr + "T00:00:00"),
    ]);

    // Extract data
    const completedTasks = todayCompletedRes.data || [];
    const pendingTasks = allPendingRes.data || [];
    const financeLogs = financeRes.data || [];
    const finance7d = finance7dRes.data || [];
    const healthLogs = healthRes.data || [];
    const health7d = health7dRes.data || [];
    const learningLogs = learningRes.data || [];
    const learning7d = learning7dRes.data || [];
    const activeSignals = signalsRes.data || [];
    const contactedLeads = leadsRes.data || [];
    const leads7d = leads7dRes.data || [];
    const goals = goalsRes.data || [];
    const weekTasks = weekTasksRes.data || [];

    // ============================================
    // COMPUTE METRICS + 7-DAY TRENDS
    // ============================================

    // --- Tasks (filter out system/agent tasks for honest scoring) ---
    const SYSTEM_PREFIXES = ["TRADING_CONFIG:", "SYSTEM:", "AGENT:", "CONFIG:"];
    const isHumanTask = (t: any) => {
      const title = t.title || "";
      if (SYSTEM_PREFIXES.some(p => title.startsWith(p))) return false;
      if (title.startsWith("📝 [") && completedTasks.some((o: any) => o !== t && title.includes(o.title?.substring(0, 20)))) return false;
      return true;
    };
    const humanCompleted = completedTasks.filter(isHumanTask);
    const humanPending = pendingTasks.filter(isHumanTask);
    const humanWeekTasks = weekTasks.filter(isHumanTask);
    const tasksDoneToday = humanCompleted.length;
    const tasksPending = humanPending.length;
    const tasksWeekAvg = humanWeekTasks.length / 7;

    // --- Finance ---
    const expenses = financeLogs.filter((f: any) => f.transaction_type === "expense");
    const incomes = financeLogs.filter((f: any) => f.transaction_type === "income");
    const totalExpenses = expenses.reduce((s: number, f: any) => s + Number(f.amount), 0);
    const totalIncome = incomes.reduce((s: number, f: any) => s + Number(f.amount), 0);
    const catTotals: Record<string, number> = {};
    expenses.forEach((f: any) => { catTotals[f.category || "autre"] = (catTotals[f.category || "autre"] || 0) + Number(f.amount); });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);

    // 7-day avg expense
    const expenses7d = finance7d.filter((f: any) => f.transaction_type === "expense");
    const totalExp7d = expenses7d.reduce((s: number, f: any) => s + Number(f.amount), 0);
    const avgExpDaily = totalExp7d / 7;

    // Monthly savings rate
    const income7d = finance7d.filter((f: any) => f.transaction_type === "income");
    const totalInc7d = income7d.reduce((s: number, f: any) => s + Number(f.amount), 0);
    const savingsRate7d = totalInc7d > 0 ? Math.round(((totalInc7d - totalExp7d) / totalInc7d) * 100) : 0;

    // --- Health ---
    const workouts = healthLogs.filter((h: any) => h.log_type === "workout");
    const weights = healthLogs.filter((h: any) => h.log_type === "weight");
    const totalWorkoutMin = workouts.reduce((s: number, w: any) => s + (Number(w.duration_minutes) || 0), 0);
    const workouts7d = health7d.filter((h: any) => h.log_type === "workout");
    const workoutsThisWeek = workouts7d.length;
    const weights7d = health7d.filter((h: any) => h.log_type === "weight").sort((a: any, b: any) => a.log_date.localeCompare(b.log_date));
    const latestWeight = weights.length > 0 ? Number(weights[weights.length - 1].value) : (weights7d.length > 0 ? Number(weights7d[weights7d.length - 1].value) : null);
    const weightTrend = weights7d.length >= 2
      ? (Number(weights7d[weights7d.length - 1].value) - Number(weights7d[0].value)).toFixed(1)
      : null;

    // --- Learning ---
    const totalStudyMin = learningLogs.reduce((s: number, l: any) => s + (Number(l.duration_minutes) || 0), 0);
    const topics = [...new Set(learningLogs.map((l: any) => l.topic))];
    const totalStudy7d = learning7d.reduce((s: number, l: any) => s + (Number(l.duration_minutes) || 0), 0);
    const avgStudyDaily = totalStudy7d / 7;
    const studyDays7d = new Set(learning7d.map((l: any) => l.session_date)).size;

    // --- Leads ---
    const leadsContactedToday = contactedLeads.length;
    const leadsContacted7d = leads7d.length;
    const avgLeadsDaily = leadsContacted7d / 7;

    // ============================================
    // STREAKS (consecutive days with key actions)
    // ============================================
    function calcStreak(dates: string[]): number {
      if (dates.length === 0) return 0;
      const sorted = [...new Set(dates)].sort().reverse();
      const today = todayStr;
      const yesterday = daysAgo(1);
      if (sorted[0] !== today && sorted[0] !== yesterday) return 0;
      let streak = 1;
      for (let i = 1; i < sorted.length; i++) {
        const d1 = new Date(sorted[i - 1]);
        const d2 = new Date(sorted[i]);
        const diff = Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
        if (diff === 1) streak++;
        else break;
      }
      return streak;
    }

    const workoutDates = health7d.filter((h: any) => h.log_type === "workout").map((h: any) => h.log_date);
    const studyDates = learning7d.map((l: any) => l.session_date);
    const workoutStreak = calcStreak(workoutDates);
    const studyStreak = calcStreak(studyDates);

    // --- Accountability: planned but not done (human tasks only) ---
    const failedTasks = humanPending.filter((t: any) => t.due_date === todayStr);
    const failedCount = failedTasks.length;
    const completionRate = (tasksDoneToday + failedCount) > 0
      ? Math.round((tasksDoneToday / (tasksDoneToday + failedCount)) * 100) : 100;

    // --- Day-of-week pattern ---
    let dayPattern = "";
    try {
      const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
      const { data: last30Days } = await supabase.from("tasks")
        .select("status, due_date, updated_at")
        .gte("due_date", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0])
        .in("status", ["completed", "pending", "in_progress"]);

      if (last30Days && last30Days.length > 10) {
        const dayStats: Record<number, { done: number; total: number }> = {};
        for (let d = 0; d < 7; d++) dayStats[d] = { done: 0, total: 0 };

        last30Days.forEach((t: any) => {
          const d = new Date(t.due_date).getDay();
          dayStats[d].total++;
          if (t.status === "completed") dayStats[d].done++;
        });

        // Find weakest and strongest days
        const dayRates = Object.entries(dayStats)
          .filter(([_, v]) => v.total >= 3)
          .map(([d, v]) => ({ day: Number(d), rate: Math.round((v.done / v.total) * 100), total: v.total }))
          .sort((a, b) => a.rate - b.rate);

        if (dayRates.length >= 2) {
          const weakest = dayRates[0];
          const strongest = dayRates[dayRates.length - 1];
          dayPattern = `📊 Pattern: ${dayNames[strongest.day]} = ${strongest.rate}% | ${dayNames[weakest.day]} = ${weakest.rate}%`;

          // Check if today is the weak day
          const todayDow = now.getDay();
          if (todayDow === weakest.day && completionRate < 60) {
            dayPattern += ` ← C'est ton jour faible, normal.`;
          }
        }
      }
    } catch (patErr) {
      console.error("Pattern error:", patErr);
    }

    // ============================================
    // SMART SCORE (weighted by goals)
    // ============================================
    let score = 0;
    let maxScore = 0;

    // Tasks (0-3): core productivity
    maxScore += 3;
    score += Math.min(3, tasksDoneToday);

    // Workout (0-2): health goal
    maxScore += 2;
    if (workouts.length > 0) score += 2;

    // Study (0-2): learning goal
    maxScore += 2;
    if (totalStudyMin >= 30) score += 2;
    else if (totalStudyMin > 0) score += 1;

    // Budget tracked (0-1): financial awareness
    maxScore += 1;
    if (financeLogs.length > 0) score += 1;

    // Leads/career (0-2): career/higrow goals
    maxScore += 2;
    if (leadsContactedToday >= 3) score += 2;
    else if (leadsContactedToday > 0) score += 1;

    const scoreEmoji = score >= 8 ? "🌟" : score >= 6 ? "🔥" : score >= 4 ? "👍" : score >= 2 ? "💪" : "📝";
    const scorePct = Math.round((score / maxScore) * 100);

    // ============================================
    // GOAL PROGRESS + PREDICTIONS
    // ============================================
    interface GoalPrediction {
      domain: string;
      title: string;
      current: number;
      target: number;
      start: number;
      direction: string;
      unit: string;
      daysLeft: number;
      progressPct: number;
      onTrack: boolean;
      predictedCompletion: string;
      dailyActionsStatus: string;
    }

    const goalPredictions: GoalPrediction[] = goals.map((goal: any) => {
      const current = Number(goal.metric_current) || 0;
      const target = Number(goal.metric_target) || 1;
      const start = Number(goal.metric_start) || 0;
      const isDecrease = goal.direction === 'decrease';
      const deadline = goal.deadline ? new Date(goal.deadline) : null;
      const daysLeft = deadline
        ? Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      // Smart progress: handle both increase and decrease goals
      let progressPct: number;
      if (isDecrease && start > target) {
        progressPct = Math.max(0, Math.min(100, Math.round(((start - current) / (start - target)) * 100)));
      } else {
        progressPct = Math.round((current / target) * 100);
      }

      // Estimate if on track based on elapsed time vs progress
      const totalDays = deadline
        ? Math.ceil((deadline.getTime() - new Date("2025-02-01").getTime()) / (1000 * 60 * 60 * 24))
        : 120;
      const elapsed = Math.max(totalDays - daysLeft, 1);
      const expectedPct = Math.round((elapsed / totalDays) * 100);
      const onTrack = progressPct >= expectedPct * 0.8; // 80% of expected = on track

      // Predict completion
      let predictedCompletion = "N/A";
      if (progressPct > 0 && elapsed > 7) {
        const dailyProgressRate = progressPct / elapsed;
        const pctRemaining = 100 - progressPct;
        const daysNeeded = dailyProgressRate > 0 ? Math.ceil(pctRemaining / dailyProgressRate) : 999;
        const completionDate = new Date(now.getTime() + daysNeeded * 24 * 60 * 60 * 1000);
        predictedCompletion = `${completionDate.getDate()}/${completionDate.getMonth() + 1}/${completionDate.getFullYear()}`;
      }

      // Daily actions check
      let dailyActionsStatus = "";
      if (goal.daily_actions && Array.isArray(goal.daily_actions)) {
        const completedTitles = completedTasks.map((t: any) => (t.title || "").toLowerCase());
        goal.daily_actions.forEach((action: string) => {
          const done = completedTitles.some((t: string) => t.includes(action.substring(0, 15).toLowerCase()));
          dailyActionsStatus += done ? "✅" : "❌";
        });
      }

      return {
        domain: goal.domain,
        title: goal.title,
        current, target, start,
        direction: goal.direction || 'increase',
        unit: goal.metric_unit || "",
        daysLeft,
        progressPct,
        onTrack,
        predictedCompletion,
        dailyActionsStatus,
      };
    });

    // ============================================
    // CONSUME INTER-AGENT SIGNALS FOR REVIEW
    // ============================================
    let signalsSummary = "";
    try {
      const summary = await signals.getActiveSummary();
      if (summary.total > 0) {
        signalsSummary += `\n📡 Signaux agents (${summary.total}):\n`;

        // Show critical signals first
        for (const sig of summary.critical.slice(0, 5)) {
          const icon = sig.priority === 1 ? "🔴" : "🟡";
          signalsSummary += `${icon} [${sig.source_agent}] ${sig.message}\n`;
        }

        // Non-critical count by source
        const nonCritical = summary.total - summary.critical.length;
        if (nonCritical > 0) {
          const sources = Object.entries(summary.bySource)
            .map(([src, count]) => `${src}(${count})`)
            .join(", ");
          signalsSummary += `ℹ️ +${nonCritical} signaux: ${sources}\n`;
        }
      }
    } catch (sigErr) {
      console.error("[Signals] Evening consume error:", sigErr);
    }

    // ============================================
    // BUILD MESSAGE
    // ============================================
    let msg = `<b>📋 BILAN</b> — ${dayName} ${todayStr}\n${LINE}\n\n`;

    // --- SCORE ---
    msg += `${scoreEmoji} <b>Score: ${score}/${maxScore}</b> (${scorePct}%)\n`;
    msg += `${progressBar(score, maxScore, 10)}\n`;
    msg += signalsSummary;
    msg += `\n`;

    // --- TACHES (with accountability) ---
    msg += `<b>📌 TÂCHES</b>  ${trend(tasksDoneToday, tasksWeekAvg)}\n`;
    msg += `✅ ${tasksDoneToday} faites · ❌ ${failedCount} non faites · Taux: <b>${completionRate}%</b>\n`;
    if (humanCompleted.length > 0) {
      humanCompleted.slice(0, 4).forEach((t: any) => {
        msg += `  ✓ ${esc(t.title)}\n`;
      });
      if (humanCompleted.length > 4) msg += `  + ${humanCompleted.length - 4} autres\n`;
    }
    if (failedTasks.length > 0) {
      msg += `\n<b>⚠️ PAS FAIT:</b>\n`;
      failedTasks.slice(0, 3).forEach((t: any) => {
        const dueTime = t.due_time ? ` (prévu ${t.due_time.substring(0, 5)})` : "";
        msg += `  ✗ ${esc(t.title)}${dueTime}\n`;
      });
      if (failedTasks.length > 3) msg += `  + ${failedTasks.length - 3} autres\n`;
      if (completionRate < 50) {
        msg += `  <i>Moins de la moitié fait. Qu'est-ce qui a bloqué ?</i>\n`;
      }
    }
    if (dayPattern) msg += `\n${dayPattern}\n`;
    msg += `  <i>Moy 7j: ${tasksWeekAvg.toFixed(1)}/jour</i>\n\n`;

    // --- FINANCE ---
    msg += `<b>💰 FINANCE</b>  ${trend(-totalExpenses, -avgExpDaily)}\n`;
    if (financeLogs.length > 0) {
      msg += `Dépenses: <b>${totalExpenses.toFixed(0)}₪</b> · Revenus: <b>${totalIncome.toFixed(0)}₪</b>\n`;
      if (topCats.length > 0) {
        msg += `  ${topCats.map(([cat, amt]) => `${esc(cat)} ${amt.toFixed(0)}₪`).join(" · ")}\n`;
      }
      msg += `  <i>Moy 7j: ${avgExpDaily.toFixed(0)}₪/jour · Épargne: ${savingsRate7d}%</i>\n`;
    } else {
      msg += `Aucune transaction enregistrée\n`;
    }
    msg += `\n`;

    // --- SANTÉ ---
    msg += `<b>🏋️ SANTÉ</b>  ${workoutsThisWeek}/5 cette semaine\n`;
    if (workouts.length > 0) {
      workouts.forEach((w: any) => {
        msg += `  ✅ ${w.workout_type || "Workout"} <b>${w.duration_minutes || 60}</b>min\n`;
      });
    } else {
      msg += `  ❌ Pas de workout aujourd'hui\n`;
    }
    if (latestWeight !== null) {
      msg += `  ⚖️ Poids: <b>${latestWeight}kg</b>`;
      if (weightTrend !== null) {
        const wt = parseFloat(weightTrend);
        msg += ` (${wt > 0 ? "+" : ""}${weightTrend}kg 7j)`;
      }
      msg += ` → 70kg\n`;
    }
    if (workoutStreak > 0) msg += `  🔥 Streak workout: ${workoutStreak}j\n`;
    msg += `\n`;

    // --- APPRENTISSAGE ---
    msg += `<b>📚 APPRENTISSAGE</b>  ${trend(totalStudyMin, avgStudyDaily)}\n`;
    if (totalStudyMin > 0) {
      msg += `  ✅ <b>${totalStudyMin}</b>min — ${topics.join(", ")}\n`;
    } else {
      msg += `  ❌ Aucune session d'étude\n`;
    }
    if (studyStreak > 0) msg += `  🔥 Streak étude: ${studyStreak}j\n`;
    msg += `  <i>Total 7j: ${(totalStudy7d / 60).toFixed(1)}h · ${studyDays7d}/7 jours</i>\n\n`;

    // --- TRADING ---
    if (activeSignals.length > 0) {
      msg += `<b>📈 TRADING</b>\n`;
      msg += `  ${activeSignals.length} signaux actifs · `;
      msg += activeSignals.slice(0, 3).map((s: any) => {
        const sym = (s.symbol || "").replace("USDT", "");
        return `${sym} ${(s.signal_type || "").toUpperCase()} ${s.confidence || "?"}/7`;
      }).join(" · ");
      msg += `\n\n`;
    }

    // --- LEADS / HIGROW ---
    if (leadsContactedToday > 0 || leadsContacted7d > 0) {
      msg += `<b>🚀 HIGROW</b>  ${trend(leadsContactedToday, avgLeadsDaily)}\n`;
      msg += `  ${leadsContactedToday} leads contactés · <i>Moy 7j: ${avgLeadsDaily.toFixed(1)}/jour</i>\n\n`;
    }

    // ============================================
    // OBJECTIFS — Prédictions + Progress bars
    // ============================================
    if (goalPredictions.length > 0) {
      msg += `${LINE}\n<b>🎯 OBJECTIFS</b>\n\n`;

      for (const gp of goalPredictions) {
        const emoji = DOMAIN_EMOJIS[gp.domain] || "📌";
        const status = gp.onTrack ? "✅" : "⚠️";
        msg += `${emoji} <b>${esc(gp.title)}</b>\n`;
        msg += `  ${progressBar(gp.current, gp.target, 10, gp.start, gp.direction)} · ${gp.current}/${gp.target}${gp.unit}\n`;
        msg += `  ${status} J-${gp.daysLeft}`;
        if (!gp.onTrack) msg += ` · ⚠️ Retard estimé`;
        msg += `\n`;
        if (gp.dailyActionsStatus) {
          msg += `  Actions du jour: ${gp.dailyActionsStatus}\n`;
        }
        msg += `\n`;
      }
    }

    // ============================================
    // TOMORROW
    // ============================================
    const tomorrowDay = (day + 1) % 7;
    msg += `${LINE}\n`;
    msg += `<b>Demain</b> — ${TOMORROW_SCHEDULE[tomorrowDay] || "?"}\n`;

    // High priority pending tasks for tomorrow
    const urgentTasks = pendingTasks
      .filter((t: any) => t.priority <= 2 || (t.due_date && t.due_date <= daysAgo(-1)))
      .slice(0, 3);
    if (urgentTasks.length > 0) {
      msg += `\n<b>⚡ Priorités demain:</b>\n`;
      urgentTasks.forEach((t: any) => {
        const domainEmoji = DOMAIN_EMOJIS[t.agent_type] || "📌";
        msg += `  ${domainEmoji} ${esc(t.title)}\n`;
      });
    }

    // ============================================
    // AI EVENING COACH — With full context
    // ============================================
    try {
      const goalsContext = goalPredictions.map(gp => {
        return `${gp.domain}: ${gp.progressPct}% (${gp.onTrack ? "on track" : "en retard"}, J-${gp.daysLeft})`;
      }).join(", ");

      const streaksContext = `Workout streak: ${workoutStreak}j, Study streak: ${studyStreak}j`;

      const aiContext = `BILAN DU JOUR (${dayName}):
- Score: ${score}/${maxScore} (${scorePct}%)
- Tâches: ${tasksDoneToday} complétées (moy 7j: ${tasksWeekAvg.toFixed(1)}/jour), ${tasksPending} en attente
- Tâches non faites: ${failedTasks.slice(0, 3).map((t: any) => t.title).join(", ") || "aucune"}
- Taux de complétion: ${completionRate}%
- Pattern jour: ${dayPattern || "pas assez de données"}
- Dépenses: ${totalExpenses.toFixed(0)}₪ (moy 7j: ${avgExpDaily.toFixed(0)}₪/jour), Épargne: ${savingsRate7d}%
- Workout: ${workouts.length > 0 ? workouts.map((w: any) => w.workout_type).join(", ") : "aucun"} (${workoutsThisWeek}/5 cette semaine)
- Poids: ${latestWeight || "N/A"}kg${weightTrend ? ` (${weightTrend}kg sur 7j)` : ""} → objectif 70kg
- Étude: ${totalStudyMin}min (${(totalStudy7d / 60).toFixed(1)}h cette semaine)
- Leads: ${leadsContactedToday} contactés (moy 7j: ${avgLeadsDaily.toFixed(1)}/jour)
- Signals trading: ${activeSignals.length} actifs
- Streaks: ${streaksContext}
- Objectifs: ${goalsContext}
- Demain: ${TOMORROW_SCHEDULE[tomorrowDay]}`;

      const aiReflection = await callOpenAI(
        `Tu es OREN, coach personnel d'Oren. Génère une réflexion de soirée en français (max 6 lignes):
1. Score du jour : ce qui a été bien fait et ce qui manque
2. Analyse des tendances 7 jours (progression ou régression ?)
3. Objectifs en retard → action correctrice spécifique
4. TOP 3 priorités CONCRÈTES pour demain (pas vagues)
5. Message de motivation adapté au contexte (si bonne journée → félicite, si mauvaise → encourage sans culpabiliser)

IMPORTANT: Sois SPÉCIFIQUE. Pas de phrases génériques. Utilise les données pour être précis.
Exemple bon: "Tu dépenses 180₪/jour en moyenne, il faut couper à 120₪ pour atteindre 20% d'épargne"
Exemple mauvais: "Continue comme ça, tu es sur la bonne voie"
Style: coach sportif français, direct, bienveillant. Emojis ok. Max 250 mots.`,
        aiContext
      );

      if (aiReflection) {
        msg += `\n${LINE}\n🧠 <b>COACH OREN</b>\n${aiReflection}`;
      }
    } catch (e) { console.error("AI reflection error:", e); }

    msg += `\n\nBonne soirée 💤`;

    // ============================================
    // EMIT INTER-AGENT SIGNALS FOR TOMORROW
    // ============================================
    try {
      // Emit daily score
      await signals.emit("daily_score", `Score: ${score}/10`, {
        score: score,
        breakdown: {
          tasks: tasksDoneToday,
          workouts: workouts.length,
          study: totalStudyMin,
          finance: financeLogs.length > 0 ? 1 : 0,
          leads: leadsContactedToday,
        },
      }, { target: "morning-briefing", priority: 3, ttlHours: 14 });

      // Detect weakest domain and signal it
      const domainScores: Record<string, number> = {};
      domainScores["productivity"] = tasksDoneToday > 0 ? Math.round((tasksDoneToday / Math.max(tasksPending + tasksDoneToday, 1)) * 10) : 5;
      domainScores["health"] = workouts.length > 0 ? 8 : 2;
      domainScores["learning"] = totalStudyMin >= 30 ? 8 : (totalStudyMin > 0 ? 5 : 2);
      domainScores["finance"] = financeLogs.length > 0 ? 7 : 3;
      domainScores["career"] = leadsContactedToday >= 3 ? 8 : (leadsContactedToday > 0 ? 5 : 2);

      const weakest = Object.entries(domainScores).sort((a, b) => a[1] - b[1])[0];
      if (weakest && weakest[1] < 5) {
        await signals.emit("weak_domain", `Domaine faible: ${weakest[0]} (${weakest[1]}/10)`, {
          domain: weakest[0],
          score: weakest[1],
        }, { target: "morning-briefing", priority: 2, ttlHours: 14 });
      }

      // Detect pattern if on strong streak
      if (workoutStreak >= 3 || studyStreak >= 3) {
        const strongDomain = workoutStreak >= 3 ? "workout" : "study";
        const streakLength = Math.max(workoutStreak, studyStreak);
        await signals.emit("pattern_detected", `${strongDomain} streak en cours: ${streakLength} jours`, {
          pattern: `${strongDomain}_streak`,
          strength: streakLength,
        }, { target: "morning-briefing", priority: 3, ttlHours: 14 });
      }
    } catch (sigErr) {
      console.error("[Signals] Evening emit error:", sigErr);
    }

    // ============================================
    // SEND + SAVE
    // ============================================
    const sent = await sendTelegram(msg);

    try {
      await supabase.from("briefings").insert({
        briefing_type: "evening",
        briefing_date: todayStr,
        content: msg,
        sent_at: new Date().toISOString(),
      });
    } catch (e) { console.error("Save error:", e); }

    // Save daily stats for trend tracking
    try {
      await supabase.from("health_logs").insert({
        log_type: "daily_score",
        log_date: todayStr,
        value: score,
        notes: JSON.stringify({
          score, maxScore, scorePct,
          tasks: tasksDoneToday, expenses: totalExpenses, income: totalIncome,
          workouts: workouts.length, studyMin: totalStudyMin, leads: leadsContactedToday,
          workoutStreak, studyStreak, savingsRate: savingsRate7d,
        }),
      }).then(() => {}).catch(() => {});
    } catch (_) {}

    return new Response(JSON.stringify({
      success: sent, score, scorePct, date: todayStr,
      trends: { tasksAvg: tasksWeekAvg, expenseAvg: avgExpDaily, studyAvg: avgStudyDaily, leadsAvg: avgLeadsDaily },
      streaks: { workout: workoutStreak, study: studyStreak },
      goals: goalPredictions.map(g => ({ domain: g.domain, pct: g.progressPct, onTrack: g.onTrack })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Evening review error:", error);
    return new Response(JSON.stringify({
      success: false, error: error instanceof Error ? error.message : "Unknown error",
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
