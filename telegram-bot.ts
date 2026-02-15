// ============================================
// OREN AGENT SYSTEM - Supabase Edge Function
// Bot Telegram complet avec tous les modules
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleCalendar, GCAL_COLORS } from "../_shared/google-calendar.ts";
import { getSignalBus } from "../_shared/agent-signals.ts";

// --- Types Telegram ---
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
    audio?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
    caption?: string;
    document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

interface InlineKeyboardButton { text: string; callback_data?: string; url?: string; }
interface InlineKeyboardMarkup { inline_keyboard: InlineKeyboardButton[][]; }

// --- Agent Configuration ---
const AGENTS = {
  career: { emoji: '💼', name: 'Career', desc: 'Recherche emploi AE/SDR SaaS' },
  higrow: { emoji: '🚀', name: 'Higrow', desc: 'Prospection coaching' },
  trading: { emoji: '📈', name: 'Trading', desc: 'Analyse crypto BTC/ETH/SOL' },
  health: { emoji: '🏋️', name: 'Health', desc: 'Santé & fitness' },
  learning: { emoji: '📚', name: 'Learning', desc: 'Apprentissage continu' },
  finance: { emoji: '💰', name: 'Finance', desc: 'Gestion finances' },
};

const AGENT_NAMES = Object.keys(AGENTS);

// --- Oren's Schedule (Weekly) ---
const SCHEDULE = {
  0: { type: 'work_long', depart: '08:30', work_start: '09:30', work_end: '19:30', return: '20:30' },
  1: { type: 'work_short', depart: '08:30', work_start: '09:30', work_end: '15:30', return: '16:30' },
  2: { type: 'work_short', depart: '08:30', work_start: '09:30', work_end: '15:30', return: '16:30' },
  3: { type: 'work_short', depart: '08:30', work_start: '09:30', work_end: '15:30', return: '16:30' },
  4: { type: 'work_late', depart: '11:00', work_start: '12:00', work_end: '19:30', return: '20:30' },
  5: { type: 'variable' },
  6: { type: 'off' },
} as Record<number, any>;

// --- Health & Fitness Constants ---
const HEALTH_TOPICS = ['weight', 'workout', 'status'];
const WORKOUT_TYPES = ['push', 'pull', 'legs', 'cardio', 'mobility'];
const EXPENSE_CATEGORIES = ['restaurant', 'transport', 'shopping', 'health', 'entertainment', 'utilities', 'other'];
const INCOME_CATEGORIES = ['salaire', 'freelance', 'bonus', 'other'];
const LEARNING_TOPICS = ['english', 'ae_skills', 'ai', 'trading', 'product'];

// --- Utility Functions ---
function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );
}

async function sendTelegramMessage(chatId: number, text: string, parseMode = 'Markdown', replyMarkup?: InlineKeyboardMarkup): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN manquant !");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode,
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Erreur Telegram: ${response.status} - ${error}`);
  }
}

async function answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text || "" }),
  });
}

// --- Inline Keyboard Helpers ---
const MAIN_MENU: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "📋 Tasks", callback_data: "menu_tasks" }, { text: "💰 Budget", callback_data: "menu_budget" }, { text: "🏋️ Santé", callback_data: "menu_health" }, { text: "💼 Carrière", callback_data: "menu_jobs" }],
    [{ text: "🚀 HiGrow", callback_data: "menu_leads" }, { text: "📈 Trading", callback_data: "menu_signals" }, { text: "🧠 Insights", callback_data: "menu_insights" }, { text: "🎯 Goals", callback_data: "menu_goals" }],
    [{ text: "❓ Tuto — Guide complet", callback_data: "tuto_main" }],
  ],
};

function parseCommand(text: string): { command: string; args: string[] } {
  const parts = text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase().replace("@", "").split("@")[0] ?? "";
  const args = parts.slice(1);
  return { command, args };
}

function getTodaySchedule(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const sched = SCHEDULE[dayOfWeek];
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

  if (sched.type === 'off') {
    return `*TODAY — ${dayNames[dayOfWeek]}*\n\nRepos`;
  }

  if (sched.type === 'variable') {
    return `*TODAY — Vendredi*\n\nVariable`;
  }

  let schedule = `*TODAY — ${dayNames[dayOfWeek]}*\n\n`;
  schedule += `Depart: ${sched.depart}\n`;
  schedule += `Travail: ${sched.work_start} — ${sched.work_end}\n`;
  schedule += `Retour: ${sched.return}`;

  return schedule;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// --- Command Handlers ---

async function handleStart(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  let dbStatus = "offline";
  try {
    const { error } = await supabase.from("missions").select("id").limit(1);
    if (!error) dbStatus = "online";
  } catch {
    // DB offline
  }

  const text =
    `*OREN SYSTEM*\n\n` +
    `6 agents | Cloud 24/7\n` +
    `DB: ${dbStatus}`;

  await sendTelegramMessage(chatId, text, 'Markdown', MAIN_MENU);
}

async function handleBrief(chatId: number, args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendTelegramMessage(
      chatId,
      `Format: /brief agent mission\nAgents: ${AGENT_NAMES.join(", ")}`
    );
    return;
  }

  const agentType = args[0].toLowerCase();
  const mission = args.slice(1).join(" ");

  if (!AGENT_NAMES.includes(agentType)) {
    await sendTelegramMessage(
      chatId,
      `agent ${agentType} inconnu\nChoix: ${AGENT_NAMES.join(", ")}`
    );
    return;
  }

  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.from("missions").insert({
      agent_type: agentType,
      title: mission.substring(0, 50),
      description: mission,
      status: "pending",
    });

    if (error) throw error;

    await sendTelegramMessage(
      chatId,
      `+ Mission a *${agentType.toUpperCase()}*\n${mission}`
    );
  } catch (e) {
    console.error("Erreur insert mission:", e);
    await sendTelegramMessage(
      chatId,
      `error: ${String(e).substring(0, 50)}`
    );
  }
}

async function handleReport(chatId: number, args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendTelegramMessage(
      chatId,
      `Format: /report agent\nAgents: ${AGENT_NAMES.join(", ")}`
    );
    return;
  }

  const agentType = args[0].toLowerCase();
  if (!AGENT_NAMES.includes(agentType)) {
    await sendTelegramMessage(chatId, `agent ${agentType} inconnu`);
    return;
  }

  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("missions")
      .select("*")
      .eq("agent_type", agentType)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) throw error;

    if (!data || data.length === 0) {
      await sendTelegramMessage(
        chatId,
        `-- aucune mission ${agentType}`
      );
      return;
    }

    const statusSymbol: Record<string, string> = {
      pending: "○",
      in_progress: "◐",
      completed: "●",
      failed: "x",
    };

    let reportText = `*${agentType.toUpperCase()}* — ${data.length} missions\n\n`;
    for (const m of data) {
      const symbol = statusSymbol[m.status] ?? "?";
      reportText += `${symbol} ${m.title}\n`;
    }

    await sendTelegramMessage(chatId, reportText);
  } catch (e) {
    console.error("Erreur select missions:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

async function handleStatus(chatId: number): Promise<void> {
  let statusText = "*STATUS*\n\n";
  for (const [agent, info] of Object.entries(AGENTS)) {
    statusText += `*${info.name}* `;
  }
  statusText += "\n\n";

  const supabase = getSupabaseClient();
  let dbStatus = "offline";
  try {
    const { error } = await supabase.from("missions").select("id").limit(1);
    if (!error) dbStatus = "connecte";
  } catch {
    // DB offline
  }

  const dayOfWeek = new Date().getDay();
  const todaySched = SCHEDULE[dayOfWeek];
  let schedType = todaySched.type === 'off' ? 'repos' : (todaySched.type === 'variable' ? 'variable' : 'travail');

  statusText += `DB: ${dbStatus}\n`;
  statusText += `Schedule: ${schedType}`;
  await sendTelegramMessage(chatId, statusText);
}

async function handleToday(chatId: number): Promise<void> {
  await sendTelegramMessage(chatId, getTodaySchedule());
}

async function handleHelp(chatId: number): Promise<void> {
  const text =
    `*COMMANDES*\n\n` +
    `MISSIONS\n` +
    `/brief agent mission\n` +
    `/report agent\n` +
    `/status\n\n` +
    `TACHES\n` +
    `/task add titre\n` +
    `/task list\n` +
    `/task done num\n\n` +
    `FINANCES\n` +
    `/expense mont cat\n` +
    `/cash mont cat (especes)\n` +
    `/income mont cat\n` +
    `/budget\n\n` +
    `SANTE\n` +
    `/health weight kg\n` +
    `/health workout type\n` +
    `/health status\n\n` +
    `APPRENTISSAGE\n` +
    `/study topic min\n\n` +
    `LEADS & JOBS\n` +
    `/lead add name spec\n` +
    `/lead list\n` +
    `/job url [titre]\n` +
    `/jobs\n\n` +
    `MISSION\n` +
    `/mission titre heure [duree]\n\n` +
    `FOCUS\n` +
    `/focus [min] — mode silencieux\n` +
    `/focus off — reprendre notifs\n\n` +
    `AUTRES\n` +
    `/today\n` +
    `/review\n` +
    `/signals\n` +
    `/goals\n` +
    `/tuto — guide complet interactif`;

  await sendTelegramMessage(chatId, text);
}

async function handleUnknown(chatId: number, text?: string): Promise<void> {
  // Au lieu de juste "?", essayer de donner une réponse utile
  if (text && text.length > 5) {
    // Sauvegarder comme note si c'est une info substantielle
    const supabase = getSupabaseClient();
    await supabase.from("tasks").insert({
      title: `📝 ${text}`.substring(0, 200),
      status: "completed",
      priority: 5,
      created_at: new Date().toISOString(),
    });
    await sendTelegramMessage(chatId, `📝 Noté. Tape /help pour les commandes.`);
  } else {
    await sendTelegramMessage(chatId, `👍`);
  }
}

// --- Task Handlers ---

async function handleTaskAdd(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    await sendTelegramMessage(chatId, `Format: /task add titre`);
    return;
  }

  const title = args.join(" ");
  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.from("tasks").insert({
      title: title.substring(0, 100),
      status: "pending",
      priority: 3,
      created_at: new Date().toISOString(),
    });

    if (error) throw error;
    await sendTelegramMessage(chatId, `+ Tache: *${escapeMarkdown(title)}*`);
  } catch (e) {
    console.error("Task add error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

async function handleTaskList(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .in("status", ["pending", "in_progress"])
      .order("priority", { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      await sendTelegramMessage(chatId, `-- aucune tache`);
      return;
    }

    // Sort: urgency (critique first), then priority, then due_date
    const urgencyOrder: Record<string, number> = { critique: 0, urgent: 1, attention: 2, normal: 3 };
    data.sort((a: any, b: any) => {
      const uA = urgencyOrder[a.urgency_level || "normal"] ?? 3;
      const uB = urgencyOrder[b.urgency_level || "normal"] ?? 3;
      if (uA !== uB) return uA - uB;
      if ((a.priority || 3) !== (b.priority || 3)) return (a.priority || 3) - (b.priority || 3);
      return (a.due_date || "9999") < (b.due_date || "9999") ? -1 : 1;
    });

    let text = `*TACHES*  ${data.length} actives\n\n`;
    const buttons: InlineKeyboardButton[][] = [];
    data.forEach((task: any, idx: number) => {
      const symbol = task.status === 'in_progress' ? '●' : '○';
      const uBadge = urgencyBadge(task.urgency_level);
      const rInfo = (task.reschedule_count || 0) > 0 ? ` \\(x${task.reschedule_count}\\)` : "";
      const dueInfo = task.due_date ? ` · ${task.due_date.substring(5)}` : "";
      text += `${idx + 1}\\. ${uBadge}${symbol} ${escapeMarkdown(task.title)}${rInfo}${dueInfo}\n`;
      // Buttons: done + demain (max 6 tasks)
      if (idx < 6) {
        buttons.push([
          { text: `✓ ${task.title.substring(0, 18)}`, callback_data: `tdone_${task.id}` },
          { text: `📅 Demain`, callback_data: `tmrw_${task.id}` },
        ]);
      }
    });

    const markup: InlineKeyboardMarkup = { inline_keyboard: buttons };
    await sendTelegramMessage(chatId, text, 'Markdown', markup);
  } catch (e) {
    console.error("Task list error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

async function handleTaskDone(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    await sendTelegramMessage(chatId, `Format: /task done num`);
    return;
  }

  const num = parseInt(args[0], 10);
  if (isNaN(num) || num < 1) {
    await sendTelegramMessage(chatId, `numero invalide`);
    return;
  }

  const supabase = getSupabaseClient();

  try {
    const { data, error: selectError } = await supabase
      .from("tasks")
      .select("id, title")
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: true });

    if (selectError) throw selectError;
    if (!data || num > data.length) {
      await sendTelegramMessage(chatId, `tache #${num} n'existe pas`);
      return;
    }

    const taskId = data[num - 1].id;
    const { error } = await supabase
      .from("tasks")
      .update({ status: "completed" })
      .eq("id", taskId);

    if (error) throw error;
    await sendTelegramMessage(chatId, `✓ Tache: *${escapeMarkdown(data[num - 1].title)}*`);
  } catch (e) {
    console.error("Task done error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Finance Handlers ---

async function handleExpense(chatId: number, args: string[], paymentMethod = "card"): Promise<void> {
  if (args.length < 2) {
    await sendTelegramMessage(chatId,
      `Format: /expense amount category [desc]\nEx: /expense 50 restaurant déjeuner\nPour cash: /cash 30 restaurant`);
    return;
  }

  const amount = parseFloat(args[0]);
  const category = args[1];
  const description = args.slice(2).join(" ") || "";

  if (isNaN(amount) || amount <= 0) {
    await sendTelegramMessage(chatId, `montant invalide`);
    return;
  }

  const supabase = getSupabaseClient();
  const pmLabel = paymentMethod === "cash" ? "💵" : "💳";

  try {
    const { error } = await supabase.from("finance_logs").insert({
      transaction_type: "expense",
      amount: amount,
      category: category,
      description: description,
      payment_method: paymentMethod,
      transaction_date: new Date().toISOString().split('T')[0],
    });

    if (error) throw error;
    await sendTelegramMessage(chatId, `✓ Depense enregistree\n*${amount}₪* ${pmLabel} · ${category}`);
  } catch (e) {
    console.error("Expense error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

async function handleIncome(chatId: number, args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendTelegramMessage(chatId,
      `Format: /income amount category\nEx: /income 200 freelance`);
    return;
  }

  const amount = parseFloat(args[0]);
  const category = args[1];
  const description = args.slice(2).join(" ") || "";

  if (isNaN(amount) || amount <= 0) {
    await sendTelegramMessage(chatId, `montant invalide`);
    return;
  }

  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.from("finance_logs").insert({
      transaction_type: "income",
      amount: amount,
      category: category,
      description: description,
      transaction_date: new Date().toISOString().split('T')[0],
    });

    if (error) throw error;
    await sendTelegramMessage(chatId, `+ Revenu enregistre\n*${amount}₪* · ${category}`);
  } catch (e) {
    console.error("Income error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

async function handleBudget(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    const monthName = now.toLocaleDateString('fr-FR', { month: 'long' }).charAt(0).toUpperCase() + now.toLocaleDateString('fr-FR', { month: 'long' }).slice(1);

    const { data, error } = await supabase
      .from("finance_logs")
      .select("*")
      .gte("transaction_date", monthStart.split('T')[0])
      .lte("transaction_date", monthEnd.split('T')[0]);

    if (error) throw error;

    if (!data || data.length === 0) {
      await sendTelegramMessage(chatId, `-- pas de transactions`);
      return;
    }

    let income = 0, expenses = 0;
    const expensesByCategory: Record<string, number> = {};

    data.forEach(log => {
      if (log.transaction_type === "income") {
        income += log.amount;
      } else {
        expenses += log.amount;
        expensesByCategory[log.category] = (expensesByCategory[log.category] || 0) + log.amount;
      }
    });

    const topCategories = Object.entries(expensesByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    let text = `*BUDGET — ${monthName}*\n\n`;
    text += `Revenus    *${income.toFixed(0)}₪*\n`;
    text += `Depenses   *${expenses.toFixed(0)}₪*\n`;
    text += `Balance   *${(income - expenses > 0 ? '+' : '')}${(income - expenses).toFixed(0)}₪*\n\n`;
    text += `Top depenses:\n`;
    topCategories.forEach(([cat, amt]) => {
      text += `${cat.charAt(0).toUpperCase() + cat.slice(1)}   ${amt.toFixed(0)}₪\n`;
    });

    await sendTelegramMessage(chatId, text);
  } catch (e) {
    console.error("Budget error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Health Handlers ---

async function handleHealth(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    await sendTelegramMessage(chatId,
      `⚠️ Format: \`/health <weight|workout|status> [args]\`\n` +
      `  weight <kg>\n` +
      `  workout <push|pull|legs|cardio|mobility> [duration]\n` +
      `  status`);
    return;
  }

  const subcommand = args[0].toLowerCase();

  if (subcommand === 'weight') {
    if (args.length < 2) {
      await sendTelegramMessage(chatId, `Format: /health weight kg`);
      return;
    }
    const weight = parseFloat(args[1]);
    if (isNaN(weight) || weight < 30 || weight > 200) {
      await sendTelegramMessage(chatId, `poids invalide`);
      return;
    }

    const supabase = getSupabaseClient();
    try {
      const { error } = await supabase.from("health_logs").insert({
        log_type: "weight",
        value: weight,
        unit: "kg",
        log_date: new Date().toISOString().split('T')[0],
      });
      if (error) throw error;
      await sendTelegramMessage(chatId, `✓ Poids: *${weight}kg*`);
    } catch (e) {
      console.error("Health weight error:", e);
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  } else if (subcommand === 'workout') {
    if (args.length < 2) {
      await sendTelegramMessage(chatId, `Format: /health workout type [min]`);
      return;
    }
    const type = args[1].toLowerCase();
    if (!WORKOUT_TYPES.includes(type)) {
      await sendTelegramMessage(chatId, `Types: ${WORKOUT_TYPES.join(", ")}`);
      return;
    }
    const duration = args[2] ? parseInt(args[2], 10) : 60;

    const supabase = getSupabaseClient();
    try {
      const { error } = await supabase.from("health_logs").insert({
        log_type: "workout",
        workout_type: type,
        duration_minutes: duration,
        log_date: new Date().toISOString().split('T')[0],
      });
      if (error) throw error;
      await sendTelegramMessage(chatId, `✓ Workout: *${type}* ${duration}min`);
    } catch (e) {
      console.error("Health workout error:", e);
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  } else if (subcommand === 'status') {
    const supabase = getSupabaseClient();
    try {
      const { data: weights } = await supabase
        .from("health_logs")
        .select("*")
        .eq("log_type", "weight")
        .order("log_date", { ascending: false })
        .limit(1);

      const { data: workouts } = await supabase
        .from("health_logs")
        .select("*")
        .eq("log_type", "workout")
        .order("log_date", { ascending: false })
        .limit(3);

      let text = `*SANTE*\n\n`;
      if (weights && weights.length > 0) {
        const lastWeight = weights[0].value;
        const target = 70;
        const progress = target - lastWeight;
        text += `Poids: *${lastWeight}kg*\n`;
        text += `Cible: 70kg (${progress > 0 ? '+' : ''}${progress}kg)\n\n`;
      }
      if (workouts && workouts.length > 0) {
        text += `Workouts:\n`;
        workouts.forEach(w => {
          text += `${w.workout_type}  ${w.duration_minutes}min\n`;
        });
      }
      await sendTelegramMessage(chatId, text);
    } catch (e) {
      console.error("Health status error:", e);
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  }
}

// --- Learning Handler ---

async function handleStudy(chatId: number, args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendTelegramMessage(chatId,
      `Format: /study topic minutes\nEx: /study english 45`);
    return;
  }

  const topic = args[0].toLowerCase();
  const minutes = parseInt(args[1], 10);
  const notes = args.slice(2).join(" ") || "";

  if (!LEARNING_TOPICS.includes(topic) || isNaN(minutes) || minutes <= 0) {
    await sendTelegramMessage(chatId, `topic ou duree invalide`);
    return;
  }

  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.from("learning_logs").insert({
      topic: topic,
      duration_minutes: minutes,
      notes: notes,
      session_date: new Date().toISOString().split('T')[0],
    });

    if (error) throw error;
    await sendTelegramMessage(chatId, `✓ Session: *${topic}* ${minutes}min`);
  } catch (e) {
    console.error("Study error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Lead Handler ---

async function handleLead(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    await sendTelegramMessage(chatId,
      `Format:\n` +
      `/lead add name specialty\n` +
      `/lead list`);
    return;
  }

  const subcommand = args[0].toLowerCase();

  if (subcommand === 'add') {
    if (args.length < 3) {
      await sendTelegramMessage(chatId, `Format: /lead add name specialty`);
      return;
    }

    const name = args[1];
    const specialty = args[2];
    const contact = args[3] || "";

    const supabase = getSupabaseClient();
    try {
      const { error } = await supabase.from("leads").insert({
        name: name,
        specialty: specialty,
        email: contact || null,
        status: "new",
      });

      if (error) throw error;
      await sendTelegramMessage(chatId, `+ Lead: *${escapeMarkdown(name)}* · ${specialty}`);
    } catch (e) {
      console.error("Lead add error:", e);
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  } else if (subcommand === 'list') {
    const supabase = getSupabaseClient();
    try {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      if (!data || data.length === 0) {
        await sendTelegramMessage(chatId, `-- aucun lead`);
        return;
      }

      let text = `*LEADS*  ${data.length}\n\n`;
      const byStatus: Record<string, any[]> = {};
      data.forEach(lead => {
        if (!byStatus[lead.status]) byStatus[lead.status] = [];
        byStatus[lead.status].push(lead);
      });

      for (const [status, leads] of Object.entries(byStatus)) {
        text += `${status.toUpperCase()} (${leads.length})\n`;
        leads.forEach(lead => {
          text += `${escapeMarkdown(lead.name)}  ${lead.specialty}\n`;
        });
        text += `\n`;
      }

      await sendTelegramMessage(chatId, text);
    } catch (e) {
      console.error("Lead list error:", e);
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  }
}

// --- Mission Handler (spontaneous task scheduling) ---

function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

function todayStr(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function fromMin(m: number): string {
  if (m < 0) m += 1440;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Urgency calculator: reschedule count + days since original date
function calcUrgency(rescheduleCount: number, originalDate: string | null): string {
  let daysOverdue = 0;
  if (originalDate) {
    const now = getIsraelNow();
    const orig = new Date(originalDate + "T00:00:00");
    daysOverdue = Math.max(0, Math.floor((now.getTime() - orig.getTime()) / 86400000));
  }
  const score = rescheduleCount * 2 + daysOverdue;
  if (score >= 8) return "critique";    // 4+ reports or 8+ days
  if (score >= 5) return "urgent";      // 2-3 reports + few days
  if (score >= 2) return "attention";   // 1 report or 2+ days
  return "normal";
}

function urgencyBadge(level: string | null): string {
  if (level === "critique") return "🔴";
  if (level === "urgent") return "🟠";
  if (level === "attention") return "🟡";
  return "";
}

// Fixed schedule blocks per day (minutes ranges that are occupied)
function getFixedBlocks(dayOfWeek: number): Array<{ start: number; end: number; label: string }> {
  const s = SCHEDULE[dayOfWeek];
  if (!s || s.type === 'off' || s.type === 'variable') return [];

  const blocks = [];
  // Commute aller
  if (s.depart && s.work_start) {
    blocks.push({ start: toMin(s.depart) - 30, end: toMin(s.work_start), label: "Trajet" });
  }
  // Work
  if (s.work_start && s.work_end) {
    blocks.push({ start: toMin(s.work_start), end: toMin(s.work_end), label: "Travail" });
  }
  // Commute retour
  if (s.work_end && s.return) {
    blocks.push({ start: toMin(s.work_end), end: toMin(s.return) + 30, label: "Trajet retour" });
  }
  return blocks;
}

async function handleMission(chatId: number, args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendTelegramMessage(chatId,
      `Format: /mission titre heure [duree]\n` +
      `Ex: /mission Rdv dentiste 14:00 60\n` +
      `Ex: /mission Appel client 10:30\n` +
      `Duree par defaut: 30 min`);
    return;
  }

  // Parse args — last arg might be duration, second-to-last is time, rest is title
  const allArgs = [...args];
  let durationMin = 30;
  let timeStr = "";
  let title = "";

  // Check if last arg is a number (duration)
  const lastArg = allArgs[allArgs.length - 1];
  if (/^\d+$/.test(lastArg) && allArgs.length > 2) {
    durationMin = parseInt(lastArg, 10);
    allArgs.pop();
  }

  // Second to last (or last after pop) should be time HH:MM or HHh
  const timeArg = allArgs[allArgs.length - 1];
  const timeMatch = timeArg.match(/^(\d{1,2})[h:](\d{2})?$/);
  if (timeMatch) {
    const h = timeMatch[1].padStart(2, "0");
    const m = timeMatch[2] || "00";
    timeStr = `${h}:${m}`;
    allArgs.pop();
  } else {
    await sendTelegramMessage(chatId, `Heure invalide: ${timeArg}\nFormat: 14:00 ou 14h`);
    return;
  }

  title = allArgs.join(" ");
  if (!title) {
    await sendTelegramMessage(chatId, `Titre manquant`);
    return;
  }

  const today = todayStr();
  const now = getIsraelNow();
  const dayOfWeek = now.getDay();
  const missionStart = toMin(timeStr);
  const missionEnd = missionStart + durationMin;

  const supabase = getSupabaseClient();

  // Check fixed schedule conflicts
  const fixedBlocks = getFixedBlocks(dayOfWeek);
  let conflict = "";
  for (const b of fixedBlocks) {
    if (missionStart < b.end && missionEnd > b.start) {
      conflict = b.label;
      break;
    }
  }

  // Check task conflicts
  let conflictTask: any = null;
  try {
    const { data: existingTasks } = await supabase
      .from("tasks")
      .select("id, title, due_time, duration_minutes")
      .eq("due_date", today)
      .in("status", ["pending", "in_progress"]);

    if (existingTasks) {
      for (const t of existingTasks) {
        if (!t.due_time) continue;
        const tStart = toMin(t.due_time.substring(0, 5));
        const tEnd = tStart + (t.duration_minutes || 30);
        if (missionStart < tEnd && missionEnd > tStart) {
          conflictTask = t;
          break;
        }
      }
    }
  } catch (e) { console.error("Mission conflict check:", e); }

  if (conflict && !conflictTask) {
    // Fixed block conflict — propose alternatives
    const free1 = fromMin(fixedBlocks[fixedBlocks.length - 1]?.end || missionEnd);
    const free2 = fromMin(toMin(free1) + 60);

    const buttons: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `${free1}`, callback_data: `mission_at_${free1}_${durationMin}_${encodeURIComponent(title)}` },
          { text: `${free2}`, callback_data: `mission_at_${free2}_${durationMin}_${encodeURIComponent(title)}` },
        ],
        [{ text: "Annuler", callback_data: "mission_cancel" }],
      ],
    };

    await sendTelegramMessage(chatId,
      `⚠ Conflit: ${timeStr} = ${conflict}\n\nCreneaux libres:`,
      'Markdown', buttons);
    return;
  }

  if (conflictTask) {
    // Task conflict — propose to reschedule
    const newSlot = fromMin(missionEnd);
    const buttons: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: `✓ Decaler "${conflictTask.title}" a ${newSlot}`, callback_data: `mission_move_${conflictTask.id}_${newSlot}_${timeStr}_${durationMin}_${encodeURIComponent(title)}` }],
        [{ text: "Annuler", callback_data: "mission_cancel" }],
      ],
    };

    await sendTelegramMessage(chatId,
      `⚠ Conflit: ${timeStr} = *${escapeMarkdown(conflictTask.title)}*\n\nDecaler et inserer la mission?`,
      'Markdown', buttons);
    return;
  }

  // No conflict — insert directly
  try {
    const { error } = await supabase.from("tasks").insert({
      title: title,
      status: "pending",
      priority: 2,
      due_date: today,
      due_time: timeStr,
      duration_minutes: durationMin,
    });

    if (error) throw error;
    await sendTelegramMessage(chatId,
      `✓ Mission ajoutee\n*${escapeMarkdown(title)}*\n${timeStr} · ${durationMin} min`);
  } catch (e) {
    console.error("Mission insert:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// ============================================
// NEW MENU HANDLERS WITH SUB-MENUS
// ============================================

const WORKOUT_SCHEDULE_BOT: Record<number, { type: string; time: string }> = {
  0: { type: "legs", time: "06:30" }, 1: { type: "push", time: "17:00" },
  2: { type: "pull", time: "17:00" }, 3: { type: "legs", time: "17:00" },
  4: { type: "cardio", time: "07:00" }, 5: { type: "push", time: "09:00" },
  6: { type: "rest", time: "—" },
};

// --- TASKS MAIN (with sub-menu) ---
async function handleTasksMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const today = todayStr();
    const { data: tasks } = await supabase.from("tasks").select("id, title, priority, status, due_time, duration_minutes")
      .eq("due_date", today).in("status", ["pending", "in_progress"]).order("due_time", { ascending: true, nullsFirst: false });
    const allTasks = tasks || [];

    let text = `📋 *TÂCHES — Aujourd'hui*\n\n`;
    if (allTasks.length === 0) {
      text += `Aucune tâche pour aujourd'hui.\n`;
    } else {
      allTasks.forEach((t: any, i: number) => {
        const p = t.priority <= 2 ? "●" : t.priority === 3 ? "◐" : "○";
        const time = t.due_time ? `${t.due_time} ` : "";
        text += `${p} ${time}${t.title}\n`;
      });
    }

    // Task done buttons (max 6)
    const buttons: any[][] = [];
    allTasks.slice(0, 6).forEach((t: any, i: number) => {
      if (i % 2 === 0) buttons.push([]);
      buttons[buttons.length - 1].push({
        text: `✅ ${(t.title || "").substring(0, 18)}`,
        callback_data: `task_done_${t.id}`,
      });
    });

    buttons.push([
      { text: "📅 Planifier", callback_data: "tasks_schedule" },
      { text: "✓ Terminées", callback_data: "tasks_completed" },
    ]);
    buttons.push([{ text: "🔙 Menu", callback_data: "menu_main" }]);

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("TasksMain error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- TASKS COMPLETED ---
async function handleTasksCompleted(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const today = todayStr();
    const { data: tasks } = await supabase.from("tasks").select("title, updated_at")
      .eq("status", "completed").gte("updated_at", today + "T00:00:00").order("updated_at", { ascending: false }).limit(10);
    const completed = tasks || [];

    let text = `✅ *TERMINÉES AUJOURD'HUI* (${completed.length})\n\n`;
    if (completed.length === 0) {
      text += `Aucune tâche terminée aujourd'hui.`;
    } else {
      completed.forEach((t: any) => { text += `✓ ${t.title}\n`; });
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [[{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
    });
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Category budget helpers ---
const CAT_EMOJI: Record<string, string> = {
  restaurant: "🍽", courses: "🛒", electricite: "⚡",
  transport: "🚌", bien_etre: "💆", divertissement: "🎬",
  abonnements: "📱", sante: "💊", autre: "📦",
};
const CAT_LABEL: Record<string, string> = {
  restaurant: "Restaurant", courses: "Courses", electricite: "Électricité",
  transport: "Transport", bien_etre: "Bien-être", divertissement: "Loisirs",
  abonnements: "Abos", sante: "Santé", autre: "Autre",
};

// --- BUDGET MAIN (with sub-menu) ---
async function handleBudgetMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const ms = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const today = todayStr();

    // Fetch finance data + category budgets in parallel
    const [finRes, budgetRes] = await Promise.all([
      supabase.from("finance_logs").select("transaction_type, amount, category, payment_method")
        .gte("transaction_date", ms).lte("transaction_date", today),
      supabase.from("category_budgets").select("category, monthly_limit, alert_threshold_pct")
        .eq("is_active", true),
    ]);

    const records = finRes.data || [];
    const budgets = budgetRes.data || [];
    const budgetMap = new Map(budgets.map((b: any) => [b.category, b]));

    const income = records.filter((f: any) => f.transaction_type === "income").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const expenses = records.filter((f: any) => f.transaction_type === "expense").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const cashExpenses = records.filter((f: any) => f.transaction_type === "expense" && f.payment_method === "cash").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const balance = income - expenses;
    const savingsRate = income > 0 ? Math.round((balance / income) * 100) : 0;
    const savingsIcon = savingsRate >= 20 ? "✅" : savingsRate >= 10 ? "⚠️" : "🔴";

    // Per-category spending
    const catMap: Record<string, number> = {};
    records.filter((f: any) => f.transaction_type === "expense").forEach((f: any) => {
      const cat = f.category || "autre";
      catMap[cat] = (catMap[cat] || 0) + Number(f.amount);
    });

    let text = `💰 *BUDGET*\n\n`;
    text += `Revenus    *${income.toFixed(0)}₪*\n`;
    text += `Dépenses   *${expenses.toFixed(0)}₪*`;
    if (cashExpenses > 0) text += ` (💵 ${cashExpenses.toFixed(0)}₪ cash)`;
    text += `\n`;
    text += `Balance    *${balance >= 0 ? "+" : ""}${balance.toFixed(0)}₪*\n`;
    text += `Épargne    ${savingsIcon} ${savingsRate}% (cible 20%)\n`;

    // Category budget bars
    if (budgets.length > 0) {
      text += `\n*Par catégorie:*\n`;
      const sortedCats = budgets
        .map((b: any) => {
          const spent = catMap[b.category] || 0;
          const pct = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
          return { ...b, spent, pct };
        })
        .sort((a: any, b: any) => b.pct - a.pct);

      for (const c of sortedCats) {
        if (c.spent === 0 && c.pct === 0) continue; // Skip categories with no spending
        const icon = c.pct >= 100 ? "💥" : c.pct >= c.alert_threshold_pct ? "🔴" : c.pct >= c.alert_threshold_pct * 0.75 ? "🟡" : "🟢";
        const emoji = CAT_EMOJI[c.category] || "📦";
        const label = CAT_LABEL[c.category] || c.category;
        text += `${icon}${emoji} ${label}: ${c.spent.toFixed(0)}/${c.monthly_limit.toFixed(0)}₪ (${c.pct}%)\n`;
      }
    } else {
      // Fallback: top 3 categories without budgets
      const topCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topCats.length > 0) {
        text += `\n*Top dépenses:*\n`;
        topCats.forEach(([cat, amt]) => { text += `  ${cat}  ${amt.toFixed(0)}₪\n`; });
      }
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📊 Analyse", callback_data: "budget_analyse" }, { text: "📈 Tendances", callback_data: "budget_trends" }],
        [{ text: "➕ Dépense", callback_data: "budget_add_expense" }, { text: "➕ Revenu", callback_data: "budget_add_income" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("BudgetMain error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- BUDGET ANALYSE (AI) ---
async function handleBudgetAnalyse(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const ms = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const { data: fin } = await supabase.from("finance_logs").select("transaction_type, amount, category, payment_method, transaction_date")
      .gte("transaction_date", ms);

    const records = fin || [];
    const income = records.filter((f: any) => f.transaction_type === "income").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const expenses = records.filter((f: any) => f.transaction_type === "expense").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const cashExp = records.filter((f: any) => f.transaction_type === "expense" && f.payment_method === "cash").reduce((s: number, f: any) => s + Number(f.amount), 0);
    const cashPct = expenses > 0 ? Math.round((cashExp / expenses) * 100) : 0;
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const dailyBurn = dayOfMonth > 0 ? expenses / dayOfMonth : 0;
    const projectedExpenses = expenses + (dailyBurn * daysRemaining);
    const projectedSavings = income > 0 ? Math.round(((income - projectedExpenses) / income) * 100) : 0;

    let text = `📊 *ANALYSE BUDGET*\n\n`;
    text += `Jour ${dayOfMonth}/${daysInMonth} · ${daysRemaining}j restants\n`;
    text += `Burn rate: ${dailyBurn.toFixed(0)}₪/jour\n`;
    text += `Projection: ${projectedExpenses.toFixed(0)}₪ dépenses\n`;
    text += `Épargne: ${projectedSavings}%\n`;

    // Cash tracking status
    if (cashPct > 0) {
      text += `\n💵 Cash: ${cashPct}% (₪${cashExp.toFixed(0)})`;
      if (cashPct < 20) text += ` ⚠️ sous-estimé?`;
    } else {
      text += `\n💵 Cash: 0% ⚠️ pense à tracker !`;
    }
    text += `\n📊 Historique: cash réel ~24% des dépenses`;

    if (projectedSavings < 20) {
      const maxDaily = income > 0 ? Math.round(((income * 0.8) - expenses) / Math.max(daysRemaining, 1)) : 0;
      text += `\n\n⚠️ Pour atteindre 20%: max *${maxDaily}₪/jour*`;
    } else {
      text += `\n\n✅ En bonne voie pour 20%+`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📈 Tendances", callback_data: "budget_trends" }],
        [{ text: "💰 Budget", callback_data: "menu_budget" }, { text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- BUDGET TRENDS (month-over-month) ---
async function handleBudgetTrends(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const ms = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const today = todayStr();

    // Previous month range
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const prevStartStr = `${prevStart.getFullYear()}-${String(prevStart.getMonth() + 1).padStart(2, "0")}-01`;
    const prevEndStr = `${prevEnd.getFullYear()}-${String(prevEnd.getMonth() + 1).padStart(2, "0")}-${String(prevEnd.getDate()).padStart(2, "0")}`;

    const [curRes, prevRes] = await Promise.all([
      supabase.from("finance_logs").select("amount, category")
        .in("transaction_type", ["expense"]).gte("transaction_date", ms).lte("transaction_date", today),
      supabase.from("finance_logs").select("amount, category")
        .in("transaction_type", ["expense"]).gte("transaction_date", prevStartStr).lte("transaction_date", prevEndStr),
    ]);

    const curByCategory: Record<string, number> = {};
    (curRes.data || []).forEach((r: any) => {
      const cat = r.category || "autre";
      curByCategory[cat] = (curByCategory[cat] || 0) + Number(r.amount);
    });

    const prevByCategory: Record<string, number> = {};
    (prevRes.data || []).forEach((r: any) => {
      const cat = r.category || "autre";
      prevByCategory[cat] = (prevByCategory[cat] || 0) + Number(r.amount);
    });

    const allCats = new Set([...Object.keys(curByCategory), ...Object.keys(prevByCategory)]);
    const trends: Array<{ cat: string; cur: number; prev: number; pct: number }> = [];
    for (const cat of allCats) {
      const cur = curByCategory[cat] || 0;
      const prev = prevByCategory[cat] || 0;
      const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);
      if (cur > 20 || prev > 20) trends.push({ cat, cur, prev, pct });
    }
    trends.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

    let text = `📈 *TENDANCES vs mois dernier*\n\n`;
    if (trends.length === 0) {
      text += `Pas assez de données pour comparer.`;
    } else {
      for (const t of trends.slice(0, 8)) {
        const icon = t.pct > 10 ? "📈" : t.pct < -10 ? "📉" : "➡️";
        const emoji = CAT_EMOJI[t.cat] || "📦";
        const label = CAT_LABEL[t.cat] || t.cat;
        text += `${icon}${emoji} ${label}: ${t.pct > 0 ? "+" : ""}${t.pct}%\n`;
        text += `   ₪${t.prev.toFixed(0)} → ₪${t.cur.toFixed(0)}\n`;
      }
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "💰 Budget", callback_data: "menu_budget" }, { text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- HEALTH MAIN (with sub-menu) ---
async function handleHealthMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const day = now.getDay();
    const ws = WORKOUT_SCHEDULE_BOT[day];
    const hour = now.getHours();

    // Fetch weight + recent workouts
    const [weightRes, workoutRes] = await Promise.all([
      supabase.from("health_logs").select("value, log_date").eq("log_type", "weight").order("log_date", { ascending: false }).limit(3),
      supabase.from("health_logs").select("workout_type, duration_minutes, log_date").eq("log_type", "workout").order("log_date", { ascending: false }).limit(5),
    ]);

    const weights = weightRes.data || [];
    const workouts = workoutRes.data || [];
    const currentWeight = weights.length > 0 ? Number(weights[0].value) : null;
    const prevWeight = weights.length > 1 ? Number(weights[1].value) : null;
    const weightTrend = currentWeight && prevWeight ? (currentWeight < prevWeight ? "↓" : currentWeight > prevWeight ? "↑" : "→") : "";

    // Fasting status
    const fastingStart = 20; // 20:00
    const fastingEnd = 12;   // 12:00
    const isFasting = hour >= fastingStart || hour < fastingEnd;
    const fastingText = isFasting ? "🟢 Jeûne en cours" : "🍽 Fenêtre alimentaire (12h-20h)";

    let text = `🏋️ *SANTÉ*\n\n`;
    text += `Poids: *${currentWeight ? currentWeight + "kg" : "?"}* ${weightTrend} → 70kg\n`;
    text += `Workout: *${ws.type.charAt(0).toUpperCase() + ws.type.slice(1)}* à ${ws.time}\n`;
    text += `${fastingText}\n`;

    if (workouts.length > 0) {
      text += `\n*Derniers workouts:*\n`;
      workouts.slice(0, 3).forEach((w: any) => {
        text += `  ${w.workout_type} · ${w.duration_minutes}min · ${w.log_date}\n`;
      });
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "🍽 Repas", callback_data: "health_meals" }, { text: "💪 Workout", callback_data: "health_workout" }],
        [{ text: "📋 Programme", callback_data: "health_program" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("HealthMain error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- HEALTH MEALS (AI recommendation) ---
async function handleHealthMeals(chatId: number): Promise<void> {
  const now = getIsraelNow();
  const day = now.getDay();
  const ws = WORKOUT_SCHEDULE_BOT[day];
  const isTraining = ws.type !== "rest";

  const meals = isTraining
    ? `*🍽 REPAS DU JOUR (Training - ${ws.type})*\n\n` +
      `12:00 — Déjeuner\n  Poulet grillé 200g + riz basmati 150g + légumes\n  ~550 cal · 45g protéines\n\n` +
      `15:30 — Collation pré-workout\n  Banane + 20g whey + flocons avoine\n  ~350 cal · 25g protéines\n\n` +
      `${ws.type === "cardio" ? "08:30" : "19:00"} — Post-workout\n  Shake whey 30g + fruits rouges\n  ~200 cal · 30g protéines\n\n` +
      `19:30 — Dîner\n  Saumon 180g + patate douce + salade\n  ~600 cal · 40g protéines\n\n` +
      `Total: ~1700 cal · 140g+ protéines`
    : `*🍽 REPAS DU JOUR (Repos)*\n\n` +
      `12:00 — Déjeuner léger\n  Salade composée + thon + avocat\n  ~450 cal · 35g protéines\n\n` +
      `16:00 — Collation\n  Yaourt grec + noix + miel\n  ~250 cal · 20g protéines\n\n` +
      `19:00 — Dîner\n  Omelette 3 oeufs + légumes sautés + pain complet\n  ~500 cal · 35g protéines\n\n` +
      `Total: ~1200 cal · 90g+ protéines`;

  await sendTelegramMessage(chatId, meals, "Markdown", {
    inline_keyboard: [[{ text: "🏋️ Santé", callback_data: "menu_health" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
  });
}

// --- HEALTH WORKOUT (today's exercises) ---
async function handleHealthWorkout(chatId: number): Promise<void> {
  const now = getIsraelNow();
  const day = now.getDay();
  const ws = WORKOUT_SCHEDULE_BOT[day];

  const EXERCISES: Record<string, string> = {
    push: `*💪 PUSH — ${ws.time}*\n\n` +
      `1. Développé couché — 4×8-10 (90s repos)\n` +
      `2. Développé incliné haltères — 3×10-12 (90s)\n` +
      `3. Dips lestés — 3×8-10 (90s)\n` +
      `4. Élévations latérales — 4×12-15 (60s)\n` +
      `5. Développé militaire — 3×10 (90s)\n` +
      `6. Écartés poulie — 3×12-15 (60s)\n` +
      `7. Extensions triceps corde — 3×12-15 (60s)`,
    pull: `*💪 PULL — ${ws.time}*\n\n` +
      `1. Tractions pronation — 4×6-8 (120s repos)\n` +
      `2. Rowing barre — 4×8-10 (90s)\n` +
      `3. Tirage vertical prise serrée — 3×10-12 (90s)\n` +
      `4. Face pulls — 4×15 (60s)\n` +
      `5. Curl barre EZ — 3×10-12 (60s)\n` +
      `6. Curl marteau — 3×12 (60s)\n` +
      `7. Rowing un bras haltère — 3×10 (90s)`,
    legs: `*💪 LEGS — ${ws.time}*\n\n` +
      `1. Squat barre — 4×6-8 (120s repos)\n` +
      `2. Presse à cuisses — 4×10-12 (90s)\n` +
      `3. Fentes marchées — 3×12/jambe (90s)\n` +
      `4. Leg curl allongé — 4×10-12 (60s)\n` +
      `5. Extensions mollets — 4×15-20 (60s)\n` +
      `6. Hip thrust — 3×12 (90s)\n` +
      `7. Leg extension — 3×12-15 (60s)`,
    cardio: `*🏃 CARDIO — ${ws.time}*\n\n` +
      `Échauffement: 5 min marche rapide\n` +
      `HIIT: 8×(30s sprint / 60s récup)\n` +
      `OU: 30 min course continue zone 2\n` +
      `Retour au calme: 5 min marche\n` +
      `Étirements: 10 min`,
    rest: `*💤 REPOS*\n\n` +
      `Journée de récupération.\n` +
      `• Marche légère 30 min\n` +
      `• Étirements / mobilité 15 min\n` +
      `• Hydratation ++\n` +
      `• Sommeil priorité`,
  };

  const text = EXERCISES[ws.type] || `Workout: ${ws.type}`;
  await sendTelegramMessage(chatId, text, "Markdown", {
    inline_keyboard: [[{ text: "🏋️ Santé", callback_data: "menu_health" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
  });
}

// --- HEALTH PROGRAM (weekly view) ---
async function handleHealthProgram(chatId: number): Promise<void> {
  const dayLabels = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const now = getIsraelNow();
  const today = now.getDay();

  let text = `*📋 PROGRAMME SEMAINE*\n\n`;
  for (let i = 0; i < 7; i++) {
    const ws = WORKOUT_SCHEDULE_BOT[i];
    const marker = i === today ? "👉 " : "   ";
    const name = ws.type.charAt(0).toUpperCase() + ws.type.slice(1);
    text += `${marker}${dayLabels[i]}  *${name}*  ${ws.time}\n`;
  }
  text += `\nJeûne 16:8 — Fenêtre 12h-20h`;

  await sendTelegramMessage(chatId, text, "Markdown", {
    inline_keyboard: [[{ text: "🏋️ Santé", callback_data: "menu_health" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
  });
}

// --- CAREER MAIN (with sub-menu) ---
async function handleCareerMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: jobs } = await supabase.from("job_listings").select("status")
      .in("status", ["new", "saved", "applied", "interviewed", "offer", "rejected"]);
    const all = jobs || [];

    const newCount = all.filter((j: any) => j.status === "new" || j.status === "saved").length;
    const applied = all.filter((j: any) => j.status === "applied").length;
    const interviews = all.filter((j: any) => j.status === "interviewed").length;
    const offers = all.filter((j: any) => j.status === "offer").length;

    // Deadline from goals
    const { data: careerGoal } = await supabase.from("goals").select("deadline")
      .eq("domain", "career").eq("status", "active").limit(1);
    const deadline = careerGoal?.[0]?.deadline;
    const daysLeft = deadline ? Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000) : null;

    const urgency = interviews === 0 && daysLeft !== null && daysLeft < 120 ? "🔴" : interviews > 0 ? "🟢" : "🟡";

    let text = `💼 *CARRIÈRE*\n\n`;
    text += `${urgency} ${daysLeft !== null ? daysLeft + " jours" : "—"} avant deadline\n\n`;
    text += `Pipeline:\n`;
    text += `  🆕 ${newCount} nouvelles · 📨 ${applied} envoyées\n`;
    text += `  🎯 ${interviews} interviews · ✅ ${offers} offres\n`;

    if (interviews === 0 && daysLeft !== null && daysLeft < 120) {
      text += `\n⚠️ *0 interviews planifiées — action requise*`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📋 Offres détail", callback_data: "career_pipeline" }, { text: "📅 Actions", callback_data: "career_actions" }],
        [{ text: "➕ Ajouter offre", callback_data: "career_add_job" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("CareerMain error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- CAREER ACTIONS (today's career tasks) ---
async function handleCareerActions(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    // Stale applications (>5 days, no response)
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split("T")[0];
    const { data: stale } = await supabase.from("job_listings").select("title, company, applied_date")
      .eq("status", "applied").lte("applied_date", fiveDaysAgo).limit(5);

    // Career tasks pending
    const today = todayStr();
    const { data: tasks } = await supabase.from("tasks").select("title, due_time")
      .in("status", ["pending", "in_progress"]).ilike("title", "%career%").limit(5);

    let text = `📅 *ACTIONS CARRIÈRE*\n\n`;

    if (stale && stale.length > 0) {
      text += `*À relancer (>5j sans réponse):*\n`;
      stale.forEach((j: any) => { text += `  📞 ${j.title} @ ${j.company}\n`; });
      text += `\n`;
    }

    if (tasks && tasks.length > 0) {
      text += `*Tâches carrière:*\n`;
      tasks.forEach((t: any) => { text += `  • ${t.title}${t.due_time ? " @ " + t.due_time : ""}\n`; });
    }

    if ((!stale || stale.length === 0) && (!tasks || tasks.length === 0)) {
      text += `Aucune action carrière en attente.`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [[{ text: "💼 Carrière", callback_data: "menu_jobs" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
    });
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- HIGROW MAIN (with sub-menu) ---
async function handleHigrowMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: leads } = await supabase.from("leads").select("name, status, specialty, last_contact_date");
    const all = leads || [];

    const cold = all.filter((l: any) => l.status === "cold" || l.status === "new").length;
    const warm = all.filter((l: any) => l.status === "warm" || l.status === "contacted").length;
    const hot = all.filter((l: any) => l.status === "hot" || l.status === "qualified").length;
    const converted = all.filter((l: any) => l.status === "converted").length;

    // Monthly velocity
    const now = getIsraelNow();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const target = 10;
    const needed = target - converted;
    const urgency = converted < Math.round((dayOfMonth / daysInMonth) * target * 0.5) ? "🔴" : converted >= target ? "✅" : "🟡";

    let text = `🚀 *HIGROW*\n\n`;
    text += `${urgency} *${converted}/${target} clients* · ${daysRemaining}j restants\n\n`;
    text += `Pipeline:\n`;
    text += `  ❄️ ${cold} cold · 🌡 ${warm} warm · 🔥 ${hot} hot · ✅ ${converted} converted\n`;

    if (needed > 0 && daysRemaining > 0) {
      text += `\nBesoin: ${needed} clients en ${daysRemaining} jours`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📞 À relancer", callback_data: "higrow_followup" }, { text: "➕ Lead", callback_data: "higrow_add_lead" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("HigrowMain error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- HIGROW FOLLOWUP (leads to contact) ---
async function handleHigrowFollowup(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0];
    const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().split("T")[0];

    const { data: hotLeads } = await supabase.from("leads").select("name, specialty, last_contact_date")
      .in("status", ["hot", "qualified"]).order("last_contact_date", { ascending: true }).limit(5);
    const { data: warmLeads } = await supabase.from("leads").select("name, specialty, last_contact_date")
      .in("status", ["warm", "contacted"]).order("last_contact_date", { ascending: true }).limit(5);

    let text = `📞 *À RELANCER*\n\n`;

    if (hotLeads && hotLeads.length > 0) {
      text += `*🔥 Hot leads:*\n`;
      hotLeads.forEach((l: any) => {
        text += `  ${l.name} · ${l.specialty || "—"} · dernier contact: ${l.last_contact_date || "jamais"}\n`;
      });
      text += `\n`;
    }

    if (warmLeads && warmLeads.length > 0) {
      text += `*🌡 Warm leads:*\n`;
      warmLeads.forEach((l: any) => {
        text += `  ${l.name} · ${l.specialty || "—"} · dernier contact: ${l.last_contact_date || "jamais"}\n`;
      });
    }

    if ((!hotLeads || hotLeads.length === 0) && (!warmLeads || warmLeads.length === 0)) {
      text += `Aucun lead à relancer.`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [[{ text: "🚀 HiGrow", callback_data: "menu_leads" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
    });
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Callback Query Handler ---
async function handleCallbackQuery(callbackId: string, chatId: number, data: string): Promise<void> {
  const supabase = getSupabaseClient();

  // === MAIN MENU BUTTONS ===
  if (data === "menu_main") {
    await sendTelegramMessage(chatId, "📌 *OREN*", "Markdown", MAIN_MENU);
  } else if (data === "menu_tasks") {
    await handleTasksMain(chatId);
  } else if (data === "menu_budget") {
    await handleBudgetMain(chatId);
  } else if (data === "menu_health") {
    await handleHealthMain(chatId);
  } else if (data === "menu_jobs") {
    await handleCareerMain(chatId);
  } else if (data === "menu_leads") {
    await handleHigrowMain(chatId);
  } else if (data === "menu_signals") {
    await handleTradingMain(chatId);
  } else if (data === "menu_insights") {
    await handleInsights(chatId);
  } else if (data === "menu_goals") {
    await handleGoals(chatId);
  }
  // === TASKS SUB-MENU ===
  else if (data === "tasks_completed") {
    await handleTasksCompleted(chatId);
  } else if (data === "tasks_add") {
    await sendTelegramMessage(chatId, "Dis-moi ta tâche en message.\nEx: _Appeler le comptable demain 14h_", "Markdown");
  } else if (data === "tasks_schedule") {
    await sendTelegramMessage(chatId, "Format: /mission titre heure [durée]\nEx: _Rdv dentiste 14:00 60_", "Markdown");
  }
  // === BUDGET SUB-MENU ===
  else if (data === "budget_analyse") {
    await handleBudgetAnalyse(chatId);
  } else if (data === "budget_trends") {
    await handleBudgetTrends(chatId);
  } else if (data === "budget_add_expense") {
    await sendTelegramMessage(chatId, "Dis-moi ta dépense.\nEx: _45 shekel café_\nPour du cash: _cash 30 restaurant_", "Markdown");
  } else if (data === "budget_add_income") {
    await sendTelegramMessage(chatId, "Dis-moi ton revenu.\nEx: _revenu 8000 salaire_", "Markdown");
  }
  // === HEALTH SUB-MENU ===
  else if (data === "health_meals") {
    await handleHealthMeals(chatId);
  } else if (data === "health_workout") {
    await handleHealthWorkout(chatId);
  } else if (data === "health_program") {
    await handleHealthProgram(chatId);
  }
  // === CAREER SUB-MENU ===
  else if (data === "career_pipeline") {
    await handleJobs(chatId);
  } else if (data === "career_actions") {
    await handleCareerActions(chatId);
  } else if (data === "career_add_job") {
    await sendTelegramMessage(chatId, "Format: /job url [titre]\nEx: _/job https://linkedin.com/jobs/view/123 AE Wiz_", "Markdown");
  }
  // === HIGROW SUB-MENU ===
  else if (data === "higrow_followup") {
    await handleHigrowFollowup(chatId);
  } else if (data === "higrow_add_lead") {
    await sendTelegramMessage(chatId, "Format: /lead add nom spécialité [email]\nEx: _/lead add David coach david@mail.com_", "Markdown");
  }
  // === TRADING SUB-MENU ===
  else if (data === "trading_last") {
    await handleTradingLast(chatId);
  } else if (data === "trading_fresh") {
    await handleTradingFresh(chatId);
  } else if (data === "trading_plans") {
    await handleTradingPlans(chatId);
  } else if (data === "trading_stats") {
    await handleTradingStats(chatId);
  } else if (data === "trading_pairs") {
    await handleTradingPairs(chatId);
  } else if (data.startsWith("tpair_add_")) {
    const pair = data.replace("tpair_add_", "");
    await handleTradingAddPair(chatId, pair);
  } else if (data.startsWith("tpair_rm_")) {
    const pair = data.replace("tpair_rm_", "");
    await handleTradingRemovePair(chatId, pair);
  }
  // Task done button
  else if (data.startsWith("task_done_")) {
    const taskId = data.replace("task_done_", "");
    try {
      const { error } = await supabase.from("tasks").update({ status: "completed" }).eq("id", taskId);
      if (error) throw error;
      await sendTelegramMessage(chatId, `✓ Tache terminee`);
    } catch (e) {
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  }
  // Mission at specific time
  else if (data.startsWith("mission_at_")) {
    const parts = data.replace("mission_at_", "").split("_");
    const time = parts[0];
    const dur = parseInt(parts[1], 10);
    const title = decodeURIComponent(parts.slice(2).join("_"));

    try {
      const { error } = await supabase.from("tasks").insert({
        title, status: "pending", priority: 2,
        due_date: todayStr(), due_time: time, duration_minutes: dur,
      });
      if (error) throw error;

      // Sync to Google Calendar
      let calSync = "";
      try {
        const gcal = getGoogleCalendar();
        if (gcal.isConfigured()) {
          const eventId = await gcal.createTaskEvent(
            `[OREN] ${title}`, todayStr(), time, dur,
            `Mission ajoutée via Telegram\nDurée: ${dur} min`,
            GCAL_COLORS.MISSION
          );
          if (eventId) calSync = " · 📅 synced";
        }
      } catch (ce) { console.error("GCal mission sync:", ce); }

      await sendTelegramMessage(chatId, `✓ Mission ajoutee\n*${escapeMarkdown(title)}*\n${time} · ${dur} min${calSync}`);
    } catch (e) {
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  }
  // Mission move (reschedule + insert)
  else if (data.startsWith("mission_move_")) {
    const parts = data.replace("mission_move_", "").split("_");
    const existingId = parts[0];
    const newTime = parts[1];
    const missionTime = parts[2];
    const missionDur = parseInt(parts[3], 10);
    const missionTitle = decodeURIComponent(parts.slice(4).join("_"));

    try {
      // Move existing task
      await supabase.from("tasks").update({ due_time: newTime }).eq("id", existingId);
      // Insert new mission
      await supabase.from("tasks").insert({
        title: missionTitle, status: "pending", priority: 2,
        due_date: todayStr(), due_time: missionTime, duration_minutes: missionDur,
      });

      // Sync to Google Calendar
      let calSync = "";
      try {
        const gcal = getGoogleCalendar();
        if (gcal.isConfigured()) {
          const eventId = await gcal.createTaskEvent(
            `[OREN] ${missionTitle}`, todayStr(), missionTime, missionDur,
            `Mission ajoutée via Telegram (reschedule)\nDurée: ${missionDur} min`,
            GCAL_COLORS.MISSION
          );
          if (eventId) calSync = " · 📅 synced";
        }
      } catch (ce) { console.error("GCal mission move sync:", ce); }

      await sendTelegramMessage(chatId, `✓ Mission ajoutee a ${missionTime}\nTache existante decalee a ${newTime}${calSync}`);
    } catch (e) {
      await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
    }
  }
  // Mission cancel
  else if (data === "mission_cancel") {
    await sendTelegramMessage(chatId, `Mission annulee`);
  }
  // Calendar reschedule — user picked a time slot
  else if (data.startsWith("calrs_")) {
    const parts = data.replace("calrs_", "").split("_");
    const date = parts[0];
    const time = parts[1];
    const dur = parseInt(parts[2], 10) || 30;
    const shortTitle = parts.slice(3).join("") || "";

    try {
      // Find the FULL task title from DB (search by date, most recent pending task)
      const { data: tasks } = await supabase.from("tasks")
        .select("id, title").eq("due_date", date)
        .in("status", ["pending", "in_progress"])
        .order("created_at", { ascending: false }).limit(5);

      // Match by short title prefix or take the most recent
      let fullTitle = "Événement";
      let taskId: string | null = null;
      if (tasks && tasks.length > 0) {
        const match = tasks.find((t: any) =>
          t.title.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().startsWith(shortTitle.toLowerCase())
        );
        if (match) {
          fullTitle = match.title;
          taskId = match.id;
        } else {
          fullTitle = tasks[0].title;
          taskId = tasks[0].id;
        }
      }

      // Update task with time
      if (taskId) {
        await supabase.from("tasks").update({
          due_time: time,
          duration_minutes: dur,
        }).eq("id", taskId);
      }

      // Update Google Calendar event with FULL title
      let calSync = "";
      try {
        const gcal = getGoogleCalendar();
        if (gcal.isConfigured()) {
          const eventId = await gcal.createTaskEvent(
            `[OREN] ${fullTitle}`, date, time, dur,
            `Planifié via Telegram`, "6"
          );
          if (eventId) calSync = " · 📅 synced";
        }
      } catch (ce) { console.error("GCal reschedule:", ce); }

      await sendTelegramMessage(chatId, `✅ Planifié: ${fullTitle}\n${time} · ${dur}min${calSync}`);
    } catch (e) {
      await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
    }
  }
  // ─── TASK REMINDER CALLBACKS ───
  // Supports: tdone_, tsnz_, tstart_, tsnz1h_, tmrw_, tcancel_
  // Supports both full UUID and short 8-char prefix (legacy)
  else if (data.startsWith("tdone_") || data.startsWith("tsnz_") || data.startsWith("tstart_") || data.startsWith("tsnz1h_") || data.startsWith("tmrw_") || data.startsWith("tcancel_")) {
    const prefix = data.startsWith("tdone_") ? "tdone_"
      : data.startsWith("tsnz1h_") ? "tsnz1h_"
      : data.startsWith("tsnz_") ? "tsnz_"
      : data.startsWith("tstart_") ? "tstart_"
      : data.startsWith("tmrw_") ? "tmrw_"
      : "tcancel_";
    const action = prefix.replace(/_$/, "");
    const taskRef = data.replace(prefix, "");

    try {
      // --- Find the task (full UUID or short ID fallback) ---
      let matchedTask: any = null;
      if (taskRef.includes("-") && taskRef.length > 30) {
        const { data: rows } = await supabase.from("tasks")
          .select("id, title, due_time, due_date, priority, reschedule_count, original_date, urgency_level")
          .eq("id", taskRef).in("status", ["pending", "in_progress"]).limit(1);
        matchedTask = rows?.[0] || null;
      }
      if (!matchedTask) {
        const { data: rows } = await supabase.from("tasks")
          .select("id, title, due_time, due_date, priority, reschedule_count, original_date, urgency_level")
          .eq("due_date", todayStr()).in("status", ["pending", "in_progress"])
          .order("priority", { ascending: true });
        matchedTask = (rows || []).find((t: any) => t.id.startsWith(taskRef)) || null;
      }
      // Also check overdue tasks if still not found
      if (!matchedTask) {
        const { data: rows } = await supabase.from("tasks")
          .select("id, title, due_time, due_date, priority, reschedule_count, original_date, urgency_level")
          .in("status", ["pending", "in_progress"]).lt("due_date", todayStr())
          .order("priority", { ascending: true }).limit(20);
        matchedTask = (rows || []).find((t: any) => t.id.startsWith(taskRef)) || null;
      }

      if (!matchedTask) {
        await sendTelegramMessage(chatId, `Tâche introuvable ou déjà complétée.`);
      }
      // ── DONE ──
      else if (action === "tdone") {
        await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", matchedTask.id);
        const rCount = matchedTask.reschedule_count || 0;
        const extra = rCount > 0 ? ` (après ${rCount} report${rCount > 1 ? "s" : ""})` : "";
        await sendTelegramMessage(chatId, `✅ *${escapeMarkdown(matchedTask.title)}* — Terminée !${extra}`, "Markdown");
      }
      // ── SNOOZE +30min (same day) ──
      else if (action === "tsnz") {
        const oldMin = toMin(matchedTask.due_time || "12:00");
        const newMin = oldMin + 30;
        const newTime = `${String(Math.floor(newMin / 60)).padStart(2, "0")}:${String(newMin % 60).padStart(2, "0")}`;
        const rCount = (matchedTask.reschedule_count || 0) + 1;
        const urgency = calcUrgency(rCount, matchedTask.original_date || matchedTask.due_date);
        await supabase.from("tasks").update({
          due_time: newTime, reminder_sent: false, reschedule_count: rCount,
          original_date: matchedTask.original_date || matchedTask.due_date,
          urgency_level: urgency,
        }).eq("id", matchedTask.id);
        const badge = urgency === "critique" ? "🔴" : urgency === "urgent" ? "🟠" : urgency === "attention" ? "🟡" : "";
        await sendTelegramMessage(chatId, `⏰ *${escapeMarkdown(matchedTask.title)}* → ${newTime} ${badge}(report #${rCount})`, "Markdown");
      }
      // ── START ──
      else if (action === "tstart") {
        await supabase.from("tasks").update({ status: "in_progress" }).eq("id", matchedTask.id);
        await sendTelegramMessage(chatId, `🚀 *${escapeMarkdown(matchedTask.title)}* — C'est parti ! Focus.`, "Markdown");
      }
      // ── SNOOZE +1h (same day) ──
      else if (action === "tsnz1h") {
        const oldMin = toMin(matchedTask.due_time || "12:00");
        const newMin = oldMin + 60;
        const newTime = `${String(Math.floor(newMin / 60)).padStart(2, "0")}:${String(newMin % 60).padStart(2, "0")}`;
        const rCount = (matchedTask.reschedule_count || 0) + 1;
        const urgency = calcUrgency(rCount, matchedTask.original_date || matchedTask.due_date);
        await supabase.from("tasks").update({
          due_time: newTime, reminder_sent: false, reschedule_count: rCount,
          original_date: matchedTask.original_date || matchedTask.due_date,
          urgency_level: urgency,
        }).eq("id", matchedTask.id);
        const badge = urgency === "critique" ? "🔴" : urgency === "urgent" ? "🟠" : urgency === "attention" ? "🟡" : "";
        await sendTelegramMessage(chatId, `⏰ *${escapeMarkdown(matchedTask.title)}* → ${newTime} ${badge}(report #${rCount})`, "Markdown");
      }
      // ── DEMAIN (reschedule to tomorrow) ──
      else if (action === "tmrw") {
        const tomorrow = new Date(getIsraelNow());
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tmrwStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
        const rCount = (matchedTask.reschedule_count || 0) + 1;
        const urgency = calcUrgency(rCount, matchedTask.original_date || matchedTask.due_date);
        await supabase.from("tasks").update({
          due_date: tmrwStr, due_time: null, reminder_sent: false, reschedule_count: rCount,
          original_date: matchedTask.original_date || matchedTask.due_date,
          urgency_level: urgency,
        }).eq("id", matchedTask.id);
        const badge = urgency === "critique" ? "🔴" : urgency === "urgent" ? "🟠" : urgency === "attention" ? "🟡" : "";
        const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
        const dayName = dayNames[tomorrow.getDay()];
        await sendTelegramMessage(chatId, `📅 *${escapeMarkdown(matchedTask.title)}* → Demain (${dayName}) ${badge}\nReport #${rCount}`, "Markdown");
      }
      // ── CANCEL ──
      else if (action === "tcancel") {
        await supabase.from("tasks").update({ status: "cancelled" }).eq("id", matchedTask.id);
        await sendTelegramMessage(chatId, `🗑 *${escapeMarkdown(matchedTask.title)}* — Annulée`, "Markdown");
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // ─── TUTORIAL PAGES ───
  else if (data.startsWith("tuto_")) {
    const page = TUTO_PAGES[data];
    if (page) {
      await sendTelegramMessage(chatId, page.text, "HTML", page.buttons);
    }
  }
  // ─── FOCUS MODE CALLBACKS ───
  else if (data === "focus_off") {
    try {
      const signals = getSignalBus("telegram-bot");
      const active = await signals.getLatest("focus_mode_active");
      if (active && active.id && active.status === "active") {
        await signals.dismiss(active.id);
        await signals.emit("focus_mode_ended", "Focus mode désactivé via bouton", {}, { target: "task-reminder", priority: 2, ttlHours: 1 });
      }
      await sendTelegramMessage(chatId, `🔔 *Focus mode désactivé*\nLes notifications reprennent.`, "Markdown");
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("focus_extend_")) {
    const extraMin = parseInt(data.replace("focus_extend_", ""), 10) || 30;
    try {
      const signals = getSignalBus("telegram-bot");
      // Dismiss current and create new with extended TTL
      const active = await signals.getLatest("focus_mode_active");
      if (active && active.id && active.status === "active") {
        await signals.dismiss(active.id);
      }
      const now = new Date();
      // If there was an active signal, extend from its expiry; else from now
      const baseTime = (active?.expires_at && new Date(active.expires_at) > now) ? new Date(active.expires_at) : now;
      const newEnd = new Date(baseTime.getTime() + extraMin * 60000);
      const totalMin = Math.round((newEnd.getTime() - now.getTime()) / 60000);
      const endStr = newEnd.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

      await signals.emit("focus_mode_active", `Focus prolongé jusqu'à ${endStr}`, {
        duration: totalMin,
        endTime: endStr,
        extended: true,
      }, { target: "task-reminder", priority: 1, ttlHours: Math.ceil(totalMin / 60) });

      await sendTelegramMessage(chatId, `🔕 *Focus prolongé +${extraMin}min*\nJusqu'à *${endStr}*`, "Markdown");
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }

  await answerCallbackQuery(callbackId);
}

// --- Job URL Manual Capture ---

async function handleJobAdd(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    await sendTelegramMessage(chatId,
      `Format: /job url [titre]\nEx: /job https://linkedin.com/jobs/view/123 AE Wiz`);
    return;
  }

  const url = args[0];
  // Validate URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    await sendTelegramMessage(chatId, `URL invalide — doit commencer par http`);
    return;
  }

  const title = args.length > 1 ? args.slice(1).join(" ") : "Offre manuelle";

  // Detect source from URL (DB constraint: linkedin, indeed, welovedevs, otta, other)
  let source = "other";
  if (url.includes("linkedin.com")) source = "linkedin";
  else if (url.includes("indeed.com") || url.includes("indeed.fr")) source = "indeed";
  else if (url.includes("welcometothejungle.") || url.includes("wttj.")) source = "welovedevs";
  else if (url.includes("otta.com")) source = "otta";

  const supabase = getSupabaseClient();

  try {
    // Check duplicate
    const { data: existing } = await supabase
      .from("job_listings")
      .select("id")
      .eq("job_url", url)
      .limit(1);

    if (existing && existing.length > 0) {
      await sendTelegramMessage(chatId, `-- Offre deja enregistree`);
      return;
    }

    const { error } = await supabase.from("job_listings").insert({
      title: title.substring(0, 150),
      company: "—",
      job_url: url,
      source: source,
      status: "new",
      date_posted: new Date().toISOString(),
    });

    if (error) throw error;
    await sendTelegramMessage(chatId, `✓ Offre ajoutee\n*${escapeMarkdown(title)}*\nSource: ${source}`);
  } catch (e) {
    console.error("Job add error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Jobs & Signals Handlers ---

async function handleJobs(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("job_listings")
      .select("*")
      .order("date_posted", { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!data || data.length === 0) {
      await sendTelegramMessage(chatId, `-- aucune offre`);
      return;
    }

    let text = `*JOBS*  ${data.length}\n\n`;
    data.forEach((job, idx) => {
      text += `${idx + 1}. ${escapeMarkdown(job.title)}\n`;
      text += `   ${escapeMarkdown(job.company)}\n`;
      text += `   ${job.job_url ? `[lien](${job.job_url})` : '—'}\n\n`;
    });

    await sendTelegramMessage(chatId, text);
  } catch (e) {
    console.error("Jobs error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading Main Menu ---
async function handleTradingMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    // Get latest signals (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from("trading_signals")
      .select("symbol, signal_type, confidence, created_at")
      .neq("symbol", "PLAN").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(3);

    const now = getIsraelNow();
    const hour = now.getHours();
    const day = now.getDay();
    const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

    let text = `📈 *TRADING*\n\n`;
    text += `${dayNames[day]} ${hour}h · `;
    text += day >= 1 && day <= 3 ? "Signaux actifs" : day >= 4 && day <= 5 ? "Observation" : "Off\n";
    text += `\n`;

    if (data && data.length > 0) {
      text += `*Dernière analyse:*\n`;
      const lastTime = new Date(data[0].created_at);
      const ago = Math.round((Date.now() - lastTime.getTime()) / (60 * 1000));
      const agoText = ago < 60 ? `${ago}min` : `${Math.round(ago / 60)}h`;
      text += `  ⏱ Il y a ${agoText}\n`;
      for (const s of data) {
        const icon = s.signal_type === "BUY" ? "▲" : s.signal_type === "SELL" ? "▼" : "—";
        text += `  ${icon} ${s.symbol} ${s.signal_type} · ${s.confidence}%\n`;
      }
    } else {
      text += `Aucune analyse récente (24h)\n`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📊 Dernière analyse", callback_data: "trading_last" }, { text: "🔄 Analyse fraîche", callback_data: "trading_fresh" }],
        [{ text: "📋 Plans semaine", callback_data: "trading_plans" }, { text: "📈 Stats 7j", callback_data: "trading_stats" }],
        [{ text: "⚙️ Gérer pairs", callback_data: "trading_pairs" }, { text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("TradingMain error:", e);
    await sendTelegramMessage(chatId, `Erreur trading: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading: Last Full Analysis ---
async function handleTradingLast(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from("trading_signals")
      .select("symbol, signal_type, confidence, notes, created_at")
      .neq("symbol", "PLAN").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(6);

    if (!data || data.length === 0) {
      await sendTelegramMessage(chatId, "Aucune analyse dans les dernières 48h.\nLance une analyse fraîche 🔄", "Markdown", {
        inline_keyboard: [[{ text: "🔄 Analyse fraîche", callback_data: "trading_fresh" }, { text: "🔙 Trading", callback_data: "menu_signals" }]],
      });
      return;
    }

    // Group by the latest batch (same time window ±5min)
    const firstTime = new Date(data[0].created_at).getTime();
    const batch = data.filter(d => Math.abs(new Date(d.created_at).getTime() - firstTime) < 5 * 60 * 1000);

    const when = new Date(data[0].created_at);
    const ago = Math.round((Date.now() - when.getTime()) / (60 * 1000));
    const agoText = ago < 60 ? `${ago}min` : ago < 1440 ? `${Math.round(ago / 60)}h` : `${Math.round(ago / 1440)}j`;

    let text = `📊 *DERNIÈRE ANALYSE* (il y a ${agoText})\n\n`;

    for (const s of batch) {
      const icon = s.signal_type === "BUY" ? "▲ BUY" : s.signal_type === "SELL" ? "▼ SELL" : "— HOLD";
      text += `*${s.symbol}* ${icon}\n`;

      try {
        const notes = JSON.parse(s.notes || "{}");
        text += `  1D ${notes.trend1D || "?"} · 4H ${notes.trend4H || "?"}\n`;
        text += `  Contexte: ${notes.context || "?"} · EMA: ${notes.ema200 || "?"}\n`;
        text += `  Confluence: ${notes.confluence || "?"}/7\n`;
        if (notes.signal) {
          const sig = notes.signal;
          text += `  Entry $${sig.entry?.toLocaleString() || "?"}\n`;
          text += `  SL $${sig.sl?.toLocaleString() || "?"} · TP $${sig.tp?.toLocaleString() || "?"}\n`;
          text += `  R:R ${sig.rr || "?"} · ${sig.strategy || ""} · ${sig.confidence || "?"}%\n`;
        }
      } catch (_) {
        text += `  Conf: ${s.confidence}%\n`;
      }
      text += `\n`;
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "🔄 Analyse fraîche", callback_data: "trading_fresh" }, { text: "🔙 Trading", callback_data: "menu_signals" }],
      ],
    });
  } catch (e) {
    console.error("TradingLast error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading: Trigger Fresh Analysis ---
async function handleTradingFresh(chatId: number): Promise<void> {
  await sendTelegramMessage(chatId, "🔄 Analyse en cours... (30-60 sec)");
  try {
    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const res = await fetch(`${sbUrl}/functions/v1/trading-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sbKey}` },
      body: JSON.stringify({ force_mode: "trading" }),
    });
    const result = await res.json();
    if (result.success) {
      await sendTelegramMessage(chatId, `✅ Analyse terminée!\n${result.analyses?.map((a: any) => `${a.symbol}: ${a.signal} (${a.confluence}/7)`).join("\n") || ""}`, "Markdown", {
        inline_keyboard: [[{ text: "📊 Voir détails", callback_data: "trading_last" }, { text: "🔙 Trading", callback_data: "menu_signals" }]],
      });
    } else {
      await sendTelegramMessage(chatId, `❌ Erreur: ${result.error || "inconnue"}`, "Markdown", {
        inline_keyboard: [[{ text: "🔙 Trading", callback_data: "menu_signals" }]],
      });
    }
  } catch (e) {
    console.error("TradingFresh error:", e);
    await sendTelegramMessage(chatId, `❌ Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading: Weekly Plans ---
async function handleTradingPlans(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from("trading_signals")
      .select("notes, created_at").eq("symbol", "PLAN").gte("created_at", weekAgo)
      .order("created_at", { ascending: false }).limit(1);

    if (!data || data.length === 0) {
      await sendTelegramMessage(chatId, "Aucun plan cette semaine.\nLe plan est généré dimanche soir automatiquement.", "Markdown", {
        inline_keyboard: [[{ text: "🔙 Trading", callback_data: "menu_signals" }]],
      });
      return;
    }

    const planData = JSON.parse(data[0].notes || "{}");
    const plans = planData.plans || [];
    const when = new Date(data[0].created_at);
    const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

    let text = `📋 *PLAN SEMAINE*\n`;
    text += `Créé ${dayNames[when.getDay()]} ${when.getDate()}/${when.getMonth() + 1}\n\n`;

    if (plans.length === 0) {
      text += `Aucun plan conditionnel.\n`;
    } else {
      for (const p of plans) {
        const icon = p.type === "BUY_ZONE" ? "🟢" : p.type === "SELL_ZONE" ? "🔴" : "⚠️";
        text += `${icon} *${p.symbol}*\n`;
        text += `  SI: ${p.condition}\n`;
        text += `  → ${p.action}\n\n`;
      }
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [[{ text: "🔙 Trading", callback_data: "menu_signals" }]],
    });
  } catch (e) {
    console.error("TradingPlans error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading: 7-Day Stats ---
async function handleTradingStats(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from("trading_signals")
      .select("symbol, signal_type, confidence, created_at")
      .neq("symbol", "PLAN").gte("created_at", weekAgo)
      .order("created_at", { ascending: false });

    let text = `📈 *STATS TRADING 7J*\n\n`;

    if (!data || data.length === 0) {
      text += `Aucun signal cette semaine.\n`;
    } else {
      const total = data.length;
      const buys = data.filter((s: any) => s.signal_type === "BUY").length;
      const sells = data.filter((s: any) => s.signal_type === "SELL").length;
      const holds = data.filter((s: any) => s.signal_type === "HOLD").length;
      const highConf = data.filter((s: any) => (s.confidence || 0) >= 50).length;

      // Unique analysis sessions (grouped by time)
      const sessions = new Set(data.map((s: any) => new Date(s.created_at).toISOString().split("T")[0]));

      text += `Analyses: ${sessions.size} jours\n`;
      text += `Signaux: *${total}* (${buys} BUY · ${sells} SELL · ${holds} HOLD)\n`;
      text += `Haute confiance: ${highConf}/${total} (${total > 0 ? Math.round((highConf / total) * 100) : 0}%)\n\n`;

      // Per symbol breakdown
      const symbols = [...new Set(data.map((s: any) => s.symbol))];
      for (const sym of symbols) {
        const symData = data.filter((s: any) => s.symbol === sym);
        const symSignals = symData.filter((s: any) => s.signal_type !== "HOLD");
        text += `*${sym}*: ${symData.length} analyses · ${symSignals.length} signaux\n`;
      }
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [[{ text: "🔙 Trading", callback_data: "menu_signals" }]],
    });
  } catch (e) {
    console.error("TradingStats error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Trading: Pair Management ---
async function getTradingPairs(): Promise<string[]> {
  const supabase = getSupabaseClient();
  try {
    // Try trading_signals with symbol="CONFIG"
    const { data } = await supabase.from("trading_signals")
      .select("notes").eq("symbol", "CONFIG")
      .order("created_at", { ascending: false }).limit(1);
    if (data && data.length > 0) {
      const cfg = JSON.parse(data[0].notes || "{}");
      if (Array.isArray(cfg.pairs) && cfg.pairs.length > 0) return cfg.pairs;
    }
    // Fallback: check tasks table for TRADING_CONFIG
    const { data: taskData } = await supabase.from("tasks")
      .select("title").like("title", "TRADING_CONFIG:%")
      .order("created_at", { ascending: false }).limit(1);
    if (taskData && taskData.length > 0) {
      const pairsJson = taskData[0].title.replace("TRADING_CONFIG:", "");
      const pairs = JSON.parse(pairsJson);
      if (Array.isArray(pairs) && pairs.length > 0) return pairs;
    }
  } catch (e) { console.error("getTradingPairs error:", e); }
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
}

async function saveTradingPairs(pairs: string[]): Promise<boolean> {
  const supabase = getSupabaseClient();
  // Use EXACT same format as trading-agent (PLAN insert) which works in production
  const payload = {
    symbol: "CONFIG",
    signal_type: "HOLD",
    confidence: 0,
    notes: JSON.stringify({ type: "CONFIG", pairs, updated: new Date().toISOString() }),
    created_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from("trading_signals").insert(payload);
    if (error) {
      console.error("saveTradingPairs error:", JSON.stringify(error));
      // Fallback: try storing in tasks table instead
      const { error: err2 } = await supabase.from("tasks").insert({
        title: "TRADING_CONFIG:" + JSON.stringify(pairs),
        status: "completed",
        priority: 5,
        created_at: new Date().toISOString(),
      });
      if (err2) {
        console.error("saveTradingPairs tasks fallback error:", JSON.stringify(err2));
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error("saveTradingPairs error:", e);
    return false;
  }
}

async function handleTradingPairs(chatId: number): Promise<void> {
  try {
    const pairs = await getTradingPairs();

    let text = `⚙️ *PAIRS TRADING*\n\n`;
    text += `Pairs actuelles (${pairs.length}):\n`;
    for (const p of pairs) {
      text += `  • ${p}\n`;
    }
    text += `\nActions:\n`;
    text += `• Ajouter: tape le symbole (ex: XRPUSDT)\n`;
    text += `• Supprimer: clique ❌ ci-dessous\n`;

    // Build remove buttons (one per pair)
    const removeButtons: InlineKeyboardButton[][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      row.push({ text: `❌ ${pairs[i]}`, callback_data: `tpair_rm_${pairs[i]}` });
      if (i + 1 < pairs.length) {
        row.push({ text: `❌ ${pairs[i + 1]}`, callback_data: `tpair_rm_${pairs[i + 1]}` });
      }
      removeButtons.push(row);
    }

    // Common pairs to add (exclude already present)
    const allCommon = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "ADAUSDT", "DOTUSDT", "LINKUSDT", "MATICUSDT"];
    const available = allCommon.filter(p => !pairs.includes(p));
    const addButtons: InlineKeyboardButton[][] = [];
    if (available.length > 0) {
      for (let i = 0; i < Math.min(available.length, 6); i += 3) {
        const row: InlineKeyboardButton[] = [];
        for (let j = i; j < Math.min(i + 3, available.length, 6); j++) {
          row.push({ text: `➕ ${available[j]}`, callback_data: `tpair_add_${available[j]}` });
        }
        addButtons.push(row);
      }
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        ...removeButtons,
        ...addButtons,
        [{ text: "🔙 Trading", callback_data: "menu_signals" }],
      ],
    });
  } catch (e) {
    console.error("TradingPairs error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

function normalizePairName(input: string): string {
  let raw = input.toUpperCase().trim();
  // Handle "PAXG/USDC", "BTC/USDT", "ETH / USDT" format
  if (raw.includes("/")) {
    const parts = raw.split("/").map(p => p.trim().replace(/[^A-Z0-9]/g, ""));
    if (parts.length === 2 && parts[0] && parts[1]) {
      return parts[0] + parts[1]; // e.g. "PAXG" + "USDC" = "PAXGUSDC"
    }
  }
  // Handle "PAXG-USDC" format
  if (raw.includes("-")) {
    const parts = raw.split("-").map(p => p.trim().replace(/[^A-Z0-9]/g, ""));
    if (parts.length === 2 && parts[0] && parts[1]) {
      return parts[0] + parts[1];
    }
  }
  // Clean up
  raw = raw.replace(/[^A-Z0-9]/g, "");
  // If it already ends with a known quote currency, keep as-is
  const quotes = ["USDT", "USDC", "BUSD", "BTC", "ETH", "EUR"];
  for (const q of quotes) {
    if (raw.endsWith(q) && raw.length > q.length) return raw;
  }
  // Default: append USDT
  return raw + "USDT";
}

async function handleTradingAddPair(chatId: number, pair: string): Promise<void> {
  try {
    const pairs = await getTradingPairs();
    const normalized = normalizePairName(pair);

    if (normalized.length < 5 || normalized.length > 20) {
      await sendTelegramMessage(chatId, `⚠️ Format invalide: ${normalized}\nExemples: XRPUSDT, PAXG/USDC, AVAXUSDT`);
      return;
    }

    if (pairs.includes(normalized)) {
      await sendTelegramMessage(chatId, `⚠️ ${normalized} est deja dans la liste.`);
      await handleTradingPairs(chatId);
      return;
    }

    if (pairs.length >= 10) {
      await sendTelegramMessage(chatId, `⚠️ Maximum 10 pairs. Supprime d'abord une pair.`);
      await handleTradingPairs(chatId);
      return;
    }

    pairs.push(normalized);
    const ok = await saveTradingPairs(pairs);
    if (ok) {
      await sendTelegramMessage(chatId, `✅ ${normalized} ajoutee! (${pairs.length} pairs)`);
    } else {
      await sendTelegramMessage(chatId, `❌ Erreur sauvegarde.`);
    }
    await handleTradingPairs(chatId);
  } catch (e) {
    console.error("AddPair error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleTradingRemovePair(chatId: number, pair: string): Promise<void> {
  try {
    const pairs = await getTradingPairs();

    if (!pairs.includes(pair)) {
      await sendTelegramMessage(chatId, `⚠️ ${pair} n'est pas dans la liste.`);
      await handleTradingPairs(chatId);
      return;
    }

    if (pairs.length <= 1) {
      await sendTelegramMessage(chatId, `⚠️ Impossible: il faut au moins 1 pair.`);
      await handleTradingPairs(chatId);
      return;
    }

    const newPairs = pairs.filter(p => p !== pair);
    const ok = await saveTradingPairs(newPairs);
    if (ok) {
      await sendTelegramMessage(chatId, `✅ ${pair} supprimee! (${newPairs.length} pairs)`);
    } else {
      await sendTelegramMessage(chatId, `❌ Erreur sauvegarde.`);
    }
    await handleTradingPairs(chatId);
  } catch (e) {
    console.error("RemovePair error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- Review Handler ---

async function handleReview(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "completed")
      .gte("updated_at", dayStart);

    const { data: expenses } = await supabase
      .from("finance_logs")
      .select("*")
      .eq("transaction_type", "expense")
      .gte("transaction_date", dayStart.split('T')[0]);

    const { data: workouts } = await supabase
      .from("health_logs")
      .select("*")
      .eq("log_type", "workout")
      .gte("log_date", dayStart.split('T')[0]);

    let text = `*EVENING REVIEW*\n\n`;

    if (tasks && tasks.length > 0) {
      text += `Completes (${tasks.length}):\n`;
      tasks.slice(0, 5).forEach(t => {
        text += `✓ ${escapeMarkdown(t.title)}\n`;
      });
      text += `\n`;
    } else {
      text += `-- aucune tache completee\n\n`;
    }

    if (expenses && expenses.length > 0) {
      const total = expenses.reduce((sum, e) => sum + e.amount, 0);
      text += `Depenses (${expenses.length}): *${total.toFixed(0)}₪*\n`;
      text += `\n`;
    }

    if (workouts && workouts.length > 0) {
      text += `Workouts (${workouts.length}):\n`;
      workouts.forEach(w => {
        text += `${w.workout_type}  ${w.duration_minutes}min\n`;
      });
    }

    await sendTelegramMessage(chatId, text);
  } catch (e) {
    console.error("Review error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Goals Handler ---

// ─── TUTORIAL SYSTEM ─────────────────────────────────────────────────────

const TUTO_PAGES: Record<string, { text: string; buttons: InlineKeyboardMarkup }> = {
  tuto_main: {
    text:
      `<b>❓ GUIDE OREN — Ton assistant personnel</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `OREN est un système de <b>10 agents IA</b> qui travaillent 24/7 en arrière-plan pour t'aider à être organisé et productif.\n\n` +
      `<b>🤖 Agents automatiques (cron):</b>\n` +
      `  · Morning Briefing — 07h00, tes 3 priorités du jour\n` +
      `  · Task Reminder — toutes les 15min, rappels + nudges\n` +
      `  · Evening Review — 21h30, bilan + coach IA\n` +
      `  · Weekly Planning — Dimanche 10h, bilan semaine\n` +
      `  · Career Agent — 09h, scan offres emploi\n` +
      `  · Health Agent — 06h, suivi santé\n` +
      `  · Finance Agent — 20h, analyse dépenses\n` +
      `  · Learning Agent — 14h, suggestions d'étude\n` +
      `  · Trading Agent — toutes les 4h, signaux crypto\n` +
      `  · Higrow Agent — 10h, suivi prospects\n\n` +
      `Choisis un domaine pour en savoir plus:`,
    buttons: {
      inline_keyboard: [
        [{ text: "📋 Tâches & Productivité", callback_data: "tuto_tasks" }, { text: "💰 Finance", callback_data: "tuto_finance" }],
        [{ text: "🏋️ Santé", callback_data: "tuto_health" }, { text: "💼 Carrière & Leads", callback_data: "tuto_career" }],
        [{ text: "📈 Trading", callback_data: "tuto_trading" }, { text: "🔕 Focus & Nudges", callback_data: "tuto_focus" }],
        [{ text: "💬 Langage naturel", callback_data: "tuto_natural" }, { text: "🎯 Objectifs", callback_data: "tuto_goals" }],
        [{ text: "« Menu principal", callback_data: "menu_main" }],
      ],
    },
  },
  tuto_tasks: {
    text:
      `<b>📋 TÂCHES & PRODUCTIVITÉ</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /task add <i>titre</i> — Ajouter une tâche\n` +
      `  /task list — Voir les tâches en cours\n` +
      `  /task done <i>num</i> — Marquer comme faite\n` +
      `  /mission <i>titre heure [durée]</i> — Planifier un créneau\n\n` +
      `<b>Automatisations:</b>\n` +
      `  · Chaque matin: "Les 3 du jour" — l'IA choisit tes 3 tâches prioritaires et leur assigne un horaire\n` +
      `  · Toutes les 15min: rappel si une tâche approche\n` +
      `  · 30-90min de retard: check-in avec boutons ✅/⏰\n` +
      `  · 2h d'inactivité: nudge "Commence par 5 min"\n` +
      `  · Le soir: confrontation des tâches non faites + taux de complétion\n` +
      `  · Dimanche: bilan hebdo + report automatique des urgences\n\n` +
      `<b>Astuce:</b> Tu peux aussi envoyer un message normal comme "appeler le comptable demain 14h" et l'IA crée la tâche automatiquement.`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "📋 Voir mes tâches", callback_data: "menu_tasks" }],
      ],
    },
  },
  tuto_finance: {
    text:
      `<b>💰 FINANCE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /expense <i>montant catégorie</i> — Dépense carte\n` +
      `  /cash <i>montant catégorie</i> — Dépense espèces\n` +
      `  /income <i>montant catégorie</i> — Revenu\n` +
      `  /budget — Dashboard budget\n\n` +
      `<b>Catégories:</b> restaurant, courses, transport, electricite, bien_etre, divertissement, abonnements, sante, autre\n\n` +
      `<b>Budgets mensuels:</b>\n` +
      `  🍽️ Restaurant ₪400 · 🛒 Courses ₪300\n` +
      `  ⚡ Électricité ₪200 · 🚌 Transport ₪150\n` +
      `  💆 Bien-être ₪100 · 🎮 Divertissement ₪80\n\n` +
      `<b>Automatisations:</b>\n` +
      `  · Alerte quand tu dépasses 80% du budget d'une catégorie\n` +
      `  · Rappel si pas de log cash depuis 3 jours\n` +
      `  · Tendances mois par mois par catégorie\n` +
      `  · Taux d'épargne calculé automatiquement\n\n` +
      `<b>Astuce:</b> Envoie juste "45 shekel café" ou une photo de ticket et l'IA comprend.`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "💰 Mon budget", callback_data: "menu_budget" }],
      ],
    },
  },
  tuto_health: {
    text:
      `<b>🏋️ SANTÉ</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /health weight <i>kg</i> — Logger ton poids\n` +
      `  /health workout <i>type</i> — Logger un entraînement\n` +
      `  /health status — Voir tes stats\n\n` +
      `<b>Automatisations:</b>\n` +
      `  · Suivi quotidien poids + tendance 7 jours\n` +
      `  · Compteur de streak entraînements\n` +
      `  · Alerte si streak en danger (2j sans sport)\n` +
      `  · Détection sommeil insuffisant → signal aux autres agents\n` +
      `  · Programme workout intégré au planning\n\n` +
      `<b>Signaux inter-agents:</b>\n` +
      `  · Mauvais sommeil → morning-briefing adapte les priorités\n` +
      `  · Streak en danger → task-reminder envoie un nudge sport\n` +
      `  · Récupération → evening-review ajuste le score`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "🏋️ Ma santé", callback_data: "menu_health" }],
      ],
    },
  },
  tuto_career: {
    text:
      `<b>💼 CARRIÈRE & LEADS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes Carrière:</b>\n` +
      `  /job <i>url [titre]</i> — Ajouter une offre\n` +
      `  /jobs — Pipeline d'offres\n\n` +
      `<b>Commandes HiGrow (prospects):</b>\n` +
      `  /lead add <i>nom spécialité [email]</i>\n` +
      `  /lead list — Voir les leads\n\n` +
      `<b>Automatisations:</b>\n` +
      `  · Career Agent: scan quotidien des offres, tracking pipeline\n` +
      `  · Détection de patterns de rejet (3+ rejets en 14j → alerte)\n` +
      `  · Extraction automatique des compétences requises\n` +
      `  · Signaux skill_gap → learning agent ajuste les priorités d'étude\n` +
      `  · HiGrow Agent: suivi relances, pipeline velocity\n\n` +
      `<b>Apprentissage:</b>\n` +
      `  /study <i>topic minutes</i> — Logger une session\n` +
      `  · Le learning agent consomme les signaux carrière pour prioriser`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "💼 Pipeline", callback_data: "menu_jobs" }],
      ],
    },
  },
  tuto_trading: {
    text:
      `<b>📈 TRADING CRYPTO</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /signals — Menu trading complet\n\n` +
      `<b>Menu Trading:</b>\n` +
      `  · 📊 Derniers signaux — signaux actifs BUY/SELL\n` +
      `  · 🔄 Analyse fraîche — lancer une analyse maintenant\n` +
      `  · 📋 Plans — plans de trade avec TP/SL\n` +
      `  · 📈 Stats — performance historique\n` +
      `  · ⚙️ Paires — gérer BTC, ETH, SOL, PAXG\n\n` +
      `<b>Automatisations:</b>\n` +
      `  · Analyse multi-timeframe toutes les 4h (Dim-Ven)\n` +
      `  · Dimanche soir: biais weekly (1D)\n` +
      `  · Lun-Mer: signaux BUY/SELL actifs\n` +
      `  · Jeu-Ven: observation uniquement\n` +
      `  · Samedi: OFF\n` +
      `  · TP/SL calculés automatiquement avec R:R\n` +
      `  · Sync Google Calendar pour les trades actifs`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "📈 Trading", callback_data: "menu_signals" }],
      ],
    },
  },
  tuto_focus: {
    text:
      `<b>🔕 FOCUS MODE & NUDGES</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /focus <i>[minutes]</i> — Active le mode focus (défaut 90min)\n` +
      `  /focus off — Désactive\n` +
      `  /focus status — Vérifie l'état\n\n` +
      `<b>Pendant le focus:</b>\n` +
      `  ✅ Rappels P1/P2 critiques → passent\n` +
      `  🔇 Check-ins de retard → silencieux\n` +
      `  🔇 Nudges d'inactivité → silencieux\n` +
      `  🔇 Events de schedule → silencieux\n\n` +
      `<b>Système de nudges (hors focus):</b>\n` +
      `  ⏰ 15min avant → Rappel classique\n` +
      `  👀 30-90min retard → "CHECK-IN" + boutons ✅ Fait / ⏰ +30min\n` +
      `  💪 2h d'inactivité → "NUDGE" + boutons ✅ J'y suis / ⏰ +1h\n\n` +
      `<b>Astuce:</b> Utilise /focus 60 avant un entretien ou une session de deep work.`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }],
      ],
    },
  },
  tuto_natural: {
    text:
      `<b>💬 LANGAGE NATUREL</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Pas besoin de commandes ! Envoie un message normal et l'IA comprend:\n\n` +
      `<b>Tâches:</b>\n` +
      `  "appeler le dentiste demain 14h"\n` +
      `  "rappelle-moi d'acheter du lait"\n` +
      `  "j'ai fini le rapport"\n\n` +
      `<b>Dépenses:</b>\n` +
      `  "45 shekel café"\n` +
      `  "j'ai payé 200 pour l'électricité"\n` +
      `  📸 Envoie une photo de ticket → extraction auto\n\n` +
      `<b>Santé:</b>\n` +
      `  "72.5 kg"\n` +
      `  "j'ai fait 30min de course"\n\n` +
      `<b>Général:</b>\n` +
      `  🎤 Envoie un vocal → transcription + action\n` +
      `  Toute phrase est analysée par GPT-4o pour extraire l'intention\n\n` +
      `<b>Astuce:</b> Plus tu es précis (date, heure, montant), mieux c'est.`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }],
      ],
    },
  },
  tuto_goals: {
    text:
      `<b>🎯 OBJECTIFS & BILANS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Commandes:</b>\n` +
      `  /goals — Voir tes objectifs actifs\n` +
      `  /review — Lancer un bilan maintenant\n` +
      `  /insights — Analyses IA transversales\n` +
      `  /today — Planning du jour\n` +
      `  /dashboard — Lien vers le dashboard web\n\n` +
      `<b>Bilans automatiques:</b>\n` +
      `  · 21h30 chaque soir — Score /10, tâches, finance, santé, coach IA\n` +
      `  · Dimanche 10h — Bilan hebdomadaire complet + plan semaine\n\n` +
      `<b>Ce que le coach IA analyse:</b>\n` +
      `  · Taux de complétion + tâches non faites\n` +
      `  · Patterns par jour (ex: lundi = jour faible)\n` +
      `  · Progress vers chaque objectif\n` +
      `  · Actions concrètes pour demain\n` +
      `  · Report auto des tâches P1/P2 en retard\n\n` +
      `<b>Inter-agent:</b> Tous les agents émettent des signaux que le bilan du soir et le briefing du matin consomment pour avoir une vue 360°.`,
    buttons: {
      inline_keyboard: [
        [{ text: "« Retour guide", callback_data: "tuto_main" }, { text: "🎯 Objectifs", callback_data: "menu_goals" }],
      ],
    },
  },
};

// ─── FOCUS MODE ──────────────────────────────────────────────────────────

async function handleFocus(chatId: number, args: string[]): Promise<void> {
  const signals = getSignalBus("telegram-bot");

  // /focus off — disable focus mode
  if (args[0] === "off" || args[0] === "stop") {
    try {
      // Find active focus signal and dismiss it
      const active = await signals.getLatest("focus_mode_active");
      if (active && active.id && active.status === "active") {
        await signals.dismiss(active.id);
        await signals.emit("focus_mode_ended", "Focus mode désactivé", {}, { target: "task-reminder", priority: 2, ttlHours: 1 });
        await sendTelegramMessage(chatId, `🔔 *Focus mode désactivé*\nLes notifications reprennent.`, "Markdown");
      } else {
        await sendTelegramMessage(chatId, `Le focus mode n'est pas actif.`);
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
    return;
  }

  // /focus status — check current state
  if (args[0] === "status") {
    try {
      const active = await signals.getLatest("focus_mode_active");
      if (active && active.status === "active" && active.expires_at && new Date(active.expires_at) > new Date()) {
        const endTime = new Date(active.expires_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
        await sendTelegramMessage(chatId, `🔕 *Focus mode actif* jusqu'à ${endTime}\n\nSeuls les rappels P1 critiques passent.\n/focus off pour désactiver`, "Markdown");
      } else {
        await sendTelegramMessage(chatId, `🔔 Focus mode *inactif*\n/focus 60 pour activer (60 min)`, "Markdown");
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
    return;
  }

  // /focus [minutes] — enable focus mode (default 90 min)
  const minutes = parseInt(args[0], 10) || 90;
  const cappedMin = Math.min(Math.max(minutes, 15), 480); // 15min to 8h

  try {
    // Check if already active
    const existing = await signals.getLatest("focus_mode_active");
    if (existing && existing.id && existing.status === "active" && existing.expires_at && new Date(existing.expires_at) > new Date()) {
      await signals.dismiss(existing.id);
    }

    // Emit focus signal with TTL
    const now = new Date();
    const endTime = new Date(now.getTime() + cappedMin * 60000);
    const endStr = endTime.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

    await signals.emit("focus_mode_active", `Focus mode jusqu'à ${endStr}`, {
      duration: cappedMin,
      endTime: endStr,
      startedAt: now.toISOString(),
    }, { target: "task-reminder", priority: 1, ttlHours: Math.ceil(cappedMin / 60) });

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "⏰ +30min", callback_data: "focus_extend_30" },
          { text: "🔔 Arrêter", callback_data: "focus_off" },
        ],
      ],
    };

    await sendTelegramMessage(chatId,
      `🔕 *Focus mode activé — ${cappedMin} min*\n\n` +
      `Jusqu'à *${endStr}*\n` +
      `Seuls les rappels critiques (P1) passeront.\n` +
      `Tout le reste est en silencieux.`,
      "Markdown", markup);
  } catch (e) {
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleGoals(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const { data: goals } = await supabase.from("goals")
      .select("*").eq("status", "active").order("priority");

    if (!goals || goals.length === 0) {
      await sendTelegramMessage(chatId, "Aucun objectif défini.");
      return;
    }

    const domainEmoji: Record<string, string> = {
      career: "💼", finance: "💰", health: "🏋️",
      higrow: "🚀", trading: "📈", learning: "📚", personal: "🏠"
    };

    let text = "🎯 *MES OBJECTIFS*\n\n";
    goals.forEach((g: any) => {
      const emoji = domainEmoji[g.domain] || "📌";
      const current = Number(g.metric_current) || 0;
      const target = Number(g.metric_target) || 1;
      const start = Number(g.metric_start) || 0;
      const isDecrease = g.direction === 'decrease';

      let progress: number;
      if (isDecrease && start > target) {
        // Decrease goal (e.g., weight: 75 → 70kg, currently 72.5)
        const totalToLose = start - target;       // 75 - 70 = 5
        const alreadyLost = start - current;      // 75 - 72.5 = 2.5
        progress = Math.max(0, Math.min(100, Math.round((alreadyLost / totalToLose) * 100)));
      } else {
        progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
      }

      const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86400000) : null;
      const barFilled = Math.round(progress / 10);
      const bar = "█".repeat(barFilled) + "░".repeat(10 - barFilled);

      text += `${emoji} *${g.title}*\n`;
      text += `   ${bar} ${progress}%\n`;
      text += `   ${current}/${target}${g.metric_unit}`;
      if (daysLeft !== null) text += ` · ${daysLeft}j restants`;
      text += `\n\n`;
    });

    await sendTelegramMessage(chatId, text);
  } catch (e) {
    console.error("Goals error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Insights Handler (4 lignes haute valeur, pas d'AI) ---

async function handleInsights(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  const now = new Date();
  const today = todayStr();
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
  const prevWeekStart = new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0];
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  try {
    const [finThisMonth, finLastWeek, finThisWeek, healthWeek, goalsRes, jobsRes, leadsRes] = await Promise.all([
      supabase.from("finance_logs").select("transaction_type, amount").gte("transaction_date", monthStart),
      supabase.from("finance_logs").select("transaction_type, amount")
        .gte("transaction_date", prevWeekStart).lt("transaction_date", weekAgo),
      supabase.from("finance_logs").select("transaction_type, amount")
        .gte("transaction_date", weekAgo),
      supabase.from("health_logs").select("log_type, log_date, workout_type")
        .gte("log_date", weekAgo).order("log_date", { ascending: false }),
      supabase.from("goals").select("domain, title, metric_current, metric_target, metric_start, direction, deadline")
        .eq("status", "active"),
      supabase.from("job_listings").select("status, created_at")
        .in("status", ["interview", "applied", "new"]),
      supabase.from("leads").select("status, created_at")
        .gte("created_at", monthStart),
    ]);

    // --- LINE 1: Finance / Savings ---
    const monthData = finThisMonth.data || [];
    const monthIncome = monthData.filter(f => f.transaction_type === "income").reduce((s, e) => s + e.amount, 0);
    const monthExpense = monthData.filter(f => f.transaction_type === "expense").reduce((s, e) => s + e.amount, 0);
    const savingsRate = monthIncome > 0 ? Math.round(((monthIncome - monthExpense) / monthIncome) * 100) : 0;

    // Week-over-week expense comparison
    const lastWeekExp = (finLastWeek.data || []).filter(f => f.transaction_type === "expense").reduce((s, e) => s + e.amount, 0);
    const thisWeekExp = (finThisWeek.data || []).filter(f => f.transaction_type === "expense").reduce((s, e) => s + e.amount, 0);
    let expDelta = "";
    if (lastWeekExp > 0) {
      const pct = Math.round(((thisWeekExp - lastWeekExp) / lastWeekExp) * 100);
      expDelta = pct >= 0 ? ` (+${pct}% vs sem\\. dern\\.)` : ` (${pct}% vs sem\\. dern\\.)`;
    }
    const savingsEmoji = savingsRate >= 20 ? "🟢" : savingsRate >= 10 ? "🟡" : "🔴";
    const line1 = `💰 Épargne: ${savingsEmoji} ${savingsRate}%${expDelta} · Obj: 20%`;

    // --- LINE 2: Career ---
    const jobs = jobsRes.data || [];
    const interviews = jobs.filter(j => j.status === "interview").length;
    const applied = jobs.filter(j => j.status === "applied").length;
    const careerGoal = (goalsRes.data || []).find((g: any) => g.domain === "career");
    let daysLeft = "?";
    if (careerGoal?.deadline) {
      daysLeft = String(Math.max(0, Math.ceil((new Date(careerGoal.deadline).getTime() - now.getTime()) / 86400000)));
    }
    const careerEmoji = interviews > 0 ? "🟢" : Number(daysLeft) < 120 ? "🔴" : "🟡";
    const line2 = `💼 Career: ${careerEmoji} ${interviews} interview${interviews !== 1 ? "s" : ""} · ${applied} applied · ${daysLeft}j deadline`;

    // --- LINE 3: Health streak + next workout ---
    const healthData = healthWeek.data || [];
    const workoutDates = [...new Set(healthData.filter(h => h.log_type === "workout").map(h => h.log_date))].sort().reverse();
    // Count streak (consecutive days from today backwards)
    let streak = 0;
    const todayDate = new Date(today);
    for (let i = 0; i < 14; i++) {
      const checkDate = new Date(todayDate.getTime() - i * 86400000).toISOString().split("T")[0];
      if (workoutDates.includes(checkDate)) {
        streak++;
      } else if (i > 0) break; // allow today to not have workout yet
    }
    // Next workout day (PPL cycle: Push/Pull/Legs/Cardio/Rest)
    const PPL = ["Push", "Pull", "Legs", "Cardio", "Rest"];
    const dayOfWeek = now.getDay(); // 0=Sun
    // Simple PPL mapping: Mon=Push, Tue=Pull, Wed=Legs, Thu=Cardio, Fri=Push, Sat=Pull, Sun=Rest
    const pplMap: Record<number, string> = { 1: "Push", 2: "Pull", 3: "Legs", 4: "Cardio", 5: "Push", 6: "Pull", 0: "Rest" };
    const todayWorkout = pplMap[dayOfWeek] || "Rest";
    const tomorrowWorkout = pplMap[(dayOfWeek + 1) % 7] || "Rest";
    const healthGoal = (goalsRes.data || []).find((g: any) => g.domain === "health");
    const weightInfo = healthGoal ? `${Number(healthGoal.metric_current)}kg→${Number(healthGoal.metric_target)}kg` : "";
    const line3 = `🏋️ Streak: ${streak}j · ${todayWorkout} aujourd'hui · ${weightInfo}`;

    // --- LINE 4: HiGrow velocity ---
    const leads = leadsRes.data || [];
    const converted = leads.filter(l => l.status === "converted").length;
    const higrowGoal = (goalsRes.data || []).find((g: any) => g.domain === "higrow");
    const target = higrowGoal ? Number(higrowGoal.metric_target) : 10;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const velocity = dayOfMonth > 0 ? (converted / dayOfMonth * daysInMonth).toFixed(0) : "0";
    const higrowEmoji = converted >= target ? "🟢" : Number(velocity) >= target ? "🟡" : "🔴";
    const line4 = `🚀 HiGrow: ${higrowEmoji} ${converted}/${target} clients · ${daysRemaining}j restants · proj: ${velocity}`;

    const text = `🧠 *INSIGHTS*\n\n${line1}\n${line2}\n${line3}\n${line4}`;
    await sendTelegramMessage(chatId, text, {
      inline_keyboard: [[{ text: "🔙 Menu", callback_data: "start" }]],
    });
  } catch (e) {
    console.error("Insights error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 80)}`);
  }
}

// --- AI Natural Language Layer ---

const AI_SYSTEM_PROMPT = `Tu es OREN, l'assistant IA personnel d'Oren. Tu reçois des messages en langage naturel via Telegram.
Tu dois comprendre l'intention et répondre UNIQUEMENT en JSON valide:
{
  "intent": "action_name",
  "params": { ... },
  "reply": "Message court en français"
}

ACTIONS DISPONIBLES:

add_task - Ajouter une tâche ou rappel
  params: { "title": "texte", "priority": 1-5, "due_date": "YYYY-MM-DD", "due_time": "HH:MM" }
  Priorité: 1=critique, 2=urgent, 3=normal, 4=faible, 5=un jour

complete_task - Marquer une tâche terminée (cherche par mot-clé)
  params: { "search": "mot clé" }

list_tasks - Voir les tâches en cours
  params: {}

add_expense - Enregistrer une dépense
  params: { "amount": number, "category": "restaurant|courses|transport|electricite|bien_etre|divertissement|abonnements|sante|autre", "description": "texte", "payment_method": "card|cash|transfer" }
  Si l'utilisateur dit "cash" ou "espèces" → payment_method: "cash"
  Si l'utilisateur dit "carte" ou rien → payment_method: "card"
  Si l'utilisateur dit "virement" → payment_method: "transfer"

add_income - Enregistrer un revenu
  params: { "amount": number, "category": "salaire|freelance|bonus|other", "description": "texte" }

show_budget - Voir le budget du mois
  params: {}

log_weight - Enregistrer le poids
  params: { "value": number }

log_workout - Enregistrer un entraînement
  params: { "type": "push|pull|legs|cardio|mobility", "duration": number }

health_status - Voir les stats santé
  params: {}

schedule_mission - Planifier une mission avec heure précise
  params: { "title": "texte", "time": "HH:MM", "duration": number }

add_to_calendar - Ajouter un événement/rdv/rencontre à l'agenda Google Calendar
  params: { "title": "texte descriptif", "date": "YYYY-MM-DD", "time": "HH:MM", "duration": number, "description": "contexte et détails", "contact": "nom de la personne si mentionnée" }
  UTILISE CECI quand l'utilisateur dit: "ajoute à l'agenda", "mets dans le calendrier", "planifie un rdv", "je veux voir X", "prévois une rencontre avec Y"
  Si pas d'heure précise → mets time: null et propose des créneaux
  Si pas de date → utilise la date du jour ou le prochain jour ouvré
  Exemples: "ajoute à l'agenda de parler avec David", "rdv coiffeur semaine prochaine", "je veux voir mon mentor"

add_lead - Ajouter un prospect Higrow
  params: { "name": "texte", "specialty": "texte", "email": "optionnel" }

list_leads - Voir les prospects
  params: {}

add_job - Enregistrer une offre d'emploi
  params: { "url": "lien", "title": "poste" }

schedule_interview - Planifier un entretien/interview d'embauche
  params: { "contact": "nom de la personne", "company": "entreprise ou contexte", "date": "YYYY-MM-DD", "time": "HH:MM", "notes": "détails optionnels (recruteur, poste, etc.)" }
  UTILISE CECI quand l'utilisateur mentionne un entretien, interview, rendez-vous lié au recrutement/carrière/emploi.
  Exemples: "j'ai un entretien vendredi à 11h avec X", "rdv recruteur mardi 14h", "interview chez Google jeudi"

list_jobs - Voir les offres
  params: {}

show_signals - Voir les signaux trading
  params: {}

show_review - Bilan de la journée
  params: {}

show_brief - Envoyer le briefing complet du jour
  params: {}

show_today - Voir le planning simplifié
  params: {}

show_dashboard - Envoyer le lien du dashboard web
  params: {}

log_study - Session d'apprentissage
  params: { "topic": "english|ae_skills|ai|trading|product", "duration": number, "notes": "texte" }

show_insights - Analyse IA de la semaine (productivité, patterns, conseils)
  params: {}

show_goals - Voir tous les objectifs actifs
  params: {}

update_goal - Mettre à jour la progression d'un objectif
  params: { "domain": "career|finance|health|higrow|trading|learning|personal", "metric_value": number }

add_note - Sauvegarder une info, un contexte, une remarque, un lien entre personnes/sujets
  params: { "content": "texte complet de la note", "category": "career|meeting|contact|project|idea|other", "related_to": "nom de personne ou sujet si pertinent" }
  UTILISE CECI quand l'utilisateur:
  - Partage une info sur quelqu'un ("Gérald est spécialiste recrutement")
  - Donne du contexte sur un rdv/meeting ("le meeting avec X c'est pour Y")
  - Partage un insight, une idée ou une observation
  - Fait un lien entre deux sujets ("le projet Z c'est lié à W")

manage_trading_pairs - Ajouter ou supprimer une paire de trading
  params: { "action": "add|remove|list", "pair": "XRPUSDT" }
  Exemples: "ajoute XRP au trading", "retire DOGE", "quelles pairs?", "ajoute AVAX à l'analyse"

chat - Conversation, question, conseil, ou quand aucune action n'est claire
  params: {}
  reply: ta réponse directe en utilisant le contexte ci-dessous

CONTEXTE:
{context}

RÈGLES:
- JSON valide uniquement, rien d'autre
- "reply" toujours en français, court et naturel (max 200 chars sauf pour "chat" et "add_note")
- Déduis la catégorie des dépenses: uber/bus/essence=transport, café/resto/mcdo=restaurant, zara/amazon=shopping, pharma=health, cinema=entertainment
- Déduis la priorité: rdv médecin=2, courses=4, deadline travail=1
- Dates relatives: "demain"=+1 jour, "lundi prochain"=prochain lundi
- Pour "chat", tu peux faire des réponses plus longues et donner des conseils basés sur le contexte
- Si l'utilisateur parle de ses données (tâches, budget, poids), consulte le contexte et réponds via "chat"
- Quand quelqu'un dit juste un mot comme "merci", "ok", "cool" → utilise "chat" avec une réponse naturelle
- IMPORTANT: Quand l'utilisateur partage une information (sur une personne, un meeting, un projet) sans demander d'action → utilise "add_note" pour sauvegarder cette info
- NE JAMAIS répondre "je ne comprends pas" — si tu ne sais pas quoi faire, utilise "chat" et réponds intelligemment ou "add_note" si c'est une info à retenir`;

async function getAIContext(): Promise<string> {
  const supabase = getSupabaseClient();
  const now = getIsraelNow();
  const today = todayStr();
  const monthStart = `${today.substring(0, 7)}-01`;
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

  const [tasksRes, budgetRes, healthRes, leadsRes, goalsRes] = await Promise.all([
    supabase.from("tasks").select("id, title, status, priority, due_date, due_time")
      .in("status", ["pending", "in_progress"]).order("priority").limit(15),
    supabase.from("finance_logs").select("transaction_type, amount, category")
      .gte("transaction_date", monthStart),
    supabase.from("health_logs").select("log_type, value, workout_type, duration_minutes, log_date")
      .order("log_date", { ascending: false }).limit(5),
    supabase.from("leads").select("name, specialty, status").limit(10),
    supabase.from("goals").select("domain, title, metric_current, metric_target, metric_unit, metric_start, direction, deadline")
      .eq("status", "active"),
  ]);

  let ctx = `Date: ${today} (${dayNames[now.getDay()]})\n`;
  ctx += `Heure: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}\n`;

  if (tasksRes.data && tasksRes.data.length > 0) {
    ctx += `\nTâches (${tasksRes.data.length}):\n`;
    tasksRes.data.forEach(t => {
      ctx += `- [${t.id}] ${t.title} (P${t.priority}${t.due_date ? ', ' + t.due_date : ''}${t.due_time ? ' ' + t.due_time : ''})\n`;
    });
  } else {
    ctx += `\nAucune tâche en cours\n`;
  }

  if (budgetRes.data && budgetRes.data.length > 0) {
    const expenses = budgetRes.data.filter((f: any) => f.transaction_type === "expense").reduce((s: number, e: any) => s + e.amount, 0);
    const income = budgetRes.data.filter((f: any) => f.transaction_type === "income").reduce((s: number, e: any) => s + e.amount, 0);
    ctx += `\nBudget mois: ${income.toFixed(0)}₪ revenus, ${expenses.toFixed(0)}₪ dépenses, balance ${(income - expenses).toFixed(0)}₪\n`;
  }

  if (healthRes.data && healthRes.data.length > 0) {
    const lastWeight = healthRes.data.find((h: any) => h.log_type === "weight");
    if (lastWeight) ctx += `Poids: ${lastWeight.value}kg\n`;
    const workouts = healthRes.data.filter((h: any) => h.log_type === "workout");
    if (workouts.length > 0) {
      ctx += `Workouts récents: ${workouts.map((w: any) => `${w.workout_type} ${w.duration_minutes}min`).join(", ")}\n`;
    }
  }

  if (leadsRes.data && leadsRes.data.length > 0) {
    ctx += `Leads (${leadsRes.data.length}): ${leadsRes.data.map((l: any) => `${l.name} (${l.status})`).join(", ")}\n`;
  }

  if (goalsRes.data && goalsRes.data.length > 0) {
    ctx += `\nObjectifs (${goalsRes.data.length}):\n`;
    goalsRes.data.forEach((g: any) => {
      const current = Number(g.metric_current) || 0;
      const target = Number(g.metric_target) || 1;
      const start = Number(g.metric_start) || 0;
      const isDecrease = g.direction === 'decrease';
      let progress: number;
      if (isDecrease && start > target) {
        progress = Math.max(0, Math.min(100, Math.round(((start - current) / (start - target)) * 100)));
      } else {
        progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
      }
      ctx += `- ${g.domain}: ${g.title} (${current}/${target}${g.metric_unit} = ${progress}%)`;
      if (g.deadline) ctx += ` [${g.deadline}]`;
      ctx += `\n`;
    });
  }

  return ctx;
}

async function callAI(userMessage: string, context: string): Promise<any> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!openaiKey && !anthropicKey) return null;

  const systemPrompt = AI_SYSTEM_PROMPT.replace("{context}", context);

  try {
    let text = "";

    if (openaiKey) {
      // --- OpenAI (GPT-4o-mini) ---
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 1024,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        console.error("OpenAI API error:", response.status, await response.text());
        return null;
      }

      const data = await response.json();
      text = data.choices?.[0]?.message?.content || "";
    } else if (anthropicKey) {
      // --- Anthropic (Claude Haiku) fallback ---
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1024,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        console.error("Anthropic API error:", response.status, await response.text());
        return null;
      }

      const data = await response.json();
      text = data.content?.[0]?.text || "";
    }

    // Extract JSON (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (e) {
    console.error("AI call failed:", e);
    return null;
  }
}

// --- AI-Powered Natural Language Processing ---

async function handleNaturalLanguage(chatId: number, text: string): Promise<void> {
  try {
    // Get DB context for the AI
    const context = await getAIContext();

    // Call AI (OpenAI or Anthropic)
    const result = await callAI(text, context);

    if (!result) {
      // No API key or API error — fallback to regex-based NL
      await handleNaturalLanguageFallback(chatId, text);
      return;
    }

    const { intent, params, reply } = result;
    console.log(`[AI] intent=${intent} params=${JSON.stringify(params)}`);

    switch (intent) {
      case "add_task": {
        const supabase = getSupabaseClient();
        const taskData: any = {
          title: (params.title || text).substring(0, 100),
          status: "pending",
          priority: params.priority || 3,
          created_at: new Date().toISOString(),
        };
        if (params.due_date) taskData.due_date = params.due_date;
        if (params.due_time) {
          taskData.due_time = params.due_time;
          taskData.duration_minutes = params.duration || 30;
        }
        const { error } = await supabase.from("tasks").insert(taskData);
        if (error) throw error;

        // Sync to Google Calendar if task has a time
        let calSync = "";
        if (params.due_time && params.due_date) {
          try {
            const gcal = getGoogleCalendar();
            if (gcal.isConfigured()) {
              const eventId = await gcal.createTaskEvent(
                `[OREN] ${params.title || text}`,
                params.due_date, params.due_time,
                params.duration || 30,
                `Priorité: ${params.priority || 3}/5`,
                params.priority <= 2 ? "6" : "9"
              );
              if (eventId) calSync = " · 📅 synced";
            }
          } catch (ce) { console.error("GCal add_task:", ce); }
        }

        await sendTelegramMessage(chatId, (reply || `✅ Tâche ajoutée: ${params.title}`) + calSync);
        break;
      }

      case "complete_task": {
        const supabase = getSupabaseClient();
        const search = params.search || text;
        const { data } = await supabase.from("tasks")
          .select("id, title")
          .in("status", ["pending", "in_progress"])
          .ilike("title", `%${search}%`)
          .limit(1);
        if (data && data.length > 0) {
          await supabase.from("tasks").update({ status: "completed" }).eq("id", data[0].id);
          await sendTelegramMessage(chatId, reply || `✅ Terminée: ${data[0].title}`);
        } else {
          await sendTelegramMessage(chatId, `Aucune tâche trouvée pour "${search}"`);
        }
        break;
      }

      case "list_tasks":
        await handleTaskList(chatId);
        break;

      case "add_expense": {
        const supabase = getSupabaseClient();
        const pm = params.payment_method || "card";
        const pmLabel = pm === "cash" ? "💵" : pm === "transfer" ? "🔄" : "💳";
        const { error } = await supabase.from("finance_logs").insert({
          transaction_type: "expense",
          amount: params.amount,
          category: params.category || "autre",
          description: params.description || "",
          payment_method: pm,
          transaction_date: todayStr(),
        });
        if (error) throw error;

        // Check category budget after adding expense
        let budgetWarning = "";
        try {
          const monthStart = `${getIsraelNow().getFullYear()}-${String(getIsraelNow().getMonth() + 1).padStart(2, "0")}-01`;
          const cat = params.category || "autre";
          const { data: budgetData } = await supabase.from("category_budgets")
            .select("monthly_limit, alert_threshold_pct")
            .eq("category", cat).eq("is_active", true).limit(1);
          if (budgetData?.[0]) {
            const { data: catSpending } = await supabase.from("finance_logs")
              .select("amount").eq("category", cat)
              .in("transaction_type", ["expense"])
              .gte("transaction_date", monthStart);
            const totalCat = (catSpending || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
            const pct = Math.round((totalCat / budgetData[0].monthly_limit) * 100);
            if (pct >= 100) {
              budgetWarning = `\n💥 ${cat}: ₪${totalCat.toFixed(0)}/₪${budgetData[0].monthly_limit.toFixed(0)} (${pct}%) DÉPASSÉ !`;
            } else if (pct >= budgetData[0].alert_threshold_pct) {
              budgetWarning = `\n⚠️ ${cat}: ₪${totalCat.toFixed(0)}/₪${budgetData[0].monthly_limit.toFixed(0)} (${pct}%)`;
            }
          }
        } catch (_) {}

        await sendTelegramMessage(chatId, reply || `✅ Dépense: ${params.amount}₪ ${pmLabel} (${params.category})${budgetWarning}`);
        break;
      }

      case "add_income": {
        const supabase = getSupabaseClient();
        const { error } = await supabase.from("finance_logs").insert({
          transaction_type: "income",
          amount: params.amount,
          category: params.category || "other",
          description: params.description || "",
          transaction_date: todayStr(),
        });
        if (error) throw error;
        await sendTelegramMessage(chatId, reply || `✅ Revenu: ${params.amount}₪`);
        break;
      }

      case "show_budget":
        await handleBudget(chatId);
        break;

      case "log_weight": {
        const supabase = getSupabaseClient();
        const { error } = await supabase.from("health_logs").insert({
          log_type: "weight",
          value: params.value,
          unit: "kg",
          log_date: todayStr(),
        });
        if (error) throw error;
        await sendTelegramMessage(chatId, reply || `✅ Poids: ${params.value}kg`);
        break;
      }

      case "log_workout": {
        const supabase = getSupabaseClient();
        const { error } = await supabase.from("health_logs").insert({
          log_type: "workout",
          workout_type: params.type || "push",
          duration_minutes: params.duration || 60,
          log_date: todayStr(),
        });
        if (error) throw error;
        await sendTelegramMessage(chatId, reply || `✅ Workout: ${params.type} ${params.duration}min`);
        break;
      }

      case "health_status":
        await handleHealth(chatId, ["status"]);
        break;

      case "schedule_mission":
        if (params.time) {
          await handleMission(chatId, [params.title || "Mission", params.time, String(params.duration || 30)]);
        } else {
          await sendTelegramMessage(chatId, reply || "Précise l'heure pour la mission (ex: 14:00)");
        }
        break;

      case "add_to_calendar": {
        const supabase = getSupabaseClient();
        const title = params.title || text.substring(0, 100);
        const date = params.date || todayStr();
        const dur = params.duration || 30;
        const description = params.description || "";
        const contact = params.contact || "";

        // Create task in DB
        const taskData: any = {
          title: title.substring(0, 100),
          status: "pending",
          priority: 2,
          due_date: date,
          created_at: new Date().toISOString(),
        };
        if (params.time) {
          taskData.due_time = params.time;
          taskData.duration_minutes = dur;
        }
        const { error: taskErr } = await supabase.from("tasks").insert(taskData);
        if (taskErr) console.error("add_to_calendar task error:", taskErr);

        // If contact mentioned, save as note
        if (contact) {
          try {
            await supabase.from("tasks").insert({
              title: `NOTE: ${contact} — ${description}`.substring(0, 100),
              status: "completed",
              priority: 5,
              created_at: new Date().toISOString(),
            });
          } catch (_) {}
        }

        // Sync to Google Calendar
        let calSync = "";
        try {
          const gcal = getGoogleCalendar();
          if (gcal.isConfigured()) {
            if (params.time) {
              // Has specific time → create event directly
              const eventId = await gcal.createTaskEvent(
                `[OREN] ${title}`, date, params.time, dur,
                `${description}${contact ? `\nContact: ${contact}` : ""}`,
                "6" // Tangerine
              );
              if (eventId) calSync = "\n📅 Ajouté au Google Calendar";
            } else {
              // No time → create event at suggested slots, ask user
              // For now create a morning reminder
              const eventId = await gcal.createTaskEvent(
                `[OREN] ⏰ ${title}`, date, "09:00", dur,
                `À PLANIFIER — pas d'heure définie\n${description}${contact ? `\nContact: ${contact}` : ""}`,
                "6"
              );
              if (eventId) calSync = "\n📅 Ajouté au calendrier (09:00 par défaut)";
            }
          }
        } catch (ce) { console.error("GCal add_to_calendar:", ce); }

        // Build response
        let msg = reply || `✅ Ajouté à l'agenda: ${title}`;
        msg += calSync;
        if (contact) msg += `\n👤 Contact: ${contact}`;
        if (!params.time) {
          // Suggest time slots with SHORT callback_data (Telegram 64 byte limit!)
          // Use first 15 chars of title to stay under limit
          const shortTitle = title.substring(0, 15).replace(/[^a-zA-Z0-9]/g, "");
          const slots = ["10:00", "14:00", "17:00"];
          msg += "\n\nQuand veux-tu planifier ?";
          const buttons = slots.map(s => ({
            text: s,
            callback_data: `calrs_${date}_${s}_${dur}_${shortTitle}`,
          }));
          const keyboard = { inline_keyboard: [buttons] };
          try {
            const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
            const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId, text: msg,
                reply_markup: keyboard,
              }),
            });
            if (!tgRes.ok) {
              // Fallback without buttons if Telegram rejects
              console.error("TG buttons error:", await tgRes.text());
              await sendTelegramMessage(chatId, msg + "\nRéponds avec l'heure souhaitée (ex: 14:00)");
            }
          } catch (tgErr) {
            console.error("TG send error:", tgErr);
            await sendTelegramMessage(chatId, msg);
          }
        } else {
          await sendTelegramMessage(chatId, msg);
        }
        break;
      }

      case "add_lead": {
        const supabase = getSupabaseClient();
        const { error } = await supabase.from("leads").insert({
          name: params.name,
          specialty: params.specialty || "",
          email: params.email || null,
          status: "new",
        });
        if (error) throw error;
        await sendTelegramMessage(chatId, reply || `✅ Lead: ${params.name}`);
        break;
      }

      case "list_leads":
        await handleLead(chatId, ["list"]);
        break;

      case "add_job":
        if (params.url) {
          await handleJobAdd(chatId, [params.url, params.title || ""]);
        } else {
          await sendTelegramMessage(chatId, reply || "Fournis l'URL de l'offre");
        }
        break;

      case "list_jobs":
        await handleJobs(chatId);
        break;

      case "schedule_interview": {
        const supabase = getSupabaseClient();
        const contact = params.contact || "Recruteur";
        const company = params.company || "";
        const interviewDate = params.date || "";
        const interviewTime = params.time || "";
        const notes = params.notes || "";

        // 1. Create task for the interview
        const taskTitle = `🎯 Entretien: ${contact}${company ? " @ " + company : ""}${notes ? " - " + notes : ""}`;
        const taskData: any = {
          title: taskTitle.substring(0, 200),
          status: "pending",
          priority: 1,
          created_at: new Date().toISOString(),
        };
        if (interviewDate) taskData.due_date = interviewDate;
        if (interviewTime) taskData.due_time = interviewTime;
        const { error: taskErr } = await supabase.from("tasks").insert(taskData);
        if (taskErr) console.error("task insert error:", taskErr);

        // 2. Add/update job_listings entry with interview status
        const jobTitle = company
          ? `Entretien ${company}${notes ? " - " + notes : ""}`.substring(0, 150)
          : `Entretien ${contact}${notes ? " - " + notes : ""}`.substring(0, 150);
        const { error: jobErr } = await supabase.from("job_listings").insert({
          title: jobTitle,
          company: company || contact,
          job_url: "manual-entry",
          source: "other",
          status: "interviewed",
          date_posted: new Date().toISOString(),
          applied_date: todayStr(),
        });
        if (jobErr) console.error("job_listings insert error:", jobErr);

        const safeContact = (contact || "").replace(/[*_`\[\]]/g, "");
        const safeCompany = (company || "").replace(/[*_`\[\]]/g, "");
        let confirmMsg = "Entretien planifie\n";
        confirmMsg += safeContact + (safeCompany ? " @ " + safeCompany : "") + "\n";
        if (interviewDate) confirmMsg += interviewDate + (interviewTime ? " a " + interviewTime : "") + "\n";
        if (notes) confirmMsg += notes + "\n";
        confirmMsg += "\nAjoute au pipeline carriere";
        if (jobErr) confirmMsg += "\nErreur pipeline: " + String(jobErr.message).substring(0, 60);
        await sendTelegramMessage(chatId, confirmMsg);
        break;
      }

      case "show_signals":
        await handleTradingMain(chatId);
        break;

      case "show_review":
        await handleReview(chatId);
        break;

      case "show_insights":
        await handleInsights(chatId);
        break;

      case "show_brief": {
        const sbUrl = Deno.env.get("SUPABASE_URL") || "";
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        try {
          await fetch(`${sbUrl}/functions/v1/morning-briefing`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sbKey}` },
            body: JSON.stringify({}),
          });
        } catch (e) {
          console.error("Brief trigger error:", e);
        }
        await sendTelegramMessage(chatId, reply || "📋 Briefing en cours d'envoi...");
        break;
      }

      case "show_today":
        await handleToday(chatId);
        break;

      case "log_study": {
        const supabase = getSupabaseClient();
        const { error } = await supabase.from("learning_logs").insert({
          topic: params.topic || "ai",
          duration_minutes: params.duration || 30,
          notes: params.notes || "",
          session_date: todayStr(),
        });
        if (error) throw error;
        await sendTelegramMessage(chatId, reply || `✅ Session: ${params.topic} ${params.duration}min`);
        break;
      }

      case "show_goals":
        await handleGoals(chatId);
        break;

      case "update_goal": {
        if (params.domain && params.metric_value !== undefined) {
          const supabase = getSupabaseClient();
          const { data, error } = await supabase.from("goals")
            .update({ metric_current: params.metric_value })
            .eq("domain", params.domain)
            .eq("status", "active")
            .select("title, metric_current, metric_target, metric_unit, metric_start, direction");

          if (data && data.length > 0) {
            const g = data[0];
            const current = Number(g.metric_current) || 0;
            const target = Number(g.metric_target) || 1;
            const start = Number(g.metric_start) || 0;
            const isDecrease = g.direction === 'decrease';
            let progress: number;
            if (isDecrease && start > target) {
              progress = Math.max(0, Math.min(100, Math.round(((start - current) / (start - target)) * 100)));
            } else {
              progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
            }
            await sendTelegramMessage(chatId, reply || `✅ Objectif *${g.title}* mis à jour: ${current}/${target}${g.metric_unit} (${progress}%)`);
          } else {
            await sendTelegramMessage(chatId, `Objectif ${params.domain} non trouvé.`);
          }
        }
        break;
      }

      case "add_note": {
        const supabase = getSupabaseClient();
        const noteContent = params.content || text;
        const relatedTo = params.related_to || "";
        const noteTitle = relatedTo
          ? `📝 [${relatedTo}] ${noteContent}`.substring(0, 200)
          : `📝 ${noteContent}`.substring(0, 200);
        await supabase.from("tasks").insert({
          title: noteTitle,
          status: "completed",
          priority: 5,
          created_at: new Date().toISOString(),
        });
        await sendTelegramMessage(chatId, reply || `📝 Noté: ${noteContent.substring(0, 100)}`);
        break;
      }

      case "show_dashboard": {
        const sbUrl = Deno.env.get("SUPABASE_URL") || "";
        const dashUrl = `${sbUrl}/functions/v1/dashboard`;
        await sendTelegramMessage(chatId, `📊 *Dashboard OREN*\n\n${dashUrl}`, "Markdown");
        break;
      }

      case "manage_trading_pairs": {
        const pairAction = params?.action || "list";
        const pairRaw = params?.pair || "";
        if (pairAction === "add" && pairRaw) {
          await handleTradingAddPair(chatId, pairRaw);
        } else if (pairAction === "remove" && pairRaw) {
          const fullPair = normalizePairName(pairRaw);
          await handleTradingRemovePair(chatId, fullPair);
        } else {
          await handleTradingPairs(chatId);
        }
        break;
      }

      case "chat":
        await sendTelegramMessage(chatId, reply || "...");
        break;

      default:
        // Si l'AI a retourné une réponse, l'utiliser même si l'intent est inconnu
        if (reply) {
          await sendTelegramMessage(chatId, reply);
        } else {
          await sendTelegramMessage(chatId, "👍");
        }
    }
  } catch (e) {
    console.error("NL AI error:", e);
    await handleNaturalLanguageFallback(chatId, text);
  }
}

// --- Fallback: Regex-based NL (used when no OPENAI_API_KEY / ANTHROPIC_API_KEY) ---

async function handleNaturalLanguageFallback(chatId: number, text: string): Promise<void> {
  const lowerText = text.toLowerCase();

  const expenseMatch = lowerText.match(/(dépensé|payé|acheté|coûté|coûte)\s+(\d+(?:,\d+)?)/);
  if (expenseMatch) {
    const amount = parseFloat(expenseMatch[2].replace(",", "."));
    await handleExpense(chatId, [amount.toString(), "other"]);
    return;
  }

  if (lowerText.includes("ajoute") && (lowerText.includes("tâche") || lowerText.includes("task"))) {
    const taskText = text.replace(/ajoute\s+(tâche|task)\s+/i, "");
    await handleTaskAdd(chatId, [taskText]);
    return;
  }

  const workoutMatch = lowerText.match(/(push|pull|legs|cardio|mobility)\s+(\d+)?/);
  if (workoutMatch) {
    const type = workoutMatch[1];
    const duration = workoutMatch[2] || "60";
    await handleHealth(chatId, ["workout", type, duration]);
    return;
  }

  const weightMatch = lowerText.match(/poids\s+(\d+(?:,\d+)?)/);
  if (weightMatch) {
    const weight = weightMatch[1].replace(",", ".");
    await handleHealth(chatId, ["weight", weight]);
    return;
  }

  if (lowerText.includes("combien") || lowerText.includes("quel")) {
    if (lowerText.includes("budget") || lowerText.includes("dépense")) {
      await handleBudget(chatId);
      return;
    }
  }

  await handleUnknown(chatId, text);
}

// --- Voice Message Handler (Whisper API) ---

async function downloadTelegramFile(fileId: string): Promise<ArrayBuffer | null> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return null;

  try {
    // Step 1: Get file path from Telegram
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok || !fileInfo.result?.file_path) return null;

    // Step 2: Download the file
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;

    return await fileRes.arrayBuffer();
  } catch (e) {
    console.error("Download file error:", e);
    return null;
  }
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return null;

  const audioBuffer = await downloadTelegramFile(fileId);
  if (!audioBuffer) return null;

  try {
    // Send to Whisper API
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model", "whisper-1");
    formData.append("language", "fr");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body: formData,
    });

    if (!response.ok) {
      console.error("Whisper error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    return data.text || null;
  } catch (e) {
    console.error("Whisper transcription failed:", e);
    return null;
  }
}

async function handleVoiceMessage(chatId: number, fileId: string, duration: number): Promise<void> {
  // Acknowledge receipt
  await sendTelegramMessage(chatId, "🎙 Transcription en cours...");

  const transcription = await transcribeVoice(fileId);
  if (!transcription) {
    await sendTelegramMessage(chatId, "Impossible de transcrire le message vocal.");
    return;
  }

  // Show what was understood
  await sendTelegramMessage(chatId, `🎙 _"${transcription}"_`, "Markdown");

  // Process the transcribed text through NL pipeline
  await handleNaturalLanguage(chatId, transcription);
}

// --- Photo/Receipt Analysis (GPT-4o Vision) ---

async function analyzePhoto(chatId: number, fileId: string, caption?: string): Promise<void> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    await sendTelegramMessage(chatId, "Analyse photo non disponible (clé API manquante)");
    return;
  }

  await sendTelegramMessage(chatId, "📸 Analyse en cours...");

  const imageBuffer = await downloadTelegramFile(fileId);
  if (!imageBuffer) {
    await sendTelegramMessage(chatId, "Impossible de télécharger l'image.");
    return;
  }

  // Convert to base64
  const base64 = btoa(String.fromCharCode(...new Uint8Array(imageBuffer)));
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  // Get DB context
  const context = await getAIContext();

  const visionPrompt = `Tu es OREN, assistant personnel. Analyse cette image et réponds en JSON:
{
  "type": "receipt|document|screenshot|other",
  "intent": "add_expense|add_task|add_job|chat",
  "params": { ... },
  "reply": "description courte en français"
}

Si c'est un ticket/reçu: extrais montant, catégorie (restaurant|transport|shopping|health|entertainment|utilities|other), description.
Si c'est une offre d'emploi: extrais titre, entreprise, URL si visible.
Si c'est autre chose: décris simplement ce que tu vois.
${caption ? `\nLégende de l'utilisateur: "${caption}"` : ""}

CONTEXTE: ${context}
Réponds UNIQUEMENT en JSON.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: visionPrompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Vision API error:", response.status, await response.text());
      await sendTelegramMessage(chatId, "Erreur analyse image.");
      return;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      await sendTelegramMessage(chatId, `📸 ${text.substring(0, 300)}`);
      return;
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[Vision] type=${result.type} intent=${result.intent}`);

    // Route based on detected intent
    switch (result.intent) {
      case "add_expense": {
        if (result.params?.amount) {
          const supabase = getSupabaseClient();
          const pm = result.params.payment_method || "card";
          const pmLabel = pm === "cash" ? "💵" : "💳";
          const { error } = await supabase.from("finance_logs").insert({
            transaction_type: "expense",
            amount: result.params.amount,
            category: result.params.category || "autre",
            description: result.params.description || "Depuis photo",
            payment_method: pm,
            transaction_date: todayStr(),
          });
          if (error) throw error;
          await sendTelegramMessage(chatId,
            `📸✅ Dépense extraite du reçu:\n*${result.params.amount}₪* ${pmLabel} · ${result.params.category || "autre"}${result.params.description ? '\n' + result.params.description : ''}`);
        } else {
          await sendTelegramMessage(chatId, result.reply || "Pas de montant détecté sur le reçu.");
        }
        break;
      }

      case "add_task": {
        if (result.params?.title) {
          const supabase = getSupabaseClient();
          await supabase.from("tasks").insert({
            title: result.params.title.substring(0, 100),
            status: "pending",
            priority: result.params.priority || 3,
            created_at: new Date().toISOString(),
          });
          await sendTelegramMessage(chatId, `📸✅ Tâche depuis image: *${result.params.title}*`);
        }
        break;
      }

      case "add_job": {
        if (result.params?.title) {
          const supabase = getSupabaseClient();
          await supabase.from("job_listings").insert({
            title: result.params.title,
            company: result.params.company || "",
            job_url: result.params.url || "",
            source: "photo",
            status: "new",
            date_posted: todayStr(),
          });
          await sendTelegramMessage(chatId, `📸✅ Offre depuis image: *${result.params.title}*${result.params.company ? ' @ ' + result.params.company : ''}`);
        }
        break;
      }

      default:
        await sendTelegramMessage(chatId, `📸 ${result.reply || "Image analysée."}`);
    }

  } catch (e) {
    console.error("Vision analysis error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 80)}`);
  }
}

// --- Main Router ---

serve(async (req: Request) => {
  // GET = setup webhook with callback_query support
  if (req.method !== "POST") {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot`;
    if (token) {
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"],
        }),
      });
      const result = await r.json();
      return new Response(JSON.stringify({ ok: true, webhook: result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, message: "Oren Agent System OK" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const update: TelegramUpdate = await req.json();

    // Handle callback queries (button presses)
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = cb.message.chat.id;
      await handleCallbackQuery(cb.id, cbChatId, cb.data);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (!update.message) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const chatId = update.message.chat.id;

    // --- Voice Message → Whisper transcription → NL processing ---
    if (update.message.voice) {
      console.log(`[${new Date().toISOString()}] ${chatId}: [VOICE ${update.message.voice.duration}s]`);
      await handleVoiceMessage(chatId, update.message.voice.file_id, update.message.voice.duration);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // --- Audio Message → Whisper transcription → NL processing ---
    if (update.message.audio) {
      console.log(`[${new Date().toISOString()}] ${chatId}: [AUDIO ${update.message.audio.duration}s]`);
      await handleVoiceMessage(chatId, update.message.audio.file_id, update.message.audio.duration);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // --- Photo → GPT-4o Vision analysis ---
    if (update.message.photo && update.message.photo.length > 0) {
      console.log(`[${new Date().toISOString()}] ${chatId}: [PHOTO]`);
      // Use the largest photo (last in array)
      const largestPhoto = update.message.photo[update.message.photo.length - 1];
      await analyzePhoto(chatId, largestPhoto.file_id, update.message.caption);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // --- Text messages ---
    if (!update.message.text) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const text = update.message.text;
    const { command, args } = parseCommand(text);

    console.log(`[${new Date().toISOString()}] ${chatId}: ${text}`);

    // Command Router
    if (command === "/start") {
      await handleStart(chatId);
    } else if (command === "/help") {
      await handleHelp(chatId);
    } else if (command === "/status") {
      await handleStatus(chatId);
    } else if (command === "/today") {
      await handleToday(chatId);
    } else if (command === "/brief") {
      await handleBrief(chatId, args);
    } else if (command === "/report") {
      await handleReport(chatId, args);
    } else if (command === "/task") {
      if (args[0] === "add") {
        await handleTaskAdd(chatId, args.slice(1));
      } else if (args[0] === "list") {
        await handleTaskList(chatId);
      } else if (args[0] === "done") {
        await handleTaskDone(chatId, args.slice(1));
      } else {
        await sendTelegramMessage(chatId, `Format: /task add|list|done`);
      }
    } else if (command === "/expense") {
      await handleExpense(chatId, args, "card");
    } else if (command === "/cash") {
      await handleExpense(chatId, args, "cash");
    } else if (command === "/income") {
      await handleIncome(chatId, args);
    } else if (command === "/budget") {
      await handleBudget(chatId);
    } else if (command === "/health") {
      await handleHealth(chatId, args);
    } else if (command === "/study") {
      await handleStudy(chatId, args);
    } else if (command === "/lead") {
      await handleLead(chatId, args);
    } else if (command === "/mission") {
      await handleMission(chatId, args);
    } else if (command === "/job") {
      await handleJobAdd(chatId, args);
    } else if (command === "/jobs") {
      await handleJobs(chatId);
    } else if (command === "/signals") {
      await handleTradingMain(chatId);
    } else if (command === "/dashboard") {
      const sbUrl = Deno.env.get("SUPABASE_URL") || "";
      await sendTelegramMessage(chatId, `📊 *Dashboard OREN*\n\n${sbUrl}/functions/v1/dashboard`, "Markdown");
    } else if (command === "/review") {
      await handleReview(chatId);
    } else if (command === "/insights") {
      await handleInsights(chatId);
    } else if (command === "/goals") {
      await handleGoals(chatId);
    } else if (command === "/focus") {
      await handleFocus(chatId, args);
    } else if (command === "/tuto" || command === "/tutorial" || command === "/guide") {
      const page = TUTO_PAGES["tuto_main"];
      await sendTelegramMessage(chatId, page.text, "HTML", page.buttons);
    } else if (command.startsWith("/")) {
      await sendTelegramMessage(chatId, `? commande inconnue — /help`);
    } else {
      // Natural language processing
      await handleNaturalLanguage(chatId, text);
    }
  } catch (e) {
    console.error("Error:", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
