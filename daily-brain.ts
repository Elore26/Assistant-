// ============================================
// DAILY BRAIN — AI Orchestrator for Morning Briefing
// Runs 5min before morning-briefing to generate prioritized daily plan
// Writes to daily_brain table, read by morning-briefing
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { getIsraelNow, todayStr, daysAgo, DAYS_FR } from "../_shared/timezone.ts";
import { callOpenAI } from "../_shared/openai.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async (_req: Request) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelNow();
    const today = todayStr();
    const day = now.getDay();
    const dayName = DAYS_FR[day];

    // Skip Saturday
    if (day === 6) {
      return new Response(JSON.stringify({ success: true, type: "off" }));
    }

    // Dedup: skip if already generated today
    const { data: existing } = await supabase.from("daily_brain")
      .select("id").eq("plan_date", today).limit(1);
    if (existing && existing.length > 0) {
      console.log(`[Daily Brain] Already generated for ${today}, skipping`);
      return new Response(JSON.stringify({ success: true, type: "skipped_duplicate" }));
    }

    // ─── Consume overnight signals ──────────────────────────────
    const signals = getSignalBus("morning-briefing");
    let overnightSignals: { critical: any[]; weakDomain: string | null; yesterdayScore: number | null; patterns: string[]; skillGaps: string[]; interviewAlert: boolean } = {
      critical: [], weakDomain: null, yesterdayScore: null, patterns: [], skillGaps: [], interviewAlert: false,
    };
    try {
      const allSignals = await signals.consume({ markConsumed: true, limit: 30 });
      for (const sig of allSignals) {
        if (sig.priority <= 2) overnightSignals.critical.push(sig);
        if (sig.signal_type === "weak_domain") overnightSignals.weakDomain = sig.payload?.domain || null;
        if (sig.signal_type === "daily_score") overnightSignals.yesterdayScore = sig.payload?.score ?? null;
        if (sig.signal_type === "pattern_detected") overnightSignals.patterns.push(sig.message);
        if (sig.signal_type === "skill_gap") overnightSignals.skillGaps.push(sig.message);
        if (sig.signal_type === "interview_scheduled") overnightSignals.interviewAlert = true;
      }
    } catch (_) {}

    // ─── Fetch context in parallel ───────────────────────────────
    const monthStart = `${today.substring(0, 7)}-01`;
    const [
      yesterdayScoreRes, goalsRes, pipelineRes, leadsRes,
      pendingTasksRes, financeRes, careerVelocityRes, rejectionsRes,
    ] = await Promise.all([
      // Yesterday's evening review score
      supabase.from("briefings").select("content")
        .eq("briefing_type", "evening").eq("briefing_date", daysAgo(1)).limit(1),
      // Active goals
      supabase.from("goals").select("domain, title, metric_current, metric_target, metric_unit, deadline, priority")
        .eq("status", "active").order("priority"),
      // Career pipeline
      supabase.from("job_listings").select("status")
        .in("status", ["new", "applied", "interview", "offer"]),
      // HiGrow leads this month
      supabase.from("leads").select("status")
        .gte("created_at", monthStart),
      // Today's pending tasks
      supabase.from("tasks").select("title, priority, due_time, context")
        .eq("due_date", today).in("status", ["pending", "in_progress"])
        .order("priority").limit(10),
      // Monthly finance
      supabase.from("finance_logs").select("transaction_type, amount")
        .gte("transaction_date", monthStart),
      // Career velocity: applications in last 7 days
      supabase.from("job_listings").select("applied_date")
        .eq("status", "applied").gte("applied_date", daysAgo(7)),
      // Recent rejections (14 days)
      supabase.from("job_listings").select("company, title")
        .eq("status", "rejected")
        .gte("updated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

    // ─── Build context string ────────────────────────────────────
    const goals = goalsRes.data || [];
    const pipeline = pipelineRes.data || [];
    const leads = leadsRes.data || [];
    const tasks = pendingTasksRes.data || [];
    const finance = financeRes.data || [];
    const recentApps = careerVelocityRes.data || [];
    const rejections = rejectionsRes.data || [];

    const newJobs = pipeline.filter(j => j.status === "new").length;
    const appliedJobs = pipeline.filter(j => j.status === "applied").length;
    const interviews = pipeline.filter(j => j.status === "interview").length;
    const convertedLeads = leads.filter(l => l.status === "converted").length;
    const totalLeads = leads.length;

    const monthIncome = finance.filter(f => f.transaction_type === "income").reduce((s, e) => s + e.amount, 0);
    const monthExpense = finance.filter(f => f.transaction_type === "expense").reduce((s, e) => s + e.amount, 0);
    const balance = monthIncome - monthExpense;

    // Career velocity: applications per day over last 7 days
    const appsLast7d = recentApps.length;
    const appVelocity = (appsLast7d / 7).toFixed(1);

    // Calculate required daily apps to hit career goal
    let requiredDailyApps = "N/A";
    const careerGoal = goals.find((g: any) => g.domain === "career");
    if (careerGoal) {
      const target = Number(careerGoal.metric_target) || 50;
      const current = Number(careerGoal.metric_current) || 0;
      const remaining = target - current;
      const daysLeft = careerGoal.deadline
        ? Math.max(1, Math.ceil((new Date(careerGoal.deadline).getTime() - now.getTime()) / 86400000))
        : 60;
      requiredDailyApps = remaining > 0 ? (remaining / daysLeft).toFixed(1) : "0";
    }

    let goalsContext = "";
    for (const g of goals) {
      const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - now.getTime()) / 86400000) : null;
      goalsContext += `- ${g.domain}: ${g.title} (${g.metric_current}/${g.metric_target}${g.metric_unit || ""})`;
      if (daysLeft !== null) goalsContext += ` [${daysLeft}j restants]`;
      goalsContext += "\n";
    }

    let tasksContext = tasks.length > 0
      ? tasks.map(t => `- P${t.priority}: ${t.title}${t.due_time ? ` @${t.due_time.substring(0, 5)}` : ""}`).join("\n")
      : "Aucune tâche planifiée";

    // Build signals context
    let signalsContext = "";
    if (overnightSignals.yesterdayScore !== null) {
      signalsContext += `Score hier: ${overnightSignals.yesterdayScore}/12\n`;
    }
    if (overnightSignals.weakDomain) {
      signalsContext += `⚠️ Domaine faible hier: ${overnightSignals.weakDomain} — à corriger aujourd'hui\n`;
    }
    if (overnightSignals.interviewAlert) {
      signalsContext += `🔴 INTERVIEW EN COURS — Priorité absolue: préparation\n`;
    }
    if (overnightSignals.skillGaps.length > 0) {
      signalsContext += `Compétences à travailler: ${overnightSignals.skillGaps.join(", ")}\n`;
    }
    if (overnightSignals.patterns.length > 0) {
      signalsContext += `Patterns positifs: ${overnightSignals.patterns.join(", ")}\n`;
    }
    if (overnightSignals.critical.length > 0) {
      signalsContext += `Alertes critiques: ${overnightSignals.critical.map(s => s.message).join("; ")}\n`;
    }

    const context = `
Date: ${dayName} ${today}
Heure: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}

OBJECTIFS ACTIFS:
${goalsContext || "Aucun objectif"}

CAREER PIPELINE:
- ${newJobs} offres non postulées
- ${appliedJobs} candidatures en cours
- ${interviews} interviews
- Vélocité: ${appVelocity} candidatures/jour (7j) · Requis: ${requiredDailyApps}/jour
- ${rejections.length} rejets en 14j${rejections.length >= 3 ? " ⚠️ PATTERN" : ""}
${interviews === 0 ? "⚠️ ALERTE: 0 interviews — le volume de candidatures est le goulot" : ""}

HIGROW:
- ${convertedLeads}/${totalLeads > 0 ? totalLeads : "?"} clients convertis ce mois

FINANCE:
- Balance: ${balance > 0 ? "+" : ""}${Math.round(balance)}₪

TÂCHES DU JOUR:
${tasksContext}

SIGNAUX AGENTS (overnight):
${signalsContext || "Aucun signal critique"}

BILAN HIER: ${yesterdayScoreRes.data?.[0]?.content ? "Disponible" : "Non disponible"}
`.trim();

    // ─── Generate AI daily plan ──────────────────────────────────
    const briefingText = await callOpenAI(
      `Tu es OREN, l'assistant IA d'Oren. Génère le briefing du matin en HTML (balises <b>, <i> autorisées).

FORMAT STRICT (utilise exactement ce format):
🔴/🟡/🟢 URGENCE_LEVEL — Domaine prioritaire · Jour Date

💼 Xj deadline, Y interviews · Vélocité Z/jour (requis: W/jour)
🚀 A/B clients, Cj restants
📋 N tâches · WORKOUT_TYPE · 💰 +BALANCE₪

${overnightSignals.weakDomain ? `⚠️ Hier faible en ${overnightSignals.weakDomain} — corrige aujourd'hui` : ""}
${overnightSignals.interviewAlert ? "🔴 INTERVIEW: prep = priorité #1" : ""}

⚡ UNE PHRASE d'action concrète orientée mission.

RÈGLES:
- 🔴 si 0 interviews OU deadline < 30j OU 0 clients HiGrow OU vélocité < requis
- 🟡 si des progrès mais insuffisants
- 🟢 si tout est on-track
- Si vélocité candidatures < requis, le dire explicitement ("Envoie X candidatures aujourd'hui pour rattraper")
- Si des signaux overnight existent, les intégrer dans la recommandation
- La phrase ⚡ doit être SPÉCIFIQUE et ACTIONNABLE (pas "travaille dur")
- Max 8 lignes total, compact, data-driven`,
      context,
      400
    );

    if (!briefingText) {
      console.error("[Daily Brain] OpenAI returned empty");
      return new Response(JSON.stringify({ success: false, error: "empty_ai" }));
    }

    // Determine priority domain (signal-aware)
    let priorityDomain = "career";
    if (overnightSignals.interviewAlert) {
      priorityDomain = "career"; // interview prep is absolute priority
    } else if (interviews === 0 && appliedJobs < 5) {
      priorityDomain = "career";
    } else if (convertedLeads === 0) {
      priorityDomain = "higrow";
    } else if (overnightSignals.weakDomain) {
      priorityDomain = overnightSignals.weakDomain; // correct yesterday's weak domain
    }

    // Determine daily mode (velocity-aware)
    let dailyMode = "normal";
    const velocityBehind = requiredDailyApps !== "N/A" && parseFloat(appVelocity) < parseFloat(requiredDailyApps);
    if (interviews === 0 || convertedLeads === 0 || velocityBehind) dailyMode = "urgence";

    // ─── Write to daily_brain ────────────────────────────────────
    await supabase.from("daily_brain").insert({
      plan_date: today,
      briefing_text: briefingText,
      priority_domain: priorityDomain,
      daily_mode: dailyMode,
    });

    console.log(`[Daily Brain] Generated for ${today}: mode=${dailyMode}, priority=${priorityDomain}`);

    return new Response(JSON.stringify({
      success: true,
      date: today,
      priority_domain: priorityDomain,
      daily_mode: dailyMode,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[Daily Brain] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
