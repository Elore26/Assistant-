// ============================================
// OREN AGENT SYSTEM — Shared Timezone Utilities
// All agents MUST use these instead of local copies
// Handles DST automatically via Asia/Jerusalem
// ============================================

/** Get current date in Israel timezone (handles DST) */
export function getIsraelNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
}

/** Get Israel date as YYYY-MM-DD string */
export function todayStr(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format any date as YYYY-MM-DD */
export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get date N days ago as YYYY-MM-DD */
export function daysAgo(n: number): string {
  const d = new Date(getIsraelNow().getTime() - n * 86400000);
  return dateStr(d);
}

/** Get first day of current month as YYYY-MM-DD */
export function monthStart(): string {
  const d = getIsraelNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Get Monday of current week as YYYY-MM-DD */
export function weekStart(): string {
  const d = getIsraelNow();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const ws = new Date(d.getFullYear(), d.getMonth(), diff);
  return dateStr(ws);
}

/** Format time as HH:MM */
export function timeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Day names in French */
export const DAYS_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
