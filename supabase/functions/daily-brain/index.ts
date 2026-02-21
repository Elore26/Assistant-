// ============================================
// DAILY BRAIN — AI Orchestrator for Morning Briefing
// Runs 5min before morning-briefing to generate prioritized daily plan
// Writes to daily_brain table, read by morning-briefing
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

function dateStr(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number): string {
  const d = new Date(getIsraelNow().getTime() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function callOpenAI(systemPrompt: string, userContent: string, maxTokens = 500): Promise<string> {
  if (!OPENAI_API_KEY) return "";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0.7, max_tokens: maxTokens,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) { console.error("OpenAI error:", e); return ""; }
}

const DAYS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

serve(async (_req: Request) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelNow();
    const today = dateStr();
    const day = now.getDay();
    const dayName = DAYS[day];

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

    // ─── Fetch context in parallel ───────────────────────────────
    const monthStart = `${today.substring(0, 7)}-01`;
    const [
      yesterdayScoreRes, goalsRes, pipelineRes, leadsRes,
      pendingTasksRes, financeRes,
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
    ]);

    // ─── Build context string ────────────────────────────────────
    const goals = goalsRes.data || [];
    const pipeline = pipelineRes.data || [];
    const leads = leadsRes.data || [];
    const tasks = pendingTasksRes.data || [];
    const finance = financeRes.data || [];

    const newJobs = pipeline.filter(j => j.status === "new").length;
    const appliedJobs = pipeline.filter(j => j.status === "applied").length;
    const interviews = pipeline.filter(j => j.status === "interview").length;
    const convertedLeads = leads.filter(l => l.status === "converted").length;
    const totalLeads = leads.length;

    const monthIncome = finance.filter(f => f.transaction_type === "income").reduce((s, e) => s + e.amount, 0);
    const monthExpense = finance.filter(f => f.transaction_type === "expense").reduce((s, e) => s + e.amount, 0);
    const balance = monthIncome - monthExpense;

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

    const context = `
Date: ${dayName} ${today}
Heure: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}

OBJECTIFS ACTIFS:
${goalsContext || "Aucun objectif"}

CAREER PIPELINE:
- ${newJobs} offres non postulées
- ${appliedJobs} candidatures en cours
- ${interviews} interviews
${interviews === 0 ? "⚠️ ALERTE: 0 interviews — le volume de candidatures est le goulot" : ""}

HIGROW:
- ${convertedLeads}/${totalLeads > 0 ? totalLeads : "?"} clients convertis ce mois

FINANCE:
- Balance: ${balance > 0 ? "+" : ""}${Math.round(balance)}₪

TÂCHES DU JOUR:
${tasksContext}

BILAN HIER: ${yesterdayScoreRes.data?.[0]?.content ? "Disponible" : "Non disponible"}
`.trim();

    // ─── Generate AI daily plan ──────────────────────────────────
    const briefingText = await callOpenAI(
      `Tu es OREN, l'assistant IA d'Oren. Génère le briefing du matin en HTML (balises <b>, <i> autorisées).

FORMAT STRICT (utilise exactement ce format):
🔴/🟡/🟢 URGENCE_LEVEL — Domaine prioritaire · Jour Date

💼 Xj deadline, Y interviews
🚀 A/B clients, Cj restants
📋 N tâches · WORKOUT_TYPE · 💰 +BALANCE₪

⚡ UNE PHRASE d'action concrète orientée mission.

RÈGLES:
- 🔴 si 0 interviews OU deadline < 30j OU 0 clients HiGrow
- 🟡 si des progrès mais insuffisants
- 🟢 si tout est on-track
- La phrase ⚡ doit être SPÉCIFIQUE et ACTIONNABLE (pas "travaille dur")
- Max 6 lignes total, compact, data-driven`,
      context,
      300
    );

    if (!briefingText) {
      console.error("[Daily Brain] OpenAI returned empty");
      return new Response(JSON.stringify({ success: false, error: "empty_ai" }));
    }

    // Determine priority domain
    let priorityDomain = "career";
    if (interviews === 0 && appliedJobs < 5) priorityDomain = "career";
    else if (convertedLeads === 0) priorityDomain = "higrow";

    // Determine daily mode
    let dailyMode = "normal";
    if (interviews === 0 || convertedLeads === 0) dailyMode = "urgence";

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
