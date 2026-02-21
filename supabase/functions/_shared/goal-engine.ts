// ============================================
// OREN AGENT SYSTEM — Goal Intelligence Engine
// Smart goal prioritization, velocity tracking,
// cross-domain analysis, and auto-nudges
// ============================================

export interface GoalRanked {
  domain: string;
  title: string;
  current: number;
  target: number;
  start: number;
  direction: string;
  unit: string;
  daysLeft: number;
  progressPct: number;
  expectedPct: number;
  gap: number; // positive = behind, negative = ahead
  urgencyScore: number; // 0-100: higher = more urgent
  requiredDailyPace: number;
  currentDailyPace: number;
  onTrack: boolean;
  riskLevel: "safe" | "watch" | "danger" | "critical";
  dailyActions: string[];
  deadline: string | null;
  priority: number;
}

/**
 * Rank goals by urgency: combines deadline proximity, off-track %, and priority.
 * Returns goals sorted from most urgent to least.
 */
export function rankGoals(goals: any[], now: Date = new Date()): GoalRanked[] {
  return goals.map((g: any) => {
    const current = Number(g.metric_current) || 0;
    const target = Number(g.metric_target) || 1;
    const start = Number(g.metric_start) || 0;
    const isDecrease = g.direction === "decrease";
    const deadline = g.deadline ? new Date(g.deadline) : null;
    const daysLeft = deadline
      ? Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 86400000))
      : 999;

    // Progress calculation (handles increase and decrease)
    let progressPct: number;
    if (isDecrease && start > target) {
      progressPct = Math.max(0, Math.min(100, ((start - current) / (start - target)) * 100));
    } else {
      progressPct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    }

    // Expected progress based on elapsed time
    const goalStartDate = g.created_at ? new Date(g.created_at) : new Date(now.getTime() - 90 * 86400000);
    const totalDays = deadline
      ? Math.max(1, Math.ceil((deadline.getTime() - goalStartDate.getTime()) / 86400000))
      : 120;
    const elapsed = Math.max(1, totalDays - daysLeft);
    const expectedPct = Math.min(100, Math.round((elapsed / totalDays) * 100));
    const gap = expectedPct - progressPct; // positive = behind schedule

    // Velocity: current pace vs required pace
    let remaining: number;
    if (isDecrease && start > target) {
      remaining = Math.max(0, current - target);
    } else {
      remaining = Math.max(0, target - current);
    }
    const requiredDailyPace = daysLeft > 0 ? remaining / daysLeft : remaining;
    const currentDailyPace = elapsed > 0 ? (isDecrease ? (start - current) : current) / elapsed : 0;

    // On-track: within 80% of expected progress
    const onTrack = progressPct >= expectedPct * 0.8;

    // Urgency score: 0-100
    // Factors: deadline proximity (40%), gap behind (30%), priority (20%), absolute progress (10%)
    const deadlineUrgency = daysLeft < 7 ? 40 : daysLeft < 14 ? 30 : daysLeft < 30 ? 20 : daysLeft < 60 ? 10 : 0;
    const gapUrgency = Math.min(30, Math.max(0, gap * 0.6));
    const priorityUrgency = (6 - Math.min(g.priority || 3, 5)) * 4; // P1=20, P5=4
    const progressUrgency = progressPct < 25 ? 10 : progressPct < 50 ? 5 : 0;
    const urgencyScore = Math.min(100, Math.round(deadlineUrgency + gapUrgency + priorityUrgency + progressUrgency));

    // Risk level
    let riskLevel: "safe" | "watch" | "danger" | "critical";
    if (daysLeft <= 0 && progressPct < 100) riskLevel = "critical";
    else if (daysLeft <= 7 && gap > 20) riskLevel = "critical";
    else if (gap > 30 || (daysLeft <= 14 && gap > 10)) riskLevel = "danger";
    else if (gap > 10 || !onTrack) riskLevel = "watch";
    else riskLevel = "safe";

    return {
      domain: g.domain,
      title: g.title,
      current: Math.round(current * 10) / 10,
      target,
      start,
      direction: g.direction || "increase",
      unit: g.metric_unit || "",
      daysLeft,
      progressPct: Math.round(progressPct),
      expectedPct,
      gap: Math.round(gap),
      urgencyScore,
      requiredDailyPace: Math.round(requiredDailyPace * 10) / 10,
      currentDailyPace: Math.round(currentDailyPace * 10) / 10,
      onTrack,
      riskLevel,
      dailyActions: Array.isArray(g.daily_actions) ? g.daily_actions : [],
      deadline: g.deadline || null,
      priority: g.priority || 3,
    };
  }).sort((a, b) => b.urgencyScore - a.urgencyScore);
}

/**
 * Generate missing daily action tasks for the most urgent goals.
 * Returns task objects ready to insert.
 */
export function generateGoalNudges(
  rankedGoals: GoalRanked[],
  completedTaskTitles: string[],
  today: string,
): Array<{ title: string; domain: string; priority: number; due_date: string; context: string }> {
  const nudges: Array<{ title: string; domain: string; priority: number; due_date: string; context: string }> = [];
  const lowerTitles = completedTaskTitles.map(t => t.toLowerCase());

  // Only process top 3 most urgent goals with daily actions
  const goalsWithActions = rankedGoals.filter(g => g.dailyActions.length > 0).slice(0, 3);

  for (const goal of goalsWithActions) {
    for (const action of goal.dailyActions) {
      const actionLower = action.toLowerCase();
      const alreadyDone = lowerTitles.some(t => t.includes(actionLower.substring(0, 15)));
      if (!alreadyDone) {
        nudges.push({
          title: `🎯 ${action}`,
          domain: goal.domain,
          priority: goal.riskLevel === "critical" ? 1 : goal.riskLevel === "danger" ? 2 : 3,
          due_date: today,
          context: `goal_nudge_${goal.domain}`,
        });
      }
    }
  }

  return nudges;
}

/**
 * Analyze 7-day trend from daily_brain history.
 * Returns pattern insights.
 */
export function analyzeBrainTrend(brainHistory: any[]): {
  dominantDomain: string | null;
  urgenceDays: number;
  pattern: string;
  stuckDomains: string[];
} {
  if (brainHistory.length < 3) {
    return { dominantDomain: null, urgenceDays: 0, pattern: "insufficient_data", stuckDomains: [] };
  }

  const domainCounts: Record<string, number> = {};
  let urgenceDays = 0;

  for (const day of brainHistory) {
    const d = day.priority_domain || "unknown";
    domainCounts[d] = (domainCounts[d] || 0) + 1;
    if (day.daily_mode === "urgence") urgenceDays++;
  }

  const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
  const dominantDomain = sorted[0]?.[0] || null;
  const dominantCount = sorted[0]?.[1] || 0;

  // Stuck if same domain is priority 5+ of 7 days
  const stuckDomains = sorted
    .filter(([, count]) => count >= 5)
    .map(([domain]) => domain);

  let pattern: string;
  if (urgenceDays >= 5) pattern = "chronic_urgence";
  else if (dominantCount >= 5) pattern = "stuck_on_domain";
  else if (urgenceDays >= 3) pattern = "frequent_urgence";
  else pattern = "balanced";

  return { dominantDomain, urgenceDays, pattern, stuckDomains };
}

/**
 * Detect goal-rock alignment issues.
 * Returns rocks that should be linked to goals but aren't progressing together.
 */
export function detectGoalRockMisalignment(
  rankedGoals: GoalRanked[],
  rocks: any[],
): Array<{ rockTitle: string; goalTitle: string; issue: string }> {
  const issues: Array<{ rockTitle: string; goalTitle: string; issue: string }> = [];

  for (const rock of rocks) {
    const matchingGoal = rankedGoals.find(g => g.domain === rock.domain);
    if (!matchingGoal) continue;

    // Rock on-track but goal off-track (or vice versa)
    if (rock.current_status === "on_track" && matchingGoal.riskLevel === "danger") {
      issues.push({
        rockTitle: rock.title,
        goalTitle: matchingGoal.title,
        issue: `Rock ✅ mais Goal ⚠️ en retard (${matchingGoal.gap}% gap)`,
      });
    }
    if (rock.current_status === "off_track" && matchingGoal.onTrack) {
      issues.push({
        rockTitle: rock.title,
        goalTitle: matchingGoal.title,
        issue: `Rock ⚠️ OFF mais Goal ok — vérifier la cohérence`,
      });
    }
  }

  return issues;
}

/**
 * Build a compact goal intelligence summary for AI context.
 * Used to feed the brain/coach with richer data.
 */
export function buildGoalIntelligenceContext(
  rankedGoals: GoalRanked[],
  trendData: ReturnType<typeof analyzeBrainTrend>,
  misalignments: ReturnType<typeof detectGoalRockMisalignment>,
): string {
  const lines: string[] = [];

  // Top 3 most urgent goals with velocity
  const top3 = rankedGoals.slice(0, 3);
  for (const g of top3) {
    const risk = g.riskLevel === "critical" ? "🔴" : g.riskLevel === "danger" ? "🟠" : g.riskLevel === "watch" ? "🟡" : "🟢";
    lines.push(`${risk} ${g.domain}: ${g.title} — ${g.progressPct}% (attendu ${g.expectedPct}%) · pace ${g.currentDailyPace}/j (requis ${g.requiredDailyPace}/j) · J-${g.daysLeft}`);
  }

  // Trend insight
  if (trendData.pattern === "chronic_urgence") {
    lines.push(`⚠️ PATTERN: Mode urgence ${trendData.urgenceDays}/7 jours — risque de burnout`);
  } else if (trendData.pattern === "stuck_on_domain") {
    lines.push(`⚠️ PATTERN: Bloqué sur ${trendData.dominantDomain} depuis ${trendData.stuckDomains.length > 0 ? "5+ jours" : "plusieurs jours"}`);
  }

  // Misalignments
  if (misalignments.length > 0) {
    lines.push(`⚠️ MISALIGNMENT: ${misalignments[0].issue}`);
  }

  return lines.join("\n");
}

const RISK_EMOJI: Record<string, string> = {
  critical: "🔴", danger: "🟠", watch: "🟡", safe: "🟢",
};

/**
 * Format goal intelligence for Telegram display.
 */
export function formatGoalIntelligence(rankedGoals: GoalRanked[]): string {
  if (rankedGoals.length === 0) return "Aucun objectif actif.";

  const lines: string[] = ["<b>🎯 OBJECTIFS — Intelligence</b>\n"];

  for (const g of rankedGoals) {
    const emoji = RISK_EMOJI[g.riskLevel] || "⚪";
    const paceInfo = g.daysLeft < 999
      ? ` · pace ${g.currentDailyPace}/j (requis ${g.requiredDailyPace}/j)`
      : "";
    const daysInfo = g.daysLeft < 999 ? ` · J-${g.daysLeft}` : "";

    lines.push(`${emoji} <b>${g.title}</b>`);
    lines.push(`   ${g.current}/${g.target}${g.unit} — ${g.progressPct}% (attendu ${g.expectedPct}%)${paceInfo}${daysInfo}`);

    if (g.riskLevel === "critical") {
      lines.push(`   ⚡ ACTION REQUISE — en retard de ${g.gap}%`);
    } else if (g.riskLevel === "danger") {
      lines.push(`   ⚠️ En retard de ${g.gap}% — accélérer`);
    }
  }

  const criticals = rankedGoals.filter(g => g.riskLevel === "critical").length;
  const dangers = rankedGoals.filter(g => g.riskLevel === "danger").length;
  const safes = rankedGoals.filter(g => g.riskLevel === "safe").length;

  lines.push(`\n${safes} on track · ${dangers} en retard · ${criticals} critiques`);

  return lines.join("\n");
}
