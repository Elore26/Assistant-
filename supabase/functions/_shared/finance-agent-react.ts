// ============================================
// OREN AGENT SYSTEM — Finance Agent (ReAct)
// Agentic financial advisor: budget monitoring,
// spending analysis, savings optimization
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runReActAgent, type AgentConfig, type AgentResult } from "./react-agent.ts";
import { registry } from "./tool-registry.ts";
import { getGuardrails } from "./agent-guardrails.ts";
import { getMemoryStore } from "./agent-memory.ts";
import { sendTG, escHTML } from "./telegram.ts";
import { getIsraelNow, todayStr } from "./timezone.ts";

// ─── Finance-Specific Tools ──────────────────────────────────────────

registry.register(
  {
    name: "get_monthly_summary",
    description: "Get current month's financial summary: income, expenses, balance, savings rate, daily budget remaining.",
    category: "data",
    tier: "auto",
    allowedAgents: ["finance", "morning-briefing", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const now = getIsraelNow();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const today = todayStr();

    const { data: logs } = await ctx.supabase.from("finance_logs")
      .select("*")
      .gte("transaction_date", monthStart)
      .lte("transaction_date", today);

    if (!logs) return { success: false, error: "Failed to fetch finance logs" };

    const income = logs.filter((l: any) => l.transaction_type === "income")
      .reduce((s: number, l: any) => s + (l.amount || 0), 0);
    const expenses = logs.filter((l: any) => l.transaction_type === "expense")
      .reduce((s: number, l: any) => s + (l.amount || 0), 0);

    const balance = income - expenses;
    const savingsRate = income > 0 ? Math.round((balance / income) * 100) : 0;

    // Days remaining in month
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;
    const dailyBudget = daysRemaining > 0 ? Math.round(balance / daysRemaining) : 0;

    // Category breakdown
    const byCategory: Record<string, number> = {};
    logs.filter((l: any) => l.transaction_type === "expense").forEach((l: any) => {
      byCategory[l.category || "other"] = (byCategory[l.category || "other"] || 0) + l.amount;
    });

    // Payment method split
    const byCash = logs.filter((l: any) => l.transaction_type === "expense" && l.payment_method === "cash")
      .reduce((s: number, l: any) => s + l.amount, 0);
    const cashPct = expenses > 0 ? Math.round((byCash / expenses) * 100) : 0;

    return {
      success: true,
      data: {
        income, expenses, balance, savingsRate, dailyBudget, daysRemaining,
        byCategory,
        cashPct,
        targetSavingsRate: 20,
        onTrack: savingsRate >= 20,
      },
    };
  }
);

registry.register(
  {
    name: "get_category_budgets",
    description: "Get budget status per spending category: limit, spent, remaining, alert status (green/yellow/red/over).",
    category: "data",
    tier: "auto",
    allowedAgents: ["finance", "evening-review"],
    parameters: [],
  },
  async (_args, ctx) => {
    const now = getIsraelNow();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const [budgets, expenses] = await Promise.all([
      ctx.supabase.from("category_budgets").select("*"),
      ctx.supabase.from("finance_logs")
        .select("category, amount")
        .eq("transaction_type", "expense")
        .gte("transaction_date", monthStart),
    ]);

    if (!budgets.data) return { success: false, error: "Failed to fetch budgets" };

    const spentByCategory: Record<string, number> = {};
    (expenses.data || []).forEach((e: any) => {
      spentByCategory[e.category || "other"] = (spentByCategory[e.category || "other"] || 0) + e.amount;
    });

    const result = (budgets.data || []).map((b: any) => {
      const spent = spentByCategory[b.category] || 0;
      const pct = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
      const remaining = b.monthly_limit - spent;
      let status = "green";
      if (pct >= 100) status = "over";
      else if (pct >= (b.alert_threshold_pct || 80)) status = "red";
      else if (pct >= 70) status = "yellow";

      return { category: b.category, limit: b.monthly_limit, spent, remaining, pct, status };
    });

    return { success: true, data: result };
  }
);

registry.register(
  {
    name: "get_spending_trend",
    description: "Compare spending between this week and last week, or this month vs last month.",
    category: "analysis",
    tier: "auto",
    allowedAgents: ["finance", "evening-review"],
    parameters: [
      { name: "period", type: "string", description: "Comparison period", required: true, enum: ["week", "month"] },
    ],
  },
  async (args, ctx) => {
    const now = Date.now();
    let currentStart: string, previousStart: string, previousEnd: string;

    if (args.period === "week") {
      currentStart = new Date(now - 7 * 86400000).toISOString().split("T")[0];
      previousStart = new Date(now - 14 * 86400000).toISOString().split("T")[0];
      previousEnd = currentStart;
    } else {
      const d = getIsraelNow();
      currentStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const pm = d.getMonth() === 0 ? 12 : d.getMonth();
      const py = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
      previousStart = `${py}-${String(pm).padStart(2, "0")}-01`;
      previousEnd = currentStart;
    }

    const [current, previous] = await Promise.all([
      ctx.supabase.from("finance_logs").select("amount, category")
        .eq("transaction_type", "expense").gte("transaction_date", currentStart),
      ctx.supabase.from("finance_logs").select("amount, category")
        .eq("transaction_type", "expense").gte("transaction_date", previousStart).lt("transaction_date", previousEnd),
    ]);

    const sum = (rows: any[]) => rows.reduce((s, r) => s + (r.amount || 0), 0);
    const currentTotal = sum(current.data || []);
    const previousTotal = sum(previous.data || []);
    const change = previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 100) : 0;

    // Category changes
    const currentByCat: Record<string, number> = {};
    const previousByCat: Record<string, number> = {};
    (current.data || []).forEach((r: any) => { currentByCat[r.category || "other"] = (currentByCat[r.category || "other"] || 0) + r.amount; });
    (previous.data || []).forEach((r: any) => { previousByCat[r.category || "other"] = (previousByCat[r.category || "other"] || 0) + r.amount; });

    const topChanges = Object.keys({ ...currentByCat, ...previousByCat })
      .map(cat => ({
        category: cat,
        current: currentByCat[cat] || 0,
        previous: previousByCat[cat] || 0,
        change: (currentByCat[cat] || 0) - (previousByCat[cat] || 0),
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 5);

    return {
      success: true,
      data: { period: args.period, currentTotal, previousTotal, changePct: change, topChanges },
    };
  }
);

registry.register(
  {
    name: "get_cash_tracking_status",
    description: "Check when cash was last logged and estimate the tracking gap.",
    category: "data",
    tier: "auto",
    allowedAgents: ["finance"],
    parameters: [],
  },
  async (_args, ctx) => {
    const { data } = await ctx.supabase.from("finance_logs")
      .select("transaction_date")
      .eq("payment_method", "cash")
      .order("transaction_date", { ascending: false })
      .limit(1);

    const lastCashDate = data?.[0]?.transaction_date || null;
    const daysSinceCash = lastCashDate
      ? Math.floor((Date.now() - new Date(lastCashDate).getTime()) / 86400000)
      : 999;

    return {
      success: true,
      data: {
        lastCashDate,
        daysSinceCash,
        needsReminder: daysSinceCash >= 3,
        estimatedGap: "~24% of real spending may be untracked (cash)",
      },
    };
  }
);

registry.register(
  {
    name: "get_daily_spending",
    description: "Get today's spending breakdown by category and payment method.",
    category: "data",
    tier: "auto",
    allowedAgents: ["finance"],
    parameters: [
      { name: "date", type: "string", description: "Date YYYY-MM-DD (default today)", required: false },
    ],
  },
  async (args, ctx) => {
    const date = args.date || todayStr();
    const { data } = await ctx.supabase.from("finance_logs")
      .select("*")
      .eq("transaction_date", date)
      .eq("transaction_type", "expense");

    const total = (data || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);
    const byCategory: Record<string, number> = {};
    (data || []).forEach((r: any) => {
      byCategory[r.category || "other"] = (byCategory[r.category || "other"] || 0) + r.amount;
    });

    return { success: true, data: { date, total, transactions: data?.length || 0, byCategory } };
  }
);

// ─── Main Handler ─────────────────────────────────────────────────────

export async function runFinanceAgent(): Promise<AgentResult> {
  const guardrails = getGuardrails();
  const canRun = await guardrails.canRun("finance");
  if (!canRun.allowed) {
    return {
      success: false, output: `Finance agent blocked: ${canRun.reason}`,
      trace: [], totalToolCalls: 0, totalLoops: 0, durationMs: 0,
      stoppedByGuardrail: true, guardrailReason: canRun.reason,
    };
  }

  const isSunday = getIsraelNow().getDay() === 0;
  const memory = getMemoryStore("finance");
  const memoryContext = await memory.buildContext("budget spending savings overspending pattern", "finance");

  const agentConfig: AgentConfig = {
    name: "finance",
    role: `Tu es le conseiller financier personnel d'Oren. Objectif: taux d'épargne de 20%+ du revenu.

Tu es RIGOUREUX mais PAS moralisateur :
- Tu donnes des chiffres PRÉCIS (pas "tu dépenses trop", mais "resto +340₪ vs le mois dernier")
- Tu identifies les patterns de dépenses et les dérives AVANT qu'elles deviennent critiques
- Tu proposes des alternatives concrètes (pas juste "dépense moins")
- Tu émets des signaux d'alerte aux autres agents (budget_alert, overspending)

Devises: ₪ (NIS) en Israël. Salaire et budget en NIS.`,

    goal: `Exécuter le cycle quotidien de l'agent finance :

1. MONTHLY: Récupère le résumé mensuel (revenus, dépenses, balance, taux d'épargne)
2. BUDGETS: Vérifie les budgets par catégorie (green/yellow/red/over)
3. DAILY: Analyse les dépenses du jour
4. CASH: Vérifie le suivi cash (rappel si 3+ jours sans log cash)
5. TRENDS: Compare les dépenses cette semaine vs la semaine dernière
6. SIGNALS: Émet les signaux pertinents :
   - budget_alert si une catégorie dépasse 80% du budget
   - cash_gap si 3+ jours sans log cash
   - savings_on_track si épargne >= 20%
   - overspending si dépenses > 80% des revenus
7. MEMORY: Stocke les patterns importants (catégories problématiques, dérives)
8. REPORT: Produis un rapport financier clair et actionnable${isSunday ? "\n9. WEEKLY: C'est dimanche — ajoute le bilan hebdomadaire complet" : ""}`,

    context: `Date: ${todayStr()} (${["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][getIsraelNow().getDay()]})
Target savings rate: 20%
Currency: ₪ (NIS)
${memoryContext}`,

    maxLoops: 5,
    maxToolCalls: 15,
    maxTokensPerLoop: 800,
    model: "gpt-4o-mini",
    temperature: 0.3,
  };

  const result = await runReActAgent(agentConfig);

  // Store financial insights as memory
  if (result.success && result.output) {
    try {
      const output = result.output.toLowerCase();
      if (output.includes("overspend") || output.includes("dépass") || output.includes("over budget")) {
        await memory.store(`Overspending détecté: ${result.output.slice(0, 300)}`, "episodic", {
          domain: "finance", importance: 4, tags: ["overspending", "alert"],
        });
      }
      if (output.includes("pattern") || output.includes("tendance")) {
        await memory.store(`Pattern financier: ${result.output.slice(0, 300)}`, "semantic", {
          domain: "finance", importance: 3, tags: ["pattern", "spending"],
        });
      }
    } catch {}
  }

  const estimatedTokens = result.totalLoops * 1500;
  await guardrails.recordUsage("finance", estimatedTokens, result.totalToolCalls, "gpt-4o-mini", result.success);

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
    const { data: already } = await supabase.from("finance_reports")
      .select("id").eq("report_date", today).eq("report_type", "daily").limit(1);
    if (already?.length) {
      return new Response(JSON.stringify({ success: true, type: "skipped_duplicate" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await runFinanceAgent();

    if (result.output && result.success) {
      await sendTG(formatFinanceReport(result));
    }

    // Save report record
    await supabase.from("finance_reports").insert({
      report_date: today, report_type: getIsraelNow().getDay() === 0 ? "weekly" : "daily",
      metrics: { loops: result.totalLoops, tools: result.totalToolCalls, duration: result.durationMs },
    }).catch(() => {});

    return new Response(JSON.stringify({
      success: result.success, type: "finance_agent_react",
      loops: result.totalLoops, toolCalls: result.totalToolCalls,
      durationMs: result.durationMs, timestamp: today,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Finance Agent Error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

function formatFinanceReport(result: AgentResult): string {
  let report = `<b>💰 FINANCE AGENT — ReAct</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  report += escHTML(result.output.slice(0, 3500));
  report += `\n\n<i>⚡ ${result.totalLoops} loops · ${result.totalToolCalls} tools · ${Math.round(result.durationMs / 1000)}s</i>`;
  if (result.stoppedByGuardrail) report += `\n⚠️ ${escHTML(result.guardrailReason || "")}`;
  return report;
}
