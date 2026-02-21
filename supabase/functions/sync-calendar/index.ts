// ============================================
// OREN AGENT — Google Calendar Full Sync
// Syncs: work blocks, workouts, meals, tasks, missions, goals, trading signals
// Trigger: called by morning-briefing, or manually via /sync
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TZ = "Asia/Jerusalem";

// =============================================
// GOOGLE CALENDAR AUTH (inline — no shared import needed)
// =============================================
function base64url(data: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToBase64url(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

async function getAccessToken(): Promise<string | null> {
  const credsRaw = Deno.env.get("GOOGLE_CALENDAR_CREDENTIALS") || "";
  if (!credsRaw) return null;
  try {
    const creds = JSON.parse(credsRaw);
    const pemBody = creds.private_key
      .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, "")
      .replace(/-----END (RSA )?PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemBody), (c: string) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8", binaryDer.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["sign"]
    );
    const now = Math.floor(Date.now() / 1000);
    const header = strToBase64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = strToBase64url(JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    }));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", key,
      new TextEncoder().encode(`${header}.${payload}`)
    );
    const jwt = `${header}.${payload}.${base64url(new Uint8Array(sig))}`;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    if (!res.ok) { console.error("Token error:", await res.text()); return null; }
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { console.error("Auth error:", e); return null; }
}

// =============================================
// CALENDAR API HELPERS
// =============================================
const CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID") || "primary";
const PREFIX = "[OREN] ";

// Colors: 1:Lavender 2:Sage 3:Grape 4:Flamingo 5:Banana 6:Tangerine 7:Peacock 8:Graphite 9:Blueberry 10:Basil 11:Tomato
const COLORS = {
  WORK: "8", WORKOUT: "10", TRADING: "11", TASK: "9",
  MISSION: "6", BRIEFING: "7", MEAL: "5", GOAL: "3", COMMUTE: "1",
};

function getIsraelOffset(date: string): string {
  const d = new Date(date + "T12:00:00");
  const utcDate = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const israelDate = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const diffHours = Math.round((israelDate.getTime() - utcDate.getTime()) / 3600000);
  return `+${String(diffHours).padStart(2, "0")}:00`;
}

async function clearDayEvents(token: string, dateStr: string): Promise<number> {
  const offset = getIsraelOffset(dateStr);
  const timeMin = `${dateStr}T00:00:00${offset}`;
  const timeMax = `${dateStr}T23:59:59${offset}`;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=200&singleEvents=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return 0;
  const data = await res.json();
  let deleted = 0;
  for (const ev of data.items || []) {
    if (ev.summary?.startsWith(PREFIX)) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${ev.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      );
      deleted++;
    }
  }
  return deleted;
}

async function createEvent(
  token: string, summary: string, date: string,
  startTime: string, endTime: string,
  description?: string, colorId?: string
): Promise<string | null> {
  const event = {
    summary: `${PREFIX}${summary}`,
    description: description || "",
    start: { dateTime: `${date}T${startTime}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: TZ },
    colorId: colorId || COLORS.TASK,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
  };
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }
  );
  if (!res.ok) { console.error("createEvent error:", await res.text()); return null; }
  const data = await res.json();
  return data.id || null;
}

function endTime(start: string, durationMin: number): string {
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

// =============================================
// SCHEDULE DATA (same as morning-briefing)
// =============================================
interface Sched { type: string; ws: string; we: string; }
function getSched(d: number): Sched {
  const s: Record<number, Sched> = {
    0: { type: "long", ws: "09:30", we: "19:30" },
    1: { type: "court", ws: "09:30", we: "15:30" },
    2: { type: "court", ws: "09:30", we: "15:30" },
    3: { type: "court", ws: "09:30", we: "15:30" },
    4: { type: "tardif", ws: "12:00", we: "19:30" },
    5: { type: "variable", ws: "10:00", we: "16:00" },
    6: { type: "off", ws: "-", we: "-" },
  };
  return s[d] || s[0];
}

const WORKOUT_SCHEDULE: Record<number, { type: string; time: string; name: string; duration: number; exercises: string[] }> = {
  0: { type: "legs", time: "06:30", name: "🦵 LEGS", duration: 65,
    exercises: ["Squat barre 4×6-8", "Presse cuisses 3×10-12", "SDT roumain 3×10-12", "Leg curl 3×12-15", "Leg extension 3×12-15", "Fentes bulgares 3×10/j", "Mollets 4×15-20"] },
  1: { type: "push", time: "17:00", name: "💪 PUSH", duration: 60,
    exercises: ["DC barre 4×8-10", "DI haltères 3×10-12", "Dips lestés 3×8-10", "Écartés câbles 3×12-15", "Élév. latérales 4×15", "Pushdown triceps 3×12-15", "Ext. overhead 3×12"] },
  2: { type: "pull", time: "17:00", name: "🏋️ PULL", duration: 60,
    exercises: ["SDT 4×5-6", "Rowing barre 4×8-10", "Tractions large 3×6-10", "Rowing câble 3×10-12", "Face pulls 4×15-20", "Curl EZ 3×10-12", "Curl marteau 3×12"] },
  3: { type: "legs", time: "17:00", name: "🦵 LEGS", duration: 65,
    exercises: ["Squat barre 4×6-8", "Presse cuisses 3×10-12", "SDT roumain 3×10-12", "Leg curl 3×12-15", "Leg extension 3×12-15", "Fentes bulgares 3×10/j", "Mollets 4×15-20"] },
  4: { type: "cardio", time: "07:00", name: "🫁 CARDIO", duration: 45,
    exercises: ["Tapis interval 25min", "Rameur 10min", "Foam rolling 5min", "Stretching hanches", "Planche 3×45s", "Dead hang 3×30s"] },
  5: { type: "push", time: "09:00", name: "💪 PUSH", duration: 60,
    exercises: ["DC barre 4×8-10", "DI haltères 3×10-12", "Dips lestés 3×8-10", "Écartés câbles 3×12-15", "Élév. latérales 4×15", "Pushdown triceps 3×12-15", "Ext. overhead 3×12"] },
  6: { type: "rest", time: "10:00", name: "😴 Repos actif", duration: 30,
    exercises: ["Marche extérieur 20-30 min", "Stretching complet 15 min"] },
};

// =============================================
// MAIN HANDLER
// =============================================
serve(async (_req: Request) => {
  const log: string[] = [];
  try {
    // Auth
    const token = await getAccessToken();
    if (!token) {
      return new Response(JSON.stringify({ error: "Google auth failed — check GOOGLE_CALENDAR_CREDENTIALS", log }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }
    log.push("✅ Authenticated");

    // Date
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const day = now.getDay();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
    log.push(`📅 ${dayNames[day]} ${today}`);

    // Clear existing auto-generated events
    const cleared = await clearDayEvents(token, today);
    log.push(`🧹 Cleared ${cleared} existing [OREN] events`);

    let created = 0;
    const sched = getSched(day);

    // =============================================
    // 1. WORK BLOCKS
    // =============================================
    if (sched.type !== "off" && sched.type !== "variable") {
      const id = await createEvent(token, `💼 Travail`, today, sched.ws, sched.we,
        `Journée ${sched.type}\nBureau Tel Aviv`, COLORS.WORK);
      if (id) created++;
      log.push(`💼 Work: ${sched.ws}-${sched.we}`);

      // Lunch break
      await createEvent(token, `🍽️ Déjeuner`, today, "12:30", "13:00",
        "Pause déjeuner", COLORS.MEAL);
      created++;
    } else if (sched.type === "variable") {
      await createEvent(token, `📅 Journée variable`, today, "10:00", "16:00",
        "Vendredi — horaire flexible", COLORS.WORK);
      created++;
    } else {
      await createEvent(token, `😎 Jour OFF`, today, "08:00", "22:00",
        "Samedi — repos", COLORS.MEAL);
      created++;
    }

    // =============================================
    // 2. WORKOUT
    // =============================================
    const workout = WORKOUT_SCHEDULE[day];
    if (workout) {
      const end = endTime(workout.time, workout.duration);
      await createEvent(token, `${workout.name} (${workout.duration}min)`, today,
        workout.time, end,
        workout.exercises.join("\n"), COLORS.WORKOUT);
      created++;
      log.push(`🏋️ Workout: ${workout.name} ${workout.time}-${end}`);
    }

    // =============================================
    // 3. FIXED DAILY BLOCKS
    // =============================================
    // Morning briefing
    await createEvent(token, `📋 Briefing matin`, today, "07:00", "07:15",
      "Lire le briefing Telegram OREN", COLORS.BRIEFING);
    created++;

    // Fasting window (12:00-20:00)
    await createEvent(token, `🍳 Fenêtre repas (16:8)`, today, "12:00", "20:00",
      "Jeûne 16:8 — manger entre 12h et 20h\nProtéines prioritaires + Créatine 5g + Omega-3", COLORS.MEAL);
    created++;

    // Evening review
    await createEvent(token, `📊 Review soir`, today, "21:30", "21:45",
      "Lire la review Telegram OREN", COLORS.BRIEFING);
    created++;

    log.push(`📋 Fixed blocks: briefing, meal window, review`);

    // =============================================
    // 4. TASKS WITH SCHEDULED TIME
    // =============================================
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: tasks } = await supabase.from("tasks")
      .select("title, priority, due_time, duration_minutes, status")
      .eq("due_date", today)
      .in("status", ["pending", "in_progress"])
      .order("priority", { ascending: true });

    if (tasks && tasks.length > 0) {
      for (const task of tasks) {
        if (task.due_time) {
          const dur = task.duration_minutes || 30;
          const end = endTime(task.due_time, dur);
          const prio = task.priority <= 2 ? "❗" : "";
          await createEvent(token, `${prio}${task.title}`, today,
            task.due_time, end,
            `Priorité: ${task.priority}/5\nDurée: ${dur}min\nStatut: ${task.status}`,
            task.priority <= 2 ? COLORS.MISSION : COLORS.TASK);
          created++;
        }
      }
      const scheduled = tasks.filter((t: any) => t.due_time).length;
      const unscheduled = tasks.length - scheduled;
      log.push(`📌 Tasks: ${scheduled} scheduled + ${unscheduled} unscheduled`);
    } else {
      log.push(`📌 Tasks: none for today`);
    }

    // =============================================
    // 5. ACTIVE GOALS WITH DEADLINES THIS WEEK
    // =============================================
    const { data: goals } = await supabase.from("goals")
      .select("domain, title, metric_current, metric_target, metric_unit, deadline")
      .eq("status", "active");

    if (goals && goals.length > 0) {
      const todayDate = new Date(today);
      const domainEmoji: Record<string, string> = {
        career: "💼", finance: "💰", health: "💪",
        higrow: "🚀", trading: "📈", learning: "📚", personal: "🏠"
      };
      for (const goal of goals) {
        if (goal.deadline) {
          const dl = new Date(goal.deadline);
          const daysUntil = Math.ceil((dl.getTime() - todayDate.getTime()) / (86400000));
          if (daysUntil >= 0 && daysUntil <= 7) {
            const dlDate = goal.deadline.split("T")[0];
            await createEvent(token,
              `${domainEmoji[goal.domain] || "🎯"} DEADLINE: ${goal.title}`,
              dlDate, "09:00", "09:30",
              `Domaine: ${goal.domain}\nObjectif: ${goal.metric_current || "?"}/${goal.metric_target || "?"} ${goal.metric_unit || ""}\nDans ${daysUntil} jours`,
              COLORS.GOAL);
            created++;
          }
        }
      }
      log.push(`🎯 Goals: ${goals.length} active, checked deadlines`);
    }

    // =============================================
    // 6. RECENT TRADING SIGNALS (last 4h)
    // =============================================
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: signals } = await supabase.from("trading_signals")
      .select("symbol, signal_type, confidence, notes, created_at")
      .gte("created_at", fourHoursAgo)
      .in("signal_type", ["BUY", "SELL"])
      .order("created_at", { ascending: false });

    if (signals && signals.length > 0) {
      for (const sig of signals) {
        try {
          const notes = JSON.parse(sig.notes || "{}");
          const signal = notes.signal;
          if (signal) {
            const icon = sig.signal_type === "BUY" ? "🟢 LONG" : "🔴 SHORT";
            const createdAt = new Date(sig.created_at);
            const startH = createdAt.getHours().toString().padStart(2, "0");
            const startM = createdAt.getMinutes().toString().padStart(2, "0");
            const endH = (createdAt.getHours() + 4).toString().padStart(2, "0");

            await createEvent(token,
              `${icon} ${sig.symbol} @ $${signal.entry}`,
              today, `${startH}:${startM}`, `${endH}:${startM}`,
              `Entry: $${signal.entry}\nSL: $${signal.sl}\nTP: $${signal.tp}${signal.tpSource ? ` (${signal.tpSource})` : ""}\nR:R: ${signal.rr}\nConfiance: ${sig.confidence}%`,
              COLORS.TRADING);
            created++;
          }
        } catch { /* skip invalid */ }
      }
      log.push(`📈 Trading: ${signals.length} active signals`);
    }

    // =============================================
    // 7. WEEKLY TRADING PLANS (if available)
    // =============================================
    const isTradingDay = [1, 2, 3].includes(day); // Lun-Mer
    if (isTradingDay) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: plans } = await supabase.from("trading_signals")
        .select("notes").eq("symbol", "PLAN")
        .gte("created_at", weekAgo)
        .order("created_at", { ascending: false }).limit(1);

      if (plans && plans.length > 0) {
        try {
          const planData = JSON.parse(plans[0].notes || "{}");
          const weeklyPlans = planData.plans || [];
          for (const plan of weeklyPlans) {
            const icon = plan.type === "BUY_ZONE" ? "🟢" : plan.type === "SELL_ZONE" ? "🔴" : "⚠️";
            await createEvent(token,
              `${icon} ${plan.symbol}: ${plan.action}`,
              today, "08:00", "08:30",
              `Condition: ${plan.condition}\nAction: ${plan.action}\nZone: $${plan.zone}`,
              COLORS.TRADING);
            created++;
          }
          log.push(`📋 Weekly plans: ${weeklyPlans.length} conditions`);
        } catch { /* skip */ }
      }
    }

    log.push(`\n🎉 SYNC COMPLETE: ${created} events created`);

    return new Response(JSON.stringify({ success: true, created, cleared, date: today, log }),
      { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.push(`❌ Fatal: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg, log }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
