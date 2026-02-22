// ============================================
// OREN AGENT SYSTEM — Health Agent (ReAct)
// Agentic fitness coaching: workout programming,
// nutrition, recovery, and streak management
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runReActAgent, type AgentConfig, type AgentResult } from "./react-agent.ts";
import { registry } from "./tool-registry.ts";
import { getGuardrails } from "./agent-guardrails.ts";
import { getMemoryStore } from "./agent-memory.ts";
import { sendTG, escHTML } from "./telegram.ts";
import { getIsraelNow, todayStr } from "./timezone.ts";
import { WORKOUT_SCHEDULE, WORK_SCHEDULE } from "./config.ts";

// ─── Workout Programs (deterministic data) ────────────────────────────

const WORKOUT_PROGRAMS: Record<string, { title: string; exercises: string }> = {
  push: {
    title: "PUSH (Chest, Shoulders, Triceps)",
    exercises: `1. Bench Press 4x8-10 (90s rest)
2. Incline Dumbbell Press 3x10-12 (75s)
3. OHP / Seated Shoulder Press 3x8-10 (90s)
4. Cable Lateral Raises 3x12-15 (60s)
5. Tricep Pushdown 3x10-12 (60s)
6. Overhead Tricep Extension 2x12-15 (60s)`,
  },
  pull: {
    title: "PULL (Back, Biceps, Rear Delts)",
    exercises: `1. Deadlift / Barbell Row 4x6-8 (120s rest)
2. Pull-ups / Lat Pulldown 3x8-10 (90s)
3. Seated Cable Row 3x10-12 (75s)
4. Face Pulls 3x15-20 (60s)
5. Barbell Curl 3x10-12 (60s)
6. Hammer Curl 2x12-15 (60s)`,
  },
  legs: {
    title: "LEGS (Quads, Hamstrings, Glutes, Calves)",
    exercises: `1. Squat 4x6-8 (120s rest)
2. Romanian Deadlift 3x8-10 (90s)
3. Leg Press 3x10-12 (75s)
4. Walking Lunges 3x12 each (60s)
5. Leg Curl 3x12-15 (60s)
6. Calf Raises 4x15-20 (45s)`,
  },
  cardio: {
    title: "CARDIO (Endurance + Core)",
    exercises: `1. HIIT: 20min (30s sprint / 60s walk)
2. Plank 3x45s (30s rest)
3. Russian Twists 3x20 (30s)
4. Mountain Climbers 3x30s (30s)
5. Bicycle Crunches 3x20 (30s)
6. Stretching 10min`,
  },
  rest: {
    title: "REST DAY — Active Recovery",
    exercises: `1. Light Walk 20-30min
2. Foam Rolling 10min
3. Stretching / Yoga 15min
4. Hydrate: 3L water target`,
  },
};

// ─── Health-Specific Tools ────────────────────────────────────────────

registry.register(
  {
    name: "get_todays_workout",
    description: "Get today's workout program based on the PPL schedule. Returns workout type, exercises, time, and duration.",
    category: "data",
    tier: "auto",
    allowedAgents: ["health", "morning-briefing", "telegram-bot"],
    parameters: [],
  },
  async () => {
    const day = getIsraelNow().getDay();
    const schedule = WORKOUT_SCHEDULE[day];
    const program = WORKOUT_PROGRAMS[schedule.type] || WORKOUT_PROGRAMS.rest;
    return {
      success: true,
      data: {
        day_of_week: day,
        type: schedule.type,
        time: schedule.time,
        note: schedule.note,
        title: program.title,
        exercises: program.exercises,
        duration_estimate: schedule.type === "rest" ? 30 : schedule.type === "cardio" ? 40 : 60,
      },
    };
  }
);

registry.register(
  {
    name: "get_health_logs",
    description: "Get recent health logs (weight, workouts, sleep). Returns data for the specified period.",
    category: "data",
    tier: "auto",
    allowedAgents: ["health", "morning-briefing", "evening-review"],
    parameters: [
      { name: "log_type", type: "string", description: "Type of log", required: false, enum: ["weight", "workout", "sleep", "all"] },
      { name: "days", type: "number", description: "How many days back (default 7)", required: false },
    ],
  },
  async (args, ctx) => {
    const days = args.days || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
    let query = ctx.supabase.from("health_logs").select("*").gte("log_date", since);
    if (args.log_type && args.log_type !== "all") query = query.eq("log_type", args.log_type);
    query = query.order("log_date", { ascending: false });
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };

    // Compute useful aggregates
    const logs = data || [];
    const weights = logs.filter((l: any) => l.log_type === "weight").map((l: any) => l.value);
    const workouts = logs.filter((l: any) => l.log_type === "workout");
    const sleepLogs = logs.filter((l: any) => l.log_type === "sleep");

    return {
      success: true,
      data: {
        logs,
        aggregates: {
          weight_current: weights[0] || null,
          weight_trend: weights.length >= 2 ? (weights[0] - weights[weights.length - 1]).toFixed(1) : null,
          workouts_this_period: workouts.length,
          total_workout_minutes: workouts.reduce((sum: number, w: any) => sum + (w.duration_minutes || 0), 0),
          avg_sleep: sleepLogs.length > 0 ? (sleepLogs.reduce((s: number, l: any) => s + (l.value || 0), 0) / sleepLogs.length).toFixed(1) : null,
        },
      },
    };
  }
);

registry.register(
  {
    name: "get_workout_streak",
    description: "Calculate current workout streak (consecutive days with a workout logged).",
    category: "data",
    tier: "auto",
    allowedAgents: ["health", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { data } = await ctx.supabase.from("health_logs")
      .select("log_date")
      .eq("log_type", "workout")
      .order("log_date", { ascending: false })
      .limit(30);

    if (!data?.length) return { success: true, data: { streak: 0, lastWorkout: null } };

    const dates = [...new Set(data.map((d: any) => d.log_date))].sort().reverse();
    let streak = 0;
    const today = todayStr();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

    // Start counting from today or yesterday
    if (dates[0] === today || dates[0] === yesterday) {
      for (let i = 0; i < dates.length; i++) {
        const expected = new Date(Date.now() - (i + (dates[0] === yesterday ? 1 : 0)) * 86400000)
          .toISOString().split("T")[0];
        if (dates[i] === expected) streak++;
        else break;
      }
    }

    return { success: true, data: { streak, lastWorkout: dates[0] } };
  }
);

registry.register(
  {
    name: "create_health_tasks",
    description: "Create today's health-related tasks (workout, meals, supplements, weigh-in, water tracking).",
    category: "action",
    tier: "auto",
    allowedAgents: ["health"],
    parameters: [
      { name: "workout_type", type: "string", description: "Workout type for today", required: true },
      { name: "workout_time", type: "string", description: "Workout time HH:MM", required: true },
    ],
  },
  async (args, ctx) => {
    const today = todayStr();
    // Check if already created
    const { data: existing } = await ctx.supabase.from("tasks")
      .select("id").eq("domain", "health").eq("due_date", today).eq("agent_type", "health").limit(1);
    if (existing?.length) return { success: true, data: { created: 0, message: "Tasks already exist for today" } };

    const tasks = [
      { title: `🏋️ ${args.workout_type.toUpperCase()} — ${args.workout_time}`, priority: 2, duration: 60 },
      { title: "🥗 Meal prep — repas du jour", priority: 3, duration: 30 },
      { title: "⚖️ Pesée matinale", priority: 3, duration: 2 },
      { title: "💧 Water tracker — 3L objectif", priority: 4, duration: 5 },
      { title: "💊 Compléments: Whey + Créatine + Omega-3", priority: 3, duration: 2 },
    ];

    let created = 0;
    for (const task of tasks) {
      const { error } = await ctx.supabase.from("tasks").insert({
        title: task.title, domain: "health", priority: task.priority,
        due_date: today, duration_minutes: task.duration,
        status: "pending", agent_type: "health",
      });
      if (!error) created++;
    }
    return { success: true, data: { created } };
  }
);

registry.register(
  {
    name: "check_recovery_status",
    description: "Analyze if the user needs a deload/recovery based on recent workout volume and sleep quality.",
    category: "analysis",
    tier: "auto",
    allowedAgents: ["health"],
    parameters: [],
  },
  async (_args, ctx) => {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const { data: workouts } = await ctx.supabase.from("health_logs")
      .select("*").eq("log_type", "workout").gte("log_date", weekAgo);
    const { data: sleep } = await ctx.supabase.from("health_logs")
      .select("*").eq("log_type", "sleep").gte("log_date", weekAgo);

    const workoutCount = workouts?.length || 0;
    const totalMinutes = workouts?.reduce((s: number, w: any) => s + (w.duration_minutes || 0), 0) || 0;
    const avgSleep = sleep?.length
      ? (sleep.reduce((s: number, l: any) => s + (l.value || 0), 0) / sleep.length)
      : null;

    let status: "fresh" | "moderate" | "fatigued" | "deload_needed" = "fresh";
    if (workoutCount >= 6 || totalMinutes >= 360) status = "deload_needed";
    else if (workoutCount >= 5 || totalMinutes >= 300) status = "fatigued";
    else if (workoutCount >= 3) status = "moderate";

    if (avgSleep !== null && avgSleep < 6) {
      // Poor sleep escalates fatigue
      if (status === "moderate") status = "fatigued";
      if (status === "fatigued") status = "deload_needed";
    }

    return {
      success: true,
      data: {
        status,
        workoutCount,
        totalMinutes,
        avgSleep: avgSleep?.toFixed(1) || "unknown",
        recommendation: status === "deload_needed"
          ? "Reduce volume 50% this week or take an extra rest day"
          : status === "fatigued"
          ? "Consider lighter weights or shorter sessions today"
          : "Good to go — full intensity",
      },
    };
  }
);

// ─── Main Handler ─────────────────────────────────────────────────────

export async function runHealthAgent(): Promise<AgentResult> {
  const guardrails = getGuardrails();
  const canRun = await guardrails.canRun("health");
  if (!canRun.allowed) {
    return {
      success: false, output: `Health agent blocked: ${canRun.reason}`,
      trace: [], totalToolCalls: 0, totalLoops: 0, durationMs: 0,
      stoppedByGuardrail: true, guardrailReason: canRun.reason,
    };
  }

  const isSunday = getIsraelNow().getDay() === 0;
  const memory = getMemoryStore("health");
  const memoryContext = await memory.buildContext("workout recovery weight progress streak", "health");

  const agentConfig: AgentConfig = {
    name: "health",
    role: `Tu es le coach fitness personnel d'Oren. Tu gères son programme PPL (Push/Pull/Legs), sa nutrition (IF 16:8, ~2800kcal/jour training, 175g protéines), et son recovery.

Tu es MOTIVANT mais RÉALISTE :
- Tu célèbres les streaks et les progrès
- Tu alertes quand le recovery est nécessaire (fatigue, manque de sommeil)
- Tu adaptes les recommandations au niveau d'énergie
- Tu émets des signaux aux autres agents (low_sleep → all, recovery_status → morning)

Style: Direct, encourageant, données chiffrées (poids, séries, reps).`,

    goal: `Exécuter le cycle quotidien de l'agent santé :

1. WORKOUT: Récupère le programme du jour (PPL schedule)
2. LOGS: Analyse les logs récents (poids, workouts, sommeil sur 7j)
3. STREAK: Calcule le streak actuel de workouts consécutifs
4. RECOVERY: Vérifie si un deload est nécessaire
5. TASKS: Crée les tâches santé du jour (workout, repas, pesée, eau, compléments)
6. SIGNALS: Émet les signaux pertinents :
   - low_sleep si sommeil < 6h
   - recovery_status si fatigue élevée
   - workout_completed si workout logged aujourd'hui
   - streak_at_risk si streak 3+ jours et rien prévu demain
7. MEMORY: Stocke les insights importants (patterns de poids, records)
8. REPORT: Produis un résumé structuré avec le programme du jour et les métriques${isSunday ? "\n9. WEEKLY: C'est dimanche — ajoute la revue hebdomadaire (évolution poids, workouts, scores)" : ""}

IMPORTANT: Accumule tout et produis UN seul rapport final.`,

    context: `Date: ${todayStr()} (${["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][getIsraelNow().getDay()]})
Heure: ${getIsraelNow().toTimeString().slice(0, 5)} IST
${memoryContext}`,

    maxLoops: 5,
    maxToolCalls: 15,
    maxTokensPerLoop: 800,
    model: "gpt-4o-mini",
    temperature: 0.3,
  };

  const result = await runReActAgent(agentConfig);

  // Store key insights as memory
  if (result.success && result.output) {
    try {
      // Extract and store any notable patterns
      const output = result.output.toLowerCase();
      if (output.includes("streak") && output.includes("record")) {
        await memory.store(`Nouveau record de streak détecté: ${result.output.slice(0, 200)}`, "episodic", {
          domain: "health", importance: 4, tags: ["streak", "record"],
        });
      }
      if (output.includes("deload") || output.includes("fatigue")) {
        await memory.store(`Recovery recommandé: ${result.output.slice(0, 200)}`, "procedural", {
          domain: "health", importance: 3, tags: ["recovery", "deload"],
        });
      }
    } catch {}
  }

  const estimatedTokens = result.totalLoops * 1500;
  await guardrails.recordUsage("health", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

  return result;
}

// ─── HTTP Handler ─────────────────────────────────────────────────────

serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Dedup
    const today = todayStr();
    const { data: already } = await supabase.from("health_logs")
      .select("id").eq("log_type", "health_agent_run").eq("log_date", today).limit(1);
    if (already?.length) {
      return new Response(JSON.stringify({ success: true, type: "skipped_duplicate" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    await supabase.from("health_logs").insert({ log_type: "health_agent_run", log_date: today, notes: "react-v2" });

    const result = await runHealthAgent();

    if (result.output && result.success) {
      await sendTG(formatHealthReport(result));
    }

    return new Response(JSON.stringify({
      success: result.success, type: "health_agent_react",
      loops: result.totalLoops, toolCalls: result.totalToolCalls,
      durationMs: result.durationMs, timestamp: today,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Health Agent Error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

function formatHealthReport(result: AgentResult): string {
  let report = `<b>🏋️ HEALTH AGENT — ReAct</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  report += escHTML(result.output.slice(0, 3500));
  report += `\n\n<i>⚡ ${result.totalLoops} loops · ${result.totalToolCalls} tools · ${Math.round(result.durationMs / 1000)}s</i>`;
  if (result.stoppedByGuardrail) report += `\n⚠️ ${escHTML(result.guardrailReason || "")}`;
  return report;
}
