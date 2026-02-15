// ============================================
// OREN AGENT SYSTEM — Health Agent V2
// Coach complet: Programme PPL, Nutrition, Jeûne, Auto-planning
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";

// --- Types ---
interface WorkoutExercise { name: string; sets: number; reps: string; rest: string; }
interface WorkoutProgram { type: string; title: string; duration: number; exercises: WorkoutExercise[]; warmup: string; cooldown: string; }
interface MealPlan { meal: string; time: string; foods: string; calories: number; protein: number; }
interface DayHealthPlan { workout: WorkoutProgram | null; meals: MealPlan[]; fasting: { start: string; end: string; eating_window: string }; water_target: number; steps_target: number; supplements: string[]; }

// --- Timezone ---
function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}
function todayStr(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- OpenAI ---
async function callOpenAI(systemPrompt: string, userContent: string, maxTokens = 800): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return "";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0.6, max_tokens: maxTokens,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) { console.error("OpenAI error:", e); return ""; }
}

// --- Telegram ---
async function sendTelegram(text: string): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";
  if (!token) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return r.ok;
  } catch (e) { console.error("TG error:", e); return false; }
}

// ============================================
// PROGRAMMES D'ENTRAÎNEMENT COMPLETS
// ============================================

const WORKOUT_PROGRAMS: Record<string, WorkoutProgram> = {
  push: {
    type: "push", title: "💪 PUSH — Pecs, Épaules, Triceps", duration: 60,
    warmup: "5 min rameur ou corde + rotations épaules + 2x15 pompes",
    cooldown: "Étirements pecs, épaules, triceps — 5 min",
    exercises: [
      { name: "Développé couché (barre)", sets: 4, reps: "8-10", rest: "2 min" },
      { name: "Développé incliné (haltères)", sets: 3, reps: "10-12", rest: "90 sec" },
      { name: "Dips lestés", sets: 3, reps: "8-10", rest: "90 sec" },
      { name: "Écartés câbles (poulie haute)", sets: 3, reps: "12-15", rest: "60 sec" },
      { name: "Élévations latérales", sets: 4, reps: "15", rest: "60 sec" },
      { name: "Pushdown triceps (corde)", sets: 3, reps: "12-15", rest: "60 sec" },
      { name: "Extensions overhead triceps", sets: 3, reps: "12", rest: "60 sec" },
    ],
  },
  pull: {
    type: "pull", title: "🏋️ PULL — Dos, Biceps, Arrière épaules", duration: 60,
    warmup: "5 min rameur + bande élastique tirage face + 2x10 scap pulls",
    cooldown: "Étirements dos, biceps, avant-bras — 5 min",
    exercises: [
      { name: "Soulevé de terre (conv.)", sets: 4, reps: "5-6", rest: "3 min" },
      { name: "Rowing barre", sets: 4, reps: "8-10", rest: "2 min" },
      { name: "Tractions (prise large)", sets: 3, reps: "6-10", rest: "2 min" },
      { name: "Rowing câble assis", sets: 3, reps: "10-12", rest: "90 sec" },
      { name: "Face pulls", sets: 4, reps: "15-20", rest: "60 sec" },
      { name: "Curl barre EZ", sets: 3, reps: "10-12", rest: "60 sec" },
      { name: "Curl marteau haltères", sets: 3, reps: "12", rest: "60 sec" },
    ],
  },
  legs: {
    type: "legs", title: "🦵 LEGS — Quadri, Ischios, Mollets", duration: 65,
    warmup: "5 min vélo + squats corps + fentes dynamiques",
    cooldown: "Étirements quadriceps, ischios, hanches, mollets — 5 min",
    exercises: [
      { name: "Squat barre (back squat)", sets: 4, reps: "6-8", rest: "3 min" },
      { name: "Presse à cuisses", sets: 3, reps: "10-12", rest: "2 min" },
      { name: "Soulevé de terre roumain", sets: 3, reps: "10-12", rest: "2 min" },
      { name: "Leg curl allongé", sets: 3, reps: "12-15", rest: "60 sec" },
      { name: "Leg extension", sets: 3, reps: "12-15", rest: "60 sec" },
      { name: "Fentes bulgares", sets: 3, reps: "10/jambe", rest: "90 sec" },
      { name: "Mollets debout (machine)", sets: 4, reps: "15-20", rest: "60 sec" },
    ],
  },
  cardio: {
    type: "cardio", title: "🫁 CARDIO + MOBILITÉ", duration: 45,
    warmup: "3 min marche rapide",
    cooldown: "Retour au calme 3 min + stretching complet 10 min",
    exercises: [
      { name: "Tapis de course (interval)", sets: 1, reps: "25 min (1min sprint / 2min marche)", rest: "-" },
      { name: "Rameur (steady state)", sets: 1, reps: "10 min", rest: "-" },
      { name: "Foam rolling (dos, jambes)", sets: 1, reps: "5 min", rest: "-" },
      { name: "Stretching dynamique hanches", sets: 2, reps: "10/côté", rest: "30 sec" },
      { name: "Planche (isométrique)", sets: 3, reps: "45 sec", rest: "30 sec" },
      { name: "Dead hang (barre)", sets: 3, reps: "30 sec", rest: "30 sec" },
    ],
  },
  rest: {
    type: "rest", title: "😴 REPOS ACTIF", duration: 20,
    warmup: "Aucun",
    cooldown: "Respiration profonde 5 min",
    exercises: [
      { name: "Marche en extérieur", sets: 1, reps: "20-30 min", rest: "-" },
      { name: "Stretching complet", sets: 1, reps: "15 min", rest: "-" },
      { name: "Foam rolling", sets: 1, reps: "10 min", rest: "-" },
    ],
  },
};

// Planning semaine aligné sur l'emploi du temps d'Oren
// Dim=0, Lun=1, Mar=2, Mer=3, Jeu=4, Ven=5, Sam=6
const WEEKLY_WORKOUT_SCHEDULE: Record<number, { type: string; time: string; note: string }> = {
  0: { type: "legs",   time: "06:30", note: "Avant le travail (journée longue)" },
  1: { type: "push",   time: "17:00", note: "Après le travail (journée courte)" },
  2: { type: "pull",   time: "17:00", note: "Après le travail (journée courte)" },
  3: { type: "legs",   time: "17:00", note: "Après le travail (journée courte)" },
  4: { type: "cardio", time: "07:00", note: "Matin avant travail tardif" },
  5: { type: "push",   time: "09:00", note: "Matinée (vendredi variable)" },
  6: { type: "rest",   time: "10:00", note: "Shabbat — repos actif seulement" },
};

// ============================================
// PLAN NUTRITIONNEL — Recomposition corporelle
// Objectif: Muscle gain + Fat loss
// Jeûne intermittent 16:8 (fenêtre 12h-20h)
// ============================================

const NUTRITION_PLAN: Record<string, MealPlan[]> = {
  training: [
    { meal: "☕ Pré-fenêtre", time: "07:00", foods: "Café noir + eau citronnée (JEÛNE)", calories: 5, protein: 0 },
    { meal: "🍳 Repas 1 (Break fast)", time: "12:00", foods: "4 œufs brouillés + avocat + 2 tranches pain complet + tomate", calories: 620, protein: 35 },
    { meal: "🍗 Repas 2 (Pré-workout)", time: "15:30", foods: "200g poulet grillé + 150g riz basmati + légumes sautés + huile d'olive", calories: 650, protein: 50 },
    { meal: "🥤 Post-workout", time: "18:30", foods: "Whey protein (30g) + banane + 30g flocons d'avoine dans eau", calories: 350, protein: 35 },
    { meal: "🥗 Repas 3 (Dîner)", time: "19:30", foods: "200g saumon/thon + salade verte + quinoa + houmous", calories: 580, protein: 45 },
  ],
  rest: [
    { meal: "☕ Pré-fenêtre", time: "07:00", foods: "Café noir + eau citronnée (JEÛNE)", calories: 5, protein: 0 },
    { meal: "🍳 Repas 1", time: "12:00", foods: "Omelette 3 œufs + fromage blanc + fruits rouges + noix", calories: 550, protein: 35 },
    { meal: "🍗 Repas 2", time: "16:00", foods: "Salade composée: thon + œuf + avocat + légumes + pain complet", calories: 580, protein: 40 },
    { meal: "🥗 Repas 3", time: "19:30", foods: "150g viande maigre + patate douce + brocoli + huile d'olive", calories: 520, protein: 40 },
  ],
};

const DAILY_SUPPLEMENTS = ["Whey Protein (30g post-workout)", "Créatine (5g/jour)", "Omega-3 (2g)", "Vitamine D (2000 UI)", "Magnésium (400mg le soir)"];

// ============================================
// FONCTIONS PRINCIPALES
// ============================================

function getTodayHealthPlan(): DayHealthPlan {
  const dayOfWeek = getIsraelNow().getDay();
  const scheduleEntry = WEEKLY_WORKOUT_SCHEDULE[dayOfWeek];
  const workoutType = scheduleEntry.type;
  const workout = WORKOUT_PROGRAMS[workoutType] || null;
  const isTraining = workoutType !== "rest";
  const meals = isTraining ? NUTRITION_PLAN.training : NUTRITION_PLAN.rest;

  return {
    workout,
    meals,
    fasting: { start: "20:00", end: "12:00", eating_window: "12:00 — 20:00" },
    water_target: isTraining ? 3 : 2.5,
    steps_target: isTraining ? 8000 : 10000,
    supplements: DAILY_SUPPLEMENTS,
  };
}

function formatWorkoutMessage(plan: DayHealthPlan, scheduleEntry: { time: string; note: string }): string {
  let msg = `<b>🏋️ COACH SANTÉ — ${todayStr()}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (plan.workout) {
    msg += `<b>${plan.workout.title}</b>\n`;
    msg += `⏰ ${scheduleEntry.time} · ${plan.workout.duration} min · ${scheduleEntry.note}\n\n`;

    msg += `<b>Échauffement:</b> ${plan.workout.warmup}\n\n`;
    msg += `<b>Programme:</b>\n`;
    plan.workout.exercises.forEach((ex, i) => {
      msg += `${i + 1}. <b>${ex.name}</b> — ${ex.sets}×${ex.reps} (repos ${ex.rest})\n`;
    });
    msg += `\n<b>Retour au calme:</b> ${plan.workout.cooldown}\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<b>🍽 NUTRITION (Jeûne 16:8)</b>\n`;
  msg += `Fenêtre: ${plan.fasting.eating_window}\n\n`;

  let totalCal = 0, totalProt = 0;
  plan.meals.forEach(m => {
    msg += `<b>${m.meal}</b> (${m.time})\n${m.foods}\n${m.calories} kcal · ${m.protein}g protéines\n\n`;
    totalCal += m.calories;
    totalProt += m.protein;
  });
  msg += `<b>Total:</b> ~${totalCal} kcal · ${totalProt}g protéines\n`;

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<b>💊 Suppléments:</b> ${plan.supplements.join(", ")}\n`;
  msg += `<b>💧 Eau:</b> ${plan.water_target}L minimum\n`;
  msg += `<b>👟 Pas:</b> ${plan.steps_target} pas\n`;

  return msg;
}

// ============================================
// AUTO-CRÉATION DE TÂCHES DANS LE PLANNING
// ============================================

async function createHealthTasks(supabase: any, plan: DayHealthPlan, scheduleEntry: { time: string; note: string }): Promise<number> {
  const today = todayStr();
  let created = 0;

  // Check if health tasks already created today
  const { data: existing } = await supabase
    .from("tasks")
    .select("id")
    .eq("due_date", today)
    .eq("agent_type", "health")
    .limit(1);

  if (existing && existing.length > 0) {
    console.log("Health tasks already created for today");
    return 0;
  }

  const tasks: Array<{ title: string; due_time: string; duration: number; priority: number }> = [];

  // Workout task
  if (plan.workout && plan.workout.type !== "rest") {
    tasks.push({
      title: `${plan.workout.title}`,
      due_time: scheduleEntry.time,
      duration: plan.workout.duration,
      priority: 2,
    });
  } else if (plan.workout?.type === "rest") {
    tasks.push({
      title: `😴 Repos actif: marche + stretching`,
      due_time: scheduleEntry.time,
      duration: 30,
      priority: 4,
    });
  }

  // Meal prep reminders
  tasks.push({
    title: `🍳 Préparer repas 1 (break fast)`,
    due_time: "11:45",
    duration: 15,
    priority: 3,
  });

  // Weigh-in (morning before eating)
  tasks.push({
    title: `⚖️ Pesée matinale (avant manger)`,
    due_time: "07:30",
    duration: 2,
    priority: 3,
  });

  // Water tracking reminder
  tasks.push({
    title: `💧 Boire ${plan.water_target}L d'eau aujourd'hui`,
    due_time: "08:00",
    duration: 0,
    priority: 4,
  });

  // Supplements
  tasks.push({
    title: `💊 Créatine 5g + Omega-3 + Vit D`,
    due_time: "12:15",
    duration: 2,
    priority: 4,
  });

  // Insert all tasks
  for (const task of tasks) {
    try {
      const { error } = await supabase.from("tasks").insert({
        title: task.title,
        status: "pending",
        priority: task.priority,
        agent_type: "health",
        due_date: today,
        due_time: task.due_time,
        duration_minutes: task.duration,
        created_at: new Date().toISOString(),
      });
      if (!error) created++;
    } catch (e) { console.error("Task insert error:", e); }
  }

  return created;
}

// ============================================
// AI COACHING PERSONNALISÉ
// ============================================

async function getAICoachAdvice(supabase: any, plan: DayHealthPlan): Promise<string> {
  // Fetch recent data for context
  const today = todayStr();
  const weekAgo = new Date(getIsraelNow().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const [weightsRes, workoutsRes, goalsRes] = await Promise.all([
    supabase.from("health_logs").select("value, log_date").eq("log_type", "weight").order("log_date", { ascending: false }).limit(7),
    supabase.from("health_logs").select("workout_type, duration_minutes, log_date").eq("log_type", "workout").gte("log_date", weekAgo).order("log_date", { ascending: false }),
    supabase.from("goals").select("title, metric_current, metric_target, metric_unit, deadline, daily_actions").eq("domain", "health").eq("status", "active").limit(1),
  ]);

  const weights = weightsRes.data || [];
  const workouts = workoutsRes.data || [];
  const goal = goalsRes.data?.[0] || null;

  let context = `DONNÉES SANTÉ D'OREN:\n`;
  if (weights.length > 0) {
    context += `Poids actuel: ${weights[0].value}kg\n`;
    if (weights.length > 1) context += `Poids il y a 7 jours: ${weights[weights.length - 1].value}kg\n`;
  }
  context += `Workouts cette semaine: ${workouts.length}\n`;
  workouts.forEach(w => { context += `  - ${w.workout_type} ${w.duration_minutes}min (${w.log_date})\n`; });

  if (goal) {
    context += `\nOBJECTIF: ${goal.title}\n`;
    context += `Cible: ${goal.metric_target}${goal.metric_unit}\n`;
    context += `Deadline: ${goal.deadline}\n`;
  }

  context += `\nPLAN DU JOUR: ${plan.workout?.title || "Repos"}\n`;
  context += `Nutrition: Jeûne 16:8, fenêtre ${plan.fasting.eating_window}\n`;

  const advice = await callOpenAI(
    `Tu es le coach santé personnel d'Oren. Profil: homme, ~75kg, objectif recomposition (muscle + perte de gras → 70kg).
Programme: PPL 5x/semaine + jeûne intermittent 16:8.
Donne un conseil UNIQUE et ACTIONNABLE pour aujourd'hui en 3-4 lignes max.
Adapte le conseil au programme du jour et aux données récentes.
Si les workouts manquent → motive. Si poids stagne → ajuste nutrition. Si bonne progression → félicite.
Français, direct, coach sportif motivant. Emojis ok.`,
    context,
    250
  );

  return advice;
}

// ============================================
// WEEKLY REVIEW COMPLÈTE
// ============================================

async function weeklyHealthReview(supabase: any): Promise<string> {
  const today = todayStr();
  const weekAgo = new Date(getIsraelNow().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const [weightsRes, workoutsRes, goalsRes] = await Promise.all([
    supabase.from("health_logs").select("value, log_date").eq("log_type", "weight").gte("log_date", weekAgo).order("log_date"),
    supabase.from("health_logs").select("workout_type, duration_minutes, log_date").eq("log_type", "workout").gte("log_date", weekAgo),
    supabase.from("goals").select("*").eq("domain", "health").eq("status", "active").limit(1),
  ]);

  const weights = weightsRes.data || [];
  const workouts = workoutsRes.data || [];
  const goal = goalsRes.data?.[0] || null;

  let msg = `<b>📊 BILAN SANTÉ HEBDO</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Workouts summary
  const totalWorkouts = workouts.length;
  const totalMinutes = workouts.reduce((s: number, w: any) => s + (w.duration_minutes || 0), 0);
  const byType: Record<string, number> = {};
  workouts.forEach((w: any) => { byType[w.workout_type] = (byType[w.workout_type] || 0) + 1; });

  msg += `<b>💪 Entraînements:</b> ${totalWorkouts}/5 sessions · ${totalMinutes} min\n`;
  Object.entries(byType).forEach(([type, count]) => { msg += `  ${type}: ${count}x\n`; });
  msg += totalWorkouts >= 4 ? `✅ Bonne régularité!\n\n` : `⚠️ ${5 - totalWorkouts} sessions manquées\n\n`;

  // Weight evolution
  if (weights.length >= 2) {
    const first = weights[0].value;
    const last = weights[weights.length - 1].value;
    const diff = (last - first).toFixed(1);
    msg += `<b>⚖️ Poids:</b> ${first}kg → ${last}kg (${parseFloat(diff) > 0 ? '+' : ''}${diff}kg)\n`;
    if (goal) {
      const remaining = (last - goal.metric_target).toFixed(1);
      const daysLeft = Math.ceil((new Date(goal.deadline).getTime() - getIsraelNow().getTime()) / (1000 * 60 * 60 * 24));
      msg += `Objectif: ${goal.metric_target}kg · Reste: ${remaining}kg · J-${daysLeft}\n`;
    }
  } else if (weights.length === 1) {
    msg += `<b>⚖️ Poids:</b> ${weights[0].value}kg (1 seule pesée cette semaine)\n`;
  } else {
    msg += `<b>⚖️ Poids:</b> Aucune pesée cette semaine ⚠️\n`;
  }

  // AI Weekly Analysis
  const aiContext = `Semaine: ${totalWorkouts}/5 workouts, ${totalMinutes} min total. Types: ${JSON.stringify(byType)}. Poids: ${weights.map((w: any) => w.value).join("→")}kg. Objectif: 70kg recomp.`;
  const aiReview = await callOpenAI(
    `Tu es coach santé. Analyse la semaine d'Oren et donne:
1) Score de la semaine /10
2) Point fort de la semaine
3) Axe d'amélioration principal
4) Objectif précis pour la semaine prochaine
5) Ajustement nutrition si nécessaire
Max 6 lignes, français, direct.`,
    aiContext, 350
  );

  if (aiReview) {
    msg += `\n<b>🧠 Analyse IA:</b>\n${aiReview}\n`;
  }

  // Update goal metric_current with latest weight
  if (goal && weights.length > 0) {
    const latestWeight = weights[weights.length - 1].value;
    await supabase.from("goals").update({ metric_current: latestWeight }).eq("id", goal.id);
  }

  return msg;
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseKey);
  const signals = getSignalBus("health");

  try {
    const now = getIsraelNow();
    const dayOfWeek = now.getDay();
    const today = todayStr();
    const todayDate = today;
    const isSunday = dayOfWeek === 0;
    const scheduleEntry = WEEKLY_WORKOUT_SCHEDULE[dayOfWeek];
    const plan = getTodayHealthPlan();

    let responseType = "daily";

    // 1. Create health tasks in planning
    const tasksCreated = await createHealthTasks(supabase, plan, scheduleEntry);
    console.log(`Health tasks created: ${tasksCreated}`);

    // 2. Check if workout was done today
    const { data: todayWorkouts } = await supabase
      .from("health_logs")
      .select("id, workout_type, duration_minutes")
      .eq("log_type", "workout")
      .eq("log_date", today);

    const workoutDone = todayWorkouts && todayWorkouts.length > 0;

    // 3. Build and send daily health message
    let message = formatWorkoutMessage(plan, scheduleEntry);

    // 4. AI Coach advice
    const aiAdvice = await getAICoachAdvice(supabase, plan);
    if (aiAdvice) {
      message += `\n<b>🧠 Coach IA:</b>\n${aiAdvice}\n`;
    }

    // 5. Workout status
    if (workoutDone) {
      const w = todayWorkouts![0];
      message += `\n✅ <b>Workout déjà fait:</b> ${w.workout_type} ${w.duration_minutes}min\n`;
    } else {
      message += `\n⏳ <b>Workout prévu:</b> ${scheduleEntry.time} — ${plan.workout?.title || "Repos"}\n`;
    }

    // --- Inter-Agent Signals ---
    try {
      // Check sleep data and emit low_sleep signal
      const { data: sleepLog } = await supabase.from("health_logs")
        .select("value").eq("log_type", "sleep").eq("log_date", todayDate).limit(1);
      const sleepHours = sleepLog?.[0]?.value || null;
      if (sleepHours !== null && sleepHours < 6) {
        await signals.emit("low_sleep", `Sommeil: ${sleepHours}h (< 6h minimum)`, {
          hours: sleepHours,
        }, { priority: 2, ttlHours: 18 });
      }

      // Check workout completion
      const { data: todayWorkout } = await supabase.from("health_logs")
        .select("id, workout_type, duration_minutes")
        .eq("log_type", "workout").eq("log_date", todayDate).limit(1);
      if (todayWorkout && todayWorkout.length > 0) {
        await signals.emit("workout_completed", `Workout ${todayWorkout[0].workout_type || "done"} (${todayWorkout[0].duration_minutes || 0}min)`, {
          type: todayWorkout[0].workout_type,
          duration: todayWorkout[0].duration_minutes,
        }, { priority: 4, ttlHours: 24 });
      }

      // Check cumulative fatigue (workouts this week)
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const { data: weekWorkouts } = await supabase.from("health_logs")
        .select("duration_minutes").eq("log_type", "workout")
        .gte("log_date", weekAgo);
      const totalMinutes = (weekWorkouts || []).reduce((s: number, w: any) => s + (w.duration_minutes || 0), 0);
      const workoutCount = weekWorkouts?.length || 0;

      if (workoutCount >= 5 || totalMinutes >= 300) {
        await signals.emit("recovery_status", `Fatigue haute: ${workoutCount} workouts / ${totalMinutes}min cette semaine`, {
          workoutCount, totalMinutes, recommendation: "deload",
        }, { priority: 2, ttlHours: 24 });
      }

      // Check if tomorrow has a workout scheduled (streak at risk)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];
      const { data: tomorrowTasks } = await supabase.from("tasks")
        .select("id").eq("agent_type", "health").eq("due_date", tomorrowStr)
        .in("status", ["pending", "in_progress"]).limit(1);

      // Check current streak
      const { data: recentWorkouts } = await supabase.from("health_logs")
        .select("log_date").eq("log_type", "workout")
        .order("log_date", { ascending: false }).limit(14);
      let streak = 0;
      if (recentWorkouts) {
        const checkDate = new Date();
        for (const w of recentWorkouts) {
          const wDate = w.log_date;
          const expected = checkDate.toISOString().split("T")[0];
          if (wDate === expected) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
          else break;
        }
      }

      if (streak >= 3 && (!tomorrowTasks || tomorrowTasks.length === 0)) {
        await signals.emit("streak_at_risk", `Streak workout ${streak}j en danger: rien de prévu demain`, {
          currentStreak: streak, tomorrow: tomorrowStr,
        }, { priority: 2, ttlHours: 18 });
      }
    } catch (sigErr) {
      console.error("[Signals] Health error:", sigErr);
    }

    await sendTelegram(message);

    // 6. Weekly review on Sunday
    let weeklyMsg = "";
    if (isSunday) {
      weeklyMsg = await weeklyHealthReview(supabase);
      await sendTelegram(weeklyMsg);
      responseType = "weekly";
    }

    // 7. Save analysis
    await supabase.from("health_logs").insert({
      log_type: "agent_analysis",
      log_date: today,
      notes: JSON.stringify({ type: responseType, tasks_created: tasksCreated, workout_done: workoutDone }),
    }).then(() => {}).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      type: responseType,
      date: today,
      workout_type: plan.workout?.type,
      workout_done: workoutDone,
      tasks_created: tasksCreated,
      meals: plan.meals.length,
      fasting_window: plan.fasting.eating_window,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Health Agent Error:", e);
    return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500 });
  }
});
