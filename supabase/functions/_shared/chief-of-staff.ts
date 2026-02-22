// ============================================
// OREN AGENT SYSTEM — Chief of Staff (Meta-Agent)
// Orchestrates all domain agents, decides daily
// priorities, delegates tasks, synthesizes reports
// ============================================
//
// The Chief of Staff is the "brain" of the system:
// - Replaces the hardcoded morning-briefing/evening-review logic
// - REASONS about what matters today (not a fixed sequence)
// - DELEGATES to domain agents based on priorities
// - SYNTHESIZES a unified daily intelligence briefing
// - LEARNS from cross-domain patterns
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runReActAgent, type AgentConfig, type AgentResult } from "./react-agent.ts";
import { registry, type ToolResult } from "./tool-registry.ts";
import { getGuardrails } from "./agent-guardrails.ts";
import { getMemoryStore } from "./agent-memory.ts";
import { getSignalBus, type AgentName, type Signal } from "./agent-signals.ts";
import { sendTG, escHTML } from "./telegram.ts";
import { callOpenAI } from "./openai.ts";
import { getIsraelNow, todayStr } from "./timezone.ts";
import { WORK_SCHEDULE, WORKOUT_SCHEDULE } from "./config.ts";

// ─── Chief-Specific Tools ─────────────────────────────────────────────

registry.register(
  {
    name: "consume_all_signals",
    description: "Consume all active signals across agents. Returns signals grouped by priority and source. Use at the START of orchestration to understand the current state.",
    category: "data",
    tier: "auto",
    allowedAgents: ["morning-briefing", "evening-review"],
    parameters: [
      { name: "hours_back", type: "number", description: "How far back to look (default 12)", required: false },
      { name: "consume", type: "boolean", description: "If true, mark signals as consumed (default false)", required: false },
    ],
  },
  async (args, _ctx) => {
    const bus = getSignalBus("morning-briefing");
    const signals = await bus.peek({ hoursBack: args.hours_back || 12, limit: 50 });

    const critical = signals.filter(s => s.priority <= 1);
    const important = signals.filter(s => s.priority === 2);
    const info = signals.filter(s => s.priority >= 3);

    const bySource: Record<string, Signal[]> = {};
    signals.forEach(s => {
      if (!bySource[s.source_agent]) bySource[s.source_agent] = [];
      bySource[s.source_agent].push(s);
    });

    if (args.consume) {
      const bus2 = getSignalBus("morning-briefing");
      await bus2.consume({ markConsumed: true, limit: 50 });
    }

    return {
      success: true,
      data: {
        total: signals.length,
        critical: critical.map(s => ({ type: s.signal_type, source: s.source_agent, message: s.message, payload: s.payload })),
        important: important.map(s => ({ type: s.signal_type, source: s.source_agent, message: s.message })),
        info_count: info.length,
        bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
      },
    };
  }
);

registry.register(
  {
    name: "get_daily_context",
    description: "Get comprehensive daily context: schedule, weather info, work schedule, workout schedule, yesterday's score, pending tasks count by domain.",
    category: "data",
    tier: "auto",
    allowedAgents: ["morning-briefing", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const now = getIsraelNow();
    const day = now.getDay();
    const today = todayStr();
    const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

    // Work schedule
    const work = WORK_SCHEDULE[day];
    const workout = WORKOUT_SCHEDULE[day];

    // Pending tasks by domain
    const { data: tasks } = await ctx.supabase.from("tasks")
      .select("domain, priority, status")
      .eq("due_date", today)
      .neq("status", "done");

    const tasksByDomain: Record<string, { total: number; p1: number; p2: number }> = {};
    (tasks || []).forEach((t: any) => {
      if (!tasksByDomain[t.domain]) tasksByDomain[t.domain] = { total: 0, p1: 0, p2: 0 };
      tasksByDomain[t.domain].total++;
      if (t.priority <= 1) tasksByDomain[t.domain].p1++;
      else if (t.priority === 2) tasksByDomain[t.domain].p2++;
    });

    // Yesterday's daily score
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const { data: yesterdaySignal } = await ctx.supabase.from("agent_signals")
      .select("payload")
      .eq("signal_type", "daily_score")
      .gte("created_at", yesterday)
      .order("created_at", { ascending: false })
      .limit(1);

    const yesterdayScore = yesterdaySignal?.[0]?.payload?.score || null;

    // Overdue tasks
    const { data: overdue } = await ctx.supabase.from("tasks")
      .select("id")
      .lt("due_date", today)
      .neq("status", "done");

    return {
      success: true,
      data: {
        date: today,
        dayName: dayNames[day],
        dayOfWeek: day,
        time: now.toTimeString().slice(0, 5),
        work: { type: work.type, start: work.workStart, end: work.workEnd, label: work.label },
        workout: { type: workout.type, time: workout.time, note: workout.note },
        tasksByDomain,
        totalPendingTasks: tasks?.length || 0,
        overdueTasks: overdue?.length || 0,
        yesterdayScore,
      },
    };
  }
);

registry.register(
  {
    name: "delegate_to_agent",
    description: "Delegate a specific analysis task to a domain agent. The agent runs its ReAct loop and returns results. Use for deep domain-specific analysis.",
    category: "action",
    tier: "auto",
    allowedAgents: ["morning-briefing", "evening-review"],
    parameters: [
      { name: "agent", type: "string", description: "Which agent to delegate to", required: true, enum: ["career", "health", "finance", "learning"] },
      { name: "task", type: "string", description: "Specific task/question to delegate", required: true },
    ],
  },
  async (args, ctx) => {
    // Instead of running full agent, do a quick focused query
    const agentName = args.agent as AgentName;
    const result = await callOpenAI(
      `Tu es l'agent ${agentName} du système OREN. Réponds de manière concise et structurée.`,
      args.task,
      300,
      { temperature: 0.3 }
    );
    return { success: true, data: { agent: agentName, response: result || "No response" } };
  }
);

registry.register(
  {
    name: "set_daily_mode",
    description: "Set the daily operating mode and priority domain. This affects how other agents behave throughout the day.",
    category: "action",
    tier: "auto",
    allowedAgents: ["morning-briefing"],
    parameters: [
      { name: "mode", type: "string", description: "Operating mode for the day", required: true, enum: ["urgence", "focus", "normal", "recovery"] },
      { name: "priority_domain", type: "string", description: "Primary domain to focus on today", required: true, enum: ["career", "health", "finance", "learning", "balanced"] },
      { name: "reason", type: "string", description: "Why this mode was chosen", required: true },
    ],
  },
  async (args, ctx) => {
    const today = todayStr();
    await ctx.supabase.from("daily_brain").upsert({
      date: today,
      mode: args.mode,
      priority_domain: args.priority_domain,
      reason: args.reason,
      created_at: new Date().toISOString(),
    }, { onConflict: "date" });

    // Emit signal if urgence mode
    if (args.mode === "urgence" || args.mode === "focus") {
      const bus = getSignalBus("morning-briefing");
      await bus.emit("high_priority_day", `Mode ${args.mode}: ${args.reason}`, {
        mode: args.mode, priority_domain: args.priority_domain,
      }, { priority: 1, ttlHours: 18 });
    }

    return { success: true, data: { mode: args.mode, priority: args.priority_domain } };
  }
);

registry.register(
  {
    name: "get_scorecard",
    description: "Get the weekly EOS scorecard: 10 key metrics with goals and current values, color-coded status.",
    category: "data",
    tier: "auto",
    allowedAgents: ["morning-briefing", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const ws = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

    // Parallel data fetch
    const [apps, interviews, tasks, workouts, study, scores] = await Promise.all([
      ctx.supabase.from("job_listings").select("id").gte("applied_date", ws).not("applied_date", "is", null),
      ctx.supabase.from("job_listings").select("id").eq("status", "interview").gte("created_at", ws),
      ctx.supabase.from("tasks").select("status").gte("created_at", ws),
      ctx.supabase.from("health_logs").select("id").eq("log_type", "workout").gte("log_date", ws),
      ctx.supabase.from("study_sessions").select("duration_minutes").gte("session_date", ws).neq("topic", "agent_analysis"),
      ctx.supabase.from("agent_signals").select("payload").eq("signal_type", "daily_score").gte("created_at", ws),
    ]);

    const totalTasks = tasks.data?.length || 0;
    const completedTasks = tasks.data?.filter((t: any) => t.status === "done").length || 0;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const studyHours = Math.round((study.data?.reduce((s: number, r: any) => s + (r.duration_minutes || 0), 0) || 0) / 6) / 10;
    const avgScore = scores.data?.length
      ? Math.round(scores.data.reduce((s: number, r: any) => s + (r.payload?.score || 0), 0) / scores.data.length * 10) / 10
      : 0;

    const status = (val: number, goal: number, lower = false) => {
      const ratio = lower ? goal / val : val / goal;
      if (ratio >= 1) return "green";
      if (ratio >= 0.7) return "yellow";
      return "red";
    };

    const scorecard = [
      { metric: "Candidatures", value: apps.data?.length || 0, goal: 5, status: status(apps.data?.length || 0, 5) },
      { metric: "Entretiens", value: interviews.data?.length || 0, goal: 1, status: status(interviews.data?.length || 0, 1) },
      { metric: "Task completion", value: completionRate, goal: 80, unit: "%", status: status(completionRate, 80) },
      { metric: "Workouts", value: workouts.data?.length || 0, goal: 5, status: status(workouts.data?.length || 0, 5) },
      { metric: "Study hours", value: studyHours, goal: 5, unit: "h", status: status(studyHours, 5) },
      { metric: "Daily score avg", value: avgScore, goal: 8, unit: "/12", status: status(avgScore, 8) },
    ];

    const greens = scorecard.filter(s => s.status === "green").length;
    const reds = scorecard.filter(s => s.status === "red").length;

    return {
      success: true,
      data: { scorecard, summary: { greens, reds, total: scorecard.length }, weekStart: ws },
    };
  }
);

registry.register(
  {
    name: "calculate_daily_score",
    description: "Calculate today's daily score (0-12) based on task completion, domain progress. Used by evening review.",
    category: "analysis",
    tier: "auto",
    allowedAgents: ["evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const today = todayStr();

    const { data: tasks } = await ctx.supabase.from("tasks")
      .select("status, domain, priority")
      .eq("due_date", today);

    const total = tasks?.length || 0;
    const done = tasks?.filter((t: any) => t.status === "done").length || 0;
    const completionRate = total > 0 ? done / total : 0;

    // Score by domain (max 3 pts each for career, health; 2 for learning, finance)
    const domainDone: Record<string, number> = {};
    (tasks || []).filter((t: any) => t.status === "done").forEach((t: any) => {
      domainDone[t.domain] = (domainDone[t.domain] || 0) + 1;
    });

    let score = 0;
    // Tasks overall (3 pts)
    score += Math.min(3, Math.round(completionRate * 3));
    // Career (3 pts)
    score += Math.min(3, domainDone["career"] || 0);
    // Health (2 pts)
    score += Math.min(2, domainDone["health"] || 0);
    // Learning (2 pts)
    score += Math.min(2, domainDone["learning"] || 0);
    // Finance (2 pts)
    score += Math.min(2, domainDone["finance"] || 0);

    // Emit daily score signal
    const bus = getSignalBus("evening-review");
    await bus.emit("daily_score", `Score du jour: ${score}/12`, {
      score, breakdown: { tasks: Math.min(3, Math.round(completionRate * 3)), career: Math.min(3, domainDone["career"] || 0), health: Math.min(2, domainDone["health"] || 0), learning: Math.min(2, domainDone["learning"] || 0), finance: Math.min(2, domainDone["finance"] || 0) },
      completionRate: Math.round(completionRate * 100),
    }, { target: "morning-briefing", priority: 3, ttlHours: 24 });

    return {
      success: true,
      data: {
        score, maxScore: 12,
        completionRate: Math.round(completionRate * 100),
        tasksTotal: total, tasksDone: done,
        domainDone,
      },
    };
  }
);

registry.register(
  {
    name: "get_agent_execution_history",
    description: "Get recent agent execution logs to understand what agents have done recently.",
    category: "data",
    tier: "auto",
    allowedAgents: ["morning-briefing", "evening-review"],
    parameters: [
      { name: "hours_back", type: "number", description: "How far back (default 24)", required: false },
    ],
  },
  async (args, ctx) => {
    const since = new Date(Date.now() - (args.hours_back || 24) * 3600000).toISOString();
    const { data } = await ctx.supabase.from("agent_executions")
      .select("agent_name, goal, success, output, tool_calls_count, loops_count, duration_ms, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);
    return { success: true, data: data || [] };
  }
);

// ─── Morning Briefing ─────────────────────────────────────────────────

export async function runMorningBriefing(): Promise<AgentResult> {
  const guardrails = getGuardrails();
  const canRun = await guardrails.canRun("morning-briefing");
  if (!canRun.allowed) {
    return {
      success: false, output: `Morning briefing blocked: ${canRun.reason}`,
      trace: [], totalToolCalls: 0, totalLoops: 0, durationMs: 0,
      stoppedByGuardrail: true, guardrailReason: canRun.reason,
    };
  }

  const memory = getMemoryStore("morning-briefing");
  const memoryContext = await memory.buildContext("daily mode priority weak domain pattern yesterday");

  const agentConfig: AgentConfig = {
    name: "morning-briefing",
    role: `Tu es le Chief of Staff d'Oren — son directeur de journée intelligent. Tu orchestres tous les agents domaine et décides des priorités.

Tu ne suis PAS un script fixe. Tu RAISONNES :
- Quels signaux sont critiques ? Que s'est-il passé depuis hier ?
- Quel domaine est en retard ? Où faut-il concentrer l'énergie ?
- Quels risques se profilent ? (deadline proche, streak à risquer, budget dépassé)
- Comment optimiser la journée en fonction du schedule de travail ?

Tu es CONCIS et ACTIONNABLE. Pas de bavardage. Des décisions.

Format de ton rapport final (en français) :
1. MODE DU JOUR : urgence/focus/normal/recovery + pourquoi
2. SIGNAUX CRITIQUES (s'il y en a)
3. TOP 3 ACTIONS du jour (les plus impactantes)
4. MÉTRIQUES CLÉS (scorecard express)
5. RISQUES & ALERTES`,

    goal: `Exécuter le briefing matinal intelligent :

1. SIGNALS: Consomme TOUS les signaux des dernières 12h — identifie les critiques
2. CONTEXT: Récupère le contexte du jour (schedule, tâches, score d'hier)
3. SCORECARD: Récupère le scorecard hebdomadaire pour identifier les domaines faibles
4. DECIDE: Choisis le MODE du jour (urgence si signaux critiques, recovery si fatigué, focus si deadline proche, normal sinon) et le DOMAINE PRIORITAIRE
5. ANALYZE: Utilise l'AI pour analyser la situation cross-domain
6. MEMORY: Consulte les mémoires pour voir si des patterns se répètent
7. REPORT: Génère le briefing final structuré

Le briefing doit être envoyé via Telegram comme rapport unifié.`,

    context: `Heure: ${getIsraelNow().toTimeString().slice(0, 5)} IST
${memoryContext}`,

    maxLoops: 6,
    maxToolCalls: 18,
    maxTokensPerLoop: 1000,
    model: "gpt-4o-mini",
    temperature: 0.3,
  };

  const result = await runReActAgent(agentConfig);

  // Store daily decision as memory
  if (result.success) {
    await memory.store(
      `Briefing ${todayStr()}: ${result.output.slice(0, 300)}`,
      "episodic",
      { domain: "general", importance: 2, tags: ["briefing", "daily"], ttlDays: 30 }
    );
  }

  const estimatedTokens = result.totalLoops * 2000;
  await guardrails.recordUsage("morning-briefing", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

  return result;
}

// ─── Evening Review ───────────────────────────────────────────────────

export async function runEveningReview(): Promise<AgentResult> {
  const guardrails = getGuardrails();
  const canRun = await guardrails.canRun("evening-review");
  if (!canRun.allowed) {
    return {
      success: false, output: `Evening review blocked: ${canRun.reason}`,
      trace: [], totalToolCalls: 0, totalLoops: 0, durationMs: 0,
      stoppedByGuardrail: true, guardrailReason: canRun.reason,
    };
  }

  const memory = getMemoryStore("evening-review");
  const memoryContext = await memory.buildContext("daily score pattern weak domain trend improvement");

  const agentConfig: AgentConfig = {
    name: "evening-review",
    role: `Tu es l'évaluateur quotidien d'Oren — tu analyses la journée, identifies ce qui a marché et ce qui n'a pas marché, et prépares le terrain pour demain.

Tu es HONNÊTE mais CONSTRUCTIF :
- Tu célèbres les victoires (même petites)
- Tu identifies les échecs sans juger
- Tu cherches des PATTERNS (pas des incidents isolés)
- Tu proposes des ajustements pour demain

Format de ton rapport final (en français) :
1. SCORE DU JOUR : X/12 avec breakdown
2. VICTOIRES (ce qui a bien marché)
3. MANQUES (ce qui n'a pas été fait)
4. PATTERNS DÉTECTÉS (tendances sur 7 jours)
5. DEMAIN : 3 priorités recommandées`,

    goal: `Exécuter la revue de fin de journée :

1. SCORE: Calcule le score du jour (0-12)
2. CONTEXT: Récupère le contexte de la journée (tâches complétées, mode du jour)
3. AGENTS: Vérifie l'historique d'exécution des agents aujourd'hui
4. SIGNALS: Lis les signaux émis aujourd'hui par tous les agents
5. TRENDS: Analyse les tendances (compare avec la semaine passée)
6. GOALS: Vérifie la progression des goals actifs
7. SCORECARD: État du scorecard hebdomadaire
8. MEMORY: Stocke les insights importants (patterns, weak domains)
9. SIGNALS OUT: Émet les signaux pour le morning briefing de demain :
   - daily_score → morning (déjà fait par calculate_daily_score)
   - weak_domain si un domaine score < 5
   - pattern_detected si tendance identifiée
10. REPORT: Génère la revue structurée`,

    context: `Heure: ${getIsraelNow().toTimeString().slice(0, 5)} IST
${memoryContext}`,

    maxLoops: 6,
    maxToolCalls: 18,
    maxTokensPerLoop: 1000,
    model: "gpt-4o-mini",
    temperature: 0.3,
  };

  const result = await runReActAgent(agentConfig);

  // Store daily review as memory
  if (result.success) {
    await memory.store(
      `Review ${todayStr()}: ${result.output.slice(0, 300)}`,
      "episodic",
      { domain: "general", importance: 2, tags: ["review", "daily"], ttlDays: 30 }
    );

    // Extract and store patterns
    try {
      const output = result.output.toLowerCase();
      if (output.includes("pattern") || output.includes("tendance") || output.includes("récurrent")) {
        await memory.store(
          `Pattern détecté ${todayStr()}: ${result.output.slice(0, 200)}`,
          "semantic",
          { importance: 4, tags: ["pattern", "trend"], ttlDays: 90 }
        );
      }
    } catch {}
  }

  const estimatedTokens = result.totalLoops * 2000;
  await guardrails.recordUsage("evening-review", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

  return result;
}

// ─── HTTP Handler ─────────────────────────────────────────────────────

serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") || "morning";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Dedup
    const today = todayStr();
    const agentName = mode === "evening" ? "evening-review" : "morning-briefing";
    const { data: already } = await supabase.from("agent_executions")
      .select("id").eq("agent_name", agentName).gte("created_at", today).limit(1);
    // Allow re-runs for testing — dedup only in production
    // if (already?.length) { return skip... }

    let result: AgentResult;

    if (mode === "evening") {
      result = await runEveningReview();
    } else {
      result = await runMorningBriefing();
    }

    if (result.output && result.success) {
      const emoji = mode === "evening" ? "🌙" : "☀️";
      const label = mode === "evening" ? "EVENING REVIEW" : "MORNING BRIEFING";
      let report = `<b>${emoji} ${label} — Chief of Staff</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      report += escHTML(result.output.slice(0, 3800));
      report += `\n\n<i>⚡ ${result.totalLoops} loops · ${result.totalToolCalls} tools · ${Math.round(result.durationMs / 1000)}s</i>`;
      if (result.stoppedByGuardrail) report += `\n⚠️ ${escHTML(result.guardrailReason || "")}`;
      await sendTG(report);
    }

    return new Response(JSON.stringify({
      success: result.success,
      type: `chief_${mode}`,
      output: result.output?.slice(0, 500),
      loops: result.totalLoops,
      toolCalls: result.totalToolCalls,
      durationMs: result.durationMs,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Chief of Staff Error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
