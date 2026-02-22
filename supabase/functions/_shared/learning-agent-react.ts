// ============================================
// OREN AGENT SYSTEM — Learning Agent (ReAct)
// Agentic study coach: streaks, skill-gap driven
// learning, resource management, interview prep
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runReActAgent, type AgentConfig, type AgentResult } from "./react-agent.ts";
import { registry } from "./tool-registry.ts";
import { getGuardrails } from "./agent-guardrails.ts";
import { getMemoryStore } from "./agent-memory.ts";
import { sendTG, escHTML } from "./telegram.ts";
import { getIsraelNow, todayStr } from "./timezone.ts";

// ─── Learning-Specific Tools ─────────────────────────────────────────

registry.register(
  {
    name: "get_study_streak",
    description: "Calculate the current study streak (consecutive days with at least one study session logged). Also returns the longest streak ever.",
    category: "data",
    tier: "auto",
    allowedAgents: ["learning", "morning-briefing", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { data } = await ctx.supabase.from("study_sessions")
      .select("session_date")
      .order("session_date", { ascending: false })
      .limit(60);

    if (!data?.length) return { success: true, data: { streak: 0, longestStreak: 0, lastStudy: null } };

    const dates = [...new Set(data.map((d: any) => d.session_date))].sort().reverse();
    const today = todayStr();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

    let streak = 0;
    if (dates[0] === today || dates[0] === yesterday) {
      for (let i = 0; i < dates.length; i++) {
        const offset = i + (dates[0] === yesterday ? 1 : 0);
        const expected = new Date(Date.now() - offset * 86400000).toISOString().split("T")[0];
        if (dates[i] === expected) streak++;
        else break;
      }
    }

    // Longest streak ever
    const allDates = dates.sort();
    let longest = 0, current = 1;
    for (let i = 1; i < allDates.length; i++) {
      const prev = new Date(allDates[i - 1]).getTime();
      const curr = new Date(allDates[i]).getTime();
      if (curr - prev === 86400000) { current++; longest = Math.max(longest, current); }
      else { current = 1; }
    }
    longest = Math.max(longest, current);

    return { success: true, data: { streak, longestStreak: longest, lastStudy: dates[0] } };
  }
);

registry.register(
  {
    name: "get_study_summary",
    description: "Get study sessions summary: total hours, topic breakdown, sessions count for a period.",
    category: "data",
    tier: "auto",
    allowedAgents: ["learning", "evening-review"],
    parameters: [
      { name: "days", type: "number", description: "Period in days (default 7)", required: false },
    ],
  },
  async (args, ctx) => {
    const days = args.days || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
    const { data } = await ctx.supabase.from("study_sessions")
      .select("*").gte("session_date", since).neq("topic", "agent_analysis");

    const sessions = data || [];
    const totalMinutes = sessions.reduce((s: number, r: any) => s + (r.duration_minutes || 0), 0);
    const byTopic: Record<string, { hours: number; sessions: number }> = {};
    sessions.forEach((s: any) => {
      const topic = s.topic || "other";
      if (!byTopic[topic]) byTopic[topic] = { hours: 0, sessions: 0 };
      byTopic[topic].hours += (s.duration_minutes || 0) / 60;
      byTopic[topic].sessions += 1;
    });

    // Round hours
    Object.keys(byTopic).forEach(k => {
      byTopic[k].hours = Math.round(byTopic[k].hours * 10) / 10;
    });

    return {
      success: true,
      data: {
        totalHours: Math.round(totalMinutes / 6) / 10, // 1 decimal
        totalSessions: sessions.length,
        byTopic,
        studiedToday: sessions.some((s: any) => s.session_date === todayStr()),
      },
    };
  }
);

registry.register(
  {
    name: "get_learning_resources",
    description: "Get learning resources with their status (in_progress, completed, todo).",
    category: "data",
    tier: "auto",
    allowedAgents: ["learning"],
    parameters: [
      { name: "status", type: "string", description: "Filter by status", required: false, enum: ["in_progress", "completed", "todo"] },
      { name: "topic", type: "string", description: "Filter by topic", required: false },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("learning_resources").select("*");
    if (args.status) query = query.eq("status", args.status);
    if (args.topic) query = query.ilike("topic", `%${args.topic}%`);
    query = query.order("created_at", { ascending: false }).limit(20);
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data: data || [] };
  }
);

registry.register(
  {
    name: "consume_skill_gap_signals",
    description: "Consume skill_gap and interview_scheduled signals from Career Agent. Creates learning tasks for identified skill gaps. Returns what was consumed and what tasks were created.",
    category: "action",
    tier: "auto",
    allowedAgents: ["learning"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { getSignalBus } = await import("./agent-signals.ts");
    const bus = getSignalBus("learning");

    // Peek at skill gaps and interview signals
    const skillGaps = await bus.peek({ types: ["skill_gap"], hoursBack: 48, limit: 10 });
    const interviews = await bus.peek({ types: ["interview_scheduled"], hoursBack: 72, limit: 5 });

    const tasksCreated: string[] = [];
    const today = todayStr();

    // Process skill gaps → create learning tasks
    for (const gap of skillGaps) {
      const skill = gap.payload?.skill || "unknown";
      const pct = gap.payload?.percentage || 0;

      // Check for existing task
      const { data: existing } = await ctx.supabase.from("tasks")
        .select("id").eq("context", `skill_gap_${skill}`).neq("status", "done").limit(1);
      if (existing?.length) continue;

      const { error } = await ctx.supabase.from("tasks").insert({
        title: `📚 Apprendre ${skill} (demandé dans ${pct}% des offres)`,
        domain: "learning", priority: 2, due_date: today,
        context: `skill_gap_${skill}`, status: "pending", agent_type: "learning",
      });
      if (!error) tasksCreated.push(skill);

      // Mark signal consumed
      if (gap.id) await bus.dismiss(gap.id);
    }

    // Process interview signals → create prep tasks
    for (const interview of interviews) {
      const companies = interview.payload?.companies || [];
      const key = `interview_prep_learning_${companies.join("_")}`;

      const { data: existing } = await ctx.supabase.from("tasks")
        .select("id").eq("context", key).neq("status", "done").limit(1);
      if (existing?.length) continue;

      const prepTasks = [
        `🗣 Pratique English (interview ${companies.join(", ")})`,
        `💼 Révise négociation salariale`,
        `🎯 Prépare pitch STAR stories`,
      ];

      for (const title of prepTasks) {
        await ctx.supabase.from("tasks").insert({
          title, domain: "learning", priority: 1, due_date: today,
          context: key, status: "pending", agent_type: "learning",
        });
      }
      tasksCreated.push(`interview_prep(${companies.join(",")})`);
    }

    return {
      success: true,
      data: {
        skillGapsFound: skillGaps.length,
        interviewsFound: interviews.length,
        tasksCreated,
      },
    };
  }
);

registry.register(
  {
    name: "get_learning_goal",
    description: "Get active learning goal with progress, deadline, and daily target.",
    category: "data",
    tier: "auto",
    allowedAgents: ["learning", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { data } = await ctx.supabase.from("goals")
      .select("*")
      .eq("domain", "learning")
      .eq("status", "active")
      .limit(1);

    if (!data?.length) return { success: true, data: null };

    const goal = data[0];
    const progress = goal.metric_target > 0
      ? Math.round((goal.metric_current / goal.metric_target) * 100)
      : 0;

    // Calculate daily target
    const deadlineMs = goal.deadline ? new Date(goal.deadline).getTime() - Date.now() : 0;
    const daysRemaining = Math.max(1, Math.ceil(deadlineMs / 86400000));
    const remaining = Math.max(0, goal.metric_target - goal.metric_current);
    const dailyTarget = Math.round((remaining / daysRemaining) * 10) / 10;

    return {
      success: true,
      data: {
        ...goal,
        progress,
        daysRemaining,
        dailyTarget,
        onTrack: progress >= (100 * (1 - daysRemaining / 90)), // rough check
      },
    };
  }
);

// ─── Main Handler ─────────────────────────────────────────────────────

export async function runLearningAgent(): Promise<AgentResult> {
  const guardrails = getGuardrails();
  const canRun = await guardrails.canRun("learning");
  if (!canRun.allowed) {
    return {
      success: false, output: `Learning agent blocked: ${canRun.reason}`,
      trace: [], totalToolCalls: 0, totalLoops: 0, durationMs: 0,
      stoppedByGuardrail: true, guardrailReason: canRun.reason,
    };
  }

  const isSunday = getIsraelNow().getDay() === 0;
  const focusTopics = Deno.env.get("LEARNING_FOCUS") || "English, Product Management, AI";
  const memory = getMemoryStore("learning");
  const memoryContext = await memory.buildContext("study streak skill gap learning progress", "learning");

  const agentConfig: AgentConfig = {
    name: "learning",
    role: `Tu es le tuteur personnel d'Oren. Tu gères son apprentissage continu avec un focus sur : ${focusTopics}.

Tu es MOTIVANT et STRATÉGIQUE :
- Tu célèbres les streaks d'étude (chaque jour compte)
- Tu connectes les skill gaps (signaux career) aux ressources d'apprentissage
- Tu priorises l'apprentissage par l'impact carrière (interviews à venir = priorité English)
- Tu proposes des ressources CONCRÈTES (pas juste "étudie plus")

Style: Encourageant, structuré, orienté progression.`,

    goal: `Exécuter le cycle quotidien de l'agent learning :

1. STREAK: Calcule le streak d'étude actuel et le record
2. SUMMARY: Récupère le résumé d'étude (heures, topics, sessions sur 7j)
3. SIGNALS: Consomme les signaux skill_gap et interview_scheduled du Career Agent → crée des tâches d'apprentissage ciblées
4. GOAL: Vérifie le progrès vers l'objectif learning (heures/mois)
5. RESOURCES: Liste les ressources en cours et complétées
6. EMIT SIGNALS:
   - study_streak si streak >= 3 jours (priorité 4)
   - skill_improved si une ressource complétée récemment (priorité 3)
7. MEMORY: Stocke les insights (quels topics marchent, quand Oren étudie le mieux)
8. REPORT: Produis un résumé motivant avec streak, progrès, et next actions
   - Si pas étudié aujourd'hui → nudge motivant
   - Si étudié → célébration + suggestion de suite${isSunday ? "\n9. WEEKLY: Bilan hebdomadaire — heures, topics, recommandations concrètes pour la semaine prochaine" : ""}`,

    context: `Date: ${todayStr()} (${["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][getIsraelNow().getDay()]})
Focus topics: ${focusTopics}
${memoryContext}`,

    maxLoops: 5,
    maxToolCalls: 15,
    maxTokensPerLoop: 800,
    model: "gpt-4o-mini",
    temperature: 0.4,
  };

  const result = await runReActAgent(agentConfig);

  // Store learning insights as memory
  if (result.success && result.output) {
    try {
      const output = result.output.toLowerCase();
      if (output.includes("streak") && (output.includes("record") || output.includes("nouveau"))) {
        await memory.store(`Streak d'étude record: ${result.output.slice(0, 200)}`, "episodic", {
          domain: "learning", importance: 4, tags: ["streak", "record"],
        });
      }
      if (output.includes("skill gap") || output.includes("compétence")) {
        await memory.store(`Skill gap identifié: ${result.output.slice(0, 200)}`, "semantic", {
          domain: "learning", importance: 3, tags: ["skill_gap"],
        });
      }
    } catch {}
  }

  const estimatedTokens = result.totalLoops * 1500;
  await guardrails.recordUsage("learning", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

  return result;
}

// ─── HTTP Handler ─────────────────────────────────────────────────────

serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const today = todayStr();
    const { data: already } = await supabase.from("agent_executions")
      .select("id").eq("agent_name", "learning").gte("created_at", today).limit(1);
    if (already?.length) {
      return new Response(JSON.stringify({ success: true, type: "skipped_duplicate" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await runLearningAgent();

    if (result.output && result.success) {
      await sendTG(formatLearningReport(result));
    }

    return new Response(JSON.stringify({
      success: result.success, type: "learning_agent_react",
      loops: result.totalLoops, toolCalls: result.totalToolCalls,
      durationMs: result.durationMs, timestamp: today,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Learning Agent Error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

function formatLearningReport(result: AgentResult): string {
  let report = `<b>📚 LEARNING AGENT — ReAct</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  report += escHTML(result.output.slice(0, 3500));
  report += `\n\n<i>⚡ ${result.totalLoops} loops · ${result.totalToolCalls} tools · ${Math.round(result.durationMs / 1000)}s</i>`;
  if (result.stoppedByGuardrail) report += `\n⚠️ ${escHTML(result.guardrailReason || "")}`;
  return report;
}
