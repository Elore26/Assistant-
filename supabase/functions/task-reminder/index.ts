// ============================================
// OREN — Task Reminder (ADHD-friendly v2)
// Max 3 TG messages/day: P1-P2 upcoming, P1 missed (1x), pomodoro
// Background: recurring spawner, CIR interview alerts
// REMOVED: idle nudge, career check, score preview, rock alerts, inbox, effectiveness backfill
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { getIsraelNow, todayStr, timeStr } from "../_shared/timezone.ts";
import { sendTG, escHTML } from "../_shared/telegram.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const LINE = "━━━━━━━━━━━━━━━━━━━━";

function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60000);
}

function diffMin(from: string, to: string): number {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  return (th * 60 + tm) - (fh * 60 + fm);
}

// Schedule events for reminder (commute alerts)
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

serve(async (_req: Request) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = getIsraelNow();
    const today = todayStr();
    const nowTime = timeStr(now);
    const in15 = timeStr(addMinutes(now, 15));
    const dow = now.getDay();
    const hour = now.getHours();

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

    // ─── 1. UPCOMING P1-P2 tasks (due in next 15 min) ────────────
    const { data: upcoming } = await supabase
      .from("tasks")
      .select("id, title, due_time, duration_minutes, priority")
      .eq("due_date", today)
      .in("status", ["pending", "in_progress"])
      .or("reminder_sent.is.null,reminder_sent.eq.false")
      .gte("due_time", nowTime)
      .lte("due_time", in15)
      .order("due_time", { ascending: true });

    // Schedule events (commute)
    const schedEvents = getScheduleEvents(dow);
    const upcomingSched = focusActive ? [] : schedEvents.filter(e => e.time >= nowTime && e.time <= in15);

    // ADHD: always filter to P1-P2 only — no low-priority noise
    const filteredUpcoming = (upcoming || []).filter((t: any) => (t.priority || 3) <= 2);

    if (filteredUpcoming.length > 0 || upcomingSched.length > 0) {
      let msg = `<b>⏰ RAPPEL</b> — ${nowTime}\n${LINE}\n`;

      for (const t of filteredUpcoming) {
        const dur = t.duration_minutes ? ` · ${t.duration_minutes}min` : "";
        msg += `● ${escHTML(t.title)} → <b>${t.due_time?.substring(0, 5)}</b>${dur}\n`;
      }

      if (upcomingSched.length > 0) {
        if (filteredUpcoming.length > 0) msg += `\n`;
        for (const e of upcomingSched) {
          msg += `🚶 ${e.label} dans ${diffMin(nowTime, e.time)} min\n`;
        }
      }

      await sendTG(msg);
      reminderCount += filteredUpcoming.length + upcomingSched.length;
    }

    // Mark ALL tasks as reminded (prevent spam when priority filter skips them)
    if (upcoming && upcoming.length > 0) {
      const ids = upcoming.map(t => t.id);
      await supabase.from("tasks").update({ reminder_sent: true }).in("id", ids);
    }

    // ─── 2. MISSED P1 tasks (1x/day max) ─────────────────────────
    // Only P1 tasks, only once per day, no guilt — just quick action buttons
    if (!focusActive && dow !== 6 && hour >= 10 && hour <= 20 && now.getMinutes() < 15) {
      try {
        // Dedup: only 1 missed nudge per day
        const { data: missedNudge } = await supabase.from("agent_executions")
          .select("id").eq("agent_name", "task-reminder-missed")
          .gte("executed_at", today + "T00:00:00").limit(1);

        if (!missedNudge || missedNudge.length === 0) {
          const ago30 = timeStr(addMinutes(now, -120));
          const ago0 = timeStr(addMinutes(now, -30));

          const { data: missed } = await supabase
            .from("tasks")
            .select("id, title, due_time, priority, reschedule_count")
            .eq("due_date", today)
            .in("status", ["pending", "in_progress"])
            .lte("priority", 1) // P1 only
            .gte("due_time", ago30)
            .lte("due_time", ago0)
            .order("due_time", { ascending: true })
            .limit(3);

          if (missed && missed.length > 0) {
            let nudgeMsg = `<b>⚠️ P1 EN RETARD</b>\n`;
            const buttons: any[][] = [];

            for (const t of missed) {
              const delay = diffMin(t.due_time?.substring(0, 5) || nowTime, nowTime);
              nudgeMsg += `→ ${escHTML(t.title)} · ${delay}min\n`;
              buttons.push([
                { text: `✅ Fait`, callback_data: `tdone_${t.id}` },
                { text: `⏰ +30min`, callback_data: `tsnz_${t.id}` },
                { text: `📅 Demain`, callback_data: `tmrw_${t.id}` },
              ]);
            }

            await sendTG(nudgeMsg, { buttons });
            reminderCount += missed.length;

            await supabase.from("agent_executions").insert({
              agent_name: "task-reminder-missed",
              executed_at: new Date().toISOString(),
              result_summary: `Missed nudge: ${missed.length} P1 tasks`,
            }).catch(() => {});
          }
        }
      } catch (e) { console.error("[Missed] Error:", e); }
    }

    // ─── 2b. "1 SEULE CHOSE" — 10h nudge if nothing done yet ────
    if (!focusActive && dow !== 6 && hour === 10 && now.getMinutes() < 15) {
      try {
        const { data: doneToday } = await supabase.from("tasks")
          .select("id").eq("status", "completed")
          .gte("updated_at", today + "T00:00:00").limit(1);

        if (!doneToday || doneToday.length === 0) {
          // Find THE single most important task
          const { data: topOne } = await supabase.from("tasks")
            .select("id, title, priority")
            .eq("due_date", today)
            .in("status", ["pending", "in_progress"])
            .order("priority", { ascending: true })
            .limit(1);

          if (topOne && topOne.length > 0) {
            const t = topOne[0];
            await sendTG(`🎯 <b>1 SEULE CHOSE</b>\n\nRien fait ce matin — c'est OK.\nFais juste ça :\n\n→ <b>${escHTML(t.title)}</b>`, {
              buttons: [[
                { text: "🍅 Go (25min)", callback_data: `pomo_start_${t.id}` },
                { text: "✅ Déjà fait", callback_data: `tdone_${t.id}` },
              ]],
            });
            reminderCount++;
          }
        }
      } catch (e) { console.error("[OneTask] Error:", e); }
    }

    // ─── 3. CIR ALERTS (interviews only) ─────────────────────────
    if (dow !== 6 && hour >= 8 && hour <= 21 && now.getMinutes() < 15) {
      try {
        const { data: cirNudge } = await supabase.from("agent_executions")
          .select("id").eq("agent_name", "task-reminder-cir")
          .gte("executed_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString())
          .limit(1);

        if (!cirNudge || cirNudge.length === 0) {
          const { data: newInterviews } = await supabase.from("job_listings")
            .select("company, title")
            .eq("status", "interview")
            .gte("updated_at", today + "T00:00:00")
            .limit(3);

          if (newInterviews && newInterviews.length > 0) {
            let alertMsg = `🔴 <b>ENTRETIEN DÉTECTÉ</b>\n\n`;
            for (const job of newInterviews) {
              alertMsg += `→ ${escHTML(job.company)} — ${escHTML(job.title)}\n`;
            }
            await sendTG(alertMsg, {
              buttons: [[
                { text: "📋 Pipeline", callback_data: "menu_jobs" },
              ]],
            });
            reminderCount++;
          }

          await supabase.from("agent_executions").insert({
            agent_name: "task-reminder-cir",
            executed_at: new Date().toISOString(),
            result_summary: "CIR check",
          }).catch(() => {});
        }
      } catch (cirErr) { console.error("[CIR] Error:", cirErr); }
    }

    // ─── 4. RECURRING TASKS SPAWNER (background, no TG) ──────────
    if (hour === 21 && now.getMinutes() < 15) {
      try {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tmrwStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
        const tmrwDow = tomorrow.getDay();

        const { data: recurring } = await supabase.from("tasks")
          .select("id, title, recurrence_rule, recurrence_source_id, due_time, duration_minutes, priority, context")
          .not("recurrence_rule", "is", null)
          .in("status", ["pending", "in_progress", "completed"]);

        const templates = (recurring || []).filter((t: any) =>
          !t.recurrence_source_id || t.recurrence_source_id === t.id
        );

        for (const tmpl of templates) {
          const rule = tmpl.recurrence_rule;
          let shouldSpawn = false;

          if (rule === "daily") shouldSpawn = true;
          else if (rule === "weekdays") shouldSpawn = tmrwDow >= 1 && tmrwDow <= 5;
          else if (rule.startsWith("weekly:")) shouldSpawn = tmrwDow === parseInt(rule.split(":")[1], 10);
          else if (rule === "monthly") shouldSpawn = tomorrow.getDate() === new Date(tmpl.created_at || now).getDate();

          if (!shouldSpawn) continue;

          const { data: existing } = await supabase.from("tasks")
            .select("id").eq("recurrence_source_id", tmpl.id)
            .eq("due_date", tmrwStr).in("status", ["pending", "in_progress"]).limit(1);
          if (existing && existing.length > 0) continue;

          await supabase.from("tasks").insert({
            title: tmpl.title,
            status: "pending",
            priority: tmpl.priority || 3,
            due_date: tmrwStr,
            due_time: tmpl.due_time || null,
            duration_minutes: tmpl.duration_minutes || null,
            context: tmpl.context || null,
            recurrence_rule: tmpl.recurrence_rule,
            recurrence_source_id: tmpl.id,
            created_at: new Date().toISOString(),
          });
        }
      } catch (recErr) { console.error("[Recurring] Spawn error:", recErr); }

      // ─── 4b. AUTO-CLEANUP dead tasks (background, no TG) ───────
      try {
        const d14ago = new Date(now); d14ago.setDate(d14ago.getDate() - 14);
        const d14str = `${d14ago.getFullYear()}-${String(d14ago.getMonth() + 1).padStart(2, "0")}-${String(d14ago.getDate()).padStart(2, "0")}`;
        const d30ago = new Date(now); d30ago.setDate(d30ago.getDate() - 30);
        const d30str = `${d30ago.getFullYear()}-${String(d30ago.getMonth() + 1).padStart(2, "0")}-${String(d30ago.getDate()).padStart(2, "0")}`;

        // P4-P5 pending for >14 days → cancelled
        const { count: cleanedLow } = await supabase.from("tasks")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .in("status", ["pending"])
          .gte("priority", 4)
          .lte("due_date", d14str)
          .select("id", { count: "exact", head: true });

        // P3 pending for >30 days → cancelled
        const { count: cleanedMed } = await supabase.from("tasks")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .in("status", ["pending"])
          .eq("priority", 3)
          .lte("due_date", d30str)
          .select("id", { count: "exact", head: true });

        const totalCleaned = (cleanedLow || 0) + (cleanedMed || 0);
        if (totalCleaned > 0) {
          console.log(`[Cleanup] Archived ${totalCleaned} dead tasks (${cleanedLow} low-pri, ${cleanedMed} med-pri)`);
        }
      } catch (cleanErr) { console.error("[Cleanup] Error:", cleanErr); }
    }

    // ─── 5. POMODORO CHECK — notify if active session expired ────
    try {
      const { data: activePomo } = await supabase.from("pomodoro_sessions")
        .select("id, task_id, started_at, duration_minutes")
        .is("ended_at", null).eq("completed", false)
        .order("started_at", { ascending: false }).limit(1);

      if (activePomo && activePomo.length > 0) {
        const session = activePomo[0];
        const startTime = new Date(session.started_at);
        const elapsed = Math.floor((now.getTime() - startTime.getTime()) / 60000);
        const dur = session.duration_minutes || 25;

        if (elapsed >= dur && elapsed < dur + 15) {
          let taskName = "Session";
          if (session.task_id) {
            const { data: t } = await supabase.from("tasks").select("title").eq("id", session.task_id).single();
            if (t) taskName = t.title;
          }

          await supabase.from("pomodoro_sessions").update({
            ended_at: new Date().toISOString(), completed: true,
          }).eq("id", session.id);

          if (session.task_id) {
            const { data: taskData } = await supabase.from("tasks").select("pomodoro_count").eq("id", session.task_id).single();
            if (taskData) {
              await supabase.from("tasks").update({ pomodoro_count: (taskData.pomodoro_count || 0) + 1 }).eq("id", session.task_id);
            }
          }

          await sendTG(`🍅 <b>POMODORO TERMINÉ</b>\n${escHTML(taskName)}`, {
            buttons: [[
              { text: "🍅 Encore", callback_data: session.task_id ? `pomo_start_${session.task_id}` : "pomo_start_free" },
              { text: "✅ Fini", callback_data: session.task_id ? `tdone_${session.task_id}` : "menu_tasks" },
            ]],
          });
          reminderCount++;
        }
      }
    } catch (pomErr) { console.error("[Pomodoro] Check error:", pomErr); }

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
