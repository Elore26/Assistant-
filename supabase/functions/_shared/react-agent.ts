// ============================================
// OREN AGENT SYSTEM — ReAct Agent Loop
// Reasoning + Acting framework for agentic AI
// Observe → Think → Act → Observe → Repeat
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { robustFetch } from "./robust-fetch.ts";
import { registry, type ToolResult, type ToolContext, type ToolExecution } from "./tool-registry.ts";
import { type AgentName } from "./agent-signals.ts";
import { callOpenAI } from "./openai.ts";

// ─── Types ────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Agent identity */
  name: AgentName;
  /** Agent's role description (system prompt) */
  role: string;
  /** Current goal the agent is pursuing */
  goal: string;
  /** Additional context (signals, user state, etc.) */
  context?: string;
  /** Maximum reasoning loops before stopping */
  maxLoops?: number;
  /** Maximum total tool calls across all loops */
  maxToolCalls?: number;
  /** Token budget per loop */
  maxTokensPerLoop?: number;
  /** Model to use (default gpt-4o-mini) */
  model?: string;
  /** Temperature for reasoning (default 0.3) */
  temperature?: number;
  /** Callback: called before each tool execution (for approval/logging) */
  onBeforeToolCall?: (tool: string, args: Record<string, any>) => Promise<boolean>;
  /** Callback: called after each loop with the reasoning trace */
  onLoopComplete?: (loop: LoopTrace) => Promise<void>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface LoopTrace {
  loopNumber: number;
  observation: string;
  reasoning: string;
  toolCalls: ToolExecution[];
  timestamp: string;
}

export interface AgentResult {
  success: boolean;
  /** Final output/conclusion from the agent */
  output: string;
  /** Full reasoning trace */
  trace: LoopTrace[];
  /** Total tool calls made */
  totalToolCalls: number;
  /** Total loops executed */
  totalLoops: number;
  /** Duration in ms */
  durationMs: number;
  /** Was the agent stopped by guardrails? */
  stoppedByGuardrail: boolean;
  guardrailReason?: string;
}

// ─── OpenAI Function Calling ──────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

async function callOpenAIWithTools(
  messages: OpenAIMessage[],
  tools: object[],
  model: string,
  temperature: number,
  maxTokens: number,
): Promise<{ content: string | null; toolCalls: ToolCall[]; finishReason: string }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return { content: "No API key", toolCalls: [], finishReason: "error" };

  const body: any = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await robustFetch("https://api.openai.com/v1/chat/completions", {
    timeoutMs: 30000,
    retries: 1,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return { content: `API error: ${response.status} ${errText.slice(0, 200)}`, toolCalls: [], finishReason: "error" };
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) return { content: "No response", toolCalls: [], finishReason: "error" };

  const toolCalls: ToolCall[] = [];
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      try {
        toolCalls.push({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || "{}"),
        });
      } catch {
        console.error(`[ReAct] Failed to parse tool call args: ${tc.function.arguments}`);
      }
    }
  }

  return {
    content: choice.message?.content || null,
    toolCalls,
    finishReason: choice.finish_reason || "stop",
  };
}

// ─── ReAct Agent Loop ─────────────────────────────────────────────────

export async function runReActAgent(config: AgentConfig): Promise<AgentResult> {
  const startTime = Date.now();
  const maxLoops = config.maxLoops || 5;
  const maxToolCalls = config.maxToolCalls || 15;
  const maxTokensPerLoop = config.maxTokensPerLoop || 800;
  const model = config.model || "gpt-4o-mini";
  const temperature = config.temperature || 0.3;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const toolContext: ToolContext = {
    agentName: config.name,
    supabase,
    onApprovalNeeded: config.onBeforeToolCall
      ? async (tool, args) => config.onBeforeToolCall!(tool, args)
      : undefined,
  };

  // Get available tools for this agent
  const toolSchemas = registry.getToolSchemaForLLM(config.name);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(config, registry.getToolsForAgent(config.name).map(t => t.name));

  // Conversation messages
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildInitialPrompt(config) },
  ];

  const trace: LoopTrace[] = [];
  let totalToolCalls = 0;
  let stoppedByGuardrail = false;
  let guardrailReason: string | undefined;
  let finalOutput = "";

  for (let loop = 0; loop < maxLoops; loop++) {
    // ── THINK: Get LLM response ──
    const response = await callOpenAIWithTools(
      messages,
      toolSchemas,
      model,
      temperature,
      maxTokensPerLoop,
    );

    const loopTrace: LoopTrace = {
      loopNumber: loop + 1,
      observation: "",
      reasoning: response.content || "",
      toolCalls: [],
      timestamp: new Date().toISOString(),
    };

    // ── No tool calls → agent is done ──
    if (response.toolCalls.length === 0) {
      finalOutput = response.content || "Agent completed without output";
      trace.push(loopTrace);
      if (config.onLoopComplete) await config.onLoopComplete(loopTrace);
      break;
    }

    // ── Check tool call budget ──
    if (totalToolCalls + response.toolCalls.length > maxToolCalls) {
      stoppedByGuardrail = true;
      guardrailReason = `Tool call limit reached (${maxToolCalls})`;
      finalOutput = response.content || `Stopped: ${guardrailReason}`;
      trace.push(loopTrace);
      break;
    }

    // ── ACT: Execute tool calls ──
    // Add assistant message with tool calls to conversation
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls.map((tc, i) => ({
        id: `call_${loop}_${i}`,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    for (let i = 0; i < response.toolCalls.length; i++) {
      const tc = response.toolCalls[i];

      // Before-hook check
      if (config.onBeforeToolCall) {
        const allowed = await config.onBeforeToolCall(tc.name, tc.arguments);
        if (!allowed) {
          const blockedResult: ToolResult = { success: false, error: `Tool ${tc.name} was blocked by guardrail` };
          messages.push({
            role: "tool",
            content: JSON.stringify(blockedResult),
            tool_call_id: `call_${loop}_${i}`,
          });
          continue;
        }
      }

      // Execute the tool
      const execStart = Date.now();
      const result = await registry.execute(tc.name, tc.arguments, toolContext);
      const execution: ToolExecution = {
        tool: tc.name,
        args: tc.arguments,
        result,
        durationMs: Date.now() - execStart,
        timestamp: new Date().toISOString(),
      };
      loopTrace.toolCalls.push(execution);
      totalToolCalls++;

      // Add tool result to conversation
      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: `call_${loop}_${i}`,
      });
    }

    // ── OBSERVE: Build observation string ──
    loopTrace.observation = loopTrace.toolCalls
      .map(tc => `${tc.tool}: ${tc.result.success ? "OK" : "FAIL"} (${tc.durationMs}ms)`)
      .join(", ");

    trace.push(loopTrace);
    if (config.onLoopComplete) await config.onLoopComplete(loopTrace);

    // If this is the last loop, get a final response
    if (loop === maxLoops - 1) {
      messages.push({
        role: "user",
        content: "Maximum loops reached. Provide your final conclusion and any remaining action items.",
      });
      const finalResponse = await callOpenAIWithTools(messages, [], model, temperature, maxTokensPerLoop);
      finalOutput = finalResponse.content || "Agent reached max loops";
      stoppedByGuardrail = true;
      guardrailReason = `Max loops reached (${maxLoops})`;
    }
  }

  // ── Log agent execution ──
  try {
    await supabase.from("agent_executions").insert({
      agent_name: config.name,
      goal: config.goal,
      success: !stoppedByGuardrail,
      output: finalOutput.slice(0, 2000),
      tool_calls_count: totalToolCalls,
      loops_count: trace.length,
      duration_ms: Date.now() - startTime,
      trace: JSON.stringify(trace.map(t => ({
        loop: t.loopNumber,
        reasoning: t.reasoning?.slice(0, 500),
        tools: t.toolCalls.map(tc => tc.tool),
        observation: t.observation,
      }))),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[ReAct] Failed to log execution:", e);
  }

  return {
    success: !stoppedByGuardrail,
    output: finalOutput,
    trace,
    totalToolCalls,
    totalLoops: trace.length,
    durationMs: Date.now() - startTime,
    stoppedByGuardrail,
    guardrailReason,
  };
}

// ─── Prompt Builders ──────────────────────────────────────────────────

function buildSystemPrompt(config: AgentConfig, availableTools: string[]): string {
  return `${config.role}

## OPERATING MODE: ReAct (Reasoning + Acting)

You are an autonomous agent in the OREN system. You REASON about what to do, then ACT using tools, then OBSERVE results, and repeat.

### Rules:
1. ALWAYS think step-by-step before acting
2. Use tools to gather data before making decisions
3. When you have enough information, provide your conclusion WITHOUT calling more tools
4. Be concise — avoid unnecessary tool calls
5. If a tool fails, reason about why and try an alternative approach
6. When done, output your final analysis/recommendations as plain text (no tool call)

### Available tools: ${availableTools.join(", ")}

### Current date: ${new Date().toISOString().split("T")[0]}
### Agent: ${config.name}`;
}

function buildInitialPrompt(config: AgentConfig): string {
  let prompt = `## GOAL\n${config.goal}\n`;
  if (config.context) {
    prompt += `\n## CONTEXT\n${config.context}\n`;
  }
  prompt += `\nAnalyze the situation, gather necessary data using tools, then provide your conclusion and recommended actions.`;
  return prompt;
}

// ─── Convenience: Run a quick single-purpose agent ────────────────────

export async function quickAgent(
  name: AgentName,
  role: string,
  goal: string,
  context?: string,
): Promise<string> {
  const result = await runReActAgent({
    name,
    role,
    goal,
    context,
    maxLoops: 3,
    maxToolCalls: 8,
  });
  return result.output;
}
