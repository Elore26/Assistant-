import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus } from "../_shared/agent-signals.ts";
import { getIsraelNow, todayStr, dateStr, weekStart, monthStart } from "../_shared/timezone.ts";
import { callOpenAI } from "../_shared/openai.ts";
import { sendTG } from "../_shared/telegram.ts";

interface StudySession {
  id?: string;
  session_date: string;
  topic: string;
  duration_minutes: number;
  notes?: string;
  created_at?: string;
}

interface LearningResource {
  id?: string;
  title: string;
  topic: string;
  type: "book" | "course" | "article" | "video" | "podcast";
  url?: string;
  status: "not_started" | "in_progress" | "completed";
  progress: number;
  notes?: string;
  created_at?: string;
}

interface StreakData {
  currentStreak: number;
  lastStudyDate?: string;
  longestStreak?: number;
}

interface WeeklyLearningData {
  totalStudyHours: number;
  topicBreakdown: Record<string, number>;
  resourcesCompleted: number;
  currentStreak: number;
}

interface FocusAreaStats {
  topic: string;
  hoursThisMonth: number;
  sessionsThisMonth: number;
  percentage: number;
}

// Timezone, OpenAI, Telegram imported from _shared modules above

async function checkTodayStudy(
  supabase: ReturnType<typeof createClient>,
  todayDate: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("study_sessions")
      .select("id")
      .eq("session_date", todayDate)
      .limit(1);

    if (error) {
      console.error("Error checking today's study:", error);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.error("Error in checkTodayStudy:", error);
    return false;
  }
}

async function calculateStudyStreak(
  supabase: ReturnType<typeof createClient>
): Promise<StreakData> {
  try {
    const { data: allSessions, error } = await supabase
      .from("study_sessions")
      .select("session_date")
      .order("session_date", { ascending: false });

    if (error || !allSessions || allSessions.length === 0) {
      console.log("No study sessions found");
      return {
        currentStreak: 0,
        longestStreak: 0,
      };
    }

    // Convert to unique dates and sort descending
    const uniqueDates = [...new Set(allSessions.map((s) => s.session_date))].sort().reverse();
    const israeliDate = getIsraelNow();
    const todayDateString = dateStr(israeliDate);
    const yesterdayDateString = dateStr(
      new Date(israeliDate.getTime() - 24 * 60 * 60 * 1000)
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;

    // Check if latest session is today or yesterday
    const startingPoint =
      uniqueDates[0] === todayDateString || uniqueDates[0] === yesterdayDateString
        ? 0
        : -1;

    for (let i = 0; i < uniqueDates.length; i++) {
      const currentIndex = i + (startingPoint === -1 ? 1 : 0);
      tempStreak++;

      // Check if dates are consecutive
      if (i < uniqueDates.length - 1) {
        const currentDate = new Date(uniqueDates[i]);
        const nextDate = new Date(uniqueDates[i + 1]);
        const dayDiff =
          Math.floor((currentDate.getTime() - nextDate.getTime()) / (24 * 60 * 60 * 1000));

        if (dayDiff !== 1) {
          longestStreak = Math.max(longestStreak, tempStreak);
          tempStreak = 0;
        }
      }
    }

    longestStreak = Math.max(longestStreak, tempStreak);

    // Current streak is from today or yesterday
    if (startingPoint !== -1) {
      currentStreak = tempStreak;
    }

    return {
      currentStreak,
      lastStudyDate: uniqueDates[0],
      longestStreak,
    };
  } catch (error) {
    console.error("Error calculating study streak:", error);
    return {
      currentStreak: 0,
      longestStreak: 0,
    };
  }
}

async function getInProgressResources(
  supabase: ReturnType<typeof createClient>
): Promise<LearningResource[]> {
  try {
    const { data, error } = await supabase
      .from("learning_resources")
      .select("*")
      .eq("status", "in_progress")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching in-progress resources:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error in getInProgressResources:", error);
    return [];
  }
}

async function getFocusAreasStats(
  supabase: ReturnType<typeof createClient>
): Promise<FocusAreaStats[]> {
  try {
    const mStart = monthStart();
    const todayDate = todayStr();
    const learningFocus = Deno.env.get("LEARNING_FOCUS") || "English,Product Management,AI";
    const focusTopics = learningFocus.split(",").map((t) => t.trim());

    const { data: sessions, error } = await supabase
      .from("study_sessions")
      .select("topic, duration_minutes")
      .gte("session_date", mStart)
      .lte("session_date", todayDate);

    if (error) {
      console.error("Error fetching study sessions:", error);
      return [];
    }

    // Aggregate by topic
    const topicStats: Record<string, { hours: number; sessions: number }> = {};
    let totalMinutes = 0;

    if (sessions) {
      sessions.forEach((session) => {
        const topic = session.topic || "Other";
        if (!topicStats[topic]) {
          topicStats[topic] = { hours: 0, sessions: 0 };
        }
        topicStats[topic].hours += session.duration_minutes / 60;
        topicStats[topic].sessions += 1;
        totalMinutes += session.duration_minutes;
      });
    }

    const totalHours = totalMinutes / 60;

    // Map to focus areas with percentages
    return focusTopics
      .map((topic) => {
        const stats = topicStats[topic] || { hours: 0, sessions: 0 };
        return {
          topic,
          hoursThisMonth: Number(stats.hours.toFixed(2)),
          sessionsThisMonth: stats.sessions,
          percentage: totalHours > 0 ? Math.round((stats.hours / totalHours) * 100) : 0,
        };
      })
      .sort((a, b) => b.hoursThisMonth - a.hoursThisMonth);
  } catch (error) {
    console.error("Error getting focus areas stats:", error);
    return [];
  }
}

async function getWeeklyLearningData(
  supabase: ReturnType<typeof createClient>
): Promise<WeeklyLearningData | null> {
  try {
    const wStart = weekStart();
    const todayDate = todayStr();

    // Get study sessions for the week
    const { data: sessions, error: sessionError } = await supabase
      .from("study_sessions")
      .select("topic, duration_minutes")
      .gte("session_date", wStart)
      .lte("session_date", todayDate);

    if (sessionError) {
      console.error("Error fetching weekly sessions:", sessionError);
      return null;
    }

    const totalStudyMinutes = sessions?.reduce((sum, s) => sum + s.duration_minutes, 0) || 0;
    const totalStudyHours = Number((totalStudyMinutes / 60).toFixed(2));

    // Topic breakdown
    const topicBreakdown: Record<string, number> = {};
    if (sessions) {
      sessions.forEach((session) => {
        const topic = session.topic || "Other";
        topicBreakdown[topic] = (topicBreakdown[topic] || 0) + session.duration_minutes / 60;
      });
    }

    // Round topic hours
    Object.keys(topicBreakdown).forEach((topic) => {
      topicBreakdown[topic] = Number(topicBreakdown[topic].toFixed(2));
    });

    // Get resources completed this week
    const { data: completedResources, error: resourceError } = await supabase
      .from("learning_resources")
      .select("id")
      .eq("status", "completed")
      .gte("created_at", wStart)
      .lte("created_at", todayDate);

    if (resourceError) {
      console.error("Error fetching completed resources:", resourceError);
      return null;
    }

    const resourcesCompleted = completedResources?.length || 0;

    // Get current streak
    const streakData = await calculateStudyStreak(supabase);

    return {
      totalStudyHours,
      topicBreakdown,
      resourcesCompleted,
      currentStreak: streakData.currentStreak,
    };
  } catch (error) {
    console.error("Error getting weekly learning data:", error);
    return null;
  }
}

function getMotivationalMessage(streak: number): string {
  if (streak >= 30) {
    return "Excellent — 30+ day streak";
  } else if (streak >= 21) {
    return "Very Good — 3 week streak";
  } else if (streak >= 14) {
    return "Good — 2 week streak";
  } else if (streak >= 7) {
    return "Solid — 1 week streak";
  } else if (streak >= 3) {
    return "Start — 3 day streak";
  } else if (streak === 1) {
    return "Today counts";
  } else {
    return "Get back on track";
  }
}

// saveAnalysis removed — was creating fake study_sessions entries with duration=0

async function processLearningAgent() {
  const signals = getSignalBus("learning");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    return {
      success: false,
      type: "error" as const,
      error: "Missing Supabase configuration",
    };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const israeliDate = getIsraelNow();
    const todayDate = dateStr(israeliDate);
    const dayOfWeek = israeliDate.getDay();
    const studiedToday = await checkTodayStudy(supabase, todayDate);
    const streakData = await calculateStudyStreak(supabase);
    const inProgressResources = await getInProgressResources(supabase);
    const focusAreaStats = await getFocusAreasStats(supabase);

    // Check if today is Sunday (0) for weekly summary
    const isSunday = dayOfWeek === 0;

    // Fetch learning goal + career skill gaps
    let learningGoal: any = null;
    let careerSkillGaps: string[] = [];
    try {
      const [goalRes, jobsRes] = await Promise.all([
        supabase.from("goals").select("*").eq("domain", "learning").eq("status", "active").limit(1),
        supabase.from("job_listings").select("title, notes").in("status", ["new", "applied"]).limit(10),
      ]);
      learningGoal = goalRes.data?.[0] || null;
      // Extract skills from job listings notes to identify gaps
      const jobNotes = (jobsRes.data || []).map((j: any) => j.notes || "").join(" ").toLowerCase();
      const skillKeywords = ["english", "hebrew", "python", "sql", "salesforce", "hubspot", "excel", "powerpoint", "negotiation", "cold calling", "crm", "saas", "product", "ai", "prompting"];
      careerSkillGaps = skillKeywords.filter(s => jobNotes.includes(s));
    } catch (_) {}

    // Update goal metric_current with monthly study hours
    if (learningGoal) {
      const mStart = monthStart();
      try {
        const { data: monthSessions } = await supabase.from("study_sessions").select("duration_minutes")
          .gte("session_date", mStart).lte("session_date", todayDate).neq("topic", "agent_analysis");
        const monthlyHours = (monthSessions || []).reduce((s: number, ss: any) => s + (Number(ss.duration_minutes) || 0), 0) / 60;
        await supabase.from("goals").update({ metric_current: Number(monthlyHours.toFixed(1)) }).eq("id", learningGoal.id);
      } catch (_) {}
    }

    let responseType = "ok";
    let sentReminder = false;
    let sentWeekly = false;

    // Daily reminder if no study session logged today
    // --- Deduplication: skip if reminder already sent today ---
    let reminderAlreadySent = false;
    if (!studiedToday) {
      try {
        const { data: existing } = await supabase.from("agent_executions")
          .select("id").eq("agent_name", "learning-agent-daily")
          .gte("executed_at", todayDate + "T00:00:00").limit(1);
        if (existing && existing.length > 0) {
          console.log(`[Learning] Daily reminder already sent (${todayDate}), skipping`);
          reminderAlreadySent = true;
        }
      } catch (_) {}
    }
    if (!studiedToday && !reminderAlreadySent) {
      // --- Consume Inter-Agent Signals ---
      let careerUrgency = "";
      let skillGapHints: string[] = [];
      try {
        // Check for skill gaps from career agent
        const skillGaps = await signals.consume({
          types: ["skill_gap"],
          markConsumed: false, // peek only, career keeps them active
        });
        if (skillGaps.length > 0) {
          skillGapHints = skillGaps.map(s => s.message);
          careerUrgency += `\n📌 Career agent détecte:\n`;
          for (const sg of skillGaps.slice(0, 3)) {
            careerUrgency += `  → ${sg.message}\n`;
          }
        }

        // Check for interview urgency
        const interviews = await signals.peek({
          types: ["interview_scheduled"],
          hoursBack: 72,
        });
        if (interviews.length > 0) {
          careerUrgency += `\n🔴 URGENCE INTERVIEW:\n`;
          for (const iv of interviews) {
            const companies = iv.payload?.companies || [];
            careerUrgency += `  → ${iv.message} (${companies.join(", ")})\n`;
          }
          careerUrgency += `  → Priorise: English, negotiation, product knowledge\n`;
        }
      } catch (sigErr) {
        console.error("[Signals] Learning consume error:", sigErr);
      }

      let reminderMessage = `LEARNING — Reminder\n`;
      reminderMessage += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      reminderMessage += `Streak  ${streakData.currentStreak} days\n`;
      reminderMessage += `Record  ${streakData.longestStreak} days\n\n`;
      reminderMessage += `No study logged today. Keep your streak alive.`;

      // Add career urgency signals to message
      reminderMessage += careerUrgency;

      // AI motivational nudge removed — saves ~80 tokens/day, static streak message is enough for TDAH

      // Add concrete suggestion based on career skill gaps (no AI needed)
      if (careerSkillGaps.length > 0) {
        reminderMessage += `\n\n🎯 Suggestion: ${careerSkillGaps.slice(0, 2).join(" ou ")} (demandé dans tes candidatures)`;
      }

      sentReminder = await sendTG(reminderMessage);
      responseType = "reminder";

      // Log execution for dedup
      try {
        await supabase.from("agent_executions").insert({
          agent_name: "learning-agent-daily",
          executed_at: new Date().toISOString(),
          result_summary: `Reminder sent: streak ${streakData.currentStreak}d`,
        });
      } catch (_) {}
    }

    // Weekly summary on Sunday
    if (isSunday) {
      const weeklyData = await getWeeklyLearningData(supabase);

      if (weeklyData) {
        let weeklyMessage = `LEARNING — Semaine\n`;
        weeklyMessage += `━━━━━━━━━━━━━━━━━━━━\n`;
        weeklyMessage += `Etude   ${weeklyData.totalStudyHours}h · Streak ${weeklyData.currentStreak} jours\n`;
        weeklyMessage += `Ressources completees: ${weeklyData.resourcesCompleted}\n\n`;

        weeklyMessage += `Par sujet:\n`;
        const topicsList: Array<[string, number]> = [];
        Object.entries(weeklyData.topicBreakdown)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .forEach(([topic, hours]) => {
            weeklyMessage += `— ${topic} · ${hours}h\n`;
            topicsList.push([topic, hours]);
          });

        // Add AI study recommendations
        const topicsStr = focusAreaStats.map((s) => s.topic).join(", ");
        const topicBreakdownStr = topicsList.map(([t, h]) => `${t}: ${h}h`).join(", ");
        const skillGapContext = careerSkillGaps.length > 0
          ? `\nCompétences demandées dans ses candidatures: ${careerSkillGaps.join(", ")}`
          : "";
        const goalContext = learningGoal
          ? `\nObjectif: ${learningGoal.metric_current || 0}/${learningGoal.metric_target}h ce mois (deadline: ${learningGoal.deadline || "N/A"})`
          : "";
        const aiPrompt = `Tu es tuteur personnel d'Oren. Il cherche un poste AE/SDR en tech/SaaS en Israël.
Il étudie: ${topicsStr}. Cette semaine: ${topicBreakdownStr}. ${weeklyData.resourcesCompleted} ressources complétées.${skillGapContext}${goalContext}
Donne: 1) Compétence PRIORITAIRE à travailler (liée à ses candidatures) 2) Ressource concrète (nom, type, durée) 3) Objectif semaine prochaine (heures + sujet) 4) Si lacune détectée → plan d'action. Max 5 lignes, français, SPÉCIFIQUE.`;

        const aiRecommendations = await callOpenAI(
          "Tu es tuteur personnel expérimenté. Analyse les progrès d'apprentissage et donne des recommandations concrètes.",
          aiPrompt,
          200
        );

        if (aiRecommendations) {
          weeklyMessage += `\n\n💡 Recommandations IA:\n${aiRecommendations}`;
        }

        sentWeekly = await sendTG(weeklyMessage);
        responseType = "weekly";
      }
    }

    // saveAnalysis calls removed — was polluting study_sessions with fake duration=0 entries

    // --- Auto-create learning tasks from skill-gap signals ---
    try {
      const skillGapSignals = await signals.consume({
        types: ["skill_gap"],
        markConsumed: true,
      });

      for (const sig of skillGapSignals) {
        const skill = sig.payload?.skill || sig.message;
        const pct = sig.payload?.percentage || 0;

        // Only create tasks for skills demanded in 20%+ of jobs
        if (pct < 20) continue;

        // Check if a learning task for this skill already exists
        const { data: existingTask } = await supabase.from("tasks")
          .select("id").eq("context", `skill_gap_${skill}`)
          .in("status", ["pending", "in_progress"]).limit(1);

        if (existingTask && existingTask.length > 0) continue;

        // Create the learning task
        const taskTitle = `📚 Apprendre ${skill} (demandé dans ${pct}% des offres)`;
        await supabase.from("tasks").insert({
          title: taskTitle,
          status: "pending",
          priority: 2,
          agent_type: "learning",
          context: `skill_gap_${skill}`,
          due_date: todayDate,
          duration_minutes: 30,
          created_at: new Date().toISOString(),
        });
        console.log(`[Learning] Auto-created task for skill gap: ${skill} (${pct}%)`);
      }

      // Also check for interview_scheduled signals to prioritize English/negotiation
      const interviewSignals = await signals.peek({
        types: ["interview_scheduled"],
        hoursBack: 72,
      });

      if (interviewSignals.length > 0) {
        const companies = interviewSignals.flatMap(s => s.payload?.companies || []);
        const interviewPrepSkills = ["English", "Négociation", "Pitch"];

        for (const skill of interviewPrepSkills) {
          const { data: existingPrep } = await supabase.from("tasks")
            .select("id").eq("context", `interview_skill_${skill.toLowerCase()}`)
            .in("status", ["pending", "in_progress"]).limit(1);

          if (existingPrep && existingPrep.length > 0) continue;

          await supabase.from("tasks").insert({
            title: `🎯 Pratiquer ${skill} (interview ${companies[0] || "prochaine"})`,
            status: "pending",
            priority: 1,
            agent_type: "learning",
            context: `interview_skill_${skill.toLowerCase()}`,
            due_date: todayDate,
            duration_minutes: 20,
            created_at: new Date().toISOString(),
          });
          console.log(`[Learning] Auto-created interview prep task: ${skill}`);
        }
      }
    } catch (skillErr) {
      console.error("[Learning] Skill gap task creation error:", skillErr);
    }

    // --- Emit Inter-Agent Signals ---
    try {
      const streak = streakData.currentStreak;
      const todayStudy = await checkTodayStudy(supabase, todayDate);

      // Emit study streak signal
      if (streak >= 3) {
        await signals.emit("study_streak", `Streak étude: ${streak} jours consécutifs`, {
          streak, todayMinutes: todayStudy ? 1 : 0,
        }, { priority: 4, ttlHours: 24 });
      }

      // Check for completed resources
      const { data: recentCompleted } = await supabase.from("learning_resources")
        .select("title, topic")
        .eq("status", "completed")
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(3);
      if (recentCompleted && recentCompleted.length > 0) {
        for (const res of recentCompleted) {
          await signals.emit("resource_completed", `Ressource terminée: ${res.title}`, {
            title: res.title, topic: res.topic,
          }, { priority: 3, ttlHours: 48 });
        }
      }
    } catch (sigErr) {
      console.error("[Signals] Learning emit error:", sigErr);
    }

    return {
      success: true,
      type: responseType,
      streak: streakData.currentStreak,
      studied_today: studiedToday,
      in_progress_resources: inProgressResources.length,
      weekly_hours: isSunday
        ? (await getWeeklyLearningData(supabase))?.totalStudyHours || 0
        : undefined,
      reminder_sent: sentReminder,
      weekly_sent: sentWeekly,
      timestamp: todayDate,
    };
  } catch (error) {
    console.error("Learning Agent Error:", error);
    return {
      success: false,
      type: "error" as const,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

serve(async (req) => {
  // Only accept POST requests
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await processLearningAgent();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Server error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
