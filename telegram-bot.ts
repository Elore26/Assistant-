// ============================================
// OREN AGENT SYSTEM - Supabase Edge Function
// Bot Telegram complet avec tous les modules
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleCalendar, GCAL_COLORS } from "../_shared/google-calendar.ts";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { rankGoals, formatGoalIntelligence } from "../_shared/goal-engine.ts";

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

// --- Task Management V2 Constants ---
const TASK_CONTEXTS = ['work', 'home', 'errands', 'health', 'learning'] as const;
const CONTEXT_EMOJI: Record<string, string> = { work: '💼', home: '🏠', errands: '🛒', health: '🏋️', learning: '📚' };
const ENERGY_LEVELS = ['high', 'medium', 'low'] as const;
const RECURRENCE_LABELS: Record<string, string> = {
  daily: 'Tous les jours', weekdays: 'Lun-Ven',
  'weekly:0': 'Chaque dimanche', 'weekly:1': 'Chaque lundi', 'weekly:2': 'Chaque mardi',
  'weekly:3': 'Chaque mercredi', 'weekly:4': 'Chaque jeudi', 'weekly:5': 'Chaque vendredi',
  'weekly:6': 'Chaque samedi', monthly: 'Chaque mois',
};
const POMODORO_WORK_MIN = 25;
const POMODORO_BREAK_MIN = 5;
const POMODORO_LONG_BREAK_MIN = 15;

// --- Utility Functions ---
function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );
}

// --- Night guard: block trading analysis between 22h-07h Israel time ---
function isNightInIsrael(): boolean {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const hour = now.getHours();
  return hour >= 22 || hour < 7;
}

// --- Notification dedup: prevent duplicate urgent messages within cooldown ---
const _notifCooldown = new Map<string, number>(); // key → timestamp
function shouldSendNotification(key: string, cooldownMinutes = 30): boolean {
  const now = Date.now();
  const last = _notifCooldown.get(key);
  if (last && now - last < cooldownMinutes * 60_000) return false;
  _notifCooldown.set(key, now);
  // Cleanup old entries (keep map small)
  if (_notifCooldown.size > 200) {
    const cutoff = now - 60 * 60_000;
    for (const [k, v] of _notifCooldown) { if (v < cutoff) _notifCooldown.delete(k); }
  }
  return true;
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
    [{ text: "☀️ Briefing", callback_data: "morning_briefing" }, { text: "📋 Tasks", callback_data: "menu_tasks" }, { text: "💰 Budget", callback_data: "menu_budget" }],
    [{ text: "💼 Carrière", callback_data: "menu_jobs" }, { text: "🚀 HiGrow", callback_data: "menu_leads" }, { text: "🏋️ Santé", callback_data: "menu_health" }],
    [{ text: "📈 Trading", callback_data: "menu_signals" }, { text: "📊 Dashboard", callback_data: "menu_dashboard" }, { text: "🎯 EOS", callback_data: "menu_eos" }],
    [{ text: "❓ Tuto", callback_data: "tuto_main" }],
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
  let dbStatus = "offline";
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("tasks").select("id").limit(1);
    if (!error) dbStatus = "online";
  } catch {
    // DB offline
  }

  const text =
    `<b>OREN SYSTEM</b>\n\n` +
    `6 agents | Cloud 24/7\n` +
    `DB: ${dbStatus}`;

  await sendTelegramMessage(chatId, text, 'HTML', MAIN_MENU);
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
    `PLANNING V2\n` +
    `/inbox — voir/trier l'inbox\n` +
    `/pomodoro — session focus 25min\n` +
    `/velocity — stats productivité\n` +
    `/repeat titre règle — tâche récurrente\n` +
    `/sprint domaine "obj" cible\n` +
    `/timeblock — planifier la journée\n` +
    `/tomorrow — plan de demain\n` +
    `/subtask id titre — sous-tâche\n` +
    `/ctx work|home|errands — filtre\n\n` +
    `AUTRES\n` +
    `/morning — briefing du jour + coach santé\n` +
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
    const { data: inserted, error } = await supabase.from("tasks").insert({
      title: title.substring(0, 100),
      status: "pending",
      priority: 3,
      created_at: new Date().toISOString(),
    }).select("id").single();

    if (error) throw error;
    const taskId = inserted.id;
    await sendTelegramMessage(chatId, `✅ Tâche ajoutée: *${escapeMarkdown(title)}*\n\n🏷 Quel contexte ?`, "Markdown", {
      inline_keyboard: [
        TASK_CONTEXTS.map(c => ({ text: `${CONTEXT_EMOJI[c]} ${c}`, callback_data: `task_setctx_${taskId}_${c}` })),
        [{ text: "⏭ Pas de contexte", callback_data: `task_setctx_${taskId}_none` }],
      ],
    });
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
      .order("priority", { ascending: true })
      .limit(50);

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
      .order("created_at", { ascending: true })
      .limit(50);

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
        .order("created_at", { ascending: false })
        .limit(50);

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

async function getRescheduleCount(supabase: any, taskId: string): Promise<number> {
  const { data } = await supabase.from("tasks").select("reschedule_count").eq("id", taskId).single();
  return data?.reschedule_count || 0;
}

function nextWeekday(fromDate: Date, targetDay: number): Date {
  const d = new Date(fromDate);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== targetDay);
  return d;
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

// ============================================
// TASK MANAGEMENT V2 — New Features
// ============================================

// --- 1. INBOX (Quick Capture) ---
async function handleInbox(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: inboxTasks } = await supabase.from("tasks")
      .select("id, title, created_at")
      .eq("is_inbox", true).in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false }).limit(10);
    const tasks = inboxTasks || [];

    if (tasks.length === 0) {
      await sendTelegramMessage(chatId, `📥 *INBOX* — Vide\n\nTout est trié ! Envoie un message rapide pour capturer une idée.`, "Markdown", {
        inline_keyboard: [[{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
      });
      return;
    }

    let text = `📥 *INBOX* — ${tasks.length} à trier\n\n`;
    const buttons: InlineKeyboardButton[][] = [];
    tasks.forEach((t: any, i: number) => {
      text += `${i + 1}. ${escapeMarkdown(t.title)}\n`;
      if (i < 5) {
        buttons.push([
          { text: `🔴 P1`, callback_data: `inbox_p_${t.id}_1` },
          { text: `🟡 P3`, callback_data: `inbox_p_${t.id}_3` },
          { text: `🟢 P5`, callback_data: `inbox_p_${t.id}_5` },
          { text: `🗑`, callback_data: `inbox_del_${t.id}` },
        ]);
      }
    });
    text += `\nAssigne une priorité pour sortir de l'inbox.`;
    buttons.push([{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]);

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("Inbox error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleInboxCapture(chatId: number, text: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { error } = await supabase.from("tasks").insert({
      title: text.substring(0, 100),
      status: "pending",
      is_inbox: true,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;

    const { count } = await supabase.from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("is_inbox", true).in("status", ["pending", "in_progress"]);

    await sendTelegramMessage(chatId, `📥 Capturé: *${escapeMarkdown(text.substring(0, 100))}*\n_${count || 1} dans l'inbox_`, "Markdown", {
      inline_keyboard: [[{ text: "📥 Voir inbox", callback_data: "menu_inbox" }, { text: "📋 Tâches", callback_data: "menu_tasks" }]],
    });
  } catch (e) {
    console.error("Inbox capture error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 2. SMART RESCHEDULING ---
async function handleSmartReschedule(chatId: number, taskId: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: task } = await supabase.from("tasks")
      .select("id, title, due_date, due_time, priority, reschedule_count, duration_minutes")
      .eq("id", taskId).single();
    if (!task) { await sendTelegramMessage(chatId, "Tâche introuvable."); return; }

    const now = getIsraelNow();
    const rCount = (task.reschedule_count || 0);

    // Find next free slot today
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nextSlotToday = fromMin(Math.ceil((nowMin + 30) / 15) * 15); // Next 15-min slot, at least 30min from now

    // Tomorrow morning slot
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tmrwStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const tmrwDay = tomorrow.getDay();
    const tmrwSched = SCHEDULE[tmrwDay];
    const tmrwSlot = tmrwSched?.work_start || "09:00";

    let msg = `🔄 *Reporter: ${escapeMarkdown(task.title)}*\n`;
    if (rCount >= 3) {
      msg += `\n⚠️ _Déjà reportée ${rCount} fois\\. Découper en sous\\-tâches ?_\n`;
    }
    msg += `\nQuand veux\\-tu la faire ?`;

    const buttons: InlineKeyboardButton[][] = [
      [
        { text: `⏰ Auj ${nextSlotToday}`, callback_data: `tsnz_custom_${taskId}_${todayStr()}_${nextSlotToday}` },
        { text: `🌅 Demain ${tmrwSlot}`, callback_data: `tsnz_custom_${taskId}_${tmrwStr}_${tmrwSlot}` },
      ],
      [
        { text: `📅 +2 jours`, callback_data: `tsnz_days_${taskId}_2` },
        { text: `📅 Lundi`, callback_data: `tsnz_nextmon_${taskId}` },
      ],
    ];

    if (rCount >= 3) {
      buttons.push([{ text: "✂️ Découper en sous-tâches", callback_data: `subtask_split_${taskId}` }]);
    }
    buttons.push([{ text: "❌ Annuler", callback_data: `tcancel_${taskId}` }]);

    await sendTelegramMessage(chatId, msg, "MarkdownV2", { inline_keyboard: buttons });
  } catch (e) {
    console.error("SmartReschedule error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 3. SUBTASKS / CHECKLISTS ---
async function handleSubtaskAdd(chatId: number, parentId: string, subtitleText: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: parent } = await supabase.from("tasks")
      .select("id, title, priority, due_date, context").eq("id", parentId).single();
    if (!parent) { await sendTelegramMessage(chatId, "Tâche parent introuvable."); return; }

    const { error } = await supabase.from("tasks").insert({
      title: subtitleText.substring(0, 100),
      parent_task_id: parentId,
      status: "pending",
      priority: parent.priority || 3,
      due_date: parent.due_date || null,
      context: parent.context || null,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;

    // Get subtask count
    const { data: subs } = await supabase.from("tasks")
      .select("id, status").eq("parent_task_id", parentId);
    const total = (subs || []).length;
    const done = (subs || []).filter((s: any) => s.status === "completed").length;

    await sendTelegramMessage(chatId,
      `✅ Sous-tâche ajoutée à *${escapeMarkdown(parent.title)}*\n→ ${escapeMarkdown(subtitleText)}\n\nProgression: \\[${done}/${total}\\]`,
      "MarkdownV2");
  } catch (e) {
    console.error("SubtaskAdd error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleSubtaskList(chatId: number, parentId: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: parent } = await supabase.from("tasks")
      .select("id, title").eq("id", parentId).single();
    if (!parent) { await sendTelegramMessage(chatId, "Tâche introuvable."); return; }

    const { data: subs } = await supabase.from("tasks")
      .select("id, title, status").eq("parent_task_id", parentId)
      .order("created_at", { ascending: true });
    const subtasks = subs || [];
    const done = subtasks.filter((s: any) => s.status === "completed").length;

    let text = `📝 *${escapeMarkdown(parent.title)}*\nProgression: [${done}/${subtasks.length}]\n\n`;
    const buttons: InlineKeyboardButton[][] = [];

    subtasks.forEach((s: any, i: number) => {
      const check = s.status === "completed" ? "✅" : "⬜";
      text += `${check} ${escapeMarkdown(s.title)}\n`;
      if (s.status !== "completed" && buttons.length < 6) {
        buttons.push([
          { text: `✅ ${s.title.substring(0, 20)}`, callback_data: `subdone_${s.id}` },
        ]);
      }
    });

    buttons.push([{ text: "➕ Ajouter sous-tâche", callback_data: `subadd_${parentId}` }]);
    buttons.push([{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]);

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("SubtaskList error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 4. RECURRING TASKS ---
async function handleRecurringAdd(chatId: number, args: string[]): Promise<void> {
  // Format: /repeat "title" rule [time] [duration]
  // rule: daily, weekdays, weekly:1 (monday), monthly
  if (args.length < 2) {
    await sendTelegramMessage(chatId,
      `Format: /repeat titre règle [heure] [durée]\n\nRègles:\n• daily — tous les jours\n• weekdays — lun-ven\n• weekly:1 — chaque lundi (0=dim)\n• monthly — chaque mois\n\nEx: /repeat "Sport push" weekly:1 17:00 60`);
    return;
  }

  const supabase = getSupabaseClient();
  try {
    // Parse title (could be in quotes)
    let title = "";
    let restArgs: string[] = [];
    const fullText = args.join(" ");
    const quoted = fullText.match(/"([^"]+)"\s+(.*)/);
    if (quoted) {
      title = quoted[1];
      restArgs = quoted[2].trim().split(/\s+/);
    } else {
      title = args[0];
      restArgs = args.slice(1);
    }

    const rule = restArgs[0] || "daily";
    const time = restArgs[1] && restArgs[1].includes(":") ? restArgs[1] : null;
    const duration = restArgs.find(a => /^\d+$/.test(a) && !a.includes(":"));

    if (!RECURRENCE_LABELS[rule]) {
      await sendTelegramMessage(chatId, `Règle invalide: ${rule}\nUtilise: daily, weekdays, weekly:0-6, monthly`);
      return;
    }

    // Create the template recurring task
    const taskData: any = {
      title: title.substring(0, 100),
      status: "pending",
      priority: 3,
      recurrence_rule: rule,
      due_date: todayStr(),
      created_at: new Date().toISOString(),
    };
    if (time) taskData.due_time = time;
    if (duration) taskData.duration_minutes = parseInt(duration, 10);

    const { data: inserted, error } = await supabase.from("tasks").insert(taskData).select("id").single();
    if (error) throw error;

    // Mark as recurrence source
    if (inserted) {
      await supabase.from("tasks").update({ recurrence_source_id: inserted.id }).eq("id", inserted.id);
    }

    const label = RECURRENCE_LABELS[rule] || rule;
    const timeStr = time ? ` à ${time}` : "";
    const durStr = duration ? ` (${duration}min)` : "";

    await sendTelegramMessage(chatId,
      `🔄 Tâche récurrente créée:\n*${escapeMarkdown(title)}*\n${label}${timeStr}${durStr}`, "Markdown");
  } catch (e) {
    console.error("RecurringAdd error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleRecurringList(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: recurring } = await supabase.from("tasks")
      .select("id, title, recurrence_rule, due_time, duration_minutes")
      .not("recurrence_rule", "is", null)
      .eq("recurrence_source_id", "id") // self-referencing = template
      .in("status", ["pending", "in_progress"])
      .limit(15);

    // Fallback: get all tasks with recurrence_rule
    const { data: allRecurring } = await supabase.from("tasks")
      .select("id, title, recurrence_rule, due_time, duration_minutes, recurrence_source_id")
      .not("recurrence_rule", "is", null)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(20);

    // Filter to just templates (source = self or no source)
    const templates = (allRecurring || []).filter((t: any) =>
      !t.recurrence_source_id || t.recurrence_source_id === t.id
    );

    if (templates.length === 0) {
      await sendTelegramMessage(chatId, `🔄 *TÂCHES RÉCURRENTES*\n\nAucune tâche récurrente.\nCrée-en une: /repeat titre règle`, "Markdown");
      return;
    }

    let text = `🔄 *TÂCHES RÉCURRENTES* (${templates.length})\n\n`;
    const buttons: InlineKeyboardButton[][] = [];

    templates.forEach((t: any, i: number) => {
      const label = RECURRENCE_LABELS[t.recurrence_rule] || t.recurrence_rule;
      const time = t.due_time ? ` ${t.due_time.substring(0, 5)}` : "";
      const dur = t.duration_minutes ? ` · ${t.duration_minutes}min` : "";
      text += `${i + 1}. ${escapeMarkdown(t.title)}\n   _${label}${time}${dur}_\n`;
      if (i < 5) {
        buttons.push([
          { text: `❌ Supprimer: ${t.title.substring(0, 18)}`, callback_data: `recurring_del_${t.id}` },
        ]);
      }
    });

    buttons.push([{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]);
    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("RecurringList error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// Spawn next occurrence of a recurring task
async function spawnNextRecurrence(supabase: any, completedTask: any): Promise<void> {
  if (!completedTask.recurrence_rule) return;
  const rule = completedTask.recurrence_rule;
  const sourceId = completedTask.recurrence_source_id || completedTask.id;

  const now = getIsraelNow();
  let nextDate: Date | null = null;

  if (rule === "daily") {
    nextDate = new Date(now);
    nextDate.setDate(nextDate.getDate() + 1);
  } else if (rule === "weekdays") {
    nextDate = new Date(now);
    do { nextDate.setDate(nextDate.getDate() + 1); } while (nextDate.getDay() === 0 || nextDate.getDay() === 6);
  } else if (rule.startsWith("weekly:")) {
    const targetDay = parseInt(rule.split(":")[1], 10);
    nextDate = new Date(now);
    do { nextDate.setDate(nextDate.getDate() + 1); } while (nextDate.getDay() !== targetDay);
  } else if (rule === "monthly") {
    nextDate = new Date(now);
    nextDate.setMonth(nextDate.getMonth() + 1);
  }

  if (!nextDate) return;

  const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;

  // Check if next occurrence already exists
  const { data: existing } = await supabase.from("tasks")
    .select("id").eq("recurrence_source_id", sourceId)
    .eq("due_date", nextDateStr).in("status", ["pending", "in_progress"]).limit(1);
  if (existing && existing.length > 0) return;

  await supabase.from("tasks").insert({
    title: completedTask.title,
    status: "pending",
    priority: completedTask.priority || 3,
    due_date: nextDateStr,
    due_time: completedTask.due_time || null,
    duration_minutes: completedTask.duration_minutes || null,
    context: completedTask.context || null,
    recurrence_rule: rule,
    recurrence_source_id: sourceId,
    created_at: new Date().toISOString(),
  });
}

// --- 5. CONTEXT / TAGS ---
async function handleTasksByContext(chatId: number, context: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: tasks } = await supabase.from("tasks")
      .select("id, title, priority, status, due_date, due_time")
      .eq("context", context)
      .in("status", ["pending", "in_progress"])
      .order("priority", { ascending: true }).limit(15);

    const emoji = CONTEXT_EMOJI[context] || "📌";
    const label = context.charAt(0).toUpperCase() + context.slice(1);

    if (!tasks || tasks.length === 0) {
      await sendTelegramMessage(chatId, `${emoji} *${label}* — Aucune tâche\n`, "Markdown", {
        inline_keyboard: [[{ text: "📋 Toutes les tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
      });
      return;
    }

    let text = `${emoji} *${label}* — ${tasks.length} tâches\n\n`;
    const buttons: InlineKeyboardButton[][] = [];
    tasks.forEach((t: any, i: number) => {
      const p = (t.priority || 3) <= 2 ? "●" : (t.priority || 3) === 3 ? "◐" : "○";
      const due = t.due_date ? ` · ${t.due_date.substring(5)}` : "";
      text += `${p} ${escapeMarkdown(t.title)}${due}\n`;
      if (i < 4) {
        buttons.push([
          { text: `✅ ${t.title.substring(0, 18)}`, callback_data: `tdone_${t.id}` },
          { text: `📅`, callback_data: `reschedule_${t.id}` },
        ]);
      }
    });

    buttons.push([{ text: "📋 Toutes", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]);
    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("TasksByContext error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 6. VELOCITY & ANALYTICS ---
async function handleVelocity(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const today = todayStr();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekAgoStr = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, "0")}-${String(weekAgo.getDate()).padStart(2, "0")}`;
    const twoWeekAgo = new Date(now.getTime() - 14 * 86400000);
    const twoWeekAgoStr = `${twoWeekAgo.getFullYear()}-${String(twoWeekAgo.getMonth() + 1).padStart(2, "0")}-${String(twoWeekAgo.getDate()).padStart(2, "0")}`;

    const [thisWeekRes, lastWeekRes, thisWeekCreated, rescheduledRes, pomodoroRes] = await Promise.all([
      supabase.from("tasks").select("id, title, updated_at, context, duration_minutes")
        .eq("status", "completed").gte("updated_at", weekAgoStr + "T00:00:00"),
      supabase.from("tasks").select("id")
        .eq("status", "completed").gte("updated_at", twoWeekAgoStr + "T00:00:00").lt("updated_at", weekAgoStr + "T00:00:00"),
      supabase.from("tasks").select("id")
        .gte("created_at", weekAgoStr + "T00:00:00"),
      supabase.from("tasks").select("id, title, reschedule_count")
        .gt("reschedule_count", 0).in("status", ["pending", "in_progress"])
        .order("reschedule_count", { ascending: false }).limit(3),
      supabase.from("pomodoro_sessions").select("id, duration_minutes")
        .eq("completed", true).gte("started_at", weekAgoStr + "T00:00:00"),
    ]);

    const thisWeek = thisWeekRes.data || [];
    const lastWeek = lastWeekRes.data || [];
    const created = thisWeekCreated.data || [];
    const rescheduled = rescheduledRes.data || [];
    const pomodoros = pomodoroRes.data || [];

    const thisWeekCount = thisWeek.length;
    const lastWeekCount = lastWeek.length;
    const delta = thisWeekCount - lastWeekCount;
    const deltaStr = delta > 0 ? `↑ +${delta}` : delta < 0 ? `↓ ${delta}` : `→ =`;
    const completionRate = created.length > 0 ? Math.round((thisWeekCount / created.length) * 100) : 0;

    // Pomodoro stats
    const totalPomodoros = pomodoros.length;
    const deepWorkMin = pomodoros.reduce((s: number, p: any) => s + (p.duration_minutes || 25), 0);

    // Per-day breakdown
    const dayNames = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const dayCounts: Record<number, number> = {};
    for (let d = 0; d < 7; d++) dayCounts[d] = 0;
    thisWeek.forEach((t: any) => {
      const d = new Date(t.updated_at).getDay();
      dayCounts[d]++;
    });
    const bestDayIdx = Object.entries(dayCounts).sort((a, b) => Number(b[1]) - Number(a[1]))[0];

    // Context breakdown
    const contextCounts: Record<string, number> = {};
    thisWeek.forEach((t: any) => {
      const ctx = t.context || "sans contexte";
      contextCounts[ctx] = (contextCounts[ctx] || 0) + 1;
    });
    const topContext = Object.entries(contextCounts).sort((a, b) => b[1] - a[1])[0];

    let text = `📊 *VÉLOCITÉ* — 7 derniers jours\n\n`;
    text += `✅ Complétées: *${thisWeekCount}* ${deltaStr} vs sem. dernière\n`;
    text += `📝 Créées: ${created.length} · Ratio: ${completionRate}%\n`;
    if (totalPomodoros > 0) {
      text += `🍅 Pomodoros: ${totalPomodoros} (${Math.round(deepWorkMin / 60)}h deep work)\n`;
    }
    text += `\n`;

    // Day chart
    text += `*Par jour:*\n`;
    dayNames.forEach((name, i) => {
      const count = dayCounts[i] || 0;
      const bar = "█".repeat(Math.min(count, 10)) + (count > 0 ? ` ${count}` : "");
      text += `${name}: ${bar || "—"}\n`;
    });

    if (bestDayIdx) {
      text += `\n💪 Meilleur jour: *${dayNames[Number(bestDayIdx[0])]}* (${bestDayIdx[1]})\n`;
    }
    if (topContext) {
      text += `🏷 Top contexte: ${CONTEXT_EMOJI[topContext[0]] || "📌"} ${topContext[0]} (${topContext[1]})\n`;
    }

    // Most rescheduled
    if (rescheduled.length > 0) {
      text += `\n⚠️ *Plus reportées:*\n`;
      rescheduled.forEach((t: any) => {
        text += `  ↻ x${t.reschedule_count} ${t.title}\n`;
      });
    }

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🎯 Sprint", callback_data: "menu_sprint" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("Velocity error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 7. POMODORO ---
async function handlePomodoro(chatId: number, args: string[]): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    // Check for active pomodoro
    const { data: active } = await supabase.from("pomodoro_sessions")
      .select("id, task_id, started_at, duration_minutes")
      .is("ended_at", null).eq("completed", false)
      .order("started_at", { ascending: false }).limit(1);

    if (active && active.length > 0) {
      const session = active[0];
      const startTime = new Date(session.started_at);
      const elapsed = Math.floor((Date.now() - startTime.getTime()) / 60000);
      const remaining = (session.duration_minutes || POMODORO_WORK_MIN) - elapsed;

      if (remaining > 0) {
        let taskName = "Tâche en cours";
        if (session.task_id) {
          const { data: t } = await supabase.from("tasks").select("title").eq("id", session.task_id).single();
          if (t) taskName = t.title;
        }

        await sendTelegramMessage(chatId,
          `🍅 *Pomodoro en cours*\n\n${escapeMarkdown(taskName)}\n⏱ ${remaining} min restantes\n\nConcentre-toi !`,
          "Markdown", {
            inline_keyboard: [
              [{ text: "✅ Terminé !", callback_data: `pomo_done_${session.id}` }],
              [{ text: "❌ Abandonner", callback_data: `pomo_cancel_${session.id}` }],
            ],
          });
        return;
      } else {
        // Timer expired — mark as completed
        await supabase.from("pomodoro_sessions").update({
          ended_at: new Date().toISOString(), completed: true,
        }).eq("id", session.id);
        if (session.task_id) {
          await supabase.from("tasks").update({
            pomodoro_count: supabase.rpc ? undefined : undefined, // handled below
          }).eq("id", session.task_id);
          // Increment pomodoro count
          const { data: taskData } = await supabase.from("tasks").select("pomodoro_count").eq("id", session.task_id).single();
          if (taskData) {
            await supabase.from("tasks").update({ pomodoro_count: (taskData.pomodoro_count || 0) + 1 }).eq("id", session.task_id);
          }
        }
      }
    }

    // Start new pomodoro
    if (args.length === 0) {
      // Show task picker
      const { data: tasks } = await supabase.from("tasks")
        .select("id, title, priority, pomodoro_count")
        .in("status", ["pending", "in_progress"])
        .order("priority", { ascending: true }).limit(6);

      let text = `🍅 *POMODORO* — ${POMODORO_WORK_MIN} min focus\n\nChoisis une tâche:\n`;
      const buttons: InlineKeyboardButton[][] = [];
      (tasks || []).forEach((t: any) => {
        const pomCount = t.pomodoro_count || 0;
        const pomStr = pomCount > 0 ? ` 🍅x${pomCount}` : "";
        buttons.push([{ text: `${t.title.substring(0, 28)}${pomStr}`, callback_data: `pomo_start_${t.id}` }]);
      });
      buttons.push([{ text: "🍅 Sans tâche", callback_data: "pomo_start_free" }]);
      buttons.push([{ text: "🔙 Menu", callback_data: "menu_main" }]);

      await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
      return;
    }

    // Start with specific task search
    const search = args.join(" ");
    const { data: matchedTasks } = await supabase.from("tasks")
      .select("id, title").in("status", ["pending", "in_progress"])
      .ilike("title", `%${search}%`).limit(1);

    const taskId = matchedTasks?.[0]?.id || null;
    const taskTitle = matchedTasks?.[0]?.title || search;

    await startPomodoro(chatId, supabase, taskId, taskTitle);
  } catch (e) {
    console.error("Pomodoro error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function startPomodoro(chatId: number, supabase: any, taskId: string | null, taskTitle: string): Promise<void> {
  const { data: session, error } = await supabase.from("pomodoro_sessions").insert({
    task_id: taskId,
    started_at: new Date().toISOString(),
    duration_minutes: POMODORO_WORK_MIN,
    break_minutes: POMODORO_BREAK_MIN,
    completed: false,
  }).select("id").single();
  if (error) throw error;

  if (taskId) {
    await supabase.from("tasks").update({ status: "in_progress" }).eq("id", taskId);
  }

  await sendTelegramMessage(chatId,
    `🍅 *POMODORO — GO !*\n\n📌 ${escapeMarkdown(taskTitle)}\n⏱ ${POMODORO_WORK_MIN} minutes\n\n_Concentre-toi. Pas de distraction._`,
    "Markdown", {
      inline_keyboard: [
        [{ text: "✅ Terminé !", callback_data: `pomo_done_${session.id}` }],
        [{ text: "❌ Abandonner", callback_data: `pomo_cancel_${session.id}` }],
      ],
    });
}

// --- 8. TIME BLOCKING ---
async function handleTimeBlock(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const today = todayStr();
    const dow = now.getDay();
    const sched = SCHEDULE[dow];

    if (!sched || sched.type === 'off') {
      await sendTelegramMessage(chatId, `📅 Jour de repos — pas de time blocking.`);
      return;
    }

    // Get today's unscheduled tasks
    const { data: tasks } = await supabase.from("tasks")
      .select("id, title, priority, duration_minutes, energy_level, due_time, context")
      .eq("due_date", today).in("status", ["pending", "in_progress"])
      .order("priority", { ascending: true })
      .limit(20);

    const unscheduled = (tasks || []).filter((t: any) => !t.due_time);
    const scheduled = (tasks || []).filter((t: any) => t.due_time);

    if (unscheduled.length === 0) {
      let text = `📅 *TIME BLOCK* — Tout est planifié !\n\n`;
      scheduled.forEach((t: any) => {
        text += `${t.due_time?.substring(0, 5)} · ${escapeMarkdown(t.title)}\n`;
      });
      await sendTelegramMessage(chatId, text, "Markdown", {
        inline_keyboard: [[{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]],
      });
      return;
    }

    // Get free slots
    const fixedBlocks = getFixedBlocks(dow);
    const scheduledBlocks = scheduled.map((t: any) => ({
      start: toMin(t.due_time),
      end: toMin(t.due_time) + (t.duration_minutes || 30),
      label: t.title,
    }));
    const allBlocks = [...fixedBlocks, ...scheduledBlocks].sort((a, b) => a.start - b.start);

    // Find free slots (between 7:00 and 21:00)
    const dayStart = sched.work_start ? toMin(sched.work_start) - 60 : 420; // 1h before work or 7:00
    const dayEnd = sched.work_end ? toMin(sched.work_end) + 60 : 1260; // 1h after work or 21:00
    const freeSlots: Array<{ start: number; end: number }> = [];
    let cursor = Math.max(dayStart, now.getHours() * 60 + now.getMinutes() + 15); // at least 15min from now

    for (const block of allBlocks) {
      if (block.start > cursor && block.start - cursor >= 15) {
        freeSlots.push({ start: cursor, end: block.start });
      }
      cursor = Math.max(cursor, block.end);
    }
    if (dayEnd > cursor && dayEnd - cursor >= 15) {
      freeSlots.push({ start: cursor, end: dayEnd });
    }

    // Sort tasks: high energy first (mornings), low energy later
    const sortedTasks = [...unscheduled].sort((a: any, b: any) => {
      const eA = a.energy_level === "high" ? 0 : a.energy_level === "low" ? 2 : 1;
      const eB = b.energy_level === "high" ? 0 : b.energy_level === "low" ? 2 : 1;
      if (eA !== eB) return eA - eB;
      return (a.priority || 3) - (b.priority || 3);
    });

    // Assign tasks to slots
    let text = `📅 *TIME BLOCK PROPOSÉ*\n\n`;
    const assignments: Array<{ taskId: string; time: string; dur: number }> = [];
    let slotIdx = 0;

    for (const task of sortedTasks) {
      const dur = task.duration_minutes || 30;
      while (slotIdx < freeSlots.length) {
        const slot = freeSlots[slotIdx];
        if (slot.end - slot.start >= dur) {
          const startTime = fromMin(slot.start);
          const endTime = fromMin(slot.start + dur);
          const energy = task.energy_level === "high" ? "⚡" : task.energy_level === "low" ? "🌙" : "☀️";
          const ctx = task.context ? ` ${CONTEXT_EMOJI[task.context] || ""}` : "";
          text += `${startTime}\\-${endTime} ${energy}${ctx} ${escapeMarkdown(task.title)}\n`;
          assignments.push({ taskId: task.id, time: startTime, dur });
          slot.start += dur + 5; // 5min buffer
          break;
        }
        slotIdx++;
      }
    }

    if (assignments.length === 0) {
      text += `Pas de créneau libre suffisant aujourd'hui.`;
    } else {
      text += `\n_${assignments.length}/${unscheduled.length} tâches placées_`;
    }

    const buttons: InlineKeyboardButton[][] = [];
    if (assignments.length > 0) {
      buttons.push([{ text: "✅ Appliquer ce planning", callback_data: `timeblock_apply_${today}` }]);
    }
    buttons.push([{ text: "📋 Tâches", callback_data: "menu_tasks" }, { text: "🔙 Menu", callback_data: "menu_main" }]);

    // Store assignments temporarily in agent_signals for the apply button
    if (assignments.length > 0) {
      const signals = getSignalBus("telegram-bot");
      await signals.emit("timeblock_proposal", "Time block proposal", {
        date: today, assignments,
      }, { target: "telegram-bot", priority: 3, ttlHours: 2 });
    }

    await sendTelegramMessage(chatId, text, "MarkdownV2", { inline_keyboard: buttons });
  } catch (e) {
    console.error("TimeBlock error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 9. SPRINT GOALS ---
async function handleSprintGoals(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    // Find current week's Monday (or Sunday for Israel)
    const weekStart = new Date(now);
    const dow = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - dow); // Go to Sunday
    const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;

    const { data: sprints } = await supabase.from("sprint_goals")
      .select("*").eq("week_start", weekStartStr).eq("status", "active")
      .order("domain");

    if (!sprints || sprints.length === 0) {
      await sendTelegramMessage(chatId,
        `🎯 *SPRINT DE LA SEMAINE*\n\nAucun objectif défini.\n\nFormat: /sprint domaine "objectif" cible\nEx: /sprint career "3 candidatures" 3\nEx: /sprint health "4 workouts" 4`,
        "Markdown", {
          inline_keyboard: [
            [{ text: "➕ Créer sprint", callback_data: "sprint_create" }],
            [{ text: "🔙 Menu", callback_data: "menu_main" }],
          ],
        });
      return;
    }

    let text = `🎯 *SPRINT — Semaine du ${weekStartStr.substring(5)}*\n\n`;
    let totalProgress = 0;

    sprints.forEach((s: any) => {
      const current = s.current_value || 0;
      const target = s.target_value || 1;
      const pct = Math.min(100, Math.round((current / target) * 100));
      totalProgress += pct;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
      const emoji = CONTEXT_EMOJI[s.domain] || "📌";
      const status = pct >= 100 ? "✅" : pct >= 60 ? "🟡" : "🔴";
      text += `${emoji} *${escapeMarkdown(s.title)}*\n`;
      text += `${bar} ${current}/${target} ${s.metric_unit} ${status}\n\n`;
    });

    const avgProgress = Math.round(totalProgress / sprints.length);
    text += `\n📊 Progression globale: *${avgProgress}%*`;

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "➕ Ajouter objectif", callback_data: "sprint_create" }],
        [{ text: "📊 Vélocité", callback_data: "menu_velocity" }, { text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("SprintGoals error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

async function handleSprintCreate(chatId: number, args: string[]): Promise<void> {
  if (args.length < 3) {
    await sendTelegramMessage(chatId,
      `Format: /sprint domaine "objectif" cible [unité]\n\nDomaines: career, health, finance, learning, personal\n\nEx:\n/sprint career "3 candidatures" 3\n/sprint health "4 workouts" 4 sessions\n/sprint learning "5h anglais" 300 min`);
    return;
  }

  const supabase = getSupabaseClient();
  try {
    const domain = args[0];
    const fullText = args.slice(1).join(" ");
    const quoted = fullText.match(/"([^"]+)"\s+([\d.]+)\s*(.*)?/);

    let title = "", target = 1, unit = "count";
    if (quoted) {
      title = quoted[1];
      target = parseFloat(quoted[2]);
      unit = quoted[3]?.trim() || "count";
    } else {
      title = args.slice(1, -1).join(" ");
      target = parseFloat(args[args.length - 1]) || 1;
    }

    const now = getIsraelNow();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;

    const { error } = await supabase.from("sprint_goals").insert({
      week_start: weekStartStr,
      domain,
      title: title.substring(0, 100),
      target_value: target,
      current_value: 0,
      metric_unit: unit,
      status: "active",
    });
    if (error) throw error;

    await sendTelegramMessage(chatId,
      `🎯 Sprint créé: *${escapeMarkdown(title)}*\nObjectif: ${target} ${unit} cette semaine`,
      "Markdown");
  } catch (e) {
    console.error("SprintCreate error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// --- 10. TOMORROW PLANNING (Evening) ---
async function handleTomorrowPlan(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tmrwStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const tmrwDay = tomorrow.getDay();
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    // Get tasks for tomorrow + overdue + high priority
    const [tmrwTasksRes, overdueRes, p1p2Res] = await Promise.all([
      supabase.from("tasks").select("id, title, priority, due_time, duration_minutes, context, reschedule_count")
        .eq("due_date", tmrwStr).in("status", ["pending", "in_progress"]).order("priority"),
      supabase.from("tasks").select("id, title, priority, due_date, reschedule_count, urgency_level")
        .in("status", ["pending", "in_progress"]).lt("due_date", tmrwStr)
        .order("priority").limit(5),
      supabase.from("tasks").select("id, title, priority, due_date")
        .in("status", ["pending", "in_progress"]).in("priority", [1, 2])
        .is("due_date", null).limit(3),
    ]);

    const tmrwTasks = tmrwTasksRes.data || [];
    const overdue = overdueRes.data || [];
    const p1p2 = p1p2Res.data || [];

    // Build suggested plan
    const allSuggested = [
      ...overdue.map((t: any) => ({ ...t, source: "overdue" })),
      ...tmrwTasks.map((t: any) => ({ ...t, source: "planned" })),
      ...p1p2.filter((t: any) => !tmrwTasks.find((tt: any) => tt.id === t.id)).map((t: any) => ({ ...t, source: "priority" })),
    ].slice(0, 8);

    const sched = SCHEDULE[tmrwDay];
    const schedLabel = sched?.type === 'off' ? 'Repos' : sched?.type === 'variable' ? 'Variable' :
      `${sched?.work_start || "?"} — ${sched?.work_end || "?"}`;

    let text = `🌙 *PLAN DEMAIN* — ${dayNames[tmrwDay]} ${tmrwStr.substring(5)}\n`;
    text += `📅 ${schedLabel}\n\n`;

    if (allSuggested.length === 0) {
      text += `Aucune tâche prévue demain.\n_Envoie un message pour capturer une tâche._`;
    } else {
      allSuggested.forEach((t: any, i: number) => {
        const p = (t.priority || 3) <= 1 ? "🔴" : (t.priority || 3) === 2 ? "🟠" : (t.priority || 3) === 3 ? "🟡" : "🟢";
        const ctx = t.context ? ` ${CONTEXT_EMOJI[t.context] || ""}` : "";
        const src = t.source === "overdue" ? " ⚠️" : t.source === "priority" ? " ⭐" : "";
        const time = t.due_time ? `${t.due_time.substring(0, 5)} ` : "";
        const rInfo = (t.reschedule_count || 0) > 0 ? ` (x${t.reschedule_count})` : "";
        text += `${i + 1}. ${p} ${time}${t.title}${ctx}${src}${rInfo}\n`;
      });
    }

    const buttons: InlineKeyboardButton[][] = [];
    if (allSuggested.length > 0) {
      buttons.push([
        { text: "✅ Valider ce plan", callback_data: `plan_validate_${tmrwStr}` },
        { text: "✏️ Modifier", callback_data: "menu_tasks" },
      ]);
    }
    buttons.push([
      { text: "📅 Time Block", callback_data: "menu_timeblock" },
      { text: "🔙 Menu", callback_data: "menu_main" },
    ]);

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });

    // Store the plan
    const taskIds = allSuggested.map((t: any) => t.id);
    await supabase.from("tomorrow_plans").upsert({
      plan_date: tmrwStr,
      task_ids: taskIds,
      validated: false,
    }, { onConflict: "plan_date" });

  } catch (e) {
    console.error("TomorrowPlan error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`);
  }
}

// ============================================
// UPDATED TASKS MAIN MENU — with new sub-menus
// ============================================
async function handleTasksMainV2(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const today = todayStr();

    const [todayRes, inboxRes, allRes] = await Promise.all([
      supabase.from("tasks").select("id, title, priority, status, due_time, duration_minutes, context, parent_task_id, pomodoro_count")
        .eq("due_date", today).in("status", ["pending", "in_progress"]).is("parent_task_id", null)
        .order("due_time", { ascending: true, nullsFirst: false }),
      supabase.from("tasks").select("id", { count: "exact", head: true })
        .eq("is_inbox", true).in("status", ["pending", "in_progress"]),
      supabase.from("tasks").select("id", { count: "exact", head: true })
        .in("status", ["pending", "in_progress"]).is("parent_task_id", null),
    ]);

    const allTasks = todayRes.data || [];
    const inboxCount = inboxRes.count || 0;
    const totalCount = allRes.count || 0;

    let text = `📋 *TÂCHES — Aujourd'hui*\n`;
    if (inboxCount > 0) text += `📥 ${inboxCount} dans l'inbox\n`;
    text += `\n`;

    if (allTasks.length === 0) {
      text += `Aucune tâche pour aujourd'hui.\n`;
    } else {
      allTasks.forEach((t: any) => {
        const p = (t.priority || 3) <= 2 ? "●" : (t.priority || 3) === 3 ? "◐" : "○";
        const time = t.due_time ? `${t.due_time.substring(0, 5)} ` : "";
        const ctx = t.context ? ` ${CONTEXT_EMOJI[t.context] || ""}` : "";
        const pom = (t.pomodoro_count || 0) > 0 ? ` 🍅${t.pomodoro_count}` : "";
        text += `${p} ${time}${t.title}${ctx}${pom}\n`;
      });
    }

    // Task done buttons (max 6)
    const buttons: InlineKeyboardButton[][] = [];
    allTasks.slice(0, 6).forEach((t: any, i: number) => {
      if (i % 2 === 0) buttons.push([]);
      buttons[buttons.length - 1].push({
        text: `✅ ${(t.title || "").substring(0, 18)}`,
        callback_data: `task_done_${t.id}`,
      });
    });

    // New sub-menu buttons
    buttons.push([
      { text: "📥 Inbox", callback_data: "menu_inbox" },
      { text: "📅 Planifier", callback_data: "tasks_schedule" },
      { text: "✓ Terminées", callback_data: "tasks_completed" },
    ]);
    buttons.push([
      { text: "🍅 Pomodoro", callback_data: "menu_pomodoro" },
      { text: "📊 Vélocité", callback_data: "menu_velocity" },
    ]);
    buttons.push([
      { text: "🔄 Récurrentes", callback_data: "menu_recurring" },
      { text: "🎯 Sprint", callback_data: "menu_sprint" },
      { text: "🌙 Demain", callback_data: "menu_tomorrow" },
    ]);

    // Context filter buttons
    buttons.push([
      { text: "💼", callback_data: "ctx_work" },
      { text: "🏠", callback_data: "ctx_home" },
      { text: "🛒", callback_data: "ctx_errands" },
      { text: "🏋️", callback_data: "ctx_health" },
      { text: "📚", callback_data: "ctx_learning" },
    ]);

    buttons.push([{ text: "🔙 Menu", callback_data: "menu_main" }]);

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: buttons });
  } catch (e) {
    console.error("TasksMainV2 error:", e);
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

// --- MORNING BRIEFING (brief summary + health coach buttons) ---
async function handleMorningBriefing(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const now = getIsraelNow();
    const today = todayStr();
    const hour = now.getHours();
    const day = now.getDay();
    const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
    const ws = WORKOUT_SCHEDULE_BOT[day];
    const sched = SCHEDULE[day];

    // Fetch data in parallel
    const [tasksRes, expRes, weightRes, workoutRes, jobsRes] = await Promise.all([
      supabase.from("tasks").select("id, title, priority, due_time")
        .eq("due_date", today).in("status", ["pending", "in_progress"])
        .order("priority", { ascending: true }).limit(5),
      supabase.from("finance_logs").select("amount")
        .eq("transaction_type", "expense")
        .gte("transaction_date", `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`),
      supabase.from("health_logs").select("value, log_date")
        .eq("log_type", "weight").order("log_date", { ascending: false }).limit(1),
      supabase.from("health_logs").select("workout_type, log_date")
        .eq("log_type", "workout").order("log_date", { ascending: false }).limit(7),
      supabase.from("job_listings").select("status")
        .in("status", ["new", "applied", "interviewed"]),
    ]);

    const tasks = tasksRes.data || [];
    const monthExpenses = (expRes.data || []).reduce((s: number, e: any) => s + e.amount, 0);
    const weight = weightRes.data?.[0]?.value ?? "?";
    const workoutDays = new Set((workoutRes.data || []).map((w: any) => w.log_date)).size;
    const jobs = jobsRes.data || [];
    const newJobs = jobs.filter((j: any) => j.status === "new").length;
    const appliedJobs = jobs.filter((j: any) => j.status === "applied").length;

    // Fasting status
    const isFasting = hour >= 20 || hour < 12;
    const fastingIcon = isFasting ? "🟢 Jeûne" : "🍽 Manger OK";

    // Work schedule
    let workInfo = "Repos";
    if (sched && sched.depart) {
      workInfo = `Départ ${sched.depart} · Fin ${sched.work_end}`;
    }

    // Workout info
    const workoutName = ws.type.charAt(0).toUpperCase() + ws.type.slice(1);

    // Build brief summary
    let text = `☀️ *Bonjour Oren !*\n`;
    text += `${dayNames[day]} · ${fastingIcon}\n\n`;

    // Schedule
    text += `📅 ${workInfo}\n`;

    // Top 3 tasks
    if (tasks.length > 0) {
      text += `\n📋 *Priorités du jour:*\n`;
      tasks.slice(0, 3).forEach((t: any) => {
        const p = (t.priority || 3) <= 2 ? "●" : "○";
        const time = t.due_time ? ` · ${t.due_time.substring(0, 5)}` : "";
        text += `  ${p} ${t.title}${time}\n`;
      });
    }

    // Quick stats line
    text += `\n📊 Poids: *${weight}kg* · Sport: ${workoutDays}j/7 · Budget: ${Math.round(monthExpenses)}₪\n`;

    // Career
    if (newJobs > 0 || appliedJobs > 0) {
      text += `💼 ${newJobs} nouvelles offres · ${appliedJobs} en cours\n`;
    }

    // Health coach teaser
    text += `\n🏋️ Aujourd'hui: *${workoutName}* à ${ws.time}`;

    await sendTelegramMessage(chatId, text, "Markdown", {
      inline_keyboard: [
        [{ text: "💪 Mon Sport", callback_data: "morning_sport" }, { text: "🍽 Ma Nutrition", callback_data: "morning_nutrition" }],
        [{ text: "📋 Toutes mes tâches", callback_data: "menu_tasks" }, { text: "💼 Offres", callback_data: "menu_jobs" }],
        [{ text: "📌 Menu complet", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("MorningBriefing error:", e);
    await sendTelegramMessage(chatId, `Erreur briefing: ${String(e).substring(0, 50)}`);
  }
}

// --- MORNING SPORT COACH (detailed workout for today) ---
async function handleMorningSport(chatId: number): Promise<void> {
  const now = getIsraelNow();
  const day = now.getDay();
  const ws = WORKOUT_SCHEDULE_BOT[day];

  const WARMUP = `*Échauffement (5 min):*\n  Jumping jacks 30s · Mobilité épaules · Rotations hanches\n`;

  const EXERCISES: Record<string, string> = {
    push: `${WARMUP}\n*💪 PUSH — ${ws.time}*\n\n` +
      `1. Développé couché — 4×8-10 (90s repos)\n` +
      `2. Développé incliné haltères — 3×10-12 (90s)\n` +
      `3. Dips lestés — 3×8-10 (90s)\n` +
      `4. Élévations latérales — 4×12-15 (60s)\n` +
      `5. Développé militaire — 3×10 (90s)\n` +
      `6. Écartés poulie — 3×12-15 (60s)\n` +
      `7. Extensions triceps corde — 3×12-15 (60s)\n\n` +
      `*Retour au calme:* Étirements pecs + épaules 5 min`,
    pull: `${WARMUP}\n*💪 PULL — ${ws.time}*\n\n` +
      `1. Tractions pronation — 4×6-8 (120s repos)\n` +
      `2. Rowing barre — 4×8-10 (90s)\n` +
      `3. Tirage vertical prise serrée — 3×10-12 (90s)\n` +
      `4. Face pulls — 4×15 (60s)\n` +
      `5. Curl barre EZ — 3×10-12 (60s)\n` +
      `6. Curl marteau — 3×12 (60s)\n` +
      `7. Rowing un bras haltère — 3×10 (90s)\n\n` +
      `*Retour au calme:* Étirements dos + biceps 5 min`,
    legs: `${WARMUP}\n*💪 LEGS — ${ws.time}*\n\n` +
      `1. Squat barre — 4×6-8 (120s repos)\n` +
      `2. Presse à cuisses — 4×10-12 (90s)\n` +
      `3. Fentes marchées — 3×12/jambe (90s)\n` +
      `4. Leg curl allongé — 4×10-12 (60s)\n` +
      `5. Extensions mollets — 4×15-20 (60s)\n` +
      `6. Hip thrust — 3×12 (90s)\n` +
      `7. Leg extension — 3×12-15 (60s)\n\n` +
      `*Retour au calme:* Étirements quadri + ischio 5 min`,
    cardio: `${WARMUP}\n*🏃 CARDIO — ${ws.time}*\n\n` +
      `Option A — HIIT (25 min):\n  8×(30s sprint / 60s récup)\n\n` +
      `Option B — Zone 2 (35 min):\n  Course continue rythme conversation\n\n` +
      `*Retour au calme:* 5 min marche + 10 min étirements`,
    rest: `*💤 JOUR DE REPOS*\n\n` +
      `La récupération fait le muscle.\n\n` +
      `Suggestions:\n` +
      `  • Marche 30 min (récup active)\n` +
      `  • Foam rolling 15 min\n` +
      `  • Étirements / yoga 20 min\n` +
      `  • Hydratation: vise 3L aujourd'hui`,
  };

  const text = EXERCISES[ws.type] || `Workout: ${ws.type}`;
  await sendTelegramMessage(chatId, text, "Markdown", {
    inline_keyboard: [
      [{ text: "🍽 Ma Nutrition", callback_data: "morning_nutrition" }, { text: "📋 Programme", callback_data: "health_program" }],
      [{ text: "☀️ Retour briefing", callback_data: "morning_briefing" }, { text: "🔙 Menu", callback_data: "menu_main" }],
    ],
  });
}

// --- MORNING NUTRITION COACH (meals for today) ---
async function handleMorningNutrition(chatId: number): Promise<void> {
  const now = getIsraelNow();
  const day = now.getDay();
  const ws = WORKOUT_SCHEDULE_BOT[day];
  const isTraining = ws.type !== "rest";
  const hour = now.getHours();

  // Fasting status
  const isFasting = hour >= 20 || hour < 12;
  const fastingRemaining = isFasting
    ? (hour >= 20 ? `${12 + 24 - hour}h` : `${12 - hour}h`)
    : "";

  let text = "";

  if (isTraining) {
    const postWorkoutTime = ws.type === "cardio" ? "08:30" : "19:00";
    text = `*🍽 NUTRITION — Jour ${ws.type.toUpperCase()}*\n\n`;
    text += isFasting
      ? `🟢 Jeûne en cours (encore ~${fastingRemaining})\n\n`
      : `🍽 Fenêtre alimentaire ouverte (12h-20h)\n\n`;

    text += `*12:00 — Déjeuner (casser le jeûne)*\n`;
    text += `  Poulet grillé 200g + riz basmati 150g + légumes\n`;
    text += `  ~550 cal · 45g protéines\n\n`;

    text += `*15:30 — Collation pré-workout*\n`;
    text += `  Banane + 20g whey + flocons avoine\n`;
    text += `  ~350 cal · 25g protéines\n\n`;

    text += `*${postWorkoutTime} — Post-workout*\n`;
    text += `  Shake whey 30g + fruits rouges\n`;
    text += `  ~200 cal · 30g protéines\n\n`;

    text += `*19:30 — Dîner (dernier repas)*\n`;
    text += `  Saumon 180g + patate douce + salade\n`;
    text += `  ~600 cal · 40g protéines\n\n`;

    text += `*Total: ~1700 cal · 140g+ protéines*\n`;
    text += `Hydratation: 2.5L minimum`;
  } else {
    text = `*🍽 NUTRITION — Jour REPOS*\n\n`;
    text += isFasting
      ? `🟢 Jeûne en cours (encore ~${fastingRemaining})\n\n`
      : `🍽 Fenêtre alimentaire ouverte (12h-20h)\n\n`;

    text += `*12:00 — Déjeuner léger*\n`;
    text += `  Salade composée + thon + avocat\n`;
    text += `  ~450 cal · 35g protéines\n\n`;

    text += `*16:00 — Collation*\n`;
    text += `  Yaourt grec + noix + miel\n`;
    text += `  ~250 cal · 20g protéines\n\n`;

    text += `*19:00 — Dîner*\n`;
    text += `  Omelette 3 oeufs + légumes sautés + pain complet\n`;
    text += `  ~500 cal · 35g protéines\n\n`;

    text += `*Total: ~1200 cal · 90g+ protéines*\n`;
    text += `Hydratation: 2.5L minimum`;
  }

  await sendTelegramMessage(chatId, text, "Markdown", {
    inline_keyboard: [
      [{ text: "💪 Mon Sport", callback_data: "morning_sport" }, { text: "📋 Programme", callback_data: "health_program" }],
      [{ text: "☀️ Retour briefing", callback_data: "morning_briefing" }, { text: "🔙 Menu", callback_data: "menu_main" }],
    ],
  });
}

// --- CAREER MAIN (with sub-menu) ---
async function handleCareerMain(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    const { data: jobs } = await supabase.from("job_listings").select("status")
      .in("status", ["new", "saved", "applied", "interviewed", "offer", "rejected"])
      .limit(500);
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
  } else if (data === "dashboard") {
    await handleDashboard(chatId);
  } else if (data === "menu_tasks") {
    await handleTasksMainV2(chatId);
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
  // === DASHBOARD SUB-MENU (Insights + Goals + Vélocité) ===
  else if (data === "menu_dashboard") {
    await sendTelegramMessage(chatId, "📊 *DASHBOARD*", "Markdown", {
      inline_keyboard: [
        [{ text: "🧠 Insights", callback_data: "menu_insights" }, { text: "🎯 Goals", callback_data: "menu_goals" }],
        [{ text: "📊 Vélocité", callback_data: "menu_velocity" }, { text: "🌙 Plan demain", callback_data: "menu_tomorrow" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  }
  // === EOS SUB-MENU (Rocks + Scorecard + CIRs) ===
  else if (data === "menu_eos") {
    await sendTelegramMessage(chatId, "🎯 *EOS — Chief of Staff*", "Markdown", {
      inline_keyboard: [
        [{ text: "🪨 Rocks", callback_data: "menu_rocks" }, { text: "📊 Scorecard", callback_data: "menu_scorecard" }],
        [{ text: "🚨 CIRs", callback_data: "menu_cirs" }],
        [{ text: "🔙 Menu", callback_data: "menu_main" }],
      ],
    });
  }
  // === TASKS SUB-MENU ===
  else if (data === "tasks_completed") {
    await handleTasksCompleted(chatId);
  } else if (data === "tasks_add") {
    await sendTelegramMessage(chatId, "Dis-moi ta tâche en message.\nEx: _Appeler le comptable demain 14h_", "Markdown");
  } else if (data === "tasks_schedule") {
    await sendTelegramMessage(chatId, "Format: /mission titre heure [durée]\nEx: _Rdv dentiste 14:00 60_", "Markdown");
  }
  // === CLEANUP CALLBACK ===
  else if (data.startsWith("cleanup_archive_")) {
    try {
      // Archive old tasks by setting status to 'completed' with a special note
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

      const { data: oldTasks, error } = await supabase.from("tasks")
        .select("id")
        .in("status", ["pending", "in_progress"])
        .or(`due_date.lt.${twoWeeksAgo},due_date.is.null`)
        .order("created_at", { ascending: true })
        .limit(50);

      if (error || !oldTasks || oldTasks.length === 0) {
        await sendTelegramMessage(chatId, "✅ Aucune tâche à archiver.");
        return;
      }

      // Filter only truly old ones
      const reallyOld = oldTasks.filter((t: any) => {
        if (!t.due_date) {
          // Check created_at via separate query is complex, so trust the initial filter
          return true;
        }
        return t.due_date < twoWeeksAgo;
      });

      if (reallyOld.length === 0) {
        await sendTelegramMessage(chatId, "✅ Aucune tâche à archiver.");
        return;
      }

      const taskIds = reallyOld.map((t: any) => t.id);

      // Archive by setting status to 'cancelled' (not completed, to not mess with stats)
      const { error: updateError } = await supabase.from("tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .in("id", taskIds);

      if (updateError) {
        await sendTelegramMessage(chatId, `❌ Erreur lors de l'archivage: ${String(updateError).substring(0, 100)}`);
        return;
      }

      await sendTelegramMessage(chatId, `✅ *${taskIds.length} tâches archivées*\n\nElles ont été marquées comme annulées et ne pollueront plus ton score quotidien.`, "Markdown");
    } catch (e) {
      await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 100)}`);
    }
  }
  // === TASK MANAGEMENT V2 CALLBACKS ===
  // --- Inbox ---
  else if (data === "menu_inbox") {
    await handleInbox(chatId);
  }
  else if (data.startsWith("inbox_p_")) {
    // inbox_p_{taskId}_{priority}
    const parts = data.replace("inbox_p_", "").split("_");
    const taskId = parts.slice(0, -1).join("_"); // UUID has dashes
    const priority = parseInt(parts[parts.length - 1], 10);
    try {
      await supabase.from("tasks").update({ is_inbox: false, priority, due_date: todayStr() }).eq("id", taskId);
      await sendTelegramMessage(chatId, `✅ Tâche sortie de l'inbox (P${priority})`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("inbox_del_")) {
    const taskId = data.replace("inbox_del_", "");
    try {
      await supabase.from("tasks").update({ status: "cancelled" }).eq("id", taskId);
      await sendTelegramMessage(chatId, `🗑 Supprimée de l'inbox`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // --- Smart Rescheduling ---
  else if (data.startsWith("reschedule_")) {
    const taskId = data.replace("reschedule_", "");
    await handleSmartReschedule(chatId, taskId);
  }
  else if (data.startsWith("tsnz_custom_")) {
    // tsnz_custom_{taskId}_{date}_{time}
    const rest = data.replace("tsnz_custom_", "");
    const lastUnderscore2 = rest.lastIndexOf("_");
    const time = rest.substring(lastUnderscore2 + 1);
    const beforeTime = rest.substring(0, lastUnderscore2);
    const lastUnderscore1 = beforeTime.lastIndexOf("_");
    // date is YYYY-MM-DD which contains dashes, not underscores
    // Format: {uuid}_{YYYY-MM-DD}_{HH:MM} — find date by pattern
    const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2})/);
    if (dateMatch) {
      const date = dateMatch[1];
      const timeSlot = dateMatch[2];
      const taskId = rest.substring(0, rest.indexOf(`_${date}`));
      try {
        const rCount = await getRescheduleCount(supabase, taskId);
        const urgency = calcUrgency(rCount + 1, null);
        await supabase.from("tasks").update({
          due_date: date, due_time: timeSlot, reminder_sent: false,
          reschedule_count: rCount + 1, urgency_level: urgency,
        }).eq("id", taskId);
        await sendTelegramMessage(chatId, `📅 Reportée → ${date} ${timeSlot}`);
      } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
    }
  }
  else if (data.startsWith("tsnz_days_")) {
    const rest = data.replace("tsnz_days_", "");
    const lastUnderscore = rest.lastIndexOf("_");
    const taskId = rest.substring(0, lastUnderscore);
    const days = parseInt(rest.substring(lastUnderscore + 1), 10);
    try {
      const future = new Date(getIsraelNow());
      future.setDate(future.getDate() + days);
      const futureStr = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
      const rCount = await getRescheduleCount(supabase, taskId);
      const urgency = calcUrgency(rCount + 1, null);
      await supabase.from("tasks").update({
        due_date: futureStr, due_time: null, reminder_sent: false,
        reschedule_count: rCount + 1, urgency_level: urgency,
      }).eq("id", taskId);
      await sendTelegramMessage(chatId, `📅 Reportée → ${futureStr}`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("tsnz_nextmon_")) {
    const taskId = data.replace("tsnz_nextmon_", "");
    try {
      const now = getIsraelNow();
      const nextMon = new Date(now);
      do { nextMon.setDate(nextMon.getDate() + 1); } while (nextMon.getDay() !== 1);
      const monStr = `${nextMon.getFullYear()}-${String(nextMon.getMonth() + 1).padStart(2, "0")}-${String(nextMon.getDate()).padStart(2, "0")}`;
      const rCount = await getRescheduleCount(supabase, taskId);
      const urgency = calcUrgency(rCount + 1, null);
      await supabase.from("tasks").update({
        due_date: monStr, due_time: null, reminder_sent: false,
        reschedule_count: rCount + 1, urgency_level: urgency,
      }).eq("id", taskId);
      await sendTelegramMessage(chatId, `📅 Reportée → Lundi ${monStr.substring(5)}`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // --- Subtasks ---
  else if (data.startsWith("subtask_split_")) {
    const taskId = data.replace("subtask_split_", "");
    await sendTelegramMessage(chatId,
      `✂️ Pour découper cette tâche, envoie les sous-tâches:\n\n/subtask ${taskId.substring(0, 8)} Sous-tâche 1\n/subtask ${taskId.substring(0, 8)} Sous-tâche 2\n...`,
      "Markdown");
  }
  else if (data.startsWith("subdone_")) {
    const subId = data.replace("subdone_", "");
    try {
      const { data: sub } = await supabase.from("tasks")
        .select("id, title, parent_task_id").eq("id", subId).single();
      if (sub) {
        await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", subId);
        // Check if all subtasks are done
        if (sub.parent_task_id) {
          const { data: remaining } = await supabase.from("tasks")
            .select("id").eq("parent_task_id", sub.parent_task_id)
            .in("status", ["pending", "in_progress"]);
          if (!remaining || remaining.length === 0) {
            await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", sub.parent_task_id);
            await sendTelegramMessage(chatId, `✅ ${sub.title}\n🎉 Toutes les sous-tâches terminées ! Tâche parent complétée.`);
          } else {
            await sendTelegramMessage(chatId, `✅ ${sub.title}\n${remaining.length} sous-tâche(s) restante(s)`);
          }
        } else {
          await sendTelegramMessage(chatId, `✅ ${sub.title}`);
        }
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("subadd_")) {
    const parentId = data.replace("subadd_", "");
    await sendTelegramMessage(chatId, `Envoie la sous-tâche:\n/subtask ${parentId.substring(0, 8)} titre de la sous-tâche`);
  }
  // --- Pomodoro ---
  else if (data === "menu_pomodoro") {
    await handlePomodoro(chatId, []);
  }
  else if (data.startsWith("pomo_start_")) {
    const taskRef = data.replace("pomo_start_", "");
    if (taskRef === "free") {
      await startPomodoro(chatId, supabase, null, "Session libre");
    } else {
      const { data: task } = await supabase.from("tasks").select("id, title").eq("id", taskRef).single();
      if (task) await startPomodoro(chatId, supabase, task.id, task.title);
      else await sendTelegramMessage(chatId, "Tâche introuvable.");
    }
  }
  else if (data.startsWith("pomo_done_")) {
    const sessionId = data.replace("pomo_done_", "");
    try {
      const { data: session } = await supabase.from("pomodoro_sessions")
        .select("id, task_id, started_at").eq("id", sessionId).single();
      if (session) {
        await supabase.from("pomodoro_sessions").update({
          ended_at: new Date().toISOString(), completed: true,
        }).eq("id", sessionId);
        let pomMsg = `✅ 🍅 Pomodoro terminé !`;
        if (session.task_id) {
          const { data: taskData } = await supabase.from("tasks").select("pomodoro_count, title").eq("id", session.task_id).single();
          if (taskData) {
            const newCount = (taskData.pomodoro_count || 0) + 1;
            await supabase.from("tasks").update({ pomodoro_count: newCount }).eq("id", session.task_id);
            pomMsg += `\n${taskData.title} — 🍅 x${newCount}`;
          }
        }
        pomMsg += `\n\n☕ Pause ${POMODORO_BREAK_MIN} min !`;
        await sendTelegramMessage(chatId, pomMsg, "Markdown", {
          inline_keyboard: [
            [{ text: "🍅 Encore un !", callback_data: session.task_id ? `pomo_start_${session.task_id}` : "pomo_start_free" }],
            [{ text: "✅ Tâche terminée", callback_data: session.task_id ? `tdone_${session.task_id}` : "menu_tasks" }],
            [{ text: "🔙 Menu", callback_data: "menu_main" }],
          ],
        });
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("pomo_cancel_")) {
    const sessionId = data.replace("pomo_cancel_", "");
    try {
      await supabase.from("pomodoro_sessions").update({
        ended_at: new Date().toISOString(), completed: false,
      }).eq("id", sessionId);
      await sendTelegramMessage(chatId, `❌ Pomodoro abandonné.`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // --- Velocity, Sprint, TimeBlock, Recurring, Tomorrow Plan ---
  else if (data === "menu_velocity") {
    await handleVelocity(chatId);
  }
  else if (data === "menu_sprint") {
    await handleSprintGoals(chatId);
  }
  else if (data === "sprint_create") {
    await sendTelegramMessage(chatId, "Format: /sprint domaine \"objectif\" cible\n\nEx: /sprint health \"4 workouts\" 4", "Markdown");
  }
  else if (data === "menu_timeblock") {
    await handleTimeBlock(chatId);
  }
  else if (data.startsWith("timeblock_apply_")) {
    const date = data.replace("timeblock_apply_", "");
    try {
      const signals = getSignalBus("telegram-bot");
      const proposal = await signals.getLatest("timeblock_proposal");
      if (proposal?.payload?.assignments) {
        for (const a of proposal.payload.assignments) {
          await supabase.from("tasks").update({
            due_time: a.time, duration_minutes: a.dur, reminder_sent: false,
          }).eq("id", a.taskId);
        }
        await sendTelegramMessage(chatId, `✅ Time block appliqué ! ${proposal.payload.assignments.length} tâches planifiées.`);
      } else {
        await sendTelegramMessage(chatId, `Proposition expirée. Relance /timeblock.`);
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data === "menu_recurring") {
    await handleRecurringList(chatId);
  }
  else if (data.startsWith("recurring_del_")) {
    const taskId = data.replace("recurring_del_", "");
    try {
      await supabase.from("tasks").update({ status: "cancelled", recurrence_rule: null }).eq("id", taskId);
      // Also cancel future occurrences
      await supabase.from("tasks").update({ status: "cancelled", recurrence_rule: null })
        .eq("recurrence_source_id", taskId).in("status", ["pending", "in_progress"]);
      await sendTelegramMessage(chatId, `🗑 Tâche récurrente supprimée.`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data === "menu_tomorrow") {
    await handleTomorrowPlan(chatId);
  }
  else if (data.startsWith("plan_validate_")) {
    const date = data.replace("plan_validate_", "");
    try {
      await supabase.from("tomorrow_plans").update({ validated: true }).eq("plan_date", date);
      await sendTelegramMessage(chatId, `✅ Plan validé pour ${date} !\nBonne soirée, demain sera productif 💪`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // --- Task context assignment ---
  else if (data.startsWith("task_setctx_")) {
    const parts = data.replace("task_setctx_", "").split("_");
    const taskId = parts[0];
    const context = parts[1];
    try {
      if (context === "none") {
        await sendTelegramMessage(chatId, `👌 Tâche sans contexte.`);
      } else {
        await supabase.from("tasks").update({ context }).eq("id", taskId);
        await sendTelegramMessage(chatId, `${CONTEXT_EMOJI[context] || "🏷"} Contexte: *${context}*`, "Markdown");
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // --- Context filters ---
  else if (data.startsWith("ctx_")) {
    const context = data.replace("ctx_", "");
    await handleTasksByContext(chatId, context);
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
  // === MORNING BRIEFING ===
  else if (data === "morning_briefing") {
    await handleMorningBriefing(chatId);
  } else if (data === "morning_sport") {
    await handleMorningSport(chatId);
  } else if (data === "morning_nutrition") {
    await handleMorningNutrition(chatId);
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
  // ─── 1-CLICK APPLY FLOW ───
  else if (data.startsWith("job_applied_")) {
    const jobId = data.replace("job_applied_", "");
    try {
      await supabase.from("job_listings").update({
        status: "applied",
        applied_date: todayStr(),
      }).eq("id", jobId);
      const { data: job } = await supabase.from("job_listings")
        .select("title, company").eq("id", jobId).single();
      if (job) {
        await sendTelegramMessage(chatId, `✅ *${escapeMarkdown(job.title)}* @ ${escapeMarkdown(job.company)} — Marqué comme postulé !`, "Markdown");
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("job_skip_")) {
    const jobId = data.replace("job_skip_", "");
    try {
      await supabase.from("job_listings").update({ status: "rejected", notes: "Skipped from daily recommendations" }).eq("id", jobId);
      await sendTelegramMessage(chatId, `⏭ Offre ignorée.`);
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("job_cover_")) {
    const jobId = data.replace("job_cover_", "");
    try {
      const { data: job } = await supabase.from("job_listings")
        .select("title, company, location, cover_letter_snippet, job_url").eq("id", jobId).single();
      if (!job) { await sendTelegramMessage(chatId, "Offre introuvable."); }
      else {
        // Generate full cover letter with callOpenAI
        const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
        const coverPrompt = `Tu es expert en candidature AE/SDR tech/SaaS. Oren est Account Executive bilingue FR/EN basé en Israël, avec expérience en vente B2B SaaS. Génère une lettre de motivation percutante et personnalisée (10-12 lignes) pour ce poste. Style: direct, orienté résultats, avec des métriques concrètes. Finis par un call-to-action fort.`;
        const coverContent = `Poste: ${job.title} chez ${job.company} (${job.location || ""})`;

        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: coverPrompt },
              { role: "user", content: coverContent },
            ],
            max_tokens: 500,
          }),
        });
        const json = await resp.json();
        const letter = json?.choices?.[0]?.message?.content || "Erreur de génération.";

        let msg = `📝 *LETTRE DE MOTIVATION*\n`;
        msg += `${escapeMarkdown(job.title)} @ ${escapeMarkdown(job.company)}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        msg += escapeMarkdown(letter);

        await sendTelegramMessage(chatId, msg, "Markdown", [
          [{ text: `✅ Postulé ${job.company.substring(0, 15)}`, callback_data: `job_applied_${jobId}` }],
        ]);

        // Cache for future use
        await supabase.from("job_listings").update({ cover_letter_snippet: letter.substring(0, 500) }).eq("id", jobId);
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 100)}`); }
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
      const { error } = await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", taskId);
      if (error) throw error;
      await sendTelegramMessage(chatId, `✓ Tache terminee`);
      // Spawn next recurrence if applicable
      try {
        const { data: fullTask } = await supabase.from("tasks").select("*").eq("id", taskId).single();
        if (fullTask?.recurrence_rule) await spawnNextRecurrence(supabase, fullTask);
      } catch (_) {}
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
        // Spawn next recurrence if applicable
        try {
          const { data: fullTask } = await supabase.from("tasks")
            .select("*").eq("id", matchedTask.id).single();
          if (fullTask?.recurrence_rule) {
            await spawnNextRecurrence(supabase, fullTask);
          }
        } catch (re) { console.error("Recurrence spawn error:", re); }
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
  // ─── FAIL REASON CALLBACKS ───
  // When user explains WHY a task wasn't done: fail_{reason}_{taskId}
  else if (data.startsWith("fail_")) {
    const parts = data.replace("fail_", "").split("_");
    const reason = parts[0]; // blocked, forgot, toobig, energy, other
    const taskId = parts.slice(1).join("_");

    const REASON_LABELS: Record<string, string> = {
      blocked: "🚧 Bloqué (dépendance externe)",
      forgot: "🧠 Oublié",
      toobig: "🏔 Trop grosse tâche",
      energy: "🔋 Pas d'énergie",
      skip: "⏭ Pas prioritaire",
    };

    try {
      const label = REASON_LABELS[reason] || reason;

      // Save to task_fail_reasons
      await supabase.from("task_fail_reasons").insert({
        task_id: taskId,
        reason,
        task_date: todayStr(),
      });

      // Update task with fail_reason and increment fail_count
      const { data: taskData } = await supabase.from("tasks")
        .select("title, fail_count").eq("id", taskId).single();

      if (taskData) {
        await supabase.from("tasks").update({
          fail_reason: reason,
          fail_count: (taskData.fail_count || 0) + 1,
        }).eq("id", taskId);

        let response = `📝 Noté: ${label}\n`;

        // Smart follow-up based on reason
        if (reason === "toobig") {
          response += `\n💡 Essaie de la découper: /subtask ${taskId.substring(0, 8)} <sous-tâche>`;
        } else if (reason === "blocked") {
          response += `\nQui/quoi te bloque ? Tape ta réponse et je noterai.`;
        } else if (reason === "energy") {
          response += `\n💡 Je la déplacerai à un moment où tu as plus d'énergie.`;
        }

        await sendTelegramMessage(chatId, response);
      } else {
        await sendTelegramMessage(chatId, `Tâche introuvable.`);
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
  // === ROCKS CALLBACKS ===
  else if (data === "menu_rocks") {
    await handleRock(chatId, []);
  }
  else if (data.startsWith("rock_done_")) {
    const rockId = data.replace("rock_done_", "");
    try {
      await supabase.from("rocks").update({
        current_status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", rockId);
      await sendTelegramMessage(chatId, `✅ Rock marqué comme *DONE* !`, "Markdown");
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("rock_off_")) {
    const rockId = data.replace("rock_off_", "");
    try {
      await supabase.from("rocks").update({
        current_status: "off_track", updated_at: new Date().toISOString(),
      }).eq("id", rockId);
      await sendTelegramMessage(chatId, `⚠️ Rock marqué *OFF TRACK*`, "Markdown");
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  else if (data.startsWith("rock_on_")) {
    const rockId = data.replace("rock_on_", "");
    try {
      await supabase.from("rocks").update({
        current_status: "on_track", updated_at: new Date().toISOString(),
      }).eq("id", rockId);
      await sendTelegramMessage(chatId, `✅ Rock marqué *ON TRACK*`, "Markdown");
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // === SCORECARD CALLBACK ===
  else if (data === "menu_scorecard") {
    await handleScorecard(chatId);
  }
  // === GOAL UPDATE CALLBACKS ===
  else if (data.startsWith("goal_inc_")) {
    const domain = data.replace("goal_inc_", "");
    try {
      const { data: goal } = await supabase.from("goals")
        .select("id, metric_current, metric_target, metric_unit, direction, title")
        .eq("domain", domain).eq("status", "active").limit(1).single();
      if (goal) {
        const current = Number(goal.metric_current) || 0;
        const isDecrease = goal.direction === "decrease";
        const newValue = isDecrease ? current - 1 : current + 1;
        await supabase.from("goals").update({ metric_current: newValue }).eq("id", goal.id);
        const arrow = isDecrease ? "↓" : "↑";
        await sendTelegramMessage(chatId, `✅ ${goal.title}: ${current} → ${newValue}${goal.metric_unit || ""} ${arrow}`);
        // Refresh goals view
        await handleGoals(chatId);
      } else {
        await sendTelegramMessage(chatId, `Aucun objectif actif pour ${domain}`);
      }
    } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
  }
  // === CIR CALLBACKS ===
  else if (data === "menu_cirs") {
    await handleCIR(chatId, []);
  }
  else if (data.startsWith("cir_toggle_")) {
    const cirId = data.replace("cir_toggle_", "");
    try {
      const { data: cir } = await supabase.from("critical_info_requirements")
        .select("active").eq("id", cirId).single();
      if (cir) {
        await supabase.from("critical_info_requirements")
          .update({ active: !cir.active }).eq("id", cirId);
        await sendTelegramMessage(chatId, cir.active ? `🔕 CIR désactivé` : `🔔 CIR activé`);
      }
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

// ============================================
// TIER 5 — ROCKS, SCORECARD, CIR HANDLERS
// ============================================

async function handleRock(chatId: number, args: string[]): Promise<void> {
  const supabase = getSupabaseClient();

  // /rock add "title" domain
  if (args[0] === "add" && args.length >= 3) {
    const domain = args[args.length - 1];
    const title = args.slice(1, -1).join(" ").replace(/"/g, "");
    const now = new Date();
    // Quarter: current 90-day window
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const quarterEnd = new Date(quarterStart.getFullYear(), quarterStart.getMonth() + 3, 0);

    const { error } = await supabase.from("rocks").insert({
      title,
      domain,
      measurable_target: title,
      quarter_start: quarterStart.toISOString().split("T")[0],
      quarter_end: quarterEnd.toISOString().split("T")[0],
    });

    if (error) {
      await sendTelegramMessage(chatId, `Erreur: ${error.message}`);
    } else {
      await sendTelegramMessage(chatId,
        `🪨 *Rock ajouté !*\n\n${escapeMarkdown(title)}\nDomaine: ${domain}\nTrimestre: ${quarterStart.toISOString().split("T")[0]} → ${quarterEnd.toISOString().split("T")[0]}`,
        "Markdown");
    }
    return;
  }

  // /rock update <id_prefix> done|off_track|on_track
  if (args[0] === "update" && args.length >= 3) {
    const idPrefix = args[1];
    const newStatus = args[2];
    if (!["done", "off_track", "on_track"].includes(newStatus)) {
      await sendTelegramMessage(chatId, "Status: done | off\\_track | on\\_track", "Markdown");
      return;
    }

    const { data: rocks } = await supabase.from("rocks")
      .select("id").in("current_status", ["on_track", "off_track"])
      .order("created_at", { ascending: false }).limit(10);
    const rock = (rocks || []).find((r: any) => r.id.startsWith(idPrefix));

    if (!rock) {
      await sendTelegramMessage(chatId, `Rock introuvable.`);
      return;
    }

    await supabase.from("rocks").update({
      current_status: newStatus,
      updated_at: new Date().toISOString(),
      ...(newStatus === "done" ? { completed_at: new Date().toISOString() } : {}),
    }).eq("id", rock.id);

    const statusEmoji = newStatus === "done" ? "✅" : newStatus === "off_track" ? "⚠️" : "🟢";
    await sendTelegramMessage(chatId, `${statusEmoji} Rock mis à jour: *${newStatus}*`, "Markdown");
    return;
  }

  // Default: /rock list
  const { data: rocks } = await supabase.from("rocks")
    .select("*")
    .in("current_status", ["on_track", "off_track"])
    .order("created_at", { ascending: true });

  if (!rocks || rocks.length === 0) {
    await sendTelegramMessage(chatId,
      `🪨 *ROCKS* — Aucun Rock actif\n\nAjoute un Rock:\n/rock add "Obtenir 3 interviews" career\n\nDomaines: career, health, finance, learning, higrow`,
      "Markdown");
    return;
  }

  const now = new Date();
  let msg = `🪨 *ROCKS — Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const buttons: any[][] = [];

  for (const r of rocks) {
    const daysLeft = Math.ceil((new Date(r.quarter_end).getTime() - now.getTime()) / 86400000);
    const statusIcon = r.current_status === "on_track" ? "🟢" : "⚠️";
    const domainEmoji = { career: "💼", health: "🏋️", finance: "💰", learning: "📚", higrow: "🚀" }[r.domain] || "📌";

    msg += `${statusIcon} ${domainEmoji} *${escapeMarkdown(r.title)}*\n`;
    msg += `   J-${daysLeft} · ${r.current_status.replace("_", " ")}\n\n`;

    const shortId = r.id.substring(0, 8);
    buttons.push([
      { text: `✅ Done ${shortId}`, callback_data: `rock_done_${r.id}` },
      { text: `⚠️ Off`, callback_data: `rock_off_${r.id}` },
      { text: `🟢 On`, callback_data: `rock_on_${r.id}` },
    ]);
  }

  msg += `\n/rock add "titre" domaine — Ajouter\n/rock update <id> done|off\\_track — Modifier`;

  await sendTelegramMessage(chatId, msg, "Markdown", { inline_keyboard: buttons });
}

async function handleScorecard(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  // Calculate week dates (Sunday to Saturday)
  const now = new Date();
  const dayOfWeek = now.getDay();
  const weekStartDate = new Date(now);
  weekStartDate.setDate(now.getDate() - dayOfWeek);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekStartDate.getDate() + 6);

  const weekStart = `${weekStartDate.getFullYear()}-${String(weekStartDate.getMonth() + 1).padStart(2, "0")}-${String(weekStartDate.getDate()).padStart(2, "0")}`;
  const weekEnd = `${weekEndDate.getFullYear()}-${String(weekEndDate.getMonth() + 1).padStart(2, "0")}-${String(weekEndDate.getDate()).padStart(2, "0")}`;

  // Fetch all data in parallel for scorecard
  const [
    jobAppsRes, jobInterviewsRes, leadsRes, leadsConvertedRes,
    tasksRes, tasksDoneRes, workoutsRes, studyRes,
    financeExpRes, financeIncRes, healthWeightRes,
  ] = await Promise.all([
    supabase.from("job_listings").select("id").eq("status", "applied").gte("applied_date", weekStart).lte("applied_date", weekEnd),
    supabase.from("job_listings").select("id").eq("status", "interview"),
    supabase.from("leads").select("id").gte("last_contact_date", weekStart + "T00:00:00").lte("last_contact_date", weekEnd + "T23:59:59"),
    supabase.from("leads").select("id").eq("status", "converted"),
    supabase.from("tasks").select("id, status").gte("due_date", weekStart).lte("due_date", weekEnd),
    supabase.from("tasks").select("id").eq("status", "completed").gte("updated_at", weekStart + "T00:00:00"),
    supabase.from("health_logs").select("log_date").eq("log_type", "workout").gte("log_date", weekStart).lte("log_date", weekEnd),
    supabase.from("study_sessions").select("duration_minutes").gte("session_date", weekStart).lte("session_date", weekEnd),
    supabase.from("finance_logs").select("amount").eq("transaction_type", "expense").gte("transaction_date", weekStart).lte("transaction_date", weekEnd),
    supabase.from("finance_logs").select("amount").eq("transaction_type", "income").gte("transaction_date", weekStart).lte("transaction_date", weekEnd),
    supabase.from("health_logs").select("value").eq("log_type", "weight").order("log_date", { ascending: false }).limit(1),
  ]);

  const jobApps = jobAppsRes.data?.length || 0;
  const jobInterviews = jobInterviewsRes.data?.length || 0;
  const leadsContacted = leadsRes.data?.length || 0;
  const leadsConverted = leadsConvertedRes.data?.length || 0;
  const totalTasks = Math.max((tasksRes.data || []).length, 1);
  const tasksDone = tasksDoneRes.data?.length || 0;
  const completionRate = Math.round((tasksDone / totalTasks) * 100);
  const workoutDays = new Set((workoutsRes.data || []).map((w: any) => w.log_date)).size;
  const studyHours = ((studyRes.data || []).reduce((s: number, l: any) => s + (l.duration_minutes || 0), 0) / 60);
  const totalExp = (financeExpRes.data || []).reduce((s: number, f: any) => s + Number(f.amount), 0);
  const totalInc = (financeIncRes.data || []).reduce((s: number, f: any) => s + Number(f.amount), 0);
  const savingsRate = totalInc > 0 ? Math.round(((totalInc - totalExp) / totalInc) * 100) : 0;
  const latestWeight = healthWeightRes.data?.[0]?.value ? Number(healthWeightRes.data[0].value) : null;

  function sc(actual: number, goal: number, dir: "up" | "down" = "up"): string {
    if (dir === "down") return actual <= goal ? "🟢" : actual <= goal * 1.2 ? "🟡" : "🔴";
    return actual >= goal ? "🟢" : actual >= goal * 0.7 ? "🟡" : "🔴";
  }

  let msg = `📊 *SCORECARD* — Semaine du ${weekStart.substring(5)}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `💼 Candidatures     ${jobApps}     /5    ${sc(jobApps, 5)}\n`;
  msg += `💼 Interviews       ${jobInterviews}     /1    ${sc(jobInterviews, 1)}\n`;
  msg += `🚀 Leads contactés  ${leadsContacted}    /10   ${sc(leadsContacted, 10)}\n`;
  msg += `🚀 Clients          ${leadsConverted}     /2    ${sc(leadsConverted, 2)}\n`;
  msg += `📋 Complétion       ${completionRate}%   /80%  ${sc(completionRate, 80)}\n`;
  msg += `🏋️ Workouts         ${workoutDays}     /5    ${sc(workoutDays, 5)}\n`;
  msg += `📚 Étude            ${studyHours.toFixed(1)}h  /5h   ${sc(studyHours, 5)}\n`;
  msg += `💰 Épargne          ${savingsRate}%   /20%  ${sc(savingsRate, 20)}\n`;
  msg += `⚖️ Poids            ${latestWeight || "?"}   /70   ${latestWeight ? sc(latestWeight, 70, "down") : "🟡"}\n`;

  const greens = [
    sc(jobApps, 5), sc(jobInterviews, 1), sc(leadsContacted, 10), sc(leadsConverted, 2),
    sc(completionRate, 80), sc(workoutDays, 5), sc(studyHours, 5), sc(savingsRate, 20),
  ].filter(s => s === "🟢").length;
  const reds = [
    sc(jobApps, 5), sc(jobInterviews, 1), sc(leadsContacted, 10), sc(leadsConverted, 2),
    sc(completionRate, 80), sc(workoutDays, 5), sc(studyHours, 5), sc(savingsRate, 20),
  ].filter(s => s === "🔴").length;

  msg += `\n${greens}/9 on track · ${reds} off track`;

  await sendTelegramMessage(chatId, msg, "Markdown");
}

async function handleCIR(chatId: number, args: string[]): Promise<void> {
  const supabase = getSupabaseClient();

  // /cir add "title" condition_type
  if (args[0] === "add" && args.length >= 3) {
    const condType = args[args.length - 1];
    const title = args.slice(1, -1).join(" ").replace(/"/g, "");

    const { error } = await supabase.from("critical_info_requirements").insert({
      title,
      condition_type: condType,
      condition_config: {},
      alert_priority: 1,
    });

    if (error) {
      await sendTelegramMessage(chatId, `Erreur: ${error.message}`);
    } else {
      await sendTelegramMessage(chatId, `🚨 CIR ajouté: *${escapeMarkdown(title)}*`, "Markdown");
    }
    return;
  }

  // Default: list CIRs
  const { data: cirs } = await supabase.from("critical_info_requirements")
    .select("*").order("alert_priority", { ascending: true });

  if (!cirs || cirs.length === 0) {
    await sendTelegramMessage(chatId, `🚨 *CIRs* — Aucun configuré\n\nLes CIRs définissent quelles alertes passent en temps réel.`, "Markdown");
    return;
  }

  let msg = `🚨 *CRITICAL INFORMATION REQUIREMENTS*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const buttons: any[][] = [];

  for (const cir of cirs) {
    const activeIcon = cir.active ? "🔔" : "🔕";
    const prioIcon = cir.alert_priority === 1 ? "🔴 Immédiat" : "🟡 Briefing";
    msg += `${activeIcon} *${escapeMarkdown(cir.title)}*\n`;
    msg += `   ${prioIcon} · ${cir.condition_type}\n\n`;

    buttons.push([
      { text: `${cir.active ? "🔕 Désactiver" : "🔔 Activer"} ${cir.title.substring(0, 20)}`, callback_data: `cir_toggle_${cir.id}` },
    ]);
  }

  msg += `\nClique pour activer/désactiver.`;
  await sendTelegramMessage(chatId, msg, "Markdown", { inline_keyboard: buttons });
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
    const isNight = hour >= 22 || hour < 7;

    let text = `📈 *TRADING*\n\n`;
    if (isNight) {
      text += `🌙 Mode nuit (${hour}h) — pas d'analyse\n`;
      text += `Reprise à 07:00\n\n`;
    } else {
      text += `${dayNames[day]} ${hour}h · `;
      text += day >= 1 && day <= 3 ? "Signaux actifs" : day >= 4 && day <= 5 ? "Observation" : "Off\n";
      text += `\n`;
    }

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

    // At night: show read-only menu (no fresh analysis button)
    const tradingButtons = isNight
      ? [
          [{ text: "📊 Dernière analyse", callback_data: "trading_last" }, { text: "📋 Plans semaine", callback_data: "trading_plans" }],
          [{ text: "📈 Stats 7j", callback_data: "trading_stats" }, { text: "🔙 Menu", callback_data: "menu_main" }],
        ]
      : [
          [{ text: "📊 Dernière analyse", callback_data: "trading_last" }, { text: "🔄 Analyse fraîche", callback_data: "trading_fresh" }],
          [{ text: "📋 Plans semaine", callback_data: "trading_plans" }, { text: "📈 Stats 7j", callback_data: "trading_stats" }],
          [{ text: "⚙️ Gérer pairs", callback_data: "trading_pairs" }, { text: "🔙 Menu", callback_data: "menu_main" }],
        ];

    await sendTelegramMessage(chatId, text, "Markdown", { inline_keyboard: tradingButtons });
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
      try {
        const notes = JSON.parse(s.notes || "{}");
        const trend1D = (notes.trend1D || "").toLowerCase();
        const trend4H = (notes.trend4H || "").toLowerCase();
        const isBearish = trend1D.includes("bear") || trend1D.includes("down") || trend4H.includes("bear") || trend4H.includes("down");

        // Determine direction: SHORT if bearish + SELL, LONG if bullish + BUY
        let direction = "";
        let icon = "";
        if (s.signal_type === "BUY") {
          direction = "LONG ▲";
          icon = "🟢";
        } else if (s.signal_type === "SELL" && isBearish) {
          direction = "SHORT ▼";
          icon = "🔴";
        } else if (s.signal_type === "SELL") {
          direction = "SELL ▼";
          icon = "🟠";
        } else {
          direction = "HOLD —";
          icon = "⚪";
        }

        text += `${icon} *${s.symbol}* — ${direction}\n`;
        text += `  Trend: 1D ${notes.trend1D || "?"} · 4H ${notes.trend4H || "?"}\n`;
        text += `  Contexte: ${notes.context || "?"} · EMA: ${notes.ema200 || "?"}\n`;
        text += `  Confluence: ${notes.confluence || "?"}/7\n`;
        if (notes.signal) {
          const sig = notes.signal;
          const posType = (s.signal_type === "SELL" && isBearish) ? "SHORT" : (s.signal_type === "BUY" ? "LONG" : "");
          if (posType) text += `  📍 ${posType} Entry: $${sig.entry?.toLocaleString() || "?"}\n`;
          else text += `  Entry $${sig.entry?.toLocaleString() || "?"}\n`;
          text += `  🛑 SL $${sig.sl?.toLocaleString() || "?"} · 🎯 TP $${sig.tp?.toLocaleString() || "?"}\n`;
          text += `  R:R ${sig.rr || "?"} · ${sig.strategy || ""} · ${sig.confidence || "?"}%\n`;
        }
      } catch (_) {
        const icon = s.signal_type === "BUY" ? "▲ BUY" : s.signal_type === "SELL" ? "▼ SELL" : "— HOLD";
        text += `*${s.symbol}* ${icon}\n`;
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
  // Block analysis at night (22h-07h Israel)
  if (isNightInIsrael()) {
    await sendTelegramMessage(chatId, "🌙 *Pas d'analyse la nuit* (22h-07h)\nLes marchés dorment, toi aussi.\nReviens demain matin!", "Markdown", {
      inline_keyboard: [[{ text: "🔙 Trading", callback_data: "menu_signals" }]],
    });
    return;
  }

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
      const count = result.analyses?.length || 0;
      const summary = result.analyses?.map((a: any) => {
        const icon = a.signal === "BUY" ? "▲" : a.signal === "SELL" ? "▼" : "—";
        return `${icon} ${a.symbol}`;
      }).join(" · ") || "";
      await sendTelegramMessage(chatId, `✅ Analyse prête ! ${count} paires analysées\n${summary}`, "Markdown", {
        inline_keyboard: [
          [{ text: "📊 Voir l'analyse complète", callback_data: "trading_last" }],
          [{ text: "🔙 Trading", callback_data: "menu_signals" }],
        ],
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

// ─── CLEANUP OLD TASKS ───────────────────────────────────────────────────
async function handleCleanup(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    const today = todayStr();
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

    // Find old pending tasks: no due_date OR due_date < 14 days ago
    const { data: oldTasks } = await supabase.from("tasks")
      .select("id, title, created_at, due_date, priority")
      .in("status", ["pending", "in_progress"])
      .or(`due_date.lt.${twoWeeksAgo},due_date.is.null`)
      .order("created_at", { ascending: true })
      .limit(50);

    if (!oldTasks || oldTasks.length === 0) {
      await sendTelegramMessage(chatId, "✅ Aucune vieille tâche à nettoyer.\nToutes tes tâches sont récentes ou planifiées.");
      return;
    }

    // Filter only truly old ones (created > 14 days ago if no due_date)
    const reallyOld = oldTasks.filter((t: any) => {
      if (t.due_date && t.due_date < twoWeeksAgo) return true;
      if (!t.due_date && t.created_at < twoWeeksAgo + "T00:00:00") return true;
      return false;
    });

    if (reallyOld.length === 0) {
      await sendTelegramMessage(chatId, "✅ Aucune vieille tâche à nettoyer.");
      return;
    }

    let text = `🧹 *NETTOYAGE — ${reallyOld.length} vieilles tâches*\n\n`;
    text += `Ces tâches ont plus de 14 jours ou sont en retard depuis longtemps:\n\n`;

    reallyOld.slice(0, 20).forEach((t: any, i: number) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000);
      const p = (t.priority || 3) <= 1 ? "🔴" : (t.priority || 3) === 2 ? "🟠" : "🟡";
      text += `${i + 1}. ${p} ${t.title.substring(0, 60)}\n`;
      text += `   _Créée il y a ${age}j${t.due_date ? `, due: ${t.due_date}` : ""}_\n`;
    });

    if (reallyOld.length > 20) {
      text += `\n_+ ${reallyOld.length - 20} autres tâches..._\n`;
    }

    text += `\n*Options:*\n`;
    text += `• *Archiver tout* → elles disparaissent de ta liste\n`;
    text += `• Annuler → garder comme elles sont`;

    const taskIds = reallyOld.map((t: any) => t.id).join(",");
    const buttons: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "🗑️ Archiver tout", callback_data: `cleanup_archive_${taskIds.substring(0, 50)}` },
          { text: "❌ Annuler", callback_data: "menu_main" },
        ],
      ],
    };

    await sendTelegramMessage(chatId, text, "Markdown", buttons);

  } catch (e) {
    console.error("Cleanup error:", e);
    await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 100)}`);
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

    // Use Goal Intelligence Engine
    const ranked = rankGoals(goals);
    const text = formatGoalIntelligence(ranked);

    // Build inline update buttons for top goals
    const buttons: InlineKeyboardButton[][] = [];
    for (const g of ranked.slice(0, 4)) {
      const domainEmoji: Record<string, string> = {
        career: "💼", finance: "💰", health: "🏋️",
        higrow: "🚀", trading: "📈", learning: "📚", personal: "🏠",
      };
      const emoji = domainEmoji[g.domain] || "📌";
      // Quick increment button
      const increment = g.direction === "decrease" ? "-1" : "+1";
      buttons.push([
        { text: `${emoji} ${g.title.substring(0, 16)} (${increment})`, callback_data: `goal_inc_${g.domain}` },
      ]);
    }
    buttons.push([{ text: "🔙 Menu", callback_data: "menu_main" }]);

    await sendTelegramMessage(chatId, text, "HTML", { inline_keyboard: buttons });
  } catch (e) {
    console.error("Goals error:", e);
    await sendTelegramMessage(chatId, `error: ${String(e).substring(0, 50)}`);
  }
}

// --- Unified Dashboard (single view of all domains) ---

async function handleDashboard(chatId: number): Promise<void> {
  const supabase = getSupabaseClient();
  const now = getIsraelNow();
  const today = todayStr();
  const dayName = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"][now.getDay()];
  const monthStart = `${today.substring(0, 7)}-01`;

  try {
    // Parallel fetch across all domains
    const [
      tasksRes, goalsRes, jobsRes, leadsRes,
      financeRes, weightRes, workoutsRes, studyRes,
    ] = await Promise.all([
      // Tasks: today pending + completed
      supabase.from("tasks").select("id, title, priority, status, due_time")
        .eq("due_date", today).in("status", ["pending", "in_progress", "completed"])
        .order("priority", { ascending: true }).limit(20),
      // Goals: active
      supabase.from("goals").select("domain, title, metric_current, metric_target, metric_unit, metric_start, direction, deadline, priority, daily_actions, created_at")
        .eq("status", "active").order("priority").limit(8),
      // Career: pipeline
      supabase.from("job_listings").select("status")
        .in("status", ["new", "applied", "interview", "offer"]),
      // HiGrow: leads this month
      supabase.from("leads").select("status")
        .gte("created_at", monthStart),
      // Finance: month summary
      supabase.from("finance_logs").select("transaction_type, amount")
        .gte("transaction_date", monthStart),
      // Health: latest weight
      supabase.from("health_logs").select("value")
        .eq("log_type", "weight").order("log_date", { ascending: false }).limit(1),
      // Health: workouts this week
      supabase.from("health_logs").select("id")
        .eq("log_type", "workout")
        .gte("log_date", new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0]),
      // Learning: study this week
      supabase.from("study_sessions").select("duration_minutes")
        .gte("session_date", new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0])
        .neq("topic", "agent_analysis"),
    ]);

    const tasks = tasksRes.data || [];
    const goals = goalsRes.data || [];
    const jobs = jobsRes.data || [];
    const leads = leadsRes.data || [];
    const finance = financeRes.data || [];
    const weight = weightRes.data?.[0]?.value || "?";
    const workoutCount = workoutsRes.data?.length || 0;
    const studyMinutes = (studyRes.data || []).reduce((s: number, ss: any) => s + (ss.duration_minutes || 0), 0);

    // Process tasks
    const pendingTasks = tasks.filter((t: any) => t.status !== "completed");
    const completedTasks = tasks.filter((t: any) => t.status === "completed");
    const p1p2 = pendingTasks.filter((t: any) => (t.priority || 3) <= 2);

    // Process career
    const newJobs = jobs.filter((j: any) => j.status === "new").length;
    const applied = jobs.filter((j: any) => j.status === "applied").length;
    const interviews = jobs.filter((j: any) => j.status === "interview").length;
    const offers = jobs.filter((j: any) => j.status === "offer").length;

    // Process HiGrow
    const totalLeads = leads.length;
    const converted = leads.filter((l: any) => l.status === "converted").length;

    // Process finance
    const monthIncome = finance.filter((f: any) => f.transaction_type === "income").reduce((s: number, e: any) => s + e.amount, 0);
    const monthExpense = finance.filter((f: any) => f.transaction_type === "expense").reduce((s: number, e: any) => s + e.amount, 0);
    const balance = monthIncome - monthExpense;
    const savingsRate = monthIncome > 0 ? Math.round(((monthIncome - monthExpense) / monthIncome) * 100) : 0;

    // Goal Intelligence — ranked by urgency
    const rankedGoals = rankGoals(goals);
    const criticalGoals = rankedGoals.filter(g => g.riskLevel === "critical" || g.riskLevel === "danger");

    // Determine urgency level — goal-aware
    let urgency = "🟢";
    if (interviews === 0 || converted === 0 || criticalGoals.length > 0) urgency = "🔴";
    else if (applied < 5 || savingsRate < 20 || rankedGoals.some(g => g.riskLevel === "watch")) urgency = "🟡";

    // Build message
    let msg = `${urgency} *DASHBOARD* — ${dayName} ${today}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Tasks summary
    msg += `📋 *TACHES:* ${completedTasks.length}✓ / ${tasks.length} total\n`;
    if (p1p2.length > 0) {
      msg += `  Urgentes: ${p1p2.map((t: any) => t.title).slice(0, 2).join(", ")}\n`;
    }

    // Career
    msg += `\n💼 *CARRIERE:*\n`;
    msg += `  ${newJobs} nouvelles · ${applied} postulées · ${interviews} interviews`;
    if (offers > 0) msg += ` · ${offers} offres`;
    msg += `\n`;
    if (interviews === 0) msg += `  ⚠️ _0 interviews — augmenter les candidatures_\n`;

    // HiGrow
    msg += `\n🚀 *HIGROW:* ${converted}/${totalLeads || "?"} clients convertis\n`;
    if (converted === 0 && totalLeads > 0) msg += `  ⚠️ _0 conversion — relancer les leads_\n`;

    // Finance
    msg += `\n💰 *FINANCE:*\n`;
    msg += `  Revenus: ${Math.round(monthIncome)}₪ · Dépenses: ${Math.round(monthExpense)}₪\n`;
    msg += `  Balance: ${balance >= 0 ? "+" : ""}${Math.round(balance)}₪ · Épargne: ${savingsRate}%\n`;

    // Health
    msg += `\n🏋️ *SANTE:* ${weight}kg · ${workoutCount}/5 workouts · ${Math.round(studyMinutes / 60)}h étude\n`;

    // Goals — Intelligence-driven
    if (rankedGoals.length > 0) {
      const topGoals = rankedGoals.slice(0, 3);
      msg += `\n🎯 *OBJECTIFS:*\n`;
      for (const g of topGoals) {
        const riskIcon = g.riskLevel === "critical" ? "🔴" : g.riskLevel === "danger" ? "🟠" : g.riskLevel === "watch" ? "🟡" : "🟢";
        const domEmoji = g.domain === "career" ? "💼" : g.domain === "health" ? "🏋️" : g.domain === "higrow" ? "🚀" : g.domain === "finance" ? "💰" : "🎯";
        msg += `  ${domEmoji} ${g.title}: ${g.progressPct}% ${riskIcon}`;
        if (g.daysLeft < 999) msg += ` · J-${g.daysLeft}`;
        if (g.gap > 0) msg += ` (-${g.gap}%)`;
        msg += `\n`;
      }
    }

    await sendTelegramMessage(chatId, msg, "Markdown", {
      inline_keyboard: [
        [{ text: "💼 Carrière", callback_data: "menu_jobs" }, { text: "🚀 HiGrow", callback_data: "menu_leads" }, { text: "💰 Budget", callback_data: "menu_budget" }],
        [{ text: "📋 Tasks", callback_data: "menu_tasks" }, { text: "🏋️ Santé", callback_data: "menu_health" }, { text: "🎯 Goals", callback_data: "menu_goals" }],
        [{ text: "🔄 Rafraîchir", callback_data: "dashboard" }, { text: "📌 Menu", callback_data: "menu_main" }],
      ],
    });
  } catch (e) {
    console.error("Dashboard error:", e);
    await sendTelegramMessage(chatId, "❌ Erreur dashboard. Réessaie.", "Markdown");
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
  params: { "title": "texte", "priority": 1-5, "due_date": "YYYY-MM-DD", "due_time": "HH:MM", "context": "work|home|errands|health|learning", "energy": "high|medium|low" }
  Priorité: 1=critique, 2=urgent, 3=normal, 4=faible, 5=un jour
  Context: déduis selon le sujet (boulot=work, maison=home, courses=errands, sport=health, étude=learning)
  Energy: tâches intellectuelles/créatives=high, admin/routine=medium, simple/mécanique=low

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

quick_capture - Capturer une idée/rappel rapide dans l'inbox (sans date ni priorité)
  params: { "title": "texte" }
  UTILISE CECI quand l'utilisateur donne une note brève, un rappel vague, ou dit "note", "rappelle-moi", "faut que je..."
  Exemples: "faut que j'appelle le dentiste", "penser à acheter du café", "rappelle-moi de répondre à David"

add_recurring_task - Créer une tâche récurrente
  params: { "title": "texte", "rule": "daily|weekdays|weekly:0-6|monthly", "time": "HH:MM", "duration": number }
  UTILISE CECI quand l'utilisateur dit "tous les jours", "chaque lundi", "chaque semaine"
  Exemples: "sport tous les lundis à 17h", "réviser l'anglais chaque jour 30min"

start_pomodoro - Démarrer une session pomodoro (25 min focus)
  params: { "task_search": "mot-clé optionnel" }
  UTILISE CECI quand l'utilisateur dit "pomodoro", "focus", "timer", "25 minutes"
  Exemples: "pomodoro sur le rapport", "lance un focus", "25 min sur l'anglais"

show_velocity - Voir les stats de productivité / vélocité
  params: {}
  UTILISE CECI quand l'utilisateur demande ses stats, productivité, combien de tâches, rythme
  Exemples: "mes stats", "combien de tâches cette semaine", "ma productivité"

show_sprint - Voir les objectifs sprint de la semaine
  params: {}
  UTILISE CECI quand l'utilisateur parle d'objectifs de la semaine, sprint, weekly goals

plan_tomorrow - Planifier demain (plan du soir)
  params: {}
  UTILISE CECI quand l'utilisateur dit "planifie demain", "qu'est-ce que j'ai demain", "plan de demain"

show_timeblock - Proposer un time blocking automatique
  params: {}
  UTILISE CECI quand l'utilisateur dit "organise ma journée", "time block", "planifie mes tâches"

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

// Cache AI context to avoid 5+ DB queries per natural language message
let _aiContextCache: { text: string; ts: number } | null = null;
const AI_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAIContext(): Promise<string> {
  const now2 = Date.now();
  if (_aiContextCache && (now2 - _aiContextCache.ts) < AI_CONTEXT_TTL_MS) {
    return _aiContextCache.text;
  }
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

  _aiContextCache = { text: ctx, ts: Date.now() };
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
        // Don't auto-assign context — ask the user instead
        if (params.energy) taskData.energy_level = params.energy;
        const { data: inserted, error } = await supabase.from("tasks").insert(taskData).select("id").single();
        if (error) throw error;
        const taskId = inserted.id;

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

        const taskTitle = params.title || text;
        await sendTelegramMessage(chatId, `${reply || `✅ Tâche ajoutée: ${taskTitle}`}${calSync}\n\n🏷 Quel contexte ?`, "Markdown", {
          inline_keyboard: [
            TASK_CONTEXTS.map(c => ({ text: `${CONTEXT_EMOJI[c]} ${c}`, callback_data: `task_setctx_${taskId}_${c}` })),
            [{ text: "⏭ Pas de contexte", callback_data: `task_setctx_${taskId}_none` }],
          ],
        });
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
        await handleMorningBriefing(chatId);
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

      // === TASK MANAGEMENT V2 NL INTENTS ===
      case "quick_capture": {
        const title = params?.title || text.substring(0, 100);
        await handleInboxCapture(chatId, title);
        break;
      }

      case "add_recurring_task": {
        const recArgs: string[] = [];
        if (params?.title) recArgs.push(`"${params.title}"`);
        if (params?.rule) recArgs.push(params.rule);
        if (params?.time) recArgs.push(params.time);
        if (params?.duration) recArgs.push(String(params.duration));
        if (recArgs.length >= 2) {
          await handleRecurringAdd(chatId, recArgs);
        } else {
          await sendTelegramMessage(chatId, reply || "Précise le titre et la fréquence.");
        }
        break;
      }

      case "start_pomodoro": {
        const pomArgs = params?.task_search ? [params.task_search] : [];
        await handlePomodoro(chatId, pomArgs);
        break;
      }

      case "show_velocity":
        await handleVelocity(chatId);
        break;

      case "show_sprint":
        await handleSprintGoals(chatId);
        break;

      case "plan_tomorrow":
        await handleTomorrowPlan(chatId);
        break;

      case "show_timeblock":
        await handleTimeBlock(chatId);
        break;

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

  // NL fallback for V2 features
  if (lowerText.match(/^(rappelle|penser|faut que|note|pas oublier)/)) {
    await handleInboxCapture(chatId, text);
    return;
  }

  if (lowerText.includes("pomodoro") || lowerText.includes("focus") || lowerText.includes("timer")) {
    await handlePomodoro(chatId, []);
    return;
  }

  if (lowerText.includes("demain") && (lowerText.includes("plan") || lowerText.includes("prévois"))) {
    await handleTomorrowPlan(chatId);
    return;
  }

  if (lowerText.includes("vélocité") || lowerText.includes("productivité") || lowerText.includes("stats tâches")) {
    await handleVelocity(chatId);
    return;
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

  const visionPrompt = `Tu es OREN, assistant personnel. Analyse cette image avec précision et réponds en JSON.

FORMAT DE RÉPONSE:
{
  "type": "receipt|bank_statement|document|screenshot|other",
  "intent": "add_expenses|add_expense|add_task|add_job|chat",
  "items": [
    { "amount": number, "category": "string", "description": "string", "payment_method": "card|cash" }
  ],
  "params": { ... },
  "reply": "description courte en français"
}

INSTRUCTIONS:
- Si c'est un relevé bancaire, ticket, liste de dépenses ou capture d'écran de transactions:
  → intent = "add_expenses"
  → Extrais CHAQUE dépense/transaction individuellement dans "items"
  → Lis ATTENTIVEMENT chaque montant, ne les invente pas
  → Catégories: restaurant, transport, shopping, health, entertainment, utilities, groceries, subscriptions, autre
  → Inclus la description/marchand de chaque ligne
  → Ne fusionne PAS les lignes entre elles, garde chaque transaction séparée

- Si c'est un seul ticket/reçu simple avec un seul montant:
  → intent = "add_expense"
  → Mets les infos dans "params": { "amount", "category", "description", "payment_method" }

- Si c'est une offre d'emploi: intent = "add_job", params: { title, company, url }
- Si c'est autre chose: intent = "chat", reply = description
${caption ? `\nMessage de l'utilisateur: "${caption}"` : ""}

CONTEXTE: ${context}
Réponds UNIQUEMENT en JSON valide. Sois PRÉCIS sur les montants.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: visionPrompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
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
      case "add_expenses": {
        // Multiple expenses from bank statement / receipt list
        const items = result.items || [];
        if (items.length === 0) {
          await sendTelegramMessage(chatId, result.reply || "Aucune dépense détectée sur l'image.");
          break;
        }
        const supabase = getSupabaseClient();
        const rows = items.map((item: { amount: number; category?: string; description?: string; payment_method?: string }) => ({
          transaction_type: "expense",
          amount: item.amount,
          category: item.category || "autre",
          description: item.description || "Depuis photo",
          payment_method: item.payment_method || "card",
          transaction_date: todayStr(),
        }));
        const { error } = await supabase.from("finance_logs").insert(rows);
        if (error) throw error;

        const total = items.reduce((sum: number, item: { amount: number }) => sum + item.amount, 0);
        const lines = items.map((item: { amount: number; category?: string; description?: string }, i: number) =>
          `${i + 1}. *${item.amount}₪* · ${item.category || "autre"}${item.description ? " — " + item.description : ""}`
        );
        await sendTelegramMessage(chatId,
          `📸✅ *${items.length} dépenses* extraites et enregistrées:\n\n${lines.join("\n")}\n\n💰 Total: *${total}₪*`);
        break;
      }

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
    } else if (command === "/morning" || command === "/bonjour") {
      await handleMorningBriefing(chatId);
    } else if (command === "/dashboard" || command === "/d") {
      await handleDashboard(chatId);
    } else if (command === "/review") {
      await handleReview(chatId);
    } else if (command === "/insights") {
      await handleInsights(chatId);
    } else if (command === "/goals") {
      await handleGoals(chatId);
    } else if (command === "/goal") {
      // /goal update <domain> <value> — Quick metric update
      if (args[0] === "update" && args[1] && args[2]) {
        const domain = args[1].toLowerCase();
        const newValue = parseFloat(args[2]);
        if (isNaN(newValue)) {
          await sendTelegramMessage(chatId, "Format: /goal update <domaine> <valeur>\nEx: /goal update health 72.5");
        } else {
          try {
            const supabase = getSupabaseClient();
            const { data: goal } = await supabase.from("goals")
              .select("id, title, metric_current, metric_unit")
              .eq("domain", domain).eq("status", "active").limit(1).single();
            if (goal) {
              const oldValue = Number(goal.metric_current) || 0;
              await supabase.from("goals").update({ metric_current: newValue }).eq("id", goal.id);
              await sendTelegramMessage(chatId, `✅ ${goal.title}: ${oldValue} → ${newValue}${goal.metric_unit || ""}`);
            } else {
              await sendTelegramMessage(chatId, `Aucun objectif actif pour "${domain}"`);
            }
          } catch (e) { await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 50)}`); }
        }
      } else {
        await sendTelegramMessage(chatId, "Usage:\n/goals — Voir les objectifs\n/goal update <domaine> <valeur>\nEx: /goal update career 45\nEx: /goal update health 72.5");
      }
    } else if (command === "/focus") {
      await handleFocus(chatId, args);
    } else if (command === "/cleanup") {
      await handleCleanup(chatId);
    }
    // === TASK MANAGEMENT V2 COMMANDS ===
    else if (command === "/inbox") {
      await handleInbox(chatId);
    } else if (command === "/pomodoro" || command === "/pomo") {
      await handlePomodoro(chatId, args);
    } else if (command === "/velocity" || command === "/vel") {
      await handleVelocity(chatId);
    } else if (command === "/repeat" || command === "/recurring") {
      if (args.length === 0) await handleRecurringList(chatId);
      else await handleRecurringAdd(chatId, args);
    } else if (command === "/sprint") {
      if (args.length === 0) await handleSprintGoals(chatId);
      else await handleSprintCreate(chatId, args);
    } else if (command === "/timeblock" || command === "/tb") {
      await handleTimeBlock(chatId);
    } else if (command === "/tomorrow" || command === "/demain") {
      await handleTomorrowPlan(chatId);
    } else if (command === "/subtask" || command === "/sub") {
      // /subtask parentId titre
      if (args.length >= 2) {
        const parentRef = args[0];
        const subTitle = args.slice(1).join(" ");
        // Find parent by short ID prefix
        const supabase = getSupabaseClient();
        const { data: parents } = await supabase.from("tasks")
          .select("id").in("status", ["pending", "in_progress"])
          .order("created_at", { ascending: false }).limit(20);
        const parent = (parents || []).find((p: any) => p.id.startsWith(parentRef));
        if (parent) await handleSubtaskAdd(chatId, parent.id, subTitle);
        else await sendTelegramMessage(chatId, `Tâche parent "${parentRef}" introuvable.`);
      } else {
        await sendTelegramMessage(chatId, "Format: /subtask id_parent titre\nEx: /subtask abc123 Préparer le CV");
      }
    } else if (command === "/context" || command === "/ctx") {
      if (args.length > 0 && TASK_CONTEXTS.includes(args[0] as any)) {
        await handleTasksByContext(chatId, args[0]);
      } else {
        await sendTelegramMessage(chatId, `Contextes: ${TASK_CONTEXTS.map(c => `${CONTEXT_EMOJI[c]} ${c}`).join(', ')}\nEx: /ctx work`);
      }
    } else if (command === "/rock" || command === "/rocks") {
      await handleRock(chatId, args);
    } else if (command === "/scorecard" || command === "/sc") {
      await handleScorecard(chatId);
    } else if (command === "/cir" || command === "/cirs") {
      await handleCIR(chatId, args);
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
    try {
      await sendTelegramMessage(chatId, `Erreur: ${String(e).substring(0, 200)}`, 'HTML');
    } catch { /* ignore send error */ }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
