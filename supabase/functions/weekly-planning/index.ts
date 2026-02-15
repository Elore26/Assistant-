// ============================================
// OREN AGENT SYSTEM - Weekly Planning (Sunday)
// Bilan de la semaine + planification semaine suivante
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";

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

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
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
        max_tokens: 600,
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

    // ─── BUILD MESSAGE PART 1: WEEK REVIEW ───────────────────────
    let msg = `<b>📊 BILAN HEBDOMADAIRE</b>\n${LINE}\n`;
    msg += `Semaine du ${weekStart.substring(5)} au ${weekEnd.substring(5)}\n\n`;

    // Task completion
    msg += `<b>📋 TÂCHES</b>\n`;
    msg += `${progressBar(completionRate)} ${completionRate}%\n`;
    msg += `✅ ${totalDone} faites · ❌ ${failedTasks.length} non faites\n`;
    if (p1p2Tasks.length > 0) {
      msg += `🎯 Prioritaires (P1/P2): ${p1p2Done}/${p1p2Tasks.length} (${p1p2Rate}%)\n`;
    }

    // Day breakdown
    msg += `\n<b>📅 Par jour:</b>\n`;
    for (const day of dayNames) {
      const s = dayStats[day];
      if (!s || s.total === 0) continue;
      const rate = Math.round((s.done / s.total) * 100);
      const icon = rate >= 80 ? "🟢" : rate >= 50 ? "🟡" : "🔴";
      msg += `${icon} ${day}: ${s.done}/${s.total} (${rate}%)\n`;
    }

    if (bestDay) msg += `\n💪 Meilleur jour: <b>${bestDay}</b> (${bestRate}%)`;
    if (worstDay && worstDay !== bestDay) msg += `\n⚠️ Plus faible: <b>${worstDay}</b> (${worstRate}%)`;
    msg += `\n`;

    // Finance
    msg += `\n<b>💰 DÉPENSES</b>\n`;
    msg += `Total: <b>₪${Math.round(totalSpent)}</b>`;
    if (cashSpending > 0) msg += ` (dont ₪${Math.round(cashSpending)} cash)`;
    msg += `\n`;
    for (const [cat, amt] of topCats) {
      msg += `  · ${cat}: ₪${Math.round(amt)}\n`;
    }

    // Health
    msg += `\n<b>🏋️ SANTÉ</b>\n`;
    msg += `Entraînements: ${workoutDays} jour(s) · ${totalWorkoutMin}min total\n`;
    msg += `Sommeil moyen: ${avgSleep}h\n`;

    await sendTG(msg);

    // ─── BUILD MESSAGE PART 2: NEXT WEEK PLAN ────────────────────
    let planMsg = `\n<b>📝 PLAN SEMAINE PROCHAINE</b>\n${LINE}\n`;

    // Overdue carry-over
    if (overdue.length > 0) {
      planMsg += `\n<b>⚠️ REPORT (${overdue.length} tâches en retard):</b>\n`;
      const showOverdue = overdue.slice(0, 5);
      for (const t of showOverdue) {
        const pIcon = (t.priority || 3) <= 2 ? "🔴" : "🟡";
        const days = Math.round((new Date(today).getTime() - new Date(t.due_date).getTime()) / 86400000);
        planMsg += `${pIcon} ${esc(t.title)} <i>(${days}j retard)</i>\n`;
      }
      if (overdue.length > 5) planMsg += `  ... +${overdue.length - 5} autres\n`;
    }

    // Next week already planned
    const nextWeek = nextWeekTasks || [];
    if (nextWeek.length > 0) {
      planMsg += `\n<b>📌 DÉJÀ PLANIFIÉ (${nextWeek.length}):</b>\n`;
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
        if (tasks.length > 3) planMsg += `  ... +${tasks.length - 3}\n`;
      }
    } else {
      planMsg += `\nAucune tâche planifiée pour la semaine prochaine.\n`;
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

    await sendTG(planMsg);

    // ─── AI COACH: WEEKLY INSIGHTS ───────────────────────────────
    const coachData = {
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
      nextWeekPlanned: nextWeek.length,
    };

    const coachInsight = await callOpenAI(
      `Tu es le coach personnel d'Oren, un professionnel ambitieux qui a des problèmes d'organisation.
      C'est le bilan de sa semaine. Tu parles en français, tu es direct et bienveillant mais honnête.
      Tes réponses sont courtes (max 5 phrases).
      Tu dois donner:
      1. Un verdict clair sur la semaine (bien/moyen/faible)
      2. LE point fort principal
      3. LE point faible principal
      4. UNE action concrète pour la semaine prochaine
      N'utilise pas de markdown ou de formatage HTML.`,
      JSON.stringify(coachData)
    );

    if (coachInsight) {
      let coachMsg = `\n<b>🧠 COACH — Analyse de la semaine</b>\n${LINE}\n`;
      coachMsg += esc(coachInsight.trim());
      await sendTG(coachMsg);
    }

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
      await sendTG(`\n✅ ${carryCount} tâche(s) prioritaire(s) reportée(s) automatiquement à demain (Lun).`);
    }

    // ─── CLOSING: Quick-plan buttons ─────────────────────────────
    await sendTG(
      `\n<b>✨ Bonne semaine Oren !</b>\n` +
      `N'oublie pas: 3 tâches max par jour, et fais d'abord les prioritaires.`,
      [
        [
          { text: "📋 Voir mes tâches", callback_data: "menu_tasks" },
          { text: "🎯 Objectifs", callback_data: "menu_goals" },
        ],
      ]
    );

    // ─── Save briefing record ────────────────────────────────────
    try {
      await supabase.from("briefings").insert({
        briefing_type: "weekly",
        briefing_date: today,
        content: `Weekly: ${totalDone}/${totalPlanned} tasks (${completionRate}%), ₪${Math.round(totalSpent)}, ${workoutDays} workouts`,
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
