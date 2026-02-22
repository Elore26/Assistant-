import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";

// ─── AI Helper ──────────────────────────────────────────────────────────
async function callOpenAI(systemPrompt: string, userContent: string, maxTokens = 500): Promise<string> {
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

// ─── Interfaces ─────────────────────────────────────────────────────────
interface CategoryBudget {
  category: string;
  monthly_limit: number;
  alert_threshold_pct: number;
  notes: string;
}

interface CategorySpending {
  category: string;
  amount: number;
  count: number;
  budget: number;
  pct: number;
  status: "green" | "yellow" | "red" | "over";
  byPayment: Record<string, number>;
}

interface TrendData {
  category: string;
  currentMonth: number;
  lastMonth: number;
  change: number;
  changePct: number;
  trend: "up" | "down" | "stable";
}

interface DailySummary {
  total: number;
  count: number;
  byCategory: Record<string, number>;
  byPayment: Record<string, number>;
  cashTotal: number;
  cardTotal: number;
}

interface MonthlySummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  savingsRate: number;
  byCategory: Record<string, number>;
  byPayment: Record<string, number>;
  cashExpenses: number;
  cashPct: number;
  dayOfMonth: number;
  daysInMonth: number;
  daysRemaining: number;
  dailySpendingRate: number;
  projectedExpense: number;
  projectedSavingsRate: number;
}

// ─── Date Helpers ───────────────────────────────────────────────────────
function getIsraeliDate(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function prevMonthRange(d: Date): { start: string; end: string } {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const end = new Date(d.getFullYear(), d.getMonth(), 0);
  return { start: dateStr(prev), end: dateStr(end) };
}

function weekStart(d: Date): string {
  const dd = new Date(d);
  const day = dd.getDay();
  const diff = dd.getDate() - day + (day === 0 ? -6 : 1);
  return dateStr(new Date(dd.setDate(diff)));
}

// ─── Telegram ───────────────────────────────────────────────────────────
async function sendTG(message: string): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";
  if (!botToken) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    return res.ok;
  } catch { return false; }
}

// ─── Normalize Category ─────────────────────────────────────────────────
function normalizeCategory(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const map: Record<string, string> = {
    "restaurant": "restaurant", "resto": "restaurant", "food": "restaurant",
    "dining": "restaurant", "takeaway": "restaurant", "uber eats": "restaurant",
    "wolt": "restaurant", "deliveroo": "restaurant",
    "courses": "courses", "groceries": "courses", "supermarket": "courses",
    "supermarche": "courses", "rami levy": "courses", "shufersal": "courses",
    "electricite": "electricite", "electricity": "electricite", "electric": "electricite",
    "iec": "electricite", "חשמל": "electricite",
    "transport": "transport", "bus": "transport", "train": "transport",
    "uber": "transport", "gett": "transport", "essence": "transport", "fuel": "transport",
    "bien_etre": "bien_etre", "wellness": "bien_etre", "gym": "bien_etre",
    "sport": "bien_etre", "massage": "bien_etre", "salle": "bien_etre",
    "divertissement": "divertissement", "entertainment": "divertissement",
    "sortie": "divertissement", "cinema": "divertissement", "bar": "divertissement",
    "abonnements": "abonnements", "subscription": "abonnements", "netflix": "abonnements",
    "spotify": "abonnements", "phone": "abonnements", "internet": "abonnements",
    "sante": "sante", "health": "sante", "pharmacy": "sante",
    "pharmacie": "sante", "medecin": "sante", "doctor": "sante",
  };
  return map[lower] || "autre";
}

// ─── Data Fetchers ──────────────────────────────────────────────────────
async function getCategoryBudgets(supabase: any): Promise<CategoryBudget[]> {
  const { data } = await supabase.from("category_budgets")
    .select("category, monthly_limit, alert_threshold_pct, notes")
    .eq("is_active", true);
  return data || [];
}

async function getDailySpending(supabase: any, date: string): Promise<DailySummary> {
  const { data } = await supabase.from("finance_logs")
    .select("amount, category, payment_method")
    .eq("transaction_date", date)
    .in("transaction_type", ["expense"]);

  const result: DailySummary = {
    total: 0, count: 0,
    byCategory: {}, byPayment: {},
    cashTotal: 0, cardTotal: 0,
  };

  if (data) {
    data.forEach((r: any) => {
      const cat = normalizeCategory(r.category);
      const pm = r.payment_method || "card";
      result.total += r.amount;
      result.count++;
      result.byCategory[cat] = (result.byCategory[cat] || 0) + r.amount;
      result.byPayment[pm] = (result.byPayment[pm] || 0) + r.amount;
      if (pm === "cash") result.cashTotal += r.amount;
      else result.cardTotal += r.amount;
    });
  }
  return result;
}

async function getMonthlyData(supabase: any, from: string, to: string): Promise<MonthlySummary> {
  const { data } = await supabase.from("finance_logs")
    .select("amount, category, transaction_type, payment_method")
    .gte("transaction_date", from)
    .lte("transaction_date", to);

  const now = getIsraeliDate();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dom = now.getDate();

  const result: MonthlySummary = {
    totalIncome: 0, totalExpense: 0, balance: 0, savingsRate: 0,
    byCategory: {}, byPayment: {},
    cashExpenses: 0, cashPct: 0,
    dayOfMonth: dom, daysInMonth: dim, daysRemaining: dim - dom,
    dailySpendingRate: 0, projectedExpense: 0, projectedSavingsRate: 0,
  };

  if (data) {
    data.forEach((r: any) => {
      if (r.transaction_type === "income") {
        result.totalIncome += r.amount;
      } else {
        const cat = normalizeCategory(r.category);
        const pm = r.payment_method || "card";
        result.totalExpense += r.amount;
        result.byCategory[cat] = (result.byCategory[cat] || 0) + r.amount;
        result.byPayment[pm] = (result.byPayment[pm] || 0) + r.amount;
        if (pm === "cash") result.cashExpenses += r.amount;
      }
    });
  }

  result.balance = result.totalIncome - result.totalExpense;
  result.savingsRate = result.totalIncome > 0
    ? Math.round(((result.totalIncome - result.totalExpense) / result.totalIncome) * 100) : 0;
  result.cashPct = result.totalExpense > 0
    ? Math.round((result.cashExpenses / result.totalExpense) * 100) : 0;
  result.dailySpendingRate = dom > 0 ? result.totalExpense / dom : 0;
  result.projectedExpense = result.totalExpense + (result.dailySpendingRate * result.daysRemaining);
  result.projectedSavingsRate = result.totalIncome > 0
    ? Math.round(((result.totalIncome - result.projectedExpense) / result.totalIncome) * 100) : 0;

  return result;
}

async function getCategoryStatus(
  monthly: MonthlySummary, budgets: CategoryBudget[]
): Promise<CategorySpending[]> {
  const results: CategorySpending[] = [];
  const budgetMap = new Map(budgets.map(b => [b.category, b]));

  // Add all budget categories
  for (const b of budgets) {
    const spent = monthly.byCategory[b.category] || 0;
    const pct = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
    let status: "green" | "yellow" | "red" | "over" = "green";
    if (pct >= 100) status = "over";
    else if (pct >= b.alert_threshold_pct) status = "red";
    else if (pct >= b.alert_threshold_pct * 0.75) status = "yellow";

    results.push({
      category: b.category,
      amount: Number(spent.toFixed(2)),
      count: 0,
      budget: b.monthly_limit,
      pct,
      status,
      byPayment: {},
    });
  }

  // Add unbudgeted categories
  for (const [cat, amount] of Object.entries(monthly.byCategory)) {
    if (!budgetMap.has(cat)) {
      results.push({
        category: cat,
        amount: Number((amount as number).toFixed(2)),
        count: 0, budget: 0, pct: 0,
        status: "yellow",
        byPayment: {},
      });
    }
  }

  return results.sort((a, b) => b.pct - a.pct);
}

async function getTrends(supabase: any, currentMonth: MonthlySummary): Promise<TrendData[]> {
  const now = getIsraeliDate();
  const prev = prevMonthRange(now);
  const { data } = await supabase.from("finance_logs")
    .select("amount, category")
    .gte("transaction_date", prev.start)
    .lte("transaction_date", prev.end)
    .in("transaction_type", ["expense"]);

  const lastMonthByCategory: Record<string, number> = {};
  if (data) {
    data.forEach((r: any) => {
      const cat = normalizeCategory(r.category);
      lastMonthByCategory[cat] = (lastMonthByCategory[cat] || 0) + r.amount;
    });
  }

  const allCats = new Set([
    ...Object.keys(currentMonth.byCategory),
    ...Object.keys(lastMonthByCategory),
  ]);

  const trends: TrendData[] = [];
  for (const cat of allCats) {
    const cur = currentMonth.byCategory[cat] || 0;
    const last = lastMonthByCategory[cat] || 0;
    const change = cur - last;
    const changePct = last > 0 ? Math.round((change / last) * 100) : (cur > 0 ? 100 : 0);
    let trend: "up" | "down" | "stable" = "stable";
    if (changePct > 10) trend = "up";
    else if (changePct < -10) trend = "down";
    trends.push({ category: cat, currentMonth: cur, lastMonth: last, change, changePct, trend });
  }

  return trends.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

async function getDaysSinceLastCashLog(supabase: any): Promise<number> {
  const { data } = await supabase.from("finance_logs")
    .select("transaction_date")
    .eq("payment_method", "cash")
    .order("transaction_date", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return 999; // Never logged cash
  const lastDate = new Date(data[0].transaction_date);
  const now = getIsraeliDate();
  return Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Report Saver ───────────────────────────────────────────────────────
async function saveReport(supabase: any, type: string, date: string, content: string, metrics: any) {
  try {
    await supabase.from("finance_reports").insert({
      report_type: type,
      report_date: date,
      content,
      metrics,
    });
  } catch (e) { console.error("Error saving report:", e); }
}

// ─── Goal Updater ───────────────────────────────────────────────────────
async function updateSavingsGoal(supabase: any, savingsRate: number) {
  try {
    const { data: goals } = await supabase.from("goals").select("id")
      .eq("domain", "finance").eq("status", "active").limit(1);
    if (goals?.[0]) {
      await supabase.from("goals").update({ metric_current: Math.max(0, savingsRate) }).eq("id", goals[0].id);
    }
  } catch (_) {}
}

// ─── Formatting Helpers ─────────────────────────────────────────────────
function statusIcon(s: string): string {
  switch (s) {
    case "green": return "🟢";
    case "yellow": return "🟡";
    case "red": return "🔴";
    case "over": return "💥";
    default: return "⚪";
  }
}

function trendIcon(t: string): string {
  switch (t) {
    case "up": return "📈";
    case "down": return "📉";
    default: return "➡️";
  }
}

function catEmoji(cat: string): string {
  const map: Record<string, string> = {
    restaurant: "🍽", courses: "🛒", electricite: "⚡",
    transport: "🚌", bien_etre: "💆", divertissement: "🎬",
    abonnements: "📱", sante: "💊", autre: "📦",
  };
  return map[cat] || "📦";
}

function catLabel(cat: string): string {
  const map: Record<string, string> = {
    restaurant: "Restaurant", courses: "Courses", electricite: "Électricité",
    transport: "Transport", bien_etre: "Bien-être", divertissement: "Loisirs",
    abonnements: "Abonnements", sante: "Santé", autre: "Autre",
  };
  return map[cat] || cat;
}

// ─── Main Process ───────────────────────────────────────────────────────
async function processFinanceAgent(): Promise<any> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return { success: false, error: "Missing Supabase config" };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = getIsraeliDate();
  const today = dateStr(now);
  const mStart = monthStart(now);
  const isSunday = now.getDay() === 0;
  const targetSavingsRate = 20;

  try {
    // --- Deduplication: skip if already processed today ---
    const { data: existingReport } = await supabase.from("finance_reports")
      .select("id").eq("report_date", today).limit(1);
    if (existingReport && existingReport.length > 0) {
      console.log(`[Finance] Already processed today (${today}), skipping duplicate`);
      return { success: true, type: "skipped_duplicate", date: today };
    }

    const signals = getSignalBus("finance");

    // ─── Fetch all data in parallel ─────────────────────────────
    const [budgets, daily, monthly, daysSinceCash] = await Promise.all([
      getCategoryBudgets(supabase),
      getDailySpending(supabase, today),
      getMonthlyData(supabase, mStart, today),
      getDaysSinceLastCashLog(supabase),
    ]);

    const [categoryStatus, trends] = await Promise.all([
      getCategoryStatus(monthly, budgets),
      getTrends(supabase, monthly),
    ]);

    // Update savings goal
    await updateSavingsGoal(supabase, monthly.savingsRate);

    const alerts: string[] = [];
    let alertSent = false;
    let weeklySent = false;

    // ─── Alert 1: Category budget overspending ──────────────────
    const overBudget = categoryStatus.filter(c => c.status === "over" || c.status === "red");
    if (overBudget.length > 0) {
      let msg = `⚠️ ALERTE BUDGET PAR CATÉGORIE\n━━━━━━━━━━━━━━━━━━━━\n`;
      for (const cat of overBudget) {
        const icon = statusIcon(cat.status);
        msg += `${icon} ${catEmoji(cat.category)} ${catLabel(cat.category)}\n`;
        msg += `   ₪${cat.amount.toFixed(0)} / ₪${cat.budget.toFixed(0)} (${cat.pct}%)\n`;
        if (cat.status === "over") {
          msg += `   → Dépassé de ₪${(cat.amount - cat.budget).toFixed(0)}\n`;
        } else {
          msg += `   → Reste ₪${(cat.budget - cat.amount).toFixed(0)} pour le mois\n`;
        }
      }
      msg += `\n📊 Total mois: ₪${monthly.totalExpense.toFixed(0)} / ₪${monthly.totalIncome.toFixed(0)}`;
      msg += `\n💰 Épargne: ${monthly.savingsRate}% (objectif ${targetSavingsRate}%)`;

      alertSent = await sendTG(msg);
      alerts.push("category_budget_alert");
    }

    // ─── Alert 2: Daily budget exceeded ─────────────────────────
    const dailyBudget = monthly.totalIncome > 0 ? monthly.totalIncome / monthly.daysInMonth : 200;
    if (daily.total > dailyBudget && daily.total > 0) {
      const excess = daily.total - dailyBudget;
      let msg = `⚠️ BUDGET JOUR DÉPASSÉ\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Budget   ₪${dailyBudget.toFixed(0)}/jour\n`;
      msg += `Dépensé  ₪${daily.total.toFixed(0)}\n`;
      msg += `Excès    +₪${excess.toFixed(0)}\n\n`;

      // Show breakdown
      for (const [cat, amt] of Object.entries(daily.byCategory)) {
        msg += `${catEmoji(cat)} ${catLabel(cat)}: ₪${(amt as number).toFixed(0)}\n`;
      }

      // Show payment method
      if (daily.cashTotal > 0) {
        msg += `\n💵 Cash: ₪${daily.cashTotal.toFixed(0)} · 💳 Carte: ₪${daily.cardTotal.toFixed(0)}`;
      }

      // AI advice
      const catList = Object.entries(daily.byCategory)
        .map(([c, a]) => `${c}: ₪${(a as number).toFixed(0)}`).join(", ");
      const advice = await callOpenAI(
        "Tu es conseiller financier d'Oren. Donne un conseil court (2 lignes) pour demain.",
        `Budget jour: ₪${dailyBudget.toFixed(0)}. Dépensé: ₪${daily.total.toFixed(0)}. Détail: ${catList}. Excès: ₪${excess.toFixed(0)}.`,
        80
      );
      if (advice) msg += `\n\n💡 ${advice}`;

      await sendTG(msg);
      alerts.push("daily_budget_alert");
    }

    // ─── Alert 3: Cash tracking reminder ────────────────────────
    if (daysSinceCash >= 3) {
      let cashMsg = `💵 RAPPEL CASH\n━━━━━━━━━━━━━━━━━━━━\n`;
      cashMsg += `Aucune dépense cash enregistrée depuis ${daysSinceCash} jours.\n\n`;
      cashMsg += `⚠️ Les dépenses cash représentent ~24% de tes dépenses réelles.\n`;
      cashMsg += `Sans les tracker, ton budget affiché est sous-estimé de ~31%.\n\n`;
      cashMsg += `💡 Prends 30 sec pour noter tes dépenses cash récentes :\n`;
      cashMsg += `Envoie-moi "cash 25 restaurant" ou "cash 15 transport"`;
      await sendTG(cashMsg);
      alerts.push("cash_reminder");
    }

    // ─── Alert 4: Monthly warning at 80% ────────────────────────
    if (monthly.totalIncome > 0 && (monthly.totalExpense / monthly.totalIncome) * 100 > 80) {
      let msg = `🔴 ALERTE MENSUELLE\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Dépenses > 80% du revenu\n\n`;
      msg += `Revenu   ₪${monthly.totalIncome.toFixed(0)}\n`;
      msg += `Dépensé  ₪${monthly.totalExpense.toFixed(0)} (${Math.round((monthly.totalExpense/monthly.totalIncome)*100)}%)\n`;
      msg += `Reste    ₪${monthly.balance.toFixed(0)}\n\n`;

      // Top categories
      const sorted = [...categoryStatus].sort((a, b) => b.amount - a.amount).slice(0, 4);
      for (const c of sorted) {
        msg += `${statusIcon(c.status)} ${catEmoji(c.category)} ${catLabel(c.category)}: ₪${c.amount.toFixed(0)}`;
        if (c.budget > 0) msg += ` / ₪${c.budget.toFixed(0)}`;
        msg += `\n`;
      }

      // Projection
      msg += `\n📊 Projection fin de mois:\n`;
      msg += `Dépense prévue  ₪${monthly.projectedExpense.toFixed(0)}\n`;
      msg += `Épargne prévue  ${monthly.projectedSavingsRate}% ${monthly.projectedSavingsRate >= targetSavingsRate ? "✅" : "⚠️"}\n`;

      if (monthly.projectedSavingsRate < targetSavingsRate) {
        const maxDaily = ((monthly.totalIncome * (1 - targetSavingsRate / 100)) - monthly.totalExpense)
          / Math.max(monthly.daysRemaining, 1);
        msg += `Budget max/jour  ₪${Math.max(0, maxDaily).toFixed(0)} pour atteindre ${targetSavingsRate}%\n`;
      }

      await sendTG(msg);
      alerts.push("monthly_warning");
    }

    // --- Inter-Agent Signals ---
    try {
      // Budget alerts per category
      for (const cat of overBudget) {
        await signals.emit("budget_alert",
          `${catLabel(cat.category)}: ₪${cat.amount.toFixed(0)}/₪${cat.budget.toFixed(0)} (${cat.pct}%)`,
          { category: cat.category, amount: cat.amount, budget: cat.budget, pct: cat.pct, status: cat.status },
          { priority: cat.status === "over" ? 1 : 2, ttlHours: 24 }
        );
      }

      // Cash gap signal
      if (daysSinceCash >= 3) {
        await signals.emit("cash_gap",
          `Pas de cash logué depuis ${daysSinceCash}j — budget sous-estimé ~31%`,
          { daysSinceCash, estimatedGap: 0.31 },
          { priority: 2, ttlHours: 24 }
        );
      }

      // Savings tracking signal
      if (monthly.totalIncome > 0) {
        if (monthly.projectedSavingsRate >= 20) {
          await signals.emit("savings_on_track",
            `Épargne projetée ${monthly.projectedSavingsRate}% — on track`,
            { savingsRate: monthly.savingsRate, projected: monthly.projectedSavingsRate },
            { priority: 4, ttlHours: 24 }
          );
        }

        if ((monthly.totalExpense / monthly.totalIncome) * 100 > 80) {
          await signals.emit("overspending",
            `Dépenses à ${Math.round((monthly.totalExpense / monthly.totalIncome) * 100)}% du revenu`,
            { expense: monthly.totalExpense, income: monthly.totalIncome, pct: Math.round((monthly.totalExpense / monthly.totalIncome) * 100) },
            { priority: 1, ttlHours: 24 }
          );
        }
      }
    } catch (sigErr) {
      console.error("[Signals] Finance error:", sigErr);
    }

    // ─── Weekly Summary (Sunday) ────────────────────────────────
    if (isSunday) {
      const wStart = weekStart(now);

      // Get weekly data
      const { data: weekData } = await supabase.from("finance_logs")
        .select("amount, category, transaction_type, payment_method")
        .gte("transaction_date", wStart)
        .lte("transaction_date", today);

      let weekIncome = 0, weekExpense = 0, weekCash = 0;
      const weekByCategory: Record<string, number> = {};

      if (weekData) {
        weekData.forEach((r: any) => {
          if (r.transaction_type === "income") { weekIncome += r.amount; }
          else {
            const cat = normalizeCategory(r.category);
            weekExpense += r.amount;
            weekByCategory[cat] = (weekByCategory[cat] || 0) + r.amount;
            if (r.payment_method === "cash") weekCash += r.amount;
          }
        });
      }

      const weekSavings = weekIncome - weekExpense;
      const weekDailyAvg = weekExpense / 7;

      // ─── Build weekly message ─────────
      let msg = `📊 FINANCE — Semaine\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Revenu    ₪${weekIncome.toFixed(0)}\n`;
      msg += `Dépensé   ₪${weekExpense.toFixed(0)}`;
      if (weekCash > 0) msg += ` (💵 ₪${weekCash.toFixed(0)} cash)`;
      msg += `\n`;
      msg += `Économie  ₪${weekSavings.toFixed(0)}\n`;
      msg += `Moy/jour  ₪${weekDailyAvg.toFixed(0)}\n\n`;

      // Category breakdown with budget status
      msg += `📋 Par catégorie:\n`;
      const topCats = Object.entries(weekByCategory)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 5);
      for (const [cat, amt] of topCats) {
        const budget = budgets.find(b => b.category === cat);
        const monthSpent = monthly.byCategory[cat] || 0;
        msg += `${catEmoji(cat)} ${catLabel(cat)}: ₪${(amt as number).toFixed(0)}`;
        if (budget) {
          msg += ` (mois: ₪${monthSpent.toFixed(0)}/₪${budget.monthly_limit.toFixed(0)})`;
        }
        msg += `\n`;
      }

      // Trends vs last month
      const significantTrends = trends.filter(t =>
        Math.abs(t.changePct) > 15 && (t.currentMonth > 50 || t.lastMonth > 50)
      ).slice(0, 3);

      if (significantTrends.length > 0) {
        msg += `\n📈 Tendances vs mois dernier:\n`;
        for (const t of significantTrends) {
          msg += `${trendIcon(t.trend)} ${catLabel(t.category)}: ${t.changePct > 0 ? "+" : ""}${t.changePct}%`;
          msg += ` (₪${t.lastMonth.toFixed(0)} → ₪${t.currentMonth.toFixed(0)})\n`;
        }
      }

      // Cash tracking status
      msg += `\n💵 Suivi cash:\n`;
      if (monthly.cashPct > 0) {
        msg += `Cash = ${monthly.cashPct}% des dépenses (₪${monthly.cashExpenses.toFixed(0)})\n`;
        if (monthly.cashPct < 20) {
          msg += `⚠️ Cash sous-estimé ? Réel estimé ~24% (analyse historique)\n`;
        }
      } else {
        msg += `⚠️ Aucune dépense cash ce mois. Pense à les enregistrer !\n`;
      }

      // Projection & savings
      msg += `\n💰 Projection fin de mois:\n`;
      msg += `Dépense prévue  ₪${monthly.projectedExpense.toFixed(0)}\n`;
      msg += `Épargne prévue  ${monthly.projectedSavingsRate}% ${monthly.projectedSavingsRate >= targetSavingsRate ? "✅" : "⚠️"}\n`;

      if (monthly.projectedSavingsRate < targetSavingsRate) {
        const maxDaily = ((monthly.totalIncome * (1 - targetSavingsRate / 100)) - monthly.totalExpense)
          / Math.max(monthly.daysRemaining, 1);
        msg += `Budget max/jour  ₪${Math.max(0, maxDaily).toFixed(0)} pour atteindre ${targetSavingsRate}%\n`;
      }

      // AI analysis with real data
      const catStr = topCats.map(([c, a]) => `${c}: ₪${(a as number).toFixed(0)}`).join(", ");
      const trendStr = significantTrends.map(t =>
        `${t.category}: ${t.changePct > 0 ? "+" : ""}${t.changePct}%`
      ).join(", ");

      const aiPrompt = `Tu es conseiller financier personnel d'Oren. Objectif: épargner ${targetSavingsRate}% du revenu.
Données semaine:
- Revenu: ₪${weekIncome.toFixed(0)} | Dépenses: ₪${weekExpense.toFixed(0)} | Cash: ₪${weekCash.toFixed(0)}
- Top catégories: ${catStr}
- Tendances: ${trendStr || "pas de changement significatif"}
- Projection épargne fin mois: ${monthly.projectedSavingsRate}%
- Cash tracking: ${monthly.cashPct}% (estimé réel ~24%)
Données historiques (analyse 3 mois): Restaurant = 43% dépenses, cible réduction 37%.
Donne 3 insights SPÉCIFIQUES avec chiffres. Max 4 lignes. Français.`;

      const aiInsights = await callOpenAI(
        "Tu es conseiller financier. Insights CONCRETS avec chiffres.",
        aiPrompt,
        150
      );
      if (aiInsights) msg += `\n\n💡 IA:\n${aiInsights}`;

      weeklySent = await sendTG(msg);

      // Save weekly report
      await saveReport(supabase, "weekly", today, msg, {
        weekIncome, weekExpense, weekSavings, weekDailyAvg,
        weekByCategory, cashPct: monthly.cashPct,
        projectedSavingsRate: monthly.projectedSavingsRate,
      });
    }

    // ─── Save daily report (clean, no more polluting finance_logs) ──
    await saveReport(supabase, "daily", today,
      `Daily: ₪${daily.total.toFixed(0)} (${daily.count}tx) | Month: ₪${monthly.totalExpense.toFixed(0)}/₪${monthly.totalIncome.toFixed(0)} (${monthly.savingsRate}%)`,
      {
        daily: { total: daily.total, count: daily.count, byCategory: daily.byCategory, cash: daily.cashTotal },
        monthly: { expense: monthly.totalExpense, income: monthly.totalIncome, savingsRate: monthly.savingsRate },
        alerts,
        categoryStatus: categoryStatus.map(c => ({ cat: c.category, amt: c.amount, budget: c.budget, pct: c.pct, status: c.status })),
      }
    );

    return {
      success: true,
      daily: { total: daily.total, count: daily.count },
      monthly: {
        expense: monthly.totalExpense,
        income: monthly.totalIncome,
        savingsRate: monthly.savingsRate,
        projectedSavingsRate: monthly.projectedSavingsRate,
        cashPct: monthly.cashPct,
      },
      alerts,
      alertSent,
      weeklySent,
      overBudgetCategories: overBudget.length,
      daysSinceCash,
      timestamp: today,
    };
  } catch (error) {
    console.error("Finance Agent Error:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── HTTP Handler ───────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await processFinanceAgent();
    return new Response(JSON.stringify(result), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false, error: error instanceof Error ? error.message : "Internal error",
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
