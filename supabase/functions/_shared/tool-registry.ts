// ============================================
// OREN AGENT SYSTEM — Agentic Tool Registry
// Defines all tools agents can discover and use
// Each tool has: name, description, parameters, execute fn
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSignalBus, type AgentName, type SignalType } from "./agent-signals.ts";
import { callOpenAI } from "./openai.ts";
import { sendTG, escHTML, type SendTGOptions } from "./telegram.ts";
import { getIsraelNow, todayStr, dateStr, weekStart } from "./timezone.ts";

// ─── Tool Types ───────────────────────────────────────────────────────

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  enum?: string[];
  /** Items schema for array types (required by OpenAI function calling) */
  items?: { type: string; properties?: Record<string, any> };
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: "data" | "action" | "analysis" | "external";
  parameters: ToolParameter[];
  /** Which agents can use this tool (empty = all) */
  allowedAgents?: AgentName[];
  /** Risk tier: auto (no approval), gated (needs approval), blocked */
  tier: "auto" | "gated" | "blocked";
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ToolExecution {
  tool: string;
  args: Record<string, any>;
  result: ToolResult;
  durationMs: number;
  timestamp: string;
}

type ToolExecutor = (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  agentName: AgentName;
  supabase: ReturnType<typeof createClient>;
  /** Approval callback for gated tools */
  onApprovalNeeded?: (tool: string, args: Record<string, any>) => Promise<boolean>;
}

// ─── Tool Registry Class ──────────────────────────────────────────────

class ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; execute: ToolExecutor }>();
  private executionLog: ToolExecution[] = [];

  register(definition: ToolDefinition, execute: ToolExecutor): void {
    this.tools.set(definition.name, { definition, execute });
  }

  /** Get tools available to a specific agent */
  getToolsForAgent(agentName: AgentName): ToolDefinition[] {
    const available: ToolDefinition[] = [];
    for (const [, tool] of this.tools) {
      if (tool.definition.tier === "blocked") continue;
      if (
        tool.definition.allowedAgents &&
        tool.definition.allowedAgents.length > 0 &&
        !tool.definition.allowedAgents.includes(agentName)
      ) continue;
      available.push(tool.definition);
    }
    return available;
  }

  /** Format tool definitions for LLM function calling */
  getToolSchemaForLLM(agentName: AgentName): object[] {
    return this.getToolsForAgent(agentName).map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.parameters.map(p => [p.name, {
              type: p.type,
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.type === "array" ? { items: p.items || { type: "string" } } : {}),
            }])
          ),
          required: tool.parameters.filter(p => p.required).map(p => p.name),
        },
      },
    }));
  }

  /** Execute a tool with guardrails */
  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    // Check agent permission
    const def = tool.definition;
    if (
      def.allowedAgents &&
      def.allowedAgents.length > 0 &&
      !def.allowedAgents.includes(context.agentName)
    ) {
      return { success: false, error: `Agent ${context.agentName} cannot use tool ${toolName}` };
    }

    // Check tier
    if (def.tier === "blocked") {
      return { success: false, error: `Tool ${toolName} is blocked` };
    }

    if (def.tier === "gated" && context.onApprovalNeeded) {
      const approved = await context.onApprovalNeeded(toolName, args);
      if (!approved) {
        return { success: false, error: `Tool ${toolName} was not approved` };
      }
    }

    // Execute with timing
    const start = Date.now();
    try {
      const result = await tool.execute(args, context);
      const execution: ToolExecution = {
        tool: toolName,
        args,
        result,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
      this.executionLog.push(execution);

      // Keep log bounded
      if (this.executionLog.length > 100) {
        this.executionLog = this.executionLog.slice(-50);
      }

      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error };
    }
  }

  getExecutionLog(): ToolExecution[] {
    return [...this.executionLog];
  }
}

// ─── Singleton Registry ───────────────────────────────────────────────

export const registry = new ToolRegistry();

// ═══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — Data Tools
// ═══════════════════════════════════════════════════════════════════════

registry.register(
  {
    name: "query_tasks",
    description: "Query tasks from the database with filters. Returns tasks matching the criteria.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "status", type: "string", description: "Filter by status", required: false, enum: ["pending", "in_progress", "done"] },
      { name: "domain", type: "string", description: "Filter by domain", required: false, enum: ["career", "health", "finance", "learning", "trading", "personal", "higrow"] },
      { name: "priority_max", type: "number", description: "Maximum priority (1=highest, 5=lowest)", required: false },
      { name: "due_date", type: "string", description: "Filter tasks due on this date (YYYY-MM-DD)", required: false },
      { name: "overdue", type: "boolean", description: "If true, return only overdue tasks", required: false },
      { name: "limit", type: "number", description: "Max results (default 20)", required: false },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("tasks").select("*");
    if (args.status) query = query.eq("status", args.status);
    if (args.domain) query = query.eq("domain", args.domain);
    if (args.priority_max) query = query.lte("priority", args.priority_max);
    if (args.due_date) query = query.eq("due_date", args.due_date);
    if (args.overdue) query = query.lt("due_date", todayStr()).neq("status", "done");
    query = query.order("priority", { ascending: true }).limit(args.limit || 20);
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }
);

registry.register(
  {
    name: "query_jobs",
    description: "Query job listings from the career pipeline. Returns jobs matching the criteria.",
    category: "data",
    tier: "auto",
    allowedAgents: ["career", "morning-briefing", "evening-review", "telegram-bot"],
    parameters: [
      { name: "status", type: "string", description: "Filter by status", required: false, enum: ["new", "applied", "interview", "offer", "rejected"] },
      { name: "region", type: "string", description: "Filter by region", required: false, enum: ["israel", "france"] },
      { name: "days_old", type: "number", description: "Only return jobs posted within this many days", required: false },
      { name: "limit", type: "number", description: "Max results (default 20)", required: false },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("job_listings").select("*");
    if (args.status) query = query.eq("status", args.status);
    if (args.region) query = query.eq("region", args.region);
    if (args.days_old) {
      const since = new Date(Date.now() - args.days_old * 86400000).toISOString();
      query = query.gte("created_at", since);
    }
    query = query.order("created_at", { ascending: false }).limit(args.limit || 20);
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }
);

registry.register(
  {
    name: "query_signals",
    description: "Read active inter-agent signals without consuming them. Useful for understanding what other agents are communicating.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "source_agent", type: "string", description: "Filter by signal source agent", required: false },
      { name: "signal_type", type: "string", description: "Filter by signal type", required: false },
      { name: "hours_back", type: "number", description: "How far back to look (default 24h)", required: false },
      { name: "min_priority", type: "number", description: "Minimum priority (1=critical, 3=info)", required: false },
    ],
  },
  async (args, ctx) => {
    const bus = getSignalBus(ctx.agentName);
    const signals = await bus.peek({
      source: args.source_agent,
      types: args.signal_type ? [args.signal_type as SignalType] : undefined,
      hoursBack: args.hours_back || 24,
      limit: 20,
    });
    const filtered = args.min_priority
      ? signals.filter(s => s.priority <= args.min_priority)
      : signals;
    return { success: true, data: filtered };
  }
);

registry.register(
  {
    name: "query_goals",
    description: "Query active goals with progress tracking. Returns goals with their current metrics.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "domain", type: "string", description: "Filter by domain", required: false },
      { name: "status", type: "string", description: "Filter by status", required: false, enum: ["active", "completed", "paused"] },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("goals").select("*");
    if (args.domain) query = query.eq("domain", args.domain);
    if (args.status) query = query.eq("status", args.status);
    else query = query.eq("status", "active");
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }
);

registry.register(
  {
    name: "query_patterns",
    description: "Query learned user behavioral patterns from the intelligence engine.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "pattern_type", type: "string", description: "Type of pattern to query", required: false },
      { name: "min_confidence", type: "number", description: "Minimum confidence (0-1)", required: false },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("user_patterns").select("*");
    if (args.pattern_type) query = query.eq("pattern_type", args.pattern_type);
    if (args.min_confidence) query = query.gte("confidence", args.min_confidence);
    query = query.order("confidence", { ascending: false }).limit(20);
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }
);

registry.register(
  {
    name: "query_rocks",
    description: "Query 90-day rocks (EOS framework). Returns current quarter priorities.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "domain", type: "string", description: "Filter by domain", required: false },
      { name: "status", type: "string", description: "Filter by status", required: false, enum: ["on_track", "off_track", "completed", "dropped"] },
    ],
  },
  async (args, ctx) => {
    let query = ctx.supabase.from("rocks").select("*");
    if (args.domain) query = query.eq("domain", args.domain);
    if (args.status) query = query.eq("current_status", args.status);
    else query = query.in("current_status", ["on_track", "off_track"]);
    const { data, error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — Action Tools
// ═══════════════════════════════════════════════════════════════════════

registry.register(
  {
    name: "create_task",
    description: "Create a new task. Use when the agent identifies something actionable that the user should do.",
    category: "action",
    tier: "auto",
    parameters: [
      { name: "title", type: "string", description: "Task title (clear, actionable)", required: true },
      { name: "domain", type: "string", description: "Domain", required: true, enum: ["career", "health", "finance", "learning", "trading", "personal", "higrow"] },
      { name: "priority", type: "number", description: "Priority 1-5 (1=urgent)", required: true },
      { name: "due_date", type: "string", description: "Due date YYYY-MM-DD (default today)", required: false },
      { name: "duration_minutes", type: "number", description: "Estimated duration in minutes", required: false },
      { name: "context", type: "string", description: "Additional context or linked entity", required: false },
    ],
  },
  async (args, ctx) => {
    const { error, data } = await ctx.supabase.from("tasks").insert({
      title: args.title,
      domain: args.domain,
      priority: args.priority,
      due_date: args.due_date || todayStr(),
      duration_minutes: args.duration_minutes || null,
      context: args.context || null,
      status: "pending",
      agent_type: ctx.agentName,
      created_at: new Date().toISOString(),
    }).select("id").single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: { id: data.id, title: args.title } };
  }
);

registry.register(
  {
    name: "emit_signal",
    description: "Emit an inter-agent signal to communicate with other agents. Use to flag important events or request action from another agent.",
    category: "action",
    tier: "auto",
    parameters: [
      { name: "signal_type", type: "string", description: "Type of signal to emit", required: true },
      { name: "message", type: "string", description: "Human-readable description of the signal", required: true },
      { name: "target_agent", type: "string", description: "Target agent (null for broadcast)", required: false },
      { name: "priority", type: "number", description: "Priority 1-3 (1=critical)", required: false },
      { name: "payload", type: "object", description: "Additional structured data", required: false },
      { name: "ttl_hours", type: "number", description: "Time-to-live in hours (default 24)", required: false },
    ],
  },
  async (args, ctx) => {
    const bus = getSignalBus(ctx.agentName);
    const id = await bus.emit(
      args.signal_type as SignalType,
      args.message,
      args.payload || {},
      {
        target: args.target_agent || null,
        priority: args.priority || 3,
        ttlHours: args.ttl_hours || 24,
      }
    );
    if (!id) return { success: false, error: "Failed to emit signal" };
    return { success: true, data: { signal_id: id } };
  }
);

registry.register(
  {
    name: "update_goal_progress",
    description: "Update progress on an active goal. Use when new data is available for a tracked metric.",
    category: "action",
    tier: "auto",
    parameters: [
      { name: "goal_id", type: "string", description: "Goal ID to update", required: true },
      { name: "metric_current", type: "number", description: "New current value of the metric", required: true },
      { name: "note", type: "string", description: "Progress note", required: false },
    ],
  },
  async (args, ctx) => {
    const { error } = await ctx.supabase.from("goals").update({
      metric_current: args.metric_current,
      ...(args.note ? { notes: args.note } : {}),
      updated_at: new Date().toISOString(),
    }).eq("id", args.goal_id);
    if (error) return { success: false, error: error.message };
    return { success: true, data: { updated: true } };
  }
);

registry.register(
  {
    name: "send_telegram",
    description: "Send a message to the user via Telegram. Use sparingly for important notifications or when explicitly needed.",
    category: "action",
    tier: "gated",
    parameters: [
      { name: "text", type: "string", description: "Message text (HTML supported)", required: true },
      { name: "buttons", type: "array", description: "Optional inline keyboard buttons — array of rows, each row is an array of {text, callback_data}", required: false, items: { type: "array", properties: { text: { type: "string" }, callback_data: { type: "string" } } } },
    ],
  },
  async (args, _ctx) => {
    const opts: SendTGOptions = {};
    if (args.buttons) opts.buttons = args.buttons;
    const sent = await sendTG(args.text, opts);
    return { success: sent, data: sent ? { sent: true } : undefined, error: sent ? undefined : "Failed to send" };
  }
);

registry.register(
  {
    name: "complete_task",
    description: "Mark a task as completed.",
    category: "action",
    tier: "auto",
    parameters: [
      { name: "task_id", type: "string", description: "Task ID to complete", required: true },
    ],
  },
  async (args, ctx) => {
    const { error } = await ctx.supabase.from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", args.task_id);
    if (error) return { success: false, error: error.message };
    return { success: true, data: { completed: true } };
  }
);

registry.register(
  {
    name: "update_job_status",
    description: "Update the status of a job listing in the career pipeline.",
    category: "action",
    tier: "auto",
    allowedAgents: ["career", "telegram-bot"],
    parameters: [
      { name: "job_id", type: "string", description: "Job listing ID", required: true },
      { name: "status", type: "string", description: "New status", required: true, enum: ["new", "applied", "interview", "offer", "rejected"] },
      { name: "notes", type: "string", description: "Optional notes", required: false },
    ],
  },
  async (args, ctx) => {
    const updates: Record<string, any> = {
      status: args.status,
      updated_at: new Date().toISOString(),
    };
    if (args.status === "applied") updates.applied_date = todayStr();
    if (args.notes) updates.notes = args.notes;
    const { error } = await ctx.supabase.from("job_listings").update(updates).eq("id", args.job_id);
    if (error) return { success: false, error: error.message };
    return { success: true, data: { updated: true } };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — Analysis Tools
// ═══════════════════════════════════════════════════════════════════════

registry.register(
  {
    name: "analyze_trend",
    description: "Analyze a metric trend over a time period. Returns statistics and direction.",
    category: "analysis",
    tier: "auto",
    parameters: [
      { name: "metric", type: "string", description: "What to analyze", required: true, enum: ["task_completion", "applications_sent", "interviews", "workout_days", "study_hours", "daily_score"] },
      { name: "days", type: "number", description: "Number of days to analyze (default 7)", required: false },
    ],
  },
  async (args, ctx) => {
    const days = args.days || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

    let data: any = null;

    switch (args.metric) {
      case "task_completion": {
        const { data: tasks } = await ctx.supabase.from("tasks")
          .select("status, completed_at, created_at")
          .gte("created_at", since);
        if (tasks) {
          const total = tasks.length;
          const completed = tasks.filter((t: any) => t.status === "done").length;
          const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
          data = { total, completed, rate, trend: rate > 70 ? "up" : rate > 50 ? "stable" : "down" };
        }
        break;
      }
      case "applications_sent": {
        const { data: jobs } = await ctx.supabase.from("job_listings")
          .select("applied_date")
          .gte("applied_date", since)
          .not("applied_date", "is", null);
        data = { count: jobs?.length || 0, period_days: days };
        break;
      }
      case "daily_score": {
        const { data: scores } = await ctx.supabase.from("agent_signals")
          .select("payload, created_at")
          .eq("signal_type", "daily_score")
          .gte("created_at", since)
          .order("created_at", { ascending: true });
        if (scores && scores.length > 0) {
          const values = scores.map((s: any) => s.payload?.score || 0);
          const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
          const latest = values[values.length - 1];
          data = { average: Math.round(avg * 10) / 10, latest, count: values.length, trend: latest > avg ? "up" : "down" };
        }
        break;
      }
      default:
        data = { message: `Metric ${args.metric} analysis not yet implemented` };
    }

    return { success: true, data: data || { message: "No data found" } };
  }
);

registry.register(
  {
    name: "ai_analyze",
    description: "Use AI (LLM) to analyze data and provide insights. Pass structured data and a question to get intelligent analysis.",
    category: "analysis",
    tier: "auto",
    parameters: [
      { name: "system_prompt", type: "string", description: "System prompt defining the AI's role and constraints", required: true },
      { name: "data", type: "string", description: "The data to analyze (formatted as text)", required: true },
      { name: "question", type: "string", description: "Specific question to answer about the data", required: true },
      { name: "max_tokens", type: "number", description: "Max response tokens (default 300)", required: false },
    ],
  },
  async (args, _ctx) => {
    const result = await callOpenAI(
      args.system_prompt,
      `DATA:\n${args.data}\n\nQUESTION:\n${args.question}`,
      args.max_tokens || 300,
      { temperature: 0.3 }
    );
    if (!result) return { success: false, error: "AI analysis returned empty" };
    return { success: true, data: { analysis: result } };
  }
);

registry.register(
  {
    name: "find_correlations",
    description: "Find correlations between two metrics over a period. Helps identify what affects what.",
    category: "analysis",
    tier: "auto",
    parameters: [
      { name: "metric_a", type: "string", description: "First metric", required: true },
      { name: "metric_b", type: "string", description: "Second metric", required: true },
      { name: "days", type: "number", description: "Analysis period in days (default 30)", required: false },
    ],
  },
  async (args, ctx) => {
    // Delegate to AI analysis with historical data
    const days = args.days || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: signals } = await ctx.supabase.from("agent_signals")
      .select("signal_type, payload, created_at")
      .gte("created_at", since)
      .in("signal_type", ["daily_score", "workout_completed", "study_streak", "budget_alert"])
      .order("created_at", { ascending: true })
      .limit(100);

    const result = await callOpenAI(
      "You are a data analyst. Find correlations between the two metrics. Be specific with numbers.",
      `Metric A: ${args.metric_a}\nMetric B: ${args.metric_b}\nPeriod: ${days} days\nSignal data: ${JSON.stringify(signals?.slice(0, 50) || [])}`,
      200,
      { temperature: 0.2 }
    );

    return { success: true, data: { correlation: result || "Insufficient data for correlation analysis" } };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — Memory Tools
// ═══════════════════════════════════════════════════════════════════════

registry.register(
  {
    name: "store_memory",
    description: "Store a memory/insight for future retrieval. Use for important decisions, patterns, or learnings that should persist.",
    category: "action",
    tier: "auto",
    parameters: [
      { name: "content", type: "string", description: "The memory content to store", required: true },
      { name: "memory_type", type: "string", description: "Type of memory", required: true, enum: ["decision", "pattern", "insight", "preference", "lesson"] },
      { name: "domain", type: "string", description: "Related domain", required: false },
      { name: "importance", type: "number", description: "Importance 1-5 (5=critical)", required: false },
      { name: "tags", type: "array", description: "Tags for retrieval", required: false, items: { type: "string" } },
    ],
  },
  async (args, ctx) => {
    const { error, data } = await ctx.supabase.from("agent_memories").insert({
      agent_name: ctx.agentName,
      content: args.content,
      memory_type: args.memory_type,
      domain: args.domain || null,
      importance: args.importance || 3,
      tags: args.tags || [],
      created_at: new Date().toISOString(),
    }).select("id").single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: { memory_id: data?.id } };
  }
);

registry.register(
  {
    name: "recall_memories",
    description: "Retrieve stored memories relevant to the current context. Use before making decisions to leverage past experience.",
    category: "data",
    tier: "auto",
    parameters: [
      { name: "query", type: "string", description: "What to search for in memories", required: true },
      { name: "domain", type: "string", description: "Filter by domain", required: false },
      { name: "memory_type", type: "string", description: "Filter by type", required: false, enum: ["decision", "pattern", "insight", "preference", "lesson"] },
      { name: "limit", type: "number", description: "Max results (default 5)", required: false },
    ],
  },
  async (args, ctx) => {
    // Text search in memories (will be upgraded to pgvector semantic search)
    let query = ctx.supabase.from("agent_memories")
      .select("*")
      .textSearch("content", args.query, { type: "websearch" });
    if (args.domain) query = query.eq("domain", args.domain);
    if (args.memory_type) query = query.eq("memory_type", args.memory_type);
    query = query.order("importance", { ascending: false }).limit(args.limit || 5);
    const { data, error } = await query;
    if (error) {
      // Fallback: simple ilike search if text search fails
      let fallback = ctx.supabase.from("agent_memories")
        .select("*")
        .ilike("content", `%${args.query}%`);
      if (args.domain) fallback = fallback.eq("domain", args.domain);
      const { data: fbData } = await fallback.limit(args.limit || 5);
      return { success: true, data: fbData || [] };
    }
    return { success: true, data: data || [] };
  }
);

// ─── Export helper ────────────────────────────────────────────────────

export function getRegistry(): ToolRegistry {
  return registry;
}
