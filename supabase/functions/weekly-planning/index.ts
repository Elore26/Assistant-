// ============================================
// OREN AGENT SYSTEM - L10 Weekly Review (Sunday)
// EOS-inspired: Scorecard + Rock Review + IDS Issues
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { buildScorecard, formatScorecardHTML } from "../_shared/scorecard.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

const LINE = "━━━━━━━━━━━━━━━━━━━━";

function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number): string {
  const d = getIsraelNow();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

function daysFromNow(n: number): string {
  const d = getIsraelNow();
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

function dayName(dateString: string): string {
  const d = new Date(dateString + "T12:00:00");
  return ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"][d.getDay()];
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function progressBar(pct: number, len = 10): string {
  const filled = Math.round((pct / 100) * len);
  return "█".repeat(Math.min(filled, len)) + "░".repeat(Math.max(len - filled, 0));
}

async function callOpenAI(systemPrompt: string, userPrompt: string, maxTokens = 600): Promise<string> {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.error("OpenAI error:", e);
    return "";
  }
}

async function sendTG(text: string, buttons?: any[][]): Promise<boolean> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: any = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: buttons };
  }
  let r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.ok) return true;
  // Fallback without HTML
  r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.replace(/<[^>]*>/g, "") }),
  });
  return r.ok;
}

serve(async (_req: Request) => {
  try {
    const now = getIsraelNow();
    const dow = now.getDay();

    // Only run on Sunday (0)
    if (dow !== 0) {
      return new Response(JSON.stringify({ success: true, skipped: "not_sunday" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const signals = getSignalBus("morning-briefing");
    const today = dateStr(now);

    // ─── Date ranges ─────────────────────────────────────────────
    const weekStart = daysAgo(7); // last Sunday
    const weekEnd = daysAgo(1);   // yesterday (Saturday)
    const nextWeekEnd = daysFromNow(6); // next Saturday

    // ─── FETCH ALL WEEK DATA IN PARALLEL ─────────────────────────
    const [
      { data: weekTasks },
      { data: weekDoneTasks },
      { data: weekExpenses },
      { data: weekHealth },
      { data: overdueRaw },
      { data: weekGoals },
      { data: weekBriefings },
      { data: nextWeekTasks },
      { data: rocksData },
      { data: failReasonsData },
    ] = await Promise.all([
      // All tasks created or due this week
      supabase.from("tasks").select("id, title, status, priority, due_date, due_time, agent_type, created_at, updated_at")
        .gte("due_date", weekStart).lte("due_date", weekEnd),
      // Completed tasks this week
      supabase.from("tasks").select("id, title, priority, due_date, updated_at, agent_type")
        .eq("status", "completed").gte("updated_at", `${weekStart}T00:00:00`),
      // Expenses this week
      supabase.from("finance_logs").select("amount, category, transaction_type, transaction_date, payment_method")
        .eq("transaction_type", "expense").gte("transaction_date", weekStart).lte("transaction_date", weekEnd),
      // Health logs this week
      supabase.from("health_logs").select("log_type, workout_type, duration_minutes, value, log_date")
        .gte("log_date", weekStart).lte("log_date", weekEnd),
      // Overdue tasks (still pending, due before today)
      supabase.from("tasks").select("id, title, priority, due_date, agent_type")
        .in("status", ["pending", "in_progress"]).lt("due_date", today)
        .order("priority", { ascending: true }),
      // Goals
      supabase.from("goals").select("domain, title, metric_current, metric_target, direction, priority")
        .eq("status", "active"),
      // Briefing scores (from evening reviews)
      supabase.from("briefings").select("briefing_date, content")
        .eq("briefing_type", "evening").gte("briefing_date", weekStart).lte("briefing_date", weekEnd)
        .order("briefing_date", { ascending: true }),
      // Already planned tasks for next week
      supabase.from("tasks").select("id, title, priority, due_date, status")
        .gte("due_date", today).lte("due_date", nextWeekEnd)
        .in("status", ["pending", "in_progress"])
        .order("due_date", { ascending: true }),
      // Active rocks
      supabase.from("rocks").select("*")
        .in("current_status", ["on_track", "off_track"])
        .order("created_at", { ascending: true }),
      // Fail reasons this week
      supabase.from("task_fail_reasons").select("reason, task_date")
        .gte("task_date", weekStart).lte("task_date", weekEnd),
    ]);

    // ─── WEEK METRICS ────────────────────────────────────────────
    const allTasks = weekTasks || [];
    const doneTasks = weekDoneTasks || [];
    const failedTasks = allTasks.filter(t => t.status === "pending" || t.status === "in_progress");
    const totalPlanned = allTasks.length;
    const totalDone = doneTasks.length;
    const completionRate = totalPlanned > 0 ? Math.round((totalDone / totalPlanned) * 100) : 0;

    // Per-day breakdown
    const dayStats: Record<string, { done: number; total: number }> = {};
    const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    for (const t of allTasks) {
      const day = dayName(t.due_date);
      if (!dayStats[day]) dayStats[day] = { done: 0, total: 0 };
      dayStats[day].total++;
      if (t.status === "completed") dayStats[day].done++;
    }
    for (const t of doneTasks) {
      const day = dayName(t.due_date || t.updated_at?.substring(0, 10) || "");
      if (!dayStats[day]) dayStats[day] = { done: 0, total: 0 };
    }

    // Best/worst days
    let bestDay = "", worstDay = "", bestRate = -1, worstRate = 101;
    for (const [day, s] of Object.entries(dayStats)) {
      if (s.total === 0) continue;
      const rate = Math.round((s.done / s.total) * 100);
      if (rate > bestRate) { bestRate = rate; bestDay = day; }
      if (rate < worstRate) { worstRate = rate; worstDay = day; }
    }

    // P1/P2 completion
    const p1p2Tasks = allTasks.filter(t => (t.priority || 3) <= 2);
    const p1p2Done = p1p2Tasks.filter(t => t.status === "completed").length;
    const p1p2Rate = p1p2Tasks.length > 0 ? Math.round((p1p2Done / p1p2Tasks.length) * 100) : 100;

    // ─── FINANCE SUMMARY ─────────────────────────────────────────
    const expenses = weekExpenses || [];
    const totalSpent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const catSpending: Record<string, number> = {};
    for (const e of expenses) {
      const cat = e.category || "autre";
      catSpending[cat] = (catSpending[cat] || 0) + (e.amount || 0);
    }
    const topCats = Object.entries(catSpending).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const cashSpending = expenses.filter(e => e.payment_method === "cash").reduce((s, e) => s + (e.amount || 0), 0);

    // ─── HEALTH SUMMARY ──────────────────────────────────────────
    const healthLogs = weekHealth || [];
    const workouts = healthLogs.filter(h => h.log_type === "workout");
    const workoutDays = new Set(workouts.map(w => w.log_date)).size;
    const totalWorkoutMin = workouts.reduce((s, w) => s + (w.duration_minutes || 0), 0);
    const sleepLogs = healthLogs.filter(h => h.log_type === "sleep" && h.value);
    const avgSleep = sleepLogs.length > 0
      ? (sleepLogs.reduce((s, l) => s + (l.value || 0), 0) / sleepLogs.length).toFixed(1)
      : "?";

    // ─── OVERDUE TASKS ───────────────────────────────────────────
    const overdue = overdueRaw || [];
    const overdueCritical = overdue.filter(t => (t.priority || 3) <= 2);

    // ─── Fail reason patterns ────────────────────────────────────
    const failReasons = failReasonsData || [];
    const failCounts: Record<string, number> = {};
    failReasons.forEach((fr: any) => { failCounts[fr.reason] = (failCounts[fr.reason] || 0) + 1; });
    const topFailReason = Object.entries(failCounts).sort((a, b) => b[1] - a[1])[0];

    // ════════════════════════════════════════════
    // MESSAGE 1: SCORECARD (EOS format)
    // ════════════════════════════════════════════
    try {
      const scorecardData = await buildScorecard(supabase, weekStart, weekEnd);
      const scorecardMsg = formatScorecardHTML(scorecardData);
      await sendTG(`<b>📋 L10 WEEKLY</b> — Dimanche ${today}\n${LINE}\n\n${scorecardMsg}`);

      // Save scorecard snapshot
      try {
        await supabase.from("scorecard_snapshots").upsert({
          week_start: weekStart,
          week_end: weekEnd,
          metrics: scorecardData.metrics,
        }, { onConflict: "week_start" });
      } catch (_) {}
    } catch (scErr) {
      console.error("[Scorecard] Error:", scErr);
      // Fallback: send basic stats
      let msg = `<b>📊 BILAN HEBDOMADAIRE</b>\n${LINE}\n`;
      msg += `Semaine du ${weekStart.substring(5)} au ${weekEnd.substring(5)}\n\n`;
      msg += `📋 Tâches: ${totalDone}/${totalPlanned} (${completionRate}%)\n`;
      msg += `💰 Dépenses: ₪${Math.round(totalSpent)}\n`;
      msg += `🏋️ Workouts: ${workoutDays}j\n`;
      await sendTG(msg);
    }

    // ════════════════════════════════════════════
    // MESSAGE 2: ROCK REVIEW
    // ════════════════════════════════════════════
    const rocks = rocksData || [];
    let rockMsg = `\n<b>🪨 ROCK REVIEW</b>\n${LINE}\n`;

    if (rocks.length > 0) {
      const DOMAIN_EMOJI: Record<string, string> = { career: "💼", health: "🏋️", finance: "💰", learning: "📚", higrow: "🚀" };
      for (const rock of rocks) {
        const daysLeft = Math.ceil((new Date(rock.quarter_end).getTime() - now.getTime()) / 86400000);
        const statusIcon = rock.current_status === "on_track" ? "✅" : "⚠️";
        const emoji = DOMAIN_EMOJI[rock.domain] || "📌";
        rockMsg += `${statusIcon} ${emoji} ${esc(rock.title)} — <b>${rock.current_status.replace("_", " ").toUpperCase()}</b>\n`;
        rockMsg += `   J-${daysLeft} · ${esc(rock.measurable_target)}\n`;
        if (rock.progress_notes) rockMsg += `   <i>${esc(rock.progress_notes)}</i>\n`;
        rockMsg += `\n`;
      }

      const onTrack = rocks.filter((r: any) => r.current_status === "on_track").length;
      const offTrack = rocks.filter((r: any) => r.current_status === "off_track").length;
      rockMsg += `${onTrack} on track · ${offTrack} off track\n`;
    } else {
      rockMsg += `Aucun Rock défini.\n/rock add "Obtenir 3 interviews" career\n`;
    }

    // Task completion details
    rockMsg += `\n<b>📋 TÂCHES</b>\n`;
    rockMsg += `${progressBar(completionRate)} ${completionRate}%\n`;
    rockMsg += `✅ ${totalDone} faites · ❌ ${failedTasks.length} non faites\n`;
    if (p1p2Tasks.length > 0) {
      rockMsg += `🎯 P1/P2: ${p1p2Done}/${p1p2Tasks.length} (${p1p2Rate}%)\n`;
    }

    // Day breakdown
    rockMsg += `\n<b>📅 Par jour:</b>\n`;
    for (const day of dayNames) {
      const s = dayStats[day];
      if (!s || s.total === 0) continue;
      const rate = Math.round((s.done / s.total) * 100);
      const icon = rate >= 80 ? "🟢" : rate >= 50 ? "🟡" : "🔴";
      rockMsg += `${icon} ${day}: ${s.done}/${s.total} (${rate}%)\n`;
    }

    if (bestDay) rockMsg += `\n💪 Meilleur: <b>${bestDay}</b> (${bestRate}%)`;
    if (worstDay && worstDay !== bestDay) rockMsg += ` · ⚠️ Faible: <b>${worstDay}</b> (${worstRate}%)`;
    rockMsg += `\n`;

    // Finance
    rockMsg += `\n<b>💰 DÉPENSES</b> · ₪${Math.round(totalSpent)}`;
    if (cashSpending > 0) rockMsg += ` (₪${Math.round(cashSpending)} cash)`;
    rockMsg += `\n`;
    for (const [cat, amt] of topCats) {
      rockMsg += `  · ${cat}: ₪${Math.round(amt)}\n`;
    }

    // Health
    rockMsg += `\n<b>🏋️ SANTÉ</b> · ${workoutDays}j · ${totalWorkoutMin}min · Sommeil: ${avgSleep}h\n`;

    // Fail reason pattern
    if (topFailReason && failReasons.length >= 3) {
      const REASON_LABELS: Record<string, string> = { blocked: "Bloqué", forgot: "Oublié", toobig: "Trop gros", energy: "Énergie", skip: "Skip" };
      rockMsg += `\n📊 <i>Pattern échecs: "${REASON_LABELS[topFailReason[0]] || topFailReason[0]}" = raison #1 (${topFailReason[1]}x)</i>\n`;
    }

    await sendTG(rockMsg);

    // ════════════════════════════════════════════
    // MESSAGE 3: IDS ISSUES (AI-generated)
    // ════════════════════════════════════════════
    const idsContext = {
      completionRate,
      totalDone,
      totalFailed: failedTasks.length,
      p1p2Rate,
      bestDay,
      worstDay,
      totalSpent: Math.round(totalSpent),
      workoutDays,
      avgSleep,
      overdueCount: overdue.length,
      overdueCritical: overdueCritical.length,
      rocksOffTrack: rocks.filter((r: any) => r.current_status === "off_track").map((r: any) => r.title),
      rocksOnTrack: rocks.filter((r: any) => r.current_status === "on_track").map((r: any) => r.title),
      topFailReason: topFailReason ? `${topFailReason[0]} (${topFailReason[1]}x)` : "N/A",
      goals: (weekGoals || []).map((g: any) => `${g.domain}: ${g.title} (${g.metric_current}/${g.metric_target})`),
    };

    const idsInsight = await callOpenAI(
      `Tu es le coach EOS d'Oren. Génère la section IDS (Identify, Discuss, Solve) du L10 weekly review.
Tu analyses les données de la semaine et identifies les 3 problèmes les plus critiques.

FORMAT STRICT (HTML autorisé, <b> et <i> seulement):
Pour chaque issue (max 3):
🔴/🟡 <b>ISSUE:</b> [description courte et précise]
   → <b>ROOT CAUSE:</b> [pourquoi ça arrive]
   → <b>SOLVE:</b> [action concrète et mesurable pour cette semaine]

RÈGLES:
- Priorise: Rocks off-track > métriques off-track > patterns d'échec
- Chaque SOLVE doit être une action concrète avec un résultat mesurable
- Si un Rock est off-track, c'est TOUJOURS une issue
- Max 200 mots total
- Ne mets pas de motivation, seulement des faits et des solutions`,
      JSON.stringify(idsContext),
      500
    );

    if (idsInsight) {
      let idsMsg = `\n<b>⚠️ IDS — Identify, Discuss, Solve</b>\n${LINE}\n\n`;
      idsMsg += idsInsight.trim();
      await sendTG(idsMsg);
    }

    // ════════════════════════════════════════════
    // MESSAGE 4: NEXT WEEK PLAN + ACTIONS
    // ════════════════════════════════════════════
    let planMsg = `\n<b>📝 PLAN SEMAINE PROCHAINE</b>\n${LINE}\n`;

    // Overdue carry-over
    if (overdue.length > 0) {
      planMsg += `\n<b>⚠️ REPORT (${overdue.length} en retard):</b>\n`;
      for (const t of overdue.slice(0, 5)) {
        const pIcon = (t.priority || 3) <= 2 ? "🔴" : "🟡";
        const days = Math.round((new Date(today).getTime() - new Date(t.due_date).getTime()) / 86400000);
        planMsg += `${pIcon} ${esc(t.title)} <i>(${days}j)</i>\n`;
      }
      if (overdue.length > 5) planMsg += `  +${overdue.length - 5} autres\n`;
    }

    // Next week tasks
    const nextWeek = nextWeekTasks || [];
    if (nextWeek.length > 0) {
      planMsg += `\n<b>📌 PLANIFIÉ (${nextWeek.length}):</b>\n`;
      const byDay: Record<string, string[]> = {};
      for (const t of nextWeek) {
        const day = `${dayName(t.due_date)} ${t.due_date.substring(5)}`;
        if (!byDay[day]) byDay[day] = [];
        const pIcon = (t.priority || 3) <= 2 ? "●" : "○";
        byDay[day].push(`${pIcon} ${esc(t.title)}`);
      }
      for (const [day, tasks] of Object.entries(byDay)) {
        planMsg += `\n<b>${day}:</b>\n`;
        for (const task of tasks.slice(0, 3)) {
          planMsg += `  ${task}\n`;
        }
        if (tasks.length > 3) planMsg += `  +${tasks.length - 3}\n`;
      }
    } else {
      planMsg += `\nAucune tâche planifiée.\n`;
    }

    // Goals progress
    const goals = weekGoals || [];
    if (goals.length > 0) {
      planMsg += `\n<b>🎯 OBJECTIFS:</b>\n`;
      for (const g of goals.slice(0, 4)) {
        const pct = g.metric_target ? Math.round(((g.metric_current || 0) / g.metric_target) * 100) : 0;
        planMsg += `${progressBar(pct, 8)} ${g.domain}: ${g.title} (${pct}%)\n`;
      }
    }

    // Sprint goals recap
    try {
      const { data: sprintGoals } = await supabase.from("sprint_goals")
        .select("*").eq("week_start", weekStart).eq("status", "active");

      if (sprintGoals && sprintGoals.length > 0) {
        planMsg += `\n<b>🎯 SPRINT:</b>\n`;
        let completedSprints = 0;

        for (const sg of sprintGoals) {
          const pct = sg.target_value > 0 ? Math.round((sg.current_value / sg.target_value) * 100) : 0;
          const status = pct >= 100 ? "✅" : pct >= 60 ? "🟡" : "🔴";
          planMsg += `${status} ${sg.title}: ${sg.current_value}/${sg.target_value} ${sg.metric_unit} (${pct}%)\n`;
          if (pct >= 100) completedSprints++;

          if (pct >= 100) {
            await supabase.from("sprint_goals").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", sg.id);
          } else {
            await supabase.from("sprint_goals").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", sg.id);
          }
        }

        planMsg += `${completedSprints}/${sprintGoals.length} atteints\n`;
      }
    } catch (spErr) { console.error("[Sprint] Recap error:", spErr); }

    // Velocity
    try {
      const { data: weekMetrics } = await supabase.from("task_metrics")
        .select("*").gte("metric_date", weekStart).lte("metric_date", weekEnd)
        .order("metric_date");

      if (weekMetrics && weekMetrics.length > 0) {
        const totalPomo = weekMetrics.reduce((s: number, m: any) => s + (m.total_pomodoros || 0), 0);
        const totalDeepWork = weekMetrics.reduce((s: number, m: any) => s + (m.deep_work_minutes || 0), 0);
        const avgCompletion = weekMetrics.reduce((s: number, m: any) => s + (m.completion_rate || 0), 0) / weekMetrics.length;

        if (totalPomo > 0 || totalDeepWork > 0) {
          planMsg += `\n<b>📊 VÉLOCITÉ:</b>\n`;
          planMsg += `🍅 ${totalPomo} pomodoros · ${Math.round(totalDeepWork / 60)}h deep work · Taux: ${Math.round(avgCompletion)}%\n`;
        }
      }
    } catch (velErr) { console.error("[Velocity] Week summary error:", velErr); }

    await sendTG(planMsg);

    // ─── AUTO-CARRY-OVER: Move critical overdue to tomorrow ──────
    let carryCount = 0;
    const tomorrow = daysFromNow(1);
    for (const t of overdueCritical.slice(0, 5)) {
      try {
        await supabase.from("tasks").update({
          due_date: tomorrow,
          reminder_sent: false,
        }).eq("id", t.id);
        carryCount++;
      } catch (e) { console.error("Carry-over error:", e); }
    }

    if (carryCount > 0) {
      await sendTG(`✅ ${carryCount} tâche(s) prioritaire(s) reportée(s) à demain.`);
    }

    // ─── CLOSING ─────────────────────────────────────────────────
    await sendTG(
      `<b>✨ Bonne semaine Oren !</b>\n` +
      `Focus sur les Rocks. 3 tâches max par jour.`,
      [
        [
          { text: "🪨 Rocks", callback_data: "menu_rocks" },
          { text: "📊 Scorecard", callback_data: "menu_scorecard" },
        ],
        [
          { text: "📋 Tâches", callback_data: "menu_tasks" },
          { text: "🎯 Sprint", callback_data: "sprint_create" },
        ],
      ]
    );

    // ─── Save briefing record ────────────────────────────────────
    try {
      await supabase.from("briefings").insert({
        briefing_type: "weekly",
        briefing_date: today,
        content: `L10 Weekly: ${totalDone}/${totalPlanned} tasks (${completionRate}%), ${rocks.length} rocks, ₪${Math.round(totalSpent)}, ${workoutDays} workouts`,
        sent_at: new Date().toISOString(),
      });
    } catch (_) {}

    return new Response(
      JSON.stringify({ success: true, date: today, completion: completionRate }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Weekly planning error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
