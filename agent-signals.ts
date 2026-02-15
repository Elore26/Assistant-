// ============================================
// OREN AGENT SYSTEM - Inter-Agent Signal Bus
// Shared module for agent-to-agent communication
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ──────────────────────────────────────────────────────────────

export type AgentName =
  | "career" | "higrow" | "trading" | "health" | "learning" | "finance"
  | "morning-briefing" | "evening-review" | "task-reminder" | "telegram-bot";

export type SignalType =
  // Career → Learning
  | "skill_gap" | "interview_scheduled" | "rejection_pattern"
  // Health → All
  | "low_sleep" | "recovery_status" | "workout_completed" | "streak_at_risk"
  // Finance → All
  | "budget_alert" | "cash_gap" | "savings_on_track" | "overspending"
  // Trading → Finance/Review
  | "signal_active" | "signal_hit_tp" | "signal_hit_sl" | "high_volatility"
  // Learning → Career/Review
  | "study_streak" | "resource_completed" | "skill_improved"
  // Higrow → Review
  | "lead_converted" | "pipeline_velocity" | "stuck_deal"
  // Evening → Morning
  | "daily_score" | "weak_domain" | "pattern_detected"
  // Morning → Reminder
  | "high_priority_day" | "commute_delay"
  // Telegram → Reminder (Focus mode)
  | "focus_mode_active" | "focus_mode_ended";

export interface Signal {
  id?: string;
  source_agent: AgentName;
  target_agent: AgentName | null;
  signal_type: SignalType;
  priority: number;
  payload: Record<string, any>;
  message: string;
  status?: string;
  expires_at?: string;
  created_at?: string;
}

// ─── Signal Bus Class ───────────────────────────────────────────────────

export class AgentSignalBus {
  private supabase: ReturnType<typeof createClient>;
  private agentName: AgentName;

  constructor(agentName: AgentName) {
    this.agentName = agentName;
    this.supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );
  }

  // ─── EMIT a signal ──────────────────────────────────────────────
  async emit(
    signalType: SignalType,
    message: string,
    payload: Record<string, any> = {},
    opts: {
      target?: AgentName | null;
      priority?: number;
      ttlHours?: number;
    } = {}
  ): Promise<string | null> {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + (opts.ttlHours || 24));

      const { data, error } = await this.supabase.from("agent_signals").insert({
        source_agent: this.agentName,
        target_agent: opts.target || null,
        signal_type: signalType,
        priority: opts.priority || 3,
        payload,
        message,
        status: "active",
        expires_at: expiresAt.toISOString(),
      }).select("id").single();

      if (error) {
        console.error(`[SignalBus] Emit error:`, error.message);
        return null;
      }

      console.log(`[SignalBus] ${this.agentName} → ${signalType}: ${message}`);
      return data?.id || null;
    } catch (e) {
      console.error(`[SignalBus] Emit exception:`, e);
      return null;
    }
  }

  // ─── CONSUME signals targeted at this agent ─────────────────────
  async consume(opts: {
    types?: SignalType[];
    minPriority?: number;
    limit?: number;
    markConsumed?: boolean;
  } = {}): Promise<Signal[]> {
    try {
      let query = this.supabase.from("agent_signals")
        .select("*")
        .eq("status", "active")
        .or(`target_agent.eq.${this.agentName},target_agent.is.null`)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(opts.limit || 20);

      if (opts.types && opts.types.length > 0) {
        query = query.in("signal_type", opts.types);
      }
      if (opts.minPriority) {
        query = query.lte("priority", opts.minPriority);
      }

      const { data, error } = await query;
      if (error) {
        console.error(`[SignalBus] Consume error:`, error.message);
        return [];
      }

      const signals = (data || []) as Signal[];

      // Mark as consumed if requested
      if (opts.markConsumed && signals.length > 0) {
        const ids = signals.map(s => s.id).filter(Boolean);
        if (ids.length > 0) {
          await this.supabase.from("agent_signals")
            .update({
              status: "consumed",
              consumed_by: this.agentName,
              consumed_at: new Date().toISOString(),
            })
            .in("id", ids);
        }
      }

      console.log(`[SignalBus] ${this.agentName} consumed ${signals.length} signals`);
      return signals;
    } catch (e) {
      console.error(`[SignalBus] Consume exception:`, e);
      return [];
    }
  }

  // ─── PEEK at signals without consuming ──────────────────────────
  async peek(opts: {
    types?: SignalType[];
    source?: AgentName;
    hoursBack?: number;
    limit?: number;
  } = {}): Promise<Signal[]> {
    try {
      const since = new Date();
      since.setHours(since.getHours() - (opts.hoursBack || 24));

      let query = this.supabase.from("agent_signals")
        .select("*")
        .eq("status", "active")
        .gte("created_at", since.toISOString())
        .order("priority", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(opts.limit || 10);

      if (opts.types && opts.types.length > 0) {
        query = query.in("signal_type", opts.types);
      }
      if (opts.source) {
        query = query.eq("source_agent", opts.source);
      }

      const { data, error } = await query;
      if (error) return [];
      return (data || []) as Signal[];
    } catch { return []; }
  }

  // ─── DISMISS a signal ───────────────────────────────────────────
  async dismiss(signalId: string): Promise<void> {
    await this.supabase.from("agent_signals")
      .update({ status: "dismissed", consumed_by: this.agentName })
      .eq("id", signalId);
  }

  // ─── CHECK if a specific signal type exists (recent) ────────────
  async hasRecent(signalType: SignalType, hoursBack = 24): Promise<boolean> {
    const since = new Date();
    since.setHours(since.getHours() - hoursBack);

    const { data } = await this.supabase.from("agent_signals")
      .select("id")
      .eq("signal_type", signalType)
      .eq("status", "active")
      .gte("created_at", since.toISOString())
      .limit(1);

    return (data?.length || 0) > 0;
  }

  // ─── GET latest signal of a type ────────────────────────────────
  async getLatest(signalType: SignalType): Promise<Signal | null> {
    const { data } = await this.supabase.from("agent_signals")
      .select("*")
      .eq("signal_type", signalType)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1);

    return data?.[0] as Signal || null;
  }

  // ─── SUMMARY of all active signals (for briefings) ──────────────
  async getActiveSummary(): Promise<{
    total: number;
    critical: Signal[];
    bySource: Record<string, number>;
    byType: Record<string, number>;
  }> {
    const signals = await this.peek({ hoursBack: 24, limit: 50 });

    const critical = signals.filter(s => s.priority <= 2);
    const bySource: Record<string, number> = {};
    const byType: Record<string, number> = {};

    signals.forEach(s => {
      bySource[s.source_agent] = (bySource[s.source_agent] || 0) + 1;
      byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
    });

    return { total: signals.length, critical, bySource, byType };
  }
}

// ─── Factory (singleton per agent name) ─────────────────────────────────
const busInstances: Record<string, AgentSignalBus> = {};

export function getSignalBus(agentName: AgentName): AgentSignalBus {
  if (!busInstances[agentName]) {
    busInstances[agentName] = new AgentSignalBus(agentName);
  }
  return busInstances[agentName];
}
