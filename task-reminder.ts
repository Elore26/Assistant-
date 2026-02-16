import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "775360436";

const LINE = "━━━━━━━━━━━━━━━━━━━━";

function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

function todayStr(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60000);
}

function diffMin(from: string, to: string): number {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  return (th * 60 + tm) - (fh * 60 + fm);
}

// Schedule events for reminder
function getScheduleEvents(dow: number): Array<{ time: string; label: string }> {
  if (dow === 6 || dow === 5) return [];
  const events: Array<{ time: string; label: string }> = [];
  if (dow === 4) {
    events.push({ time: "10:00", label: "Départ maison" });
    events.push({ time: "19:30", label: "Fin bureau" });
  } else {
    events.push({ time: "07:00", label: "Départ maison" });
    events.push({ time: dow === 0 ? "19:30" : "15:30", label: "Fin bureau" });
  }
  return events;
}

// Send TG with optional inline keyboard
async function sendTG(text: string, buttons?: any[][]): Promise<boolean> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: any = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: buttons };
  }

  let r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.ok) return true;
  // Fallback plain (without buttons)
  r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.replace(/<[^>]*>/g, "") }),
  });
  return r.ok;
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

serve(async (_req: Request) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelNow();
    const today = todayStr();
    const nowTime = timeStr(now);
    const in15 = timeStr(addMinutes(now, 15));
    const dow = now.getDay();

    let reminderCount = 0;

    // ─── CHECK FOCUS MODE ────────────────────────────────────────
    const signals = getSignalBus("task-reminder");
    let focusActive = false;
    try {
      const focusSignal = await signals.getLatest("focus_mode_active");
      if (focusSignal && focusSignal.status === "active" && focusSignal.expires_at) {
        focusActive = new Date(focusSignal.expires_at) > now;
      }
    } catch (e) { console.error("[Focus] Check error:", e); }

    // ─── 1. UPCOMING tasks (due in next 15 min, not reminded) ─────
    const { data: upcoming } = await supabase
      .from("tasks")
      .select("id, title, due_time, duration_minutes, priority")
      .eq("due_date", today)
      .in("status", ["pending", "in_progress"])
      .or("reminder_sent.is.null,reminder_sent.eq.false")
      .gte("due_time", nowTime)
      .lte("due_time", in15)
      .order("due_time", { ascending: true });

    // Schedule events
    const schedEvents = getScheduleEvents(dow);
    const upcomingSched = schedEvents.filter(e => e.time >= nowTime && e.time <= in15);

    // In focus mode: only P1-P2 tasks pass through, skip schedule events
    const filteredUpcoming = focusActive
      ? (upcoming || []).filter((t: any) => (t.priority || 3) <= 2)
      : (upcoming || []);
    const filteredSched = focusActive ? [] : upcomingSched;

    if (filteredUpcoming.length > 0 || filteredSched.length > 0) {
      let msg = focusActive
        ? `<b>🔕 RAPPEL URGENT</b> — ${nowTime}\n${LINE}\n`
        : `<b>⏰ RAPPEL</b> — ${nowTime}\n${LINE}\n`;

      if (filteredUpcoming.length > 0) {
        for (const t of filteredUpcoming) {
          const p = (t.priority || 3) <= 2 ? "●" : (t.priority || 3) === 3 ? "◐" : "○";
          const dur = t.duration_minutes ? ` · ${t.duration_minutes}min` : "";
          msg += `${p} ${esc(t.title)} → <b>${t.due_time?.substring(0, 5)}</b>${dur}\n`;
        }
      }

      if (filteredSched.length > 0) {
        if (filteredUpcoming.length > 0) msg += `\n`;
        for (const e of filteredSched) {
          msg += `🚶 ${e.label} dans ${diffMin(nowTime, e.time)} min\n`;
        }
      }

      await sendTG(msg);
      reminderCount += filteredUpcoming.length + filteredSched.length;

      // Mark ALL tasks as reminded (even filtered ones, to avoid spam after focus ends)
      if (upcoming && upcoming.length > 0) {
        const ids = upcoming.map(t => t.id);
        await supabase.from("tasks").update({ reminder_sent: true }).in("id", ids);
      }
    }

    // ─── 2. MISSED tasks (due 30-90 min ago, still pending) ───────
    // Suppressed entirely during focus mode
    // DEDUP: only nudge once per task (mark nudge_sent to prevent double notifications)
    if (!focusActive) {
      const ago30 = timeStr(addMinutes(now, -90));
      const ago0 = timeStr(addMinutes(now, -30));

      const { data: missed } = await supabase
        .from("tasks")
        .select("id, title, due_time, priority, reschedule_count, urgency_level")
        .eq("due_date", today)
        .in("status", ["pending", "in_progress"])
        .or("reminder_sent.is.null,reminder_sent.eq.false")
        .gte("due_time", ago30)
        .lte("due_time", ago0)
        .order("due_time", { ascending: true })
        .limit(3);

      if (missed && missed.length > 0) {
        let nudgeMsg = `<b>👀 CHECK-IN</b> — ${nowTime}\n${LINE}\n`;
        nudgeMsg += `Tu as ${missed.length} tâche(s) en retard:\n\n`;

        const buttons: any[][] = [];

        for (const t of missed) {
          const delay = diffMin(t.due_time?.substring(0, 5) || nowTime, nowTime);
          const rBadge = t.urgency_level === "critique" ? "🔴" : t.urgency_level === "urgent" ? "🟠" : t.urgency_level === "attention" ? "🟡" : "";
          const rInfo = (t.reschedule_count || 0) > 0 ? ` (report x${t.reschedule_count})` : "";
          nudgeMsg += `⚠️ ${rBadge}${esc(t.title)} — <b>${delay}min</b> retard${rInfo}\n`;

          buttons.push([
            { text: `✅ Fait`, callback_data: `tdone_${t.id}` },
            { text: `⏰ +30min`, callback_data: `tsnz_${t.id}` },
            { text: `📅 Demain`, callback_data: `tmrw_${t.id}` },
          ]);
        }

        nudgeMsg += `\nQu'est-ce qui bloque ?`;
        await sendTG(nudgeMsg, buttons);
        reminderCount += missed.length;

        // Mark missed tasks as reminded to prevent duplicate nudges
        const missedIds = missed.map((t: any) => t.id);
        await supabase.from("tasks").update({ reminder_sent: true }).in("id", missedIds);
      }
    }

    // ─── 3. IDLE CHECK (no task activity for 2+ hours) ────────────
    // Suppressed entirely during focus mode
    const hour = now.getHours();
    if (!focusActive && dow !== 6 && hour >= 8 && hour <= 21) {
      // Check if any task was completed in the last 2 hours
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const { data: recentDone } = await supabase
        .from("tasks")
        .select("id")
        .eq("status", "completed")
        .gte("updated_at", twoHoursAgo)
        .limit(1);

      // Check if there are pending tasks today
      const { data: pendingToday } = await supabase
        .from("tasks")
        .select("id, title, priority")
        .eq("due_date", today)
        .in("status", ["pending", "in_progress"])
        .order("priority", { ascending: true })
        .limit(1);

      if ((!recentDone || recentDone.length === 0) && pendingToday && pendingToday.length > 0) {
        // Only send idle nudge once per 2h block (check minutes)
        const min = now.getMinutes();
        if (min >= 0 && min < 15) {
          const nextTask = pendingToday[0];
          let idleMsg = `<b>💪 NUDGE</b>\n`;
          idleMsg += `Rien complété depuis 2h. Ta prochaine tâche :\n\n`;
          idleMsg += `→ <b>${esc(nextTask.title)}</b>\n\n`;
          idleMsg += `Commence par 5 minutes. C'est tout.`;

          await sendTG(idleMsg, [
            [
              { text: "✅ J'y suis", callback_data: `tstart_${nextTask.id}` },
              { text: "⏰ +1h", callback_data: `tsnz1h_${nextTask.id}` },
            ],
          ]);
          reminderCount++;
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, reminders: reminderCount }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Reminder error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
