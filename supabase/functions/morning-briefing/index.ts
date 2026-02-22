import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleCalendar, GCAL_COLORS, getGoogleCalendar } from "../_shared/google-calendar.ts";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { robustFetch } from "../_shared/robust-fetch.ts";
import { getIsraelNow, todayStr, daysAgo, DAYS_FR } from "../_shared/timezone.ts";
import { callOpenAI } from "../_shared/openai.ts";
import { sendTG, escHTML } from "../_shared/telegram.ts";
import { rankGoals, analyzeBrainTrend, detectGoalRockMisalignment, generateGoalNudges, buildGoalIntelligenceContext } from "../_shared/goal-engine.ts";
import { predictTasks, formatAtRiskTasks } from "../_shared/intelligence-engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GMAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") || "";

// --- Commute config ---
const HOME = "114 Marc Shagal, Ashdod, Israel";
const STATION_ASHDOD = "Ashdod Ad Halom Railway Station, Israel";
const STATION_TLV = "Tel Aviv HaShalom Railway Station, Israel";
const WORK = "Shaul Hamelech Street, Tel Aviv, Israel";
const LIME_MIN = 10;

// --- Timezone helpers (unique to morning-briefing) ---
function istToUnix(h: number, m: number, daysOffset = 0): number {
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate() + daysOffset;
  const utcH = h - 2;
  const utc = new Date(Date.UTC(utcYear, utcMonth, utcDay, utcH, m, 0));
  return Math.floor(utc.getTime() / 1000);
}

// --- Schedule ---
interface Sched { type: string; ws: string; we: string; label: string; }
function getSched(d: number): Sched {
  const s: Record<number, Sched> = {
    0: { type: "long", ws: "09:30", we: "19:30", label: "Journee longue" },
    1: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    2: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    3: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    4: { type: "tardif", ws: "12:00", we: "19:30", label: "Journee tardive" },
    5: { type: "variable", ws: "-", we: "-", label: "Variable" },
    6: { type: "off", ws: "-", we: "-", label: "OFF" },
  };
  return s[d] || s[0];
}

// =============================================
// WORKOUT PROGRAMS (PPL) — Synced with Health Agent V2
// =============================================
const WORKOUT_PROGRAMS: Record<string, { name: string; duration: number; exercises: string[] }> = {
  push: {
    name: "💪 PUSH — Pecs, Épaules, Triceps",
    duration: 60,
    exercises: [
      "Développé couché 4×8-10",
      "Développé incliné haltères 3×10-12",
      "Dips lestés 3×8-10",
      "Écartés câbles 3×12-15",
      "Élévations latérales 4×15",
      "Pushdown triceps 3×12-15",
      "Extensions overhead triceps 3×12",
    ],
  },
  pull: {
    name: "🏋️ PULL — Dos, Biceps",
    duration: 60,
    exercises: [
      "Soulevé de terre 4×5-6",
      "Rowing barre 4×8-10",
      "Tractions prise large 3×6-10",
      "Rowing câble assis 3×10-12",
      "Face pulls 4×15-20",
      "Curl barre EZ 3×10-12",
      "Curl marteau 3×12",
    ],
  },
  legs: {
    name: "🦵 LEGS — Quadri, Ischios, Mollets",
    duration: 65,
    exercises: [
      "Squat barre 4×6-8",
      "Presse à cuisses 3×10-12",
      "Soulevé de terre roumain 3×10-12",
      "Leg curl allongé 3×12-15",
      "Leg extension 3×12-15",
      "Fentes bulgares 3×10/jambe",
      "Mollets debout 4×15-20",
    ],
  },
  cardio: {
    name: "🫁 CARDIO + MOBILITÉ",
    duration: 45,
    exercises: [
      "Tapis interval 25min (1min sprint/2min marche)",
      "Rameur 10 min",
      "Foam rolling 5 min",
      "Stretching hanches 2×10/côté",
      "Planche 3×45s",
      "Dead hang 3×30s",
    ],
  },
  rest: {
    name: "😴 REPOS ACTIF",
    duration: 30,
    exercises: [
      "Marche extérieur 20-30 min",
      "Stretching complet 15 min",
      "Foam rolling 10 min",
    ],
  },
};

// Day → workout type + time — Synced with Health Agent V2
const WORKOUT_SCHEDULE: Record<number, { type: string; time: string }> = {
  0: { type: "legs",   time: "06:30" },  // Dimanche — avant travail (journée longue)
  1: { type: "push",   time: "17:00" },  // Lundi — après travail (courte)
  2: { type: "pull",   time: "17:00" },  // Mardi — après travail (courte)
  3: { type: "legs",   time: "17:00" },  // Mercredi — après travail (courte)
  4: { type: "cardio", time: "07:00" },  // Jeudi — matin avant travail tardif
  5: { type: "push",   time: "09:00" },  // Vendredi — matinée (variable)
  6: { type: "rest",   time: "10:00" },  // Samedi — repos actif
};
// Backward compat
const WORKOUT_DAY: Record<number, string> = {};
for (const [d, s] of Object.entries(WORKOUT_SCHEDULE)) { WORKOUT_DAY[Number(d)] = s.type === "rest" ? "" : s.type; }

// =============================================
// NUTRITION SUMMARY (Jeûne 16:8) — from Health Agent V2
// =============================================
function getHealthSummary(isTraining: boolean): string {
  const fastWindow = "12:00 — 20:00";
  const cal = isTraining ? "~2200 kcal" : "~1655 kcal";
  const prot = isTraining ? "165g" : "115g";
  return `Jeûne 16:8 · Fenêtre ${fastWindow}\n${cal} · ${prot} protéines · Créatine 5g · Omega-3 · Vit D`;
}

// =============================================
// GOOGLE MAPS API HELPERS (unchanged)
// =============================================
async function getDriveMin(from: string, to: string, departureTs?: number): Promise<number> {
  if (!GMAPS_KEY) return 12;
  try {
    const params: Record<string, string> = { origin: from, destination: to, mode: "driving", key: GMAPS_KEY };
    if (departureTs && departureTs > Math.floor(Date.now() / 1000)) {
      params.departure_time = String(departureTs);
    }
    const p = new URLSearchParams(params);
    const r = await robustFetch(`https://maps.googleapis.com/maps/api/directions/json?${p}`, {
      timeoutMs: 8000,
      retries: 1,
    });
    if (!r.ok) {
      console.error(`Drive API HTTP ${r.status}`);
      return 12;
    }
    const j = await r.json();
    if (j.status === "OK" && j.routes?.length > 0 && j.routes[0].legs?.length > 0) {
      const leg = j.routes[0].legs[0];
      const seconds = leg.duration_in_traffic?.value || leg.duration?.value || 720;
      return Math.ceil(seconds / 60);
    }
    if (j.status !== "OK") {
      console.warn(`Drive API status: ${j.status} — ${j.error_message || ""}`);
    }
  } catch (e) { console.error("Drive API error:", e); }
  return 12;
}

interface TrainInfo { dep: string; arr: string; dur: string; line: string; depTs: number; arrTs: number; }
async function getTrainSchedule(
  fromStation: string, toStation: string, targetISTh: number, targetISTm: number, useDeparture: boolean, daysOffset = 0
): Promise<TrainInfo | null> {
  if (!GMAPS_KEY) return null;
  try {
    const ts = istToUnix(targetISTh, targetISTm, daysOffset);
    const timeParam = useDeparture ? "departure_time" : "arrival_time";
    const p = new URLSearchParams({
      origin: fromStation, destination: toStation, mode: "transit", transit_mode: "rail",
      [timeParam]: String(ts), language: "fr", key: GMAPS_KEY,
    });
    const r = await robustFetch(`https://maps.googleapis.com/maps/api/directions/json?${p}`, {
      timeoutMs: 10000,
      retries: 1,
    });
    if (!r.ok) {
      console.error(`Train API HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    if (j.status !== "OK" || !j.routes?.length) {
      if (j.status !== "OK") {
        console.warn(`Train API status: ${j.status} — ${j.error_message || ""}`);
      }
      return null;
    }
    const leg = j.routes[0]?.legs?.[0];
    if (!leg) return null;

    // Search for TRANSIT step (rail) in the route
    if (leg.steps) {
      for (const step of leg.steps) {
        if (step.travel_mode === "TRANSIT") {
          const td = step.transit_details;
          if (!td) continue;
          return {
            dep: td.departure_time?.text || "", arr: td.arrival_time?.text || "",
            dur: step.duration?.text || "", line: td.line?.short_name || td.line?.name || "",
            depTs: td.departure_time?.value || 0, arrTs: td.arrival_time?.value || 0,
          };
        }
      }
    }

    // Fallback: use the leg-level timing if no TRANSIT step found
    return {
      dep: leg.departure_time?.text || "", arr: leg.arrival_time?.text || "",
      dur: leg.duration?.text || "", line: "Israel Railways",
      depTs: leg.departure_time?.value || 0, arrTs: leg.arrival_time?.value || 0,
    };
  } catch (e) { console.error("Train error:", e); return null; }
}

// =============================================
// sendTG and escHTML imported from _shared/telegram.ts

// =============================================
// TIME HELPERS
// =============================================
function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}
function fromMin(m: number): string {
  if (m < 0) m += 1440;
  if (m >= 1440) m -= 1440;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function addMin(time: string, mins: number): string { return fromMin(toMin(time) + mins); }
function subMin(time: string, mins: number): string { return fromMin(toMin(time) - mins); }

// =============================================
// HOUR-BY-HOUR PLAN BUILDER
// =============================================

interface PlanBlock {
  start: string;  // "HH:MM"
  end: string;
  label: string;
  details?: string[];
}

function buildDayPlan(
  day: number,
  allerDepart: string,
  allerArrive: string,
  retourDepart: string,
  retourArrive: string,
  scheduledTasks: any[],
): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const sched = getSched(day);
  const workout = WORKOUT_DAY[day];
  const program = workout ? WORKOUT_PROGRAMS[workout] : null;

  // === SATURDAY OFF ===
  if (sched.type === "off") {
    blocks.push({ start: "08:00", end: "09:00", label: "Reveil + cafe" });
    blocks.push({ start: "10:00", end: "10:30", label: "😴 Repos actif: marche + stretching", details: ["Marche extérieur 20-30 min", "Stretching complet 15 min"] });
    blocks.push({ start: "10:30", end: "12:00", label: "Temps libre / Famille" });
    blocks.push({ start: "12:00", end: "12:30", label: "🍳 Break fast (fin jeûne)" });
    blocks.push({ start: "12:30", end: "22:00", label: "Jour libre" });
    return blocks;
  }

  // === FRIDAY VARIABLE ===
  if (sched.type === "variable") {
    const ws = WORKOUT_SCHEDULE[day];
    const wTime = ws?.time || "09:00";
    blocks.push({ start: "06:30", end: "07:30", label: "Reveil + cafe" });
    blocks.push({ start: "07:30", end: "08:00", label: "Job Search (30 min)", details: ["Lire annonces LinkedIn/WTTJ", "Postuler 2-3 offres"] });
    if (program) {
      blocks.push({ start: wTime, end: addMin(wTime, program.duration), label: `${program.name} (${program.duration} min)`, details: program.exercises });
      blocks.push({ start: addMin(wTime, program.duration), end: addMin(wTime, program.duration + 20), label: "Douche" });
    }
    blocks.push({ start: "10:30", end: "12:00", label: "Temps libre / Projets perso" });
    blocks.push({ start: "12:00", end: "12:30", label: "🍳 Break fast (fin jeûne)" });
    blocks.push({ start: "12:30", end: "22:00", label: "Shabbat preparation + repos" });
    return blocks;
  }

  // === WORK DAYS ===
  const ws = WORKOUT_SCHEDULE[day];

  // SUNDAY: Legs at 06:30 before long day
  if (day === 0 && program) {
    blocks.push({ start: "05:45", end: "06:15", label: "Reveil + cafe" });
    blocks.push({ start: "06:15", end: addMin("06:15", program.duration + 5), label: `${program.name} (${program.duration} min)`, details: program.exercises });
    blocks.push({ start: addMin("06:15", program.duration + 5), end: addMin("06:15", program.duration + 25), label: "Douche" });
    blocks.push({ start: addMin("06:15", program.duration + 25), end: allerDepart, label: "Preparation depart" });
  }
  // THURSDAY: Cardio at 07:00 before late day + job search
  else if (day === 4) {
    blocks.push({ start: "06:30", end: "07:00", label: "Reveil + cafe" });
    if (program) {
      blocks.push({ start: "07:00", end: addMin("07:00", program.duration), label: `${program.name} (${program.duration} min)`, details: program.exercises });
      blocks.push({ start: addMin("07:00", program.duration), end: addMin("07:00", program.duration + 20), label: "Douche" });
    }
    const jobStart = program ? addMin("07:00", program.duration + 20) : "08:00";
    blocks.push({ start: jobStart, end: addMin(jobStart, 30), label: "Job Search (30 min)", details: ["Lire annonces LinkedIn/WTTJ", "Postuler 2-3 offres"] });
    blocks.push({ start: addMin(jobStart, 30), end: allerDepart, label: "Temps libre / Projets" });
  }
  // MON-WED: Normal morning, workout after work
  else {
    blocks.push({ start: "06:30", end: "07:00", label: "Reveil + cafe" });
    blocks.push({ start: "07:00", end: allerDepart, label: "Preparation" });
  }

  // Commute ALLER
  blocks.push({ start: allerDepart, end: allerArrive, label: "Trajet → Bureau" });

  // Work — split with lunch
  const workStart = toMin(sched.ws);
  const workEnd = toMin(sched.we);
  const lunchStart = Math.max(workStart, toMin("12:30"));

  if (workEnd - workStart > 240) {
    // Long day: split work into AM / lunch / PM
    blocks.push({ start: sched.ws, end: fromMin(lunchStart), label: "Travail" });
    blocks.push({ start: fromMin(lunchStart), end: fromMin(lunchStart + 30), label: "Dejeuner" });
    blocks.push({ start: fromMin(lunchStart + 30), end: sched.we, label: "Travail" });
  } else {
    blocks.push({ start: sched.ws, end: sched.we, label: "Travail" });
  }

  // Commute RETOUR
  blocks.push({ start: retourDepart, end: retourArrive, label: "Trajet → Maison" });

  // After work activities (Mon-Wed: short days)
  if (sched.type === "court" && program) {
    const afterHome = retourArrive;
    const jobStart = afterHome;
    const jobEnd = addMin(jobStart, 30);
    const workoutStart = jobEnd;
    const workoutEnd = addMin(workoutStart, program.duration);
    const showerEnd = addMin(workoutEnd, 20);

    blocks.push({ start: jobStart, end: jobEnd, label: "Job Search (30 min)", details: ["Lire annonces LinkedIn/WTTJ", "Postuler 2-3 offres"] });
    blocks.push({ start: workoutStart, end: workoutEnd, label: `${program.name} (${program.duration} min)`, details: program.exercises });
    blocks.push({ start: workoutEnd, end: showerEnd, label: "Douche" });
    blocks.push({ start: showerEnd, end: addMin(showerEnd, 60), label: "Diner" });
    blocks.push({ start: addMin(showerEnd, 60), end: "22:00", label: "Temps libre" });
  } else if (sched.type === "court") {
    // Short day without workout
    const afterHome = retourArrive;
    blocks.push({ start: afterHome, end: addMin(afterHome, 30), label: "Job Search (30 min)", details: ["Lire annonces LinkedIn/WTTJ", "Postuler 2-3 offres"] });
    blocks.push({ start: addMin(afterHome, 30), end: addMin(afterHome, 90), label: "Temps libre" });
    blocks.push({ start: addMin(afterHome, 90), end: addMin(afterHome, 150), label: "Diner" });
    blocks.push({ start: addMin(afterHome, 150), end: "22:00", label: "Temps libre" });
  } else if (sched.type === "long" || sched.type === "tardif") {
    // Long/late day: just dinner + free time after return
    const afterHome = retourArrive;
    blocks.push({ start: afterHome, end: addMin(afterHome, 30), label: "Repos" });
    blocks.push({ start: addMin(afterHome, 30), end: addMin(afterHome, 90), label: "Diner" });
    blocks.push({ start: addMin(afterHome, 90), end: "22:00", label: "Temps libre" });
  }

  // Insert scheduled tasks into timeline
  for (const task of scheduledTasks) {
    if (!task.due_time) continue;
    const tStart = task.due_time.substring(0, 5); // "HH:MM"
    const dur = task.duration_minutes || 30;
    const tEnd = addMin(tStart, dur);
    const pSymbol = task.priority <= 2 ? "●" : task.priority === 3 ? "◐" : "○";

    // Find if this overlaps a "Temps libre" block and replace
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].label.includes("Temps libre") || blocks[i].label === "Repos") {
        const bStart = toMin(blocks[i].start);
        const bEnd = toMin(blocks[i].end);
        const taskStart = toMin(tStart);
        const taskEnd = toMin(tEnd);

        if (taskStart >= bStart && taskEnd <= bEnd) {
          const newBlocks: PlanBlock[] = [];
          if (taskStart > bStart) {
            newBlocks.push({ start: blocks[i].start, end: tStart, label: blocks[i].label });
          }
          newBlocks.push({ start: tStart, end: tEnd, label: `${pSymbol} ${task.title}` });
          if (taskEnd < bEnd) {
            newBlocks.push({ start: tEnd, end: blocks[i].end, label: blocks[i].label });
          }
          blocks.splice(i, 1, ...newBlocks);
          break;
        }
      }
    }
  }

  blocks.push({ start: "22:00", end: "22:30", label: "Coucher" });

  return blocks;
}

function formatPlan(blocks: PlanBlock[]): string {
  let text = "";
  for (const b of blocks) {
    text += `<b>${b.start}</b>  ${escHTML(b.label)}\n`;
    if (b.details && b.details.length > 0) {
      for (const d of b.details) {
        text += `        · ${escHTML(d)}\n`;
      }
    }
  }
  return text;
}

// Domain emoji mapping
function getDomainEmoji(domain: string): string {
  const emojiMap: Record<string, string> = {
    career: "💼",
    finance: "💰",
    health: "🏋️",
    higrow: "🚀",
    trading: "📈",
    learning: "📚",
    personal: "🏠",
  };
  return emojiMap[domain?.toLowerCase()] || "🎯";
}

// Calculate days remaining to deadline
function daysUntilDeadline(deadline: string): number {
  const deadlineDate = new Date(deadline);
  const today = new Date(getIsraelNow());
  today.setHours(0, 0, 0, 0);
  deadlineDate.setHours(0, 0, 0, 0);
  const daysMs = deadlineDate.getTime() - today.getTime();
  return Math.ceil(daysMs / (1000 * 60 * 60 * 24));
}

// =============================================
// SMART SLOT ASSIGNMENT
// =============================================
function getAvailableSlots(sched: any, scheduledTasks: any[]): string[] {
  const slots: string[] = [];
  const takenTimes = new Set(scheduledTasks.map((t: any) => t.due_time?.substring(0, 5)));

  // Define possible slots based on work schedule
  let possibleSlots: string[] = [];
  if (sched.type === "work_short") {
    possibleSlots = ["07:00", "16:30", "17:30", "19:00", "20:00"];
  } else if (sched.type === "work_long") {
    possibleSlots = ["07:00", "20:30", "21:00"];
  } else if (sched.type === "work_late") {
    possibleSlots = ["08:00", "09:00", "10:00", "20:30"];
  } else if (sched.type === "off") {
    possibleSlots = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];
  } else {
    possibleSlots = ["09:00", "10:00", "14:00", "16:00", "19:00"];
  }

  for (const slot of possibleSlots) {
    if (!takenTimes.has(slot)) {
      slots.push(slot);
    }
  }
  return slots;
}

// =============================================
// MAIN
// =============================================
serve(async (req: Request) => {
  try {
    const signals = getSignalBus("morning-briefing");

    let forceDay: number | null = null;
    try { const b = await req.json(); if (typeof b.force_day === "number") forceDay = b.force_day; } catch (_) {}

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelNow();
    const actualDay = now.getDay();
    const day = forceDay !== null ? forceDay : actualDay;
    const dayName = DAYS_FR[day];
    const today = todayStr();
    const sched = getSched(day);
    const daysOffset = forceDay !== null ? ((forceDay - actualDay + 7) % 7) : 0;

    const LINE = "━━━━━━━━━━━━━━━━━━━━";

    // --- Deduplication: skip if briefing already sent today ---
    if (forceDay === null) {
      try {
        const { data: existingBriefing } = await supabase.from("briefings")
          .select("id").eq("briefing_type", "morning").eq("briefing_date", today).limit(1);
        if (existingBriefing && existingBriefing.length > 0) {
          console.log(`[Morning Briefing] Already sent today (${today}), skipping duplicate`);
          return new Response(JSON.stringify({
            success: true, type: "skipped_duplicate", date: today,
          }), { headers: { "Content-Type": "application/json" } });
        }
      } catch (_) {}
    }

    // Saturday OFF
    if (sched.type === "off") {
      const offPlan = buildDayPlan(day, "", "", "", "", []);
      let offMsg = `<b>OREN — Samedi ${today}</b>\n${LINE}\n\nJour OFF\n\n`;
      offMsg += formatPlan(offPlan);
      offMsg += `\n${LINE}\nBon week-end.`;
      await sendTG(offMsg);
      try { await supabase.from("briefings").insert({ briefing_type: "morning", briefing_date: today, content: offMsg, sent_at: new Date().toISOString() }); } catch (_) {}
      return new Response(JSON.stringify({ success: true, type: "off" }), { headers: { "Content-Type": "application/json" } });
    }

    // =============================================
    // COMMUTE DATA
    // =============================================
    let allerDepart = "08:00";
    let allerArrive = sched.ws || "09:30";
    let retourDepart = sched.we || "15:30";
    let retourArrive = "16:30";

    if (sched.type !== "variable") {
      const [wsH, wsM] = sched.ws.split(":").map(Number);
      const [weH, weM] = sched.we.split(":").map(Number);

      let allerH = wsH, allerM = wsM - LIME_MIN;
      if (allerM < 0) { allerM += 60; allerH -= 1; }
      const trainAller = await getTrainSchedule(STATION_ASHDOD, STATION_TLV, allerH, allerM, false, daysOffset);

      let retourH = weH, retourM = weM + LIME_MIN;
      if (retourM >= 60) { retourM -= 60; retourH += 1; }
      const trainRetour = await getTrainSchedule(STATION_TLV, STATION_ASHDOD, retourH, retourM, true, daysOffset);

      const allerDriveTs = trainAller?.depTs ? trainAller.depTs - (20 * 60) : undefined;
      const driveMinAller = await getDriveMin(HOME, STATION_ASHDOD, allerDriveTs);
      const retourDriveTs = trainRetour?.arrTs ? trainRetour.arrTs : undefined;
      const driveMinRetour = await getDriveMin(STATION_ASHDOD, HOME, retourDriveTs);

      if (trainAller) {
        allerDepart = subMin(trainAller.dep, driveMinAller + 5);
        allerArrive = addMin(trainAller.arr, LIME_MIN);
      } else {
        allerDepart = subMin(sched.ws, driveMinAller + 40 + LIME_MIN + 5);
      }
      if (trainRetour) {
        retourDepart = subMin(trainRetour.dep, LIME_MIN);
        retourArrive = addMin(trainRetour.arr, driveMinRetour);
      } else {
        retourArrive = addMin(sched.we, LIME_MIN + 40 + driveMinRetour);
      }
    }

    // =============================================
    // FETCH DATA
    // =============================================
    // Tasks for today - fetch ALL pending tasks, not just today's
    let scheduledTasks: any[] = [];
    let allTasks: any[] = [];
    let overdueTasks: any[] = [];
    let top3: any[] = [];
    try {
      // Today's tasks
      const { data } = await supabase.from("tasks").select("id, title, priority, status, due_time, duration_minutes, agent_type, context, reschedule_count")
        .eq("due_date", today).in("status", ["pending", "in_progress"]).order("priority", { ascending: true });
      allTasks = data || [];
      scheduledTasks = allTasks.filter((t: any) => t.due_time);

      // Also fetch overdue tasks (past due_date, still pending)
      const { data: overdue } = await supabase.from("tasks").select("id, title, priority, status, due_time, duration_minutes, agent_type, context, reschedule_count")
        .lt("due_date", today).in("status", ["pending", "in_progress"]).order("priority", { ascending: true }).limit(5);
      overdueTasks = overdue || [];

      // Smart "Les 3 du jour" selection
      // Priority: 1) overdue tasks, 2) today's high priority, 3) today's scheduled
      const candidates = [
        ...overdueTasks.map((t: any) => ({ ...t, urgencyBoost: 3 })),
        ...allTasks.map((t: any) => ({ ...t, urgencyBoost: 0 })),
      ];

      // Score each candidate
      const scored = candidates.map((t: any) => {
        let score = 0;
        score += (5 - (t.priority || 3)) * 2; // Priority 1 = +8, Priority 5 = +0
        score += t.urgencyBoost || 0;          // Overdue = +3
        if (t.due_time) score += 1;            // Has specific time = +1
        return { ...t, score };
      });

      // Sort by score descending, take top 3 unique tasks
      scored.sort((a: any, b: any) => b.score - a.score);
      const seen = new Set();
      for (const t of scored) {
        if (seen.has(t.title)) continue;
        seen.add(t.title);
        top3.push(t);
        if (top3.length >= 3) break;
      }

      // Auto-assign time slots to tasks without due_time
      const availableSlots = getAvailableSlots(sched, scheduledTasks);
      for (const t of top3) {
        if (!t.due_time && availableSlots.length > 0) {
          t.autoTime = availableSlots.shift();
          // Save auto-assigned time to DB
          try {
            await supabase.from("tasks").update({ due_time: t.autoTime }).eq("id", t.id);
          } catch (_) {}
        }
      }
    } catch (e) { console.error("Tasks:", e); }

    // Fetch active goals
    let activeGoals: any[] = [];
    try {
      const { data: goals } = await supabase
        .from("goals")
        .select("domain, title, metric_current, metric_target, metric_unit, metric_start, direction, deadline, daily_actions, priority")
        .eq("status", "active")
        .order("priority");
      activeGoals = goals || [];
    } catch (e) { console.error("Goals:", e); }

    // =============================================
    // FETCH DAILY BRAIN DATA (merged from daily-brain)
    // =============================================
    const monthStart = `${today.substring(0, 7)}-01`;
    const [
      pipelineRes, leadsRes, financeRes, careerVelocityRes,
      rejectionsRes, rocksRes, staleAppsRes, failPatternsRes,
    ] = await Promise.all([
      supabase.from("job_listings").select("status")
        .in("status", ["new", "applied", "interview", "offer"]),
      supabase.from("leads").select("status").gte("created_at", monthStart),
      supabase.from("finance_logs").select("transaction_type, amount")
        .gte("transaction_date", monthStart),
      supabase.from("job_listings").select("applied_date")
        .eq("status", "applied").gte("applied_date", daysAgo(7)),
      supabase.from("job_listings").select("company, title")
        .eq("status", "rejected")
        .gte("updated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from("rocks").select("title, domain, measurable_target, current_status, quarter_end")
        .in("current_status", ["on_track", "off_track"]),
      supabase.from("job_listings").select("id, company, title, applied_date")
        .eq("status", "applied").lte("applied_date", daysAgo(5)),
      supabase.from("task_fail_reasons").select("reason, task_date")
        .gte("task_date", daysAgo(30)),
    ]);

    const pipeline = pipelineRes.data || [];
    const leads = leadsRes.data || [];
    const finance = financeRes.data || [];
    const recentApps = careerVelocityRes.data || [];
    const rejections = rejectionsRes.data || [];
    const rocks = rocksRes.data || [];
    const staleApps = staleAppsRes.data || [];

    const newJobs = pipeline.filter((j: any) => j.status === "new").length;
    const appliedJobs = pipeline.filter((j: any) => j.status === "applied").length;
    const interviews = pipeline.filter((j: any) => j.status === "interview").length;
    const convertedLeads = leads.filter((l: any) => l.status === "converted").length;
    const totalLeads = leads.length;
    const monthIncome = finance.filter((f: any) => f.transaction_type === "income").reduce((s: number, e: any) => s + e.amount, 0);
    const monthExpense = finance.filter((f: any) => f.transaction_type === "expense").reduce((s: number, e: any) => s + e.amount, 0);
    const balance = monthIncome - monthExpense;
    const appVelocity = (recentApps.length / 7).toFixed(1);

    let requiredDailyApps = "N/A";
    const careerGoal = activeGoals.find((g: any) => g.domain === "career");
    if (careerGoal) {
      const target = Number(careerGoal.metric_target) || 50;
      const current = Number(careerGoal.metric_current) || 0;
      const remaining = target - current;
      const dLeft = careerGoal.deadline
        ? Math.max(1, Math.ceil((new Date(careerGoal.deadline).getTime() - now.getTime()) / 86400000))
        : 60;
      requiredDailyApps = remaining > 0 ? (remaining / dLeft).toFixed(1) : "0";
    }

    // =============================================
    // CONSUME OVERNIGHT SIGNALS
    // =============================================
    let overnightAlerts = "";
    let highPriorityDay = false;
    const overnightSignals = {
      critical: [] as any[], weakDomain: null as string | null,
      yesterdayScore: null as number | null, patterns: [] as string[],
      skillGaps: [] as string[], interviewAlert: false,
    };
    try {
      const overnight = await signals.consume({ markConsumed: true, limit: 30 });
      for (const sig of overnight) {
        if (sig.priority <= 2) { overnightSignals.critical.push(sig); highPriorityDay = true; }
        if (sig.signal_type === "weak_domain") overnightSignals.weakDomain = sig.payload?.domain || null;
        if (sig.signal_type === "daily_score") overnightSignals.yesterdayScore = sig.payload?.score ?? null;
        if (sig.signal_type === "pattern_detected") overnightSignals.patterns.push(sig.message);
        if (sig.signal_type === "skill_gap") overnightSignals.skillGaps.push(sig.message);
        if (sig.signal_type === "interview_scheduled") overnightSignals.interviewAlert = true;
      }
      if (overnight.length > 0) {
        const critical = overnight.filter((s: any) => s.priority <= 2);
        const info = overnight.filter((s: any) => s.priority > 2);
        if (critical.length > 0) {
          overnightAlerts += `\n⚡ ALERTES:\n`;
          for (const sig of critical) { overnightAlerts += `→ [${sig.source_agent}] ${sig.message}\n`; }
        }
        if (info.length > 0) {
          overnightAlerts += `\n📡 Signaux (${info.length}):\n`;
          for (const sig of info.slice(0, 5)) { overnightAlerts += `→ ${sig.message}\n`; }
          if (info.length > 5) overnightAlerts += `  +${info.length - 5} autres\n`;
        }
        const lowSleep = overnight.find((s: any) => s.signal_type === "low_sleep");
        if (lowSleep) overnightAlerts += `\n😴 Sommeil faible (${lowSleep.payload?.hours}h) → journée allégée\n`;
        const recovery = overnight.find((s: any) => s.signal_type === "recovery_status");
        if (recovery) overnightAlerts += `\n💪 ${recovery.payload?.recommendation === "deload" ? "Deload recommandé" : "Recovery OK"}\n`;
        const streakRisk = overnight.find((s: any) => s.signal_type === "streak_at_risk");
        if (streakRisk) overnightAlerts += `\n⚠️ ${streakRisk.message}\n`;
      }
    } catch (sigErr) { console.error("[Signals] Morning consume error:", sigErr); }

    // =============================================
    // GENERATE DAILY BRAIN (inline — replaces daily-brain function)
    // =============================================
    let brainText = "";
    let priorityDomain = "career";
    let dailyMode = "normal";
    try {
      // === GOAL INTELLIGENCE ENGINE ===
      const rankedGoalsList = rankGoals(activeGoals, now);

      // 7-day brain trend analysis
      let trendData = { dominantDomain: null as string | null, urgenceDays: 0, pattern: "insufficient_data", stuckDomains: [] as string[] };
      try {
        const { data: brainHistory } = await supabase.from("daily_brain")
          .select("priority_domain, daily_mode")
          .gte("plan_date", daysAgo(7))
          .order("plan_date", { ascending: false });
        if (brainHistory && brainHistory.length > 0) {
          trendData = analyzeBrainTrend(brainHistory);
        }
      } catch (_) {}

      // Goal-Rock misalignment detection
      const misalignments = detectGoalRockMisalignment(rankedGoalsList, rocks);

      // Build enriched goal intelligence context for AI
      const goalIntelCtx = buildGoalIntelligenceContext(rankedGoalsList, trendData, misalignments);

      // Auto-create goal nudge tasks (daily_actions not yet done)
      try {
        const { data: todayDoneTasks } = await supabase.from("tasks")
          .select("title").eq("due_date", today)
          .in("status", ["completed", "in_progress"]);
        const doneTitles = (todayDoneTasks || []).map((t: any) => t.title || "");
        const nudges = generateGoalNudges(rankedGoalsList, doneTitles, today);
        for (const nudge of nudges) {
          // Dedup: don't create if similar task exists
          const { data: existing } = await supabase.from("tasks")
            .select("id").eq("context", nudge.context).eq("due_date", today)
            .in("status", ["pending", "in_progress"]).limit(1);
          if (existing && existing.length > 0) continue;
          await supabase.from("tasks").insert({
            title: nudge.title, status: "pending", priority: nudge.priority,
            agent_type: nudge.domain, context: nudge.context,
            due_date: nudge.due_date, created_at: new Date().toISOString(),
          });
        }
      } catch (nudgeErr) { console.error("Goal nudge error:", nudgeErr); }

      const tasksCtx = allTasks.length > 0
        ? allTasks.slice(0, 10).map((t: any) => `- P${t.priority}: ${t.title}${t.due_time ? ` @${t.due_time.substring(0, 5)}` : ""}`).join("\n")
        : "Aucune tâche";

      let rocksCtx = "";
      const rocksOffTrack: string[] = [];
      let signalsCtx = "";
      for (const rock of rocks) {
        const dLeft = Math.ceil((new Date(rock.quarter_end).getTime() - now.getTime()) / 86400000);
        const status = rock.current_status === "on_track" ? "✅" : "⚠️ OFF";
        rocksCtx += `- [${rock.domain}] ${rock.title} — ${status} (J-${dLeft})\n`;
        if (rock.current_status === "off_track") rocksOffTrack.push(rock.title);
        if (dLeft <= 14 && dLeft > 0) signalsCtx += `🔴 Rock "${rock.title}" — J-${dLeft}\n`;
      }

      if (overnightSignals.yesterdayScore !== null) signalsCtx += `Score hier: ${overnightSignals.yesterdayScore}/12\n`;
      if (overnightSignals.weakDomain) signalsCtx += `⚠️ Faible hier: ${overnightSignals.weakDomain}\n`;
      if (overnightSignals.interviewAlert) signalsCtx += `🔴 INTERVIEW — Priorité absolue\n`;

      let anticipationsCtx = "";
      if (staleApps.length > 0) {
        anticipationsCtx += `RELANCES (>5j):\n`;
        for (const app of staleApps.slice(0, 3)) {
          const daysSince = Math.ceil((now.getTime() - new Date(app.applied_date).getTime()) / 86400000);
          anticipationsCtx += `- ${app.company} "${app.title}" (${daysSince}j)\n`;
        }
      }

      const failPatterns = failPatternsRes.data || [];
      const todayFailReasons = failPatterns.filter((fr: any) => new Date(fr.task_date).getDay() === day);
      if (todayFailReasons.length >= 3) {
        const reasonCounts: Record<string, number> = {};
        todayFailReasons.forEach((fr: any) => { reasonCounts[fr.reason] = (reasonCounts[fr.reason] || 0) + 1; });
        const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
        if (topReason) anticipationsCtx += `⚠️ ${dayName} jour faible (${topReason[0]} ${topReason[1]}x)\n`;
      }

      // Trend context for AI
      let trendCtx = "";
      if (trendData.pattern === "chronic_urgence") trendCtx = `⚠️ TREND: Mode urgence ${trendData.urgenceDays}/7 jours — attention burnout`;
      else if (trendData.pattern === "stuck_on_domain") trendCtx = `⚠️ TREND: Bloqué sur ${trendData.dominantDomain} depuis 5+ jours`;
      else if (trendData.pattern === "frequent_urgence") trendCtx = `⚡ TREND: Urgence fréquente (${trendData.urgenceDays}/7j)`;

      const brainContext = `${dayName} ${today}
Rocks: ${rocksCtx || "aucun"}${rocksOffTrack.length > 0 ? ` | ⚠️ OFF: ${rocksOffTrack.join(", ")}` : ""}
Career: ${newJobs} new, ${appliedJobs} applied, ${interviews} interviews · Vélocité ${appVelocity}/j (requis ${requiredDailyApps}/j) · ${rejections.length} rejets${interviews === 0 ? " ⚠️ 0 INTERVIEWS" : ""}
HiGrow: ${convertedLeads}/${totalLeads || "?"} convertis · Finance: ${balance > 0 ? "+" : ""}${Math.round(balance)}₪
🎯 GOAL INTELLIGENCE:
${goalIntelCtx || "Aucun objectif actif"}${misalignments.length > 0 ? `\n⚠️ MISALIGNMENT: ${misalignments.map(m => m.issue).join("; ")}` : ""}
${trendCtx ? `${trendCtx}\n` : ""}Tâches: ${tasksCtx}
${signalsCtx ? `Signaux: ${signalsCtx}` : ""}${anticipationsCtx ? `Anticipations: ${anticipationsCtx}` : ""}`.trim();

      brainText = await callOpenAI(
        `Briefing matin Oren (HTML: <b>, <i>). Format strict:
🔴/🟡/🟢 URGENCE — Domaine prioritaire · ${dayName}
🎯 Goal le + critique: pace actuel vs requis, J-X, risque
💼 Career · 🚀 HiGrow · 💰 Finance (chiffres réels)
🪨 Rocks off-track${overnightSignals.interviewAlert ? " · 🔴 INTERVIEW PREP" : ""}
${trendCtx ? `📊 Trend 7j\n` : ""}⚡ UNE action concrète pour débloquer le goal critique
🔴=goal critique/danger · 🟡=watch · 🟢=on track
Max 8 lignes, data-driven, focus sur le goal le plus en retard.`,
        brainContext,
        350
      );

      // Priority domain: Goal-aware + Rock-aware + signal-aware
      const criticalGoal = rankedGoalsList.find(g => g.riskLevel === "critical" || g.riskLevel === "danger");
      const offTrackRock = rocks.find((r: any) => r.current_status === "off_track");
      if (overnightSignals.interviewAlert) priorityDomain = "career";
      else if (criticalGoal) priorityDomain = criticalGoal.domain;
      else if (offTrackRock) priorityDomain = offTrackRock.domain;
      else if (interviews === 0 && appliedJobs < 5) priorityDomain = "career";
      else if (convertedLeads === 0) priorityDomain = "higrow";
      else if (overnightSignals.weakDomain) priorityDomain = overnightSignals.weakDomain;

      // Daily mode — goal-aware
      const velocityBehind = requiredDailyApps !== "N/A" && parseFloat(appVelocity) < parseFloat(requiredDailyApps);
      const hasCriticalGoal = rankedGoalsList.some(g => g.riskLevel === "critical");
      const hasDangerGoal = rankedGoalsList.some(g => g.riskLevel === "danger" && g.daysLeft <= 14);
      if (interviews === 0 || convertedLeads === 0 || velocityBehind || rocksOffTrack.length > 0 || hasCriticalGoal || hasDangerGoal) dailyMode = "urgence";

      // Auto-create follow-up tasks for stale applications
      for (const app of staleApps.slice(0, 3)) {
        try {
          const { data: existing } = await supabase.from("tasks")
            .select("id").eq("context", `followup_${app.id}`)
            .in("status", ["pending", "in_progress"]).limit(1);
          if (existing && existing.length > 0) continue;
          const daysSince = Math.ceil((now.getTime() - new Date(app.applied_date).getTime()) / 86400000);
          await supabase.from("tasks").insert({
            title: `📧 Relance ${app.company} — "${app.title}" (${daysSince}j)`,
            status: "pending", priority: 2, agent_type: "career",
            context: `followup_${app.id}`, due_date: today,
            duration_minutes: 10, created_at: new Date().toISOString(),
          });
        } catch (e) { console.error(`Follow-up task error:`, e); }
      }

      // Write to daily_brain for history
      try {
        await supabase.from("daily_brain").upsert({
          plan_date: today, briefing_text: brainText,
          priority_domain: priorityDomain, daily_mode: dailyMode,
        }, { onConflict: "plan_date" });
      } catch (_) {}
    } catch (brainErr) { console.error("Brain generation error:", brainErr); }

    // Build the day plan (used for Calendar sync + message)
    const dayPlan = buildDayPlan(day, allerDepart, allerArrive, retourDepart, retourArrive, scheduledTasks);

    // =============================================
    // GOOGLE CALENDAR SYNC
    // =============================================
    try {
      const gcal = getGoogleCalendar();
      if (gcal.isConfigured()) {
        const PREFIX = "[OREN] ";
        // Clear yesterday's auto-generated events and create today's
        const calEvents = [];

        // 1. Schedule blocks → Calendar events
        for (const block of dayPlan) {
          let colorId = GCAL_COLORS.TASK;
          const label = block.label.toLowerCase();
          if (label.includes("travail") || label.includes("bureau") || label.includes("boulot")) colorId = GCAL_COLORS.WORK;
          else if (label.includes("push") || label.includes("pull") || label.includes("legs") || label.includes("cardio") || label.includes("repos actif") || label.includes("workout")) colorId = GCAL_COLORS.WORKOUT;
          else if (label.includes("fast") || label.includes("repas") || label.includes("déjeuner") || label.includes("diner") || label.includes("break fast") || label.includes("🍳")) colorId = GCAL_COLORS.MEAL;
          else if (label.includes("briefing") || label.includes("review")) colorId = GCAL_COLORS.BRIEFING;

          calEvents.push(gcal.buildEvent(
            `${PREFIX}${block.label.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").trim()}`,
            today,
            block.start,
            block.end,
            block.details ? block.details.join("\n") : undefined,
            colorId
          ));
        }

        // 2. Scheduled tasks/missions → Calendar events
        for (const task of scheduledTasks) {
          const dur = task.duration_minutes || 30;
          const [h, m] = task.due_time.split(":").map(Number);
          const totalEnd = h * 60 + m + dur;
          const endH = Math.floor(totalEnd / 60).toString().padStart(2, "0");
          const endM = (totalEnd % 60).toString().padStart(2, "0");
          const prio = task.priority <= 2 ? "❗" : "";
          calEvents.push(gcal.buildEvent(
            `${PREFIX}${prio}${task.title}`,
            today,
            task.due_time,
            `${endH}:${endM}`,
            `Priorité: ${task.priority}/5\nStatut: ${task.status}`,
            GCAL_COLORS.MISSION
          ));
        }

        // 3. Goals with deadlines this week → Calendar reminder
        for (const goal of activeGoals) {
          if (goal.deadline) {
            const deadlineDate = new Date(goal.deadline);
            const todayDate = new Date(today);
            const daysUntil = Math.ceil((deadlineDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000));
            if (daysUntil >= 0 && daysUntil <= 7) {
              const domainEmoji: Record<string, string> = { career: "💼", finance: "💰", health: "💪", higrow: "🚀", trading: "📈", learning: "📚", personal: "🏠" };
              calEvents.push(gcal.buildEvent(
                `${PREFIX}${domainEmoji[goal.domain] || "🎯"} DEADLINE: ${goal.title}`,
                goal.deadline.split("T")[0],
                "09:00",
                "09:30",
                `Domaine: ${goal.domain}\nObjectif: ${goal.metric_current || "?"}/${goal.metric_target || "?"} ${goal.metric_unit || ""}\nJours restants: ${daysUntil}`,
                GCAL_COLORS.GOAL
              ));
            }
          }
        }

        // 4. Trading signals (merged from sync-calendar)
        try {
          const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
          const { data: tradingSignals } = await supabase.from("trading_signals")
            .select("symbol, signal_type, confidence, notes, created_at")
            .gte("created_at", fourHoursAgo)
            .in("signal_type", ["BUY", "SELL"])
            .order("created_at", { ascending: false }).limit(5);

          if (tradingSignals && tradingSignals.length > 0) {
            for (const sig of tradingSignals) {
              try {
                const notes = JSON.parse(sig.notes || "{}");
                const signal = notes.signal;
                if (signal) {
                  const icon = sig.signal_type === "BUY" ? "🟢 LONG" : "🔴 SHORT";
                  const createdAt = new Date(sig.created_at);
                  const startH = createdAt.getHours().toString().padStart(2, "0");
                  const startM = createdAt.getMinutes().toString().padStart(2, "0");
                  const endH = (createdAt.getHours() + 4).toString().padStart(2, "0");
                  calEvents.push(gcal.buildEvent(
                    `${PREFIX}${icon} ${sig.symbol} @ $${signal.entry}`,
                    today, `${startH}:${startM}`, `${endH}:${startM}`,
                    `Entry: $${signal.entry}\nSL: $${signal.sl}\nTP: $${signal.tp}\nR:R: ${signal.rr}\nConfiance: ${sig.confidence}%`,
                    GCAL_COLORS.TRADING || "11"
                  ));
                }
              } catch { /* skip invalid */ }
            }
          }
        } catch (trErr) { console.error("Trading calendar error:", trErr); }

        const synced = await gcal.syncDayEvents(today, calEvents, PREFIX);
        console.log(`📅 Google Calendar: ${synced}/${calEvents.length} events synced`);
      }
    } catch (e) { console.error("Google Calendar sync error:", e); }

    // =============================================
    // BUILD SHORT MESSAGE
    // =============================================
    let msg = "";

    if (brainText) {
      // Brain ran — use its output as the briefing
      msg = brainText + "\n";
    } else {
      // Brain didn't run — fallback to basic briefing
      msg = `<b>OREN — ${dayName} ${today}</b>\n${LINE}\n\n`;
      msg += `📋 ${allTasks.length} tâches\n`;
    }

    // Add commute info (compact, 1-2 lines)
    msg += `\n${LINE}\n`;
    if (sched.type !== "variable") {
      msg += `🚆 ${allerDepart} → Bureau ${allerArrive} · Retour ${retourArrive}\n`;
    } else {
      msg += `📅 Journée variable\n`;
    }

    // LES 3 DU JOUR (smart top 3 tasks)
    if (top3.length > 0) {
      msg += `\n<b>🎯 LES 3 DU JOUR</b>\n`;
      top3.forEach((t: any, i: number) => {
        const num = ["1️⃣", "2️⃣", "3️⃣"][i] || "▸";
        const time = t.due_time || t.autoTime;
        const timeStr = time ? ` → <b>${time.substring(0, 5)}</b>` : "";
        const overdue = t.urgencyBoost > 0 ? " ⚠️" : "";
        msg += `${num} ${escHTML(t.title)}${timeStr}${overdue}\n`;
      });
      if (allTasks.length > 3) {
        msg += `<i>+${allTasks.length - 3} autres tâches</i>\n`;
      }
    } else if (allTasks.length > 0) {
      msg += `\n<b>TÂCHES</b> (${allTasks.length})\n`;
      allTasks.slice(0, 5).forEach((t: any) => {
        const p = t.priority <= 2 ? "●" : t.priority === 3 ? "◐" : "○";
        const time = t.due_time ? ` <b>${t.due_time}</b>` : "";
        msg += `${p} ${escHTML(t.title)}${time}\n`;
      });
    }

    // ─── PREDICTIVE SCORING: tasks at risk ─────────────────
    try {
      const allTasksForPred = [...allTasks, ...(overdueTasks || [])];
      if (allTasksForPred.length > 0) {
        const predictions = await predictTasks(supabase, allTasksForPred, day, now.getHours());
        const atRiskMsg = formatAtRiskTasks(predictions);
        if (atRiskMsg) msg += atRiskMsg;
      }
    } catch (e) { console.error("[Intelligence] Prediction error:", e); }

    // Add overnight alerts if any
    if (overnightAlerts) {
      msg += overnightAlerts;
    }

    msg += `\n<b>Focus sur ces 3 actions. Le reste peut attendre.</b>`;

    const sent = await sendTG(msg);
    try { await supabase.from("briefings").insert({ briefing_type: "morning", briefing_date: today, content: msg, sent_at: new Date().toISOString() }); } catch (_) {}

    // --- Emit day priority signal ---
    try {
      if (highPriorityDay) {
        await signals.emit("high_priority_day", "Journée haute priorité — focus total", {
          criticalAlerts: true,
        }, { target: "task-reminder", priority: 1, ttlHours: 16 });
      }
    } catch (sigErr) {
      console.error("[Signals] Morning emit error:", sigErr);
    }

    return new Response(JSON.stringify({ success: sent, date: today }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
