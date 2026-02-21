// ============================================
// OREN AGENT SYSTEM — Shared Formatting Utilities
// Progress bars, trend arrows, common formatters
// ============================================

/** Visual progress bar (unicode blocks) */
export function progressBar(current: number, target: number, width = 10, start?: number, direction?: string): string {
  let ratio: number;
  if (direction === "decrease" && start !== undefined && start > target) {
    ratio = Math.max(0, Math.min(1, (start - current) / (start - target)));
  } else {
    ratio = Math.min(current / Math.max(target, 1), 1);
  }
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty) + ` ${Math.round(ratio * 100)}%`;
}

/** Simple progress bar (percentage only) */
export function simpleProgressBar(pct: number, len = 10): string {
  const filled = Math.round((pct / 100) * len);
  return "█".repeat(Math.min(filled, len)) + "░".repeat(Math.max(len - filled, 0));
}

/** Trend arrow comparing today vs average */
export function trend(today: number, weekAvg: number): string {
  if (today > weekAvg * 1.1) return "↑";
  if (today < weekAvg * 0.9) return "↓";
  return "→";
}

/** Format a number as currency (ILS) */
export function formatILS(amount: number): string {
  return `₪${Math.round(amount)}`;
}

/** Truncate string with ellipsis */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + "…";
}
