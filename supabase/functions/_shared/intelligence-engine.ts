// ============================================
// OREN AGENT SYSTEM — Intelligence Engine
// Predictive scoring, behavior learning,
// pattern detection, and self-optimization
// ============================================

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface TaskPrediction {
  taskId: string;
  title: string;
  completionProbability: number; // 0-100
  riskLevel: "high" | "medium" | "low";
  riskReasons: string[];
  suggestion?: string;
}

export interface UserPattern {
  pattern_type: string;
  pattern_key: string;
  pattern_value: Record<string, any>;
  confidence: number;
}

export interface BotRetroResult {
  whatWorks: Array<{ domain: string; detail: string; metric: number }>;
  whatFails: Array<{ domain: string; detail: string; metric: number; suggestion: string }>;
  changesApplied: Array<{ type: string; detail: string }>;
}

// ─── PREDICTION ENGINE ──────────────────────────────────────────────────────
// Predicts probability of completing a task based on historical patterns

export async function predictTaskCompletion(
  supabase: SupabaseClient,
  task: any,
  dayOfWeek: number,
  hourNow: number
): Promise<TaskPrediction> {
  // Fetch all relevant patterns
  const { data: patterns } = await supabase
    .from("user_patterns")
    .select("pattern_type, pattern_key, pattern_value, confidence")
    .gte("confidence", 0.2); // Only use patterns with decent confidence

  const pats = (patterns || []) as UserPattern[];
  const patMap = new Map<string, UserPattern>();
  for (const p of pats) patMap.set(`${p.pattern_type}:${p.pattern_key}`, p);

  let probability = 65; // Base: 65% (slightly optimistic default)
  const reasons: string[] = [];
  let totalWeight = 0;
  let weightedSum = 0;

  // Factor 1: Context-based completion rate (weight: 30%)
  const context = task.context || "other";
  const ctxPat = patMap.get(`completion_by_context:${context}`);
  if (ctxPat && ctxPat.confidence >= 0.3) {
    const rate = ctxPat.pattern_value.rate * 100;
    weightedSum += rate * 30;
    totalWeight += 30;
    if (rate < 50) reasons.push(`${context}: ${Math.round(rate)}% historique`);
  }

  // Factor 2: Day of week completion rate (weight: 20%)
  const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const dayPat = patMap.get(`completion_by_day:${dayNames[dayOfWeek]}`);
  if (dayPat && dayPat.confidence >= 0.3) {
    const rate = dayPat.pattern_value.rate * 100;
    weightedSum += rate * 20;
    totalWeight += 20;
    if (rate < 50) reasons.push(`${dayNames[dayOfWeek]}: ${Math.round(rate)}% complétion`);
  }

  // Factor 3: Duration-based (weight: 20%)
  const dur = task.duration_minutes || 30;
  const durBucket = dur <= 15 ? "15min" : dur <= 25 ? "25min" : dur <= 45 ? "45min" : "60min+";
  const durPat = patMap.get(`completion_by_duration:${durBucket}`);
  if (durPat && durPat.confidence >= 0.3) {
    const rate = durPat.pattern_value.rate * 100;
    weightedSum += rate * 20;
    totalWeight += 20;
    if (rate < 50) reasons.push(`tâches ${durBucket}: ${Math.round(rate)}%`);
  }

  // Factor 4: Reschedule count penalty (weight: 15%)
  const reschedules = task.reschedule_count || 0;
  if (reschedules > 0) {
    const reschedulePenalty = Math.max(0, 100 - reschedules * 20); // -20% per reschedule
    weightedSum += reschedulePenalty * 15;
    totalWeight += 15;
    if (reschedules >= 3) reasons.push(`reportée ${reschedules}x`);
  }

  // Factor 5: Priority boost (weight: 15%)
  const priority = task.priority || 3;
  const priorityBoost = priority === 1 ? 90 : priority === 2 ? 75 : priority === 3 ? 60 : 40;
  weightedSum += priorityBoost * 15;
  totalWeight += 15;

  // Factor 6: Context + Day combo pattern
  const comboPat = patMap.get(`completion_by_context:${context}_${dayNames[dayOfWeek]}`);
  if (comboPat && comboPat.confidence >= 0.4) {
    const rate = comboPat.pattern_value.rate * 100;
    // Override context factor with more specific data
    weightedSum += rate * 10;
    totalWeight += 10;
  }

  // Calculate weighted average
  if (totalWeight > 0) {
    probability = Math.round(weightedSum / totalWeight);
  }

  // Clamp
  probability = Math.max(5, Math.min(98, probability));

  // Determine risk level
  const riskLevel = probability < 40 ? "high" : probability < 65 ? "medium" : "low";

  // Generate suggestion for at-risk tasks
  let suggestion: string | undefined;
  if (riskLevel === "high") {
    if (reschedules >= 3) suggestion = "Découper en sous-tâches de 15min";
    else if (dur > 45) suggestion = "Réduire la durée ou découper";
    else suggestion = "Planifier sur un créneau protégé";
  } else if (riskLevel === "medium" && reschedules >= 2) {
    suggestion = "Prévoir un rappel supplémentaire";
  }

  return {
    taskId: task.id,
    title: task.title || "?",
    completionProbability: probability,
    riskLevel,
    riskReasons: reasons,
    suggestion,
  };
}

// Batch predict for multiple tasks
export async function predictTasks(
  supabase: SupabaseClient,
  tasks: any[],
  dayOfWeek: number,
  hourNow: number
): Promise<TaskPrediction[]> {
  if (tasks.length === 0) return [];

  // Fetch patterns once
  const { data: patterns } = await supabase
    .from("user_patterns")
    .select("pattern_type, pattern_key, pattern_value, confidence")
    .gte("confidence", 0.2);

  const pats = (patterns || []) as UserPattern[];

  // Predict each task (reusing patterns)
  const results: TaskPrediction[] = [];
  for (const task of tasks) {
    const pred = await predictTaskCompletion(supabase, task, dayOfWeek, hourNow);
    results.push(pred);
  }

  return results.sort((a, b) => a.completionProbability - b.completionProbability);
}

// ─── BEHAVIOR LEARNING ENGINE ───────────────────────────────────────────────
// Analyzes 30 days of task data to detect patterns

export async function learnPatterns(supabase: SupabaseClient): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  let patternsUpdated = 0;

  // Fetch 30 days of completed + failed tasks
  const { data: allTasks } = await supabase.from("tasks")
    .select("id, title, status, context, priority, due_date, due_time, duration_minutes, reschedule_count, created_at, completed_at")
    .gte("due_date", thirtyDaysAgo)
    .in("status", ["completed", "cancelled", "pending", "in_progress"])
    .limit(1000);

  if (!allTasks || allTasks.length < 10) return 0;

  // Only count tasks that had a due_date in the past (should have been done)
  const today = new Date().toISOString().split("T")[0];
  const actionable = allTasks.filter((t: any) => t.due_date && t.due_date <= today);

  // ─── Pattern 1: Completion by context ───
  const byContext: Record<string, { done: number; total: number }> = {};
  for (const t of actionable) {
    const ctx = t.context || "other";
    if (!byContext[ctx]) byContext[ctx] = { done: 0, total: 0 };
    byContext[ctx].total++;
    if (t.status === "completed") byContext[ctx].done++;
  }
  for (const [ctx, stats] of Object.entries(byContext)) {
    if (stats.total >= 5) {
      await upsertPattern(supabase, "completion_by_context", ctx, {
        rate: Math.round((stats.done / stats.total) * 100) / 100,
        sample_size: stats.total,
        done: stats.done,
      }, Math.min(1, stats.total / 30));
      patternsUpdated++;
    }
  }

  // ─── Pattern 2: Completion by day of week ───
  const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const byDay: Record<number, { done: number; total: number }> = {};
  for (const t of actionable) {
    const d = new Date(t.due_date + "T12:00:00").getDay();
    if (!byDay[d]) byDay[d] = { done: 0, total: 0 };
    byDay[d].total++;
    if (t.status === "completed") byDay[d].done++;
  }
  for (const [d, stats] of Object.entries(byDay)) {
    if (stats.total >= 3) {
      await upsertPattern(supabase, "completion_by_day", dayNames[Number(d)], {
        rate: Math.round((stats.done / stats.total) * 100) / 100,
        sample_size: stats.total,
        done: stats.done,
      }, Math.min(1, stats.total / 20));
      patternsUpdated++;
    }
  }

  // ─── Pattern 3: Completion by duration bucket ───
  const byDur: Record<string, { done: number; total: number }> = {};
  for (const t of actionable) {
    const dur = t.duration_minutes || 30;
    const bucket = dur <= 15 ? "15min" : dur <= 25 ? "25min" : dur <= 45 ? "45min" : "60min+";
    if (!byDur[bucket]) byDur[bucket] = { done: 0, total: 0 };
    byDur[bucket].total++;
    if (t.status === "completed") byDur[bucket].done++;
  }
  for (const [bucket, stats] of Object.entries(byDur)) {
    if (stats.total >= 5) {
      await upsertPattern(supabase, "completion_by_duration", bucket, {
        rate: Math.round((stats.done / stats.total) * 100) / 100,
        sample_size: stats.total,
      }, Math.min(1, stats.total / 25));
      patternsUpdated++;
    }
  }

  // ─── Pattern 4: Completion by hour of due_time ───
  const byHour: Record<number, { done: number; total: number }> = {};
  for (const t of actionable) {
    if (!t.due_time) continue;
    const hour = parseInt(t.due_time.substring(0, 2));
    if (isNaN(hour)) continue;
    if (!byHour[hour]) byHour[hour] = { done: 0, total: 0 };
    byHour[hour].total++;
    if (t.status === "completed") byHour[hour].done++;
  }
  for (const [h, stats] of Object.entries(byHour)) {
    if (stats.total >= 3) {
      await upsertPattern(supabase, "completion_by_hour", `${h}h`, {
        rate: Math.round((stats.done / stats.total) * 100) / 100,
        sample_size: stats.total,
      }, Math.min(1, stats.total / 15));
      patternsUpdated++;
    }
  }

  // ─── Pattern 5: Context + Day combo ───
  const byCombo: Record<string, { done: number; total: number }> = {};
  for (const t of actionable) {
    const ctx = t.context || "other";
    const d = new Date(t.due_date + "T12:00:00").getDay();
    const key = `${ctx}_${dayNames[d]}`;
    if (!byCombo[key]) byCombo[key] = { done: 0, total: 0 };
    byCombo[key].total++;
    if (t.status === "completed") byCombo[key].done++;
  }
  for (const [key, stats] of Object.entries(byCombo)) {
    if (stats.total >= 3) {
      await upsertPattern(supabase, "completion_by_context", key, {
        rate: Math.round((stats.done / stats.total) * 100) / 100,
        sample_size: stats.total,
      }, Math.min(1, stats.total / 15));
      patternsUpdated++;
    }
  }

  // ─── Pattern 6: Duration estimation accuracy ───
  const { data: feedbacks } = await supabase.from("task_feedback")
    .select("task_id, actual_duration_minutes, difficulty")
    .order("created_at", { ascending: false })
    .limit(200);

  if (feedbacks && feedbacks.length >= 5) {
    // Join with tasks to get estimated duration
    const taskIds = feedbacks.map((f: any) => f.task_id);
    const { data: feedbackTasks } = await supabase.from("tasks")
      .select("id, duration_minutes, context")
      .in("id", taskIds);

    const taskMap = new Map((feedbackTasks || []).map((t: any) => [t.id, t]));

    // Compute average over/under estimation by context
    const estByCtx: Record<string, { ratios: number[]; difficulties: string[] }> = {};
    for (const fb of feedbacks) {
      const t = taskMap.get(fb.task_id);
      if (!t || !t.duration_minutes || !fb.actual_duration_minutes) continue;
      const ctx = t.context || "other";
      if (!estByCtx[ctx]) estByCtx[ctx] = { ratios: [], difficulties: [] };
      estByCtx[ctx].ratios.push(fb.actual_duration_minutes / t.duration_minutes);
      if (fb.difficulty) estByCtx[ctx].difficulties.push(fb.difficulty);
    }

    for (const [ctx, data] of Object.entries(estByCtx)) {
      if (data.ratios.length >= 3) {
        const avgRatio = data.ratios.reduce((s, r) => s + r, 0) / data.ratios.length;
        const hardPct = data.difficulties.filter(d => d === "hard").length / data.difficulties.length;
        await upsertPattern(supabase, "duration_accuracy", ctx, {
          avg_ratio: Math.round(avgRatio * 100) / 100, // 1.5 = takes 50% longer than estimated
          sample_size: data.ratios.length,
          hard_pct: Math.round(hardPct * 100) / 100,
        }, Math.min(1, data.ratios.length / 15));
        patternsUpdated++;
      }
    }
  }

  return patternsUpdated;
}

// ─── REMINDER EFFECTIVENESS ANALYSIS ────────────────────────────────────────

export async function analyzeReminderEffectiveness(supabase: SupabaseClient): Promise<{
  bestHours: number[];
  worstHours: number[];
  bestTypes: string[];
  overallRate: number;
}> {
  // Backfill: check recent reminders for completion
  const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data: unchecked } = await supabase.from("reminder_effectiveness")
    .select("id, task_id, sent_at")
    .is("task_completed_within_2h", null)
    .lt("sent_at", twoHoursAgo)
    .limit(50);

  if (unchecked && unchecked.length > 0) {
    for (const rem of unchecked) {
      const cutoff = new Date(new Date(rem.sent_at).getTime() + 2 * 3600000).toISOString();
      const { data: task } = await supabase.from("tasks")
        .select("status, completed_at")
        .eq("id", rem.task_id)
        .single();

      const completedWithin = task?.status === "completed" &&
        task?.completed_at && task.completed_at <= cutoff;

      await supabase.from("reminder_effectiveness")
        .update({
          task_completed_within_2h: completedWithin || false,
          task_completed_at: task?.completed_at || null,
        })
        .eq("id", rem.id);
    }
  }

  // Analyze effectiveness by hour
  const { data: reminders } = await supabase.from("reminder_effectiveness")
    .select("hour_sent, day_of_week, reminder_type, task_completed_within_2h")
    .not("task_completed_within_2h", "is", null)
    .limit(500);

  if (!reminders || reminders.length < 10) {
    return { bestHours: [], worstHours: [], bestTypes: [], overallRate: 0 };
  }

  // By hour
  const byHour: Record<number, { hit: number; total: number }> = {};
  for (const r of reminders) {
    if (!byHour[r.hour_sent]) byHour[r.hour_sent] = { hit: 0, total: 0 };
    byHour[r.hour_sent].total++;
    if (r.task_completed_within_2h) byHour[r.hour_sent].hit++;
  }

  const hourRates = Object.entries(byHour)
    .filter(([_, v]) => v.total >= 3)
    .map(([h, v]) => ({ hour: Number(h), rate: v.hit / v.total }))
    .sort((a, b) => b.rate - a.rate);

  const bestHours = hourRates.filter(h => h.rate >= 0.6).map(h => h.hour);
  const worstHours = hourRates.filter(h => h.rate < 0.3).map(h => h.hour);

  // By type
  const byType: Record<string, { hit: number; total: number }> = {};
  for (const r of reminders) {
    if (!byType[r.reminder_type]) byType[r.reminder_type] = { hit: 0, total: 0 };
    byType[r.reminder_type].total++;
    if (r.task_completed_within_2h) byType[r.reminder_type].hit++;
  }
  const bestTypes = Object.entries(byType)
    .filter(([_, v]) => v.total >= 5 && v.hit / v.total >= 0.5)
    .map(([t]) => t);

  // Overall rate
  const totalHit = reminders.filter((r: any) => r.task_completed_within_2h).length;
  const overallRate = Math.round((totalHit / reminders.length) * 100);

  // Save patterns
  for (const hr of hourRates) {
    await upsertPattern(supabase, "reminder_effectiveness_hour", `${hr.hour}h`, {
      rate: Math.round(hr.rate * 100) / 100,
      sample_size: byHour[hr.hour].total,
    }, Math.min(1, byHour[hr.hour].total / 10));
  }

  return { bestHours, worstHours, bestTypes, overallRate };
}

// ─── BOT SELF-RETRO ────────────────────────────────────────────────────────

export async function generateBotRetro(supabase: SupabaseClient): Promise<BotRetroResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  // Fetch week's data
  const [tasksRes, remindersRes, patternsRes] = await Promise.all([
    supabase.from("tasks")
      .select("id, title, status, context, priority, due_date, reschedule_count, completed_at")
      .gte("due_date", sevenDaysAgo)
      .limit(500),
    supabase.from("reminder_effectiveness")
      .select("reminder_type, hour_sent, task_completed_within_2h")
      .gte("sent_at", new Date(Date.now() - 7 * 86400000).toISOString())
      .not("task_completed_within_2h", "is", null),
    supabase.from("user_patterns")
      .select("pattern_type, pattern_key, pattern_value, confidence"),
  ]);

  const tasks = tasksRes.data || [];
  const reminders = remindersRes.data || [];
  const patterns = patternsRes.data || [];

  const whatWorks: BotRetroResult["whatWorks"] = [];
  const whatFails: BotRetroResult["whatFails"] = [];
  const changesApplied: BotRetroResult["changesApplied"] = [];

  // Analyze by context
  const ctxStats: Record<string, { done: number; total: number }> = {};
  for (const t of tasks) {
    const ctx = t.context || "other";
    if (!ctxStats[ctx]) ctxStats[ctx] = { done: 0, total: 0 };
    ctxStats[ctx].total++;
    if (t.status === "completed") ctxStats[ctx].done++;
  }

  const ctxLabels: Record<string, string> = {
    health: "🏋️ Health", work: "💼 Career", learning: "📚 Learning",
    home: "🏠 Personal", errands: "🛒 Courses", other: "📦 Autres",
  };

  for (const [ctx, stats] of Object.entries(ctxStats)) {
    if (stats.total < 3) continue;
    const rate = Math.round((stats.done / stats.total) * 100);
    const domain = ctxLabels[ctx] || ctx;
    if (rate >= 75) {
      whatWorks.push({ domain, detail: `${rate}% complétion (${stats.done}/${stats.total})`, metric: rate });
    } else if (rate < 50) {
      // Find suggestion based on patterns
      let suggestion = "Planifier aux heures efficaces";
      const rescheduled = tasks.filter((t: any) => t.context === ctx && (t.reschedule_count || 0) >= 2).length;
      if (rescheduled > stats.total * 0.4) suggestion = "Découper en tâches plus petites";
      whatFails.push({ domain, detail: `${rate}% complétion (${stats.done}/${stats.total})`, metric: rate, suggestion });
    }
  }

  // Analyze reminder effectiveness
  if (reminders.length >= 5) {
    const totalHit = reminders.filter((r: any) => r.task_completed_within_2h).length;
    const rate = Math.round((totalHit / reminders.length) * 100);
    if (rate >= 60) {
      whatWorks.push({ domain: "🔔 Rappels", detail: `${rate}% efficacité`, metric: rate });
    } else if (rate < 40) {
      whatFails.push({ domain: "🔔 Rappels", detail: `${rate}% efficacité seulement`, metric: rate, suggestion: "Ajuster horaires de rappel" });
    }

    // Find worst hours
    const byHour: Record<number, { hit: number; total: number }> = {};
    for (const r of reminders) {
      if (!byHour[r.hour_sent]) byHour[r.hour_sent] = { hit: 0, total: 0 };
      byHour[r.hour_sent].total++;
      if (r.task_completed_within_2h) byHour[r.hour_sent].hit++;
    }
    for (const [h, stats] of Object.entries(byHour)) {
      if (stats.total >= 3 && stats.hit / stats.total < 0.2) {
        changesApplied.push({
          type: "reminder_hour_disabled",
          detail: `Rappels à ${h}h inefficaces (${Math.round(stats.hit / stats.total * 100)}%) — à éviter`,
        });
      }
    }
  }

  // Check chronically rescheduled tasks
  const chronic = tasks.filter((t: any) => (t.reschedule_count || 0) >= 3 && t.status !== "completed");
  if (chronic.length > 0) {
    whatFails.push({
      domain: "🔄 Reports",
      detail: `${chronic.length} tâches reportées 3x+`,
      metric: chronic.length,
      suggestion: "Auto-découper ou archiver",
    });
  }

  // bot_retro upsert removed — write-only table, never read

  return { whatWorks, whatFails, changesApplied };
}

// Format retro for Telegram
export function formatRetro(retro: BotRetroResult): string {
  let msg = "<b>🤖 AUTO-ANALYSE HEBDO</b>\n━━━━━━━━━━━━━━━━━━━━\n\n";

  if (retro.whatWorks.length > 0) {
    msg += "<b>✅ Ce qui marche</b>\n";
    for (const w of retro.whatWorks) {
      msg += `  ${w.domain}: ${w.detail}\n`;
    }
    msg += "\n";
  }

  if (retro.whatFails.length > 0) {
    msg += "<b>❌ Ce qui bloque</b>\n";
    for (const f of retro.whatFails) {
      msg += `  ${f.domain}: ${f.detail}\n`;
      msg += `  → <i>${f.suggestion}</i>\n`;
    }
    msg += "\n";
  }

  if (retro.changesApplied.length > 0) {
    msg += "<b>🔧 Ajustements auto</b>\n";
    for (const c of retro.changesApplied) {
      msg += `  ${c.detail}\n`;
    }
  }

  if (retro.whatWorks.length === 0 && retro.whatFails.length === 0) {
    msg += "<i>Pas encore assez de données (besoin de 1-2 semaines)</i>";
  }

  return msg;
}

// Format at-risk tasks for morning briefing
export function formatAtRiskTasks(predictions: TaskPrediction[]): string {
  const atRisk = predictions.filter(p => p.riskLevel === "high" || p.riskLevel === "medium");
  if (atRisk.length === 0) return "";

  const highRisk = atRisk.filter(p => p.riskLevel === "high");
  const medRisk = atRisk.filter(p => p.riskLevel === "medium");

  let msg = "\n<b>⚠️ TÂCHES À RISQUE</b>\n";

  for (const t of highRisk.slice(0, 3)) {
    const pct = t.completionProbability;
    msg += `🔴 ${escHTML(t.title.substring(0, 40))} — ${pct}%`;
    if (t.riskReasons.length > 0) msg += ` (${t.riskReasons[0]})`;
    msg += "\n";
    if (t.suggestion) msg += `   → <i>${t.suggestion}</i>\n`;
  }

  for (const t of medRisk.slice(0, 2)) {
    msg += `🟡 ${escHTML(t.title.substring(0, 40))} — ${t.completionProbability}%\n`;
  }

  return msg;
}

function escHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── HELPER: upsert pattern ─────────────────────────────────────────────────

async function upsertPattern(
  supabase: SupabaseClient,
  type: string,
  key: string,
  value: Record<string, any>,
  confidence: number
): Promise<void> {
  await supabase.from("user_patterns").upsert({
    pattern_type: type,
    pattern_key: key,
    pattern_value: value,
    confidence: Math.round(confidence * 100) / 100,
    last_computed_at: new Date().toISOString(),
  }, { onConflict: "pattern_type,pattern_key" });
}
