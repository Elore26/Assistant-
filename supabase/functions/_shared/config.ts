// ============================================
// OREN AGENT SYSTEM — Shared Configuration
// All hardcoded values centralized here
// Environment variables override defaults
// ============================================

// --- Locations ---
export const LOCATIONS = {
  home: Deno.env.get("USER_HOME_ADDRESS") || "114 Marc Shagal, Ashdod, Israel",
  stationAshdod: "Ashdod Ad Halom Railway Station, Israel",
  stationTLV: "Tel Aviv HaShalom Railway Station, Israel",
  office: "Shaul Hamelech Street, Tel Aviv, Israel",
  limeBufferMin: 10,
};

// --- Domain Emojis (used across all agents) ---
export const DOMAIN_EMOJIS: Record<string, string> = {
  career: "💼", finance: "💰", health: "🏋️", higrow: "🚀",
  trading: "📈", learning: "📚", personal: "🏠",
  work: "💼", home: "🏠", errands: "🛒",
};

// --- Work Schedule ---
export interface WorkSchedule {
  type: string;
  workStart: string;
  workEnd: string;
  label: string;
}

export const WORK_SCHEDULE: Record<number, WorkSchedule> = {
  0: { type: "long", workStart: "09:30", workEnd: "19:30", label: "Journée longue" },
  1: { type: "court", workStart: "09:30", workEnd: "15:30", label: "Journée courte" },
  2: { type: "court", workStart: "09:30", workEnd: "15:30", label: "Journée courte" },
  3: { type: "court", workStart: "09:30", workEnd: "15:30", label: "Journée courte" },
  4: { type: "tardif", workStart: "12:00", workEnd: "19:30", label: "Journée tardive" },
  5: { type: "variable", workStart: "-", workEnd: "-", label: "Variable" },
  6: { type: "off", workStart: "-", workEnd: "-", label: "OFF" },
};

// --- Workout Schedule ---
export const WORKOUT_SCHEDULE: Record<number, { type: string; time: string; note: string }> = {
  0: { type: "legs", time: "06:30", note: "Avant le travail (journée longue)" },
  1: { type: "push", time: "17:00", note: "Après le travail (journée courte)" },
  2: { type: "pull", time: "17:00", note: "Après le travail (journée courte)" },
  3: { type: "legs", time: "17:00", note: "Après le travail (journée courte)" },
  4: { type: "cardio", time: "07:00", note: "Matin avant travail tardif" },
  5: { type: "push", time: "09:00", note: "Matinée (vendredi variable)" },
  6: { type: "rest", time: "10:00", note: "Shabbat — repos actif seulement" },
};

// --- Tomorrow Schedule Labels (evening-review) ---
export const TOMORROW_SCHEDULE: Record<number, string> = {
  0: "Dimanche — Journée longue (09:30-19:30) · Legs 06:30",
  1: "Lundi — Journée courte (09:30-15:30) · Push 17:00",
  2: "Mardi — Journée courte (09:30-15:30) · Pull 17:00",
  3: "Mercredi — Journée courte (09:30-15:30) · Legs 17:00",
  4: "Jeudi — Journée tardive (12:00-19:30) · Cardio 07:00",
  5: "Vendredi — Variable · Push 09:00",
  6: "Samedi — OFF · Repos actif",
};

// --- Fail Reason Labels ---
export const FAIL_REASON_LABELS: Record<string, string> = {
  blocked: "Bloqué", forgot: "Oublié", toobig: "Trop gros",
  energy: "Énergie", skip: "Pas prioritaire",
};

// --- Scorecard Defaults (goals) ---
export const SCORECARD_GOALS = {
  weeklyApps: 5,
  weeklyInterviews: 1,
  weeklyLeads: 10,
  weeklyClients: 2,
  completionRate: 80,
  weeklyWorkouts: 5,
  weeklyStudyHours: 5,
  savingsRate: 20,
  targetWeight: 70,
  dailyScore: 8,
};

// --- Agent Names (for dedup in agent_executions) ---
export const AGENT_NAMES = {
  morningBriefing: "morning-briefing",
  eveningReview: "evening-review",
  dailyBrain: "daily-brain",
  weeklyPlanning: "weekly-planning",
  taskReminder: "task-reminder",
  taskReminderIdle: "task-reminder-idle",
  taskReminderCareer: "task-reminder-career",
  taskReminderPreview: "task-reminder-preview",
  taskReminderCir: "task-reminder-cir",
  taskReminderRock: "task-reminder-rock",
  careerAgent: "career-agent",
  healthAgent: "health-agent",
  learningAgent: "learning-agent",
};
