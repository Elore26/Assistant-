// ============================================
// OREN AGENT SYSTEM — Agent Guardrails
// Safety, budget, and circuit breaker system
// Prevents runaway agents and cost overruns
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type AgentName } from "./agent-signals.ts";
import { sendTG } from "./telegram.ts";

// ─── Types ────────────────────────────────────────────────────────────

export interface GuardrailConfig {
  /** Max tokens per day per agent */
  maxTokensPerDay: number;
  /** Max tool calls per single run */
  maxToolCallsPerRun: number;
  /** Max loops per single run */
  maxLoopsPerRun: number;
  /** Max runs per day per agent */
  maxRunsPerDay: number;
  /** Max cost per day in USD (approximate) */
  maxCostPerDay: number;
  /** Circuit breaker: consecutive failures before shutdown */
  circuitBreakerThreshold: number;
  /** Tools that are always blocked */
  blockedTools: string[];
  /** Tools that require approval */
  gatedTools: string[];
  /** Kill switch: if true, no agent can run */
  killSwitch: boolean;
}

export interface AgentBudget {
  agentName: AgentName;
  date: string;
  tokensUsed: number;
  toolCalls: number;
  runs: number;
  estimatedCost: number;
  consecutiveFailures: number;
  isCircuitBroken: boolean;
}

// ─── Default Config ───────────────────────────────────────────────────

const DEFAULT_CONFIG: GuardrailConfig = {
  maxTokensPerDay: 500_000,
  maxToolCallsPerRun: 15,
  maxLoopsPerRun: 5,
  maxRunsPerDay: 20,
  maxCostPerDay: 5.0,
  circuitBreakerThreshold: 3,
  blockedTools: [],
  gatedTools: ["send_telegram"],
  killSwitch: false,
};

// Cost estimates per 1K tokens (input + output average)
const COST_PER_1K_TOKENS: Record<string, number> = {
  "gpt-4o-mini": 0.00015 + 0.0006, // ~$0.00075 per 1K
  "gpt-4o": 0.0025 + 0.01,          // ~$0.0125 per 1K
  "gpt-4-turbo": 0.01 + 0.03,       // ~$0.04 per 1K
};

// ─── Guardrails Class ─────────────────────────────────────────────────

export class AgentGuardrails {
  private config: GuardrailConfig;
  private budgets = new Map<string, AgentBudget>();
  private supabase: ReturnType<typeof createClient>;

  constructor(config?: Partial<GuardrailConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );
  }

  // ─── Pre-run checks ──────────────────────────────────────────────

  async canRun(agentName: AgentName): Promise<{ allowed: boolean; reason?: string }> {
    // Kill switch
    if (this.config.killSwitch) {
      return { allowed: false, reason: "Kill switch is active" };
    }

    const budget = await this.getBudget(agentName);

    // Circuit breaker
    if (budget.isCircuitBroken) {
      return { allowed: false, reason: `Circuit breaker open: ${budget.consecutiveFailures} consecutive failures` };
    }

    // Daily run limit
    if (budget.runs >= this.config.maxRunsPerDay) {
      return { allowed: false, reason: `Daily run limit reached (${this.config.maxRunsPerDay})` };
    }

    // Token budget
    if (budget.tokensUsed >= this.config.maxTokensPerDay) {
      return { allowed: false, reason: `Daily token budget exhausted (${this.config.maxTokensPerDay})` };
    }

    // Cost budget
    if (budget.estimatedCost >= this.config.maxCostPerDay) {
      return { allowed: false, reason: `Daily cost budget exhausted ($${this.config.maxCostPerDay})` };
    }

    return { allowed: true };
  }

  // ─── Tool-level checks ───────────────────────────────────────────

  canUseTool(toolName: string): { allowed: boolean; needsApproval: boolean; reason?: string } {
    if (this.config.blockedTools.includes(toolName)) {
      return { allowed: false, needsApproval: false, reason: `Tool ${toolName} is blocked` };
    }
    if (this.config.gatedTools.includes(toolName)) {
      return { allowed: true, needsApproval: true };
    }
    return { allowed: true, needsApproval: false };
  }

  // ─── Budget tracking ─────────────────────────────────────────────

  async getBudget(agentName: AgentName): Promise<AgentBudget> {
    const today = new Date().toISOString().split("T")[0];
    const key = `${agentName}:${today}`;

    if (this.budgets.has(key)) {
      return this.budgets.get(key)!;
    }

    // Try to load from DB
    try {
      const { data } = await this.supabase.from("agent_budgets")
        .select("*")
        .eq("agent_name", agentName)
        .eq("date", today)
        .single();

      if (data) {
        const budget: AgentBudget = {
          agentName,
          date: today,
          tokensUsed: data.tokens_used || 0,
          toolCalls: data.tool_calls || 0,
          runs: data.runs || 0,
          estimatedCost: data.estimated_cost || 0,
          consecutiveFailures: data.consecutive_failures || 0,
          isCircuitBroken: data.is_circuit_broken || false,
        };
        this.budgets.set(key, budget);
        return budget;
      }
    } catch { /* table might not exist yet */ }

    // Initialize fresh budget
    const budget: AgentBudget = {
      agentName,
      date: today,
      tokensUsed: 0,
      toolCalls: 0,
      runs: 0,
      estimatedCost: 0,
      consecutiveFailures: 0,
      isCircuitBroken: false,
    };
    this.budgets.set(key, budget);
    return budget;
  }

  async recordUsage(
    agentName: AgentName,
    tokensUsed: number,
    toolCalls: number,
    model: string,
    success: boolean,
  ): Promise<void> {
    const budget = await this.getBudget(agentName);

    budget.tokensUsed += tokensUsed;
    budget.toolCalls += toolCalls;
    budget.runs += 1;

    const costPer1K = COST_PER_1K_TOKENS[model] || 0.001;
    budget.estimatedCost += (tokensUsed / 1000) * costPer1K;

    if (success) {
      budget.consecutiveFailures = 0;
    } else {
      budget.consecutiveFailures += 1;
      if (budget.consecutiveFailures >= this.config.circuitBreakerThreshold) {
        budget.isCircuitBroken = true;
        await this.alertCircuitBreaker(agentName, budget.consecutiveFailures);
      }
    }

    // Persist to DB
    try {
      await this.supabase.from("agent_budgets").upsert({
        agent_name: agentName,
        date: budget.date,
        tokens_used: budget.tokensUsed,
        tool_calls: budget.toolCalls,
        runs: budget.runs,
        estimated_cost: budget.estimatedCost,
        consecutive_failures: budget.consecutiveFailures,
        is_circuit_broken: budget.isCircuitBroken,
        updated_at: new Date().toISOString(),
      }, { onConflict: "agent_name,date" });
    } catch (e) {
      console.error("[Guardrails] Failed to persist budget:", e);
    }

    // Check for alerts
    await this.checkAlerts(agentName, budget);
  }

  // ─── Circuit breaker ─────────────────────────────────────────────

  async resetCircuitBreaker(agentName: AgentName): Promise<void> {
    const budget = await this.getBudget(agentName);
    budget.consecutiveFailures = 0;
    budget.isCircuitBroken = false;

    try {
      await this.supabase.from("agent_budgets").update({
        consecutive_failures: 0,
        is_circuit_broken: false,
      }).eq("agent_name", agentName).eq("date", budget.date);
    } catch { /* ok */ }
  }

  // ─── Kill switch ─────────────────────────────────────────────────

  activateKillSwitch(): void {
    this.config.killSwitch = true;
    console.warn("[Guardrails] KILL SWITCH ACTIVATED — all agents stopped");
  }

  deactivateKillSwitch(): void {
    this.config.killSwitch = false;
    console.log("[Guardrails] Kill switch deactivated");
  }

  // ─── Alerts ──────────────────────────────────────────────────────

  private async checkAlerts(agentName: AgentName, budget: AgentBudget): Promise<void> {
    // Cost alert at 80%
    if (budget.estimatedCost >= this.config.maxCostPerDay * 0.8) {
      await sendTG(
        `⚠️ <b>AGENT BUDGET ALERT</b>\n` +
        `Agent: ${agentName}\n` +
        `Cost: $${budget.estimatedCost.toFixed(3)} / $${this.config.maxCostPerDay}\n` +
        `Tokens: ${budget.tokensUsed.toLocaleString()} / ${this.config.maxTokensPerDay.toLocaleString()}\n` +
        `Runs: ${budget.runs} / ${this.config.maxRunsPerDay}`
      );
    }

    // Token alert at 90%
    if (budget.tokensUsed >= this.config.maxTokensPerDay * 0.9) {
      console.warn(`[Guardrails] ${agentName} at ${Math.round(budget.tokensUsed / this.config.maxTokensPerDay * 100)}% token budget`);
    }
  }

  private async alertCircuitBreaker(agentName: AgentName, failures: number): Promise<void> {
    await sendTG(
      `🔴 <b>CIRCUIT BREAKER OPEN</b>\n` +
      `Agent: ${agentName}\n` +
      `Consecutive failures: ${failures}\n` +
      `Agent is now STOPPED until manual reset.\n\n` +
      `Use /agent_reset ${agentName} to restart.`
    );
  }

  // ─── Status ──────────────────────────────────────────────────────

  async getStatus(): Promise<Record<string, AgentBudget>> {
    const today = new Date().toISOString().split("T")[0];
    const status: Record<string, AgentBudget> = {};

    try {
      const { data } = await this.supabase.from("agent_budgets")
        .select("*")
        .eq("date", today);

      for (const row of data || []) {
        status[row.agent_name] = {
          agentName: row.agent_name,
          date: today,
          tokensUsed: row.tokens_used || 0,
          toolCalls: row.tool_calls || 0,
          runs: row.runs || 0,
          estimatedCost: row.estimated_cost || 0,
          consecutiveFailures: row.consecutive_failures || 0,
          isCircuitBroken: row.is_circuit_broken || false,
        };
      }
    } catch { /* ok */ }

    return status;
  }

  getConfig(): Readonly<GuardrailConfig> {
    return { ...this.config };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────

let _instance: AgentGuardrails | null = null;

export function getGuardrails(config?: Partial<GuardrailConfig>): AgentGuardrails {
  if (!_instance) {
    _instance = new AgentGuardrails(config);
  }
  return _instance;
}
