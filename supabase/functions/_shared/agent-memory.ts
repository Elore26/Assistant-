// ============================================
// OREN AGENT SYSTEM — Agent Memory System
// Episodic + Semantic + Procedural memory
// Phase 1: Text search (upgradeable to pgvector)
// Phase 2: Embedding-based RAG (pgvector)
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAI } from "./openai.ts";
import { robustFetch } from "./robust-fetch.ts";
import { type AgentName } from "./agent-signals.ts";

// ─── Types ────────────────────────────────────────────────────────────

export type MemoryType =
  | "episodic"     // Specific events: "Interview at Google went well on 2026-02-20"
  | "semantic"     // General knowledge: "Oren performs better at morning interviews"
  | "procedural"   // How-to: "When 3+ gym days missed, suggest short workout"
  | "decision"     // Past decisions: "Pivoted career focus from SDR to AE roles"
  | "preference";  // User preferences: "Prefers French for career comms"

export interface Memory {
  id?: string;
  agent_name: AgentName;
  memory_type: MemoryType;
  content: string;
  domain?: string;
  importance: number; // 1-5 (5=critical, never forget)
  tags: string[];
  /** Embedding vector (null until pgvector migration) */
  embedding?: number[] | null;
  access_count: number;
  last_accessed?: string;
  created_at: string;
  expires_at?: string | null;
}

export interface MemorySearchResult {
  memory: Memory;
  relevance: number; // 0-1 score
}

// ─── Memory Store Class ───────────────────────────────────────────────

export class AgentMemoryStore {
  private supabase: ReturnType<typeof createClient>;
  private agentName: AgentName;
  private usePgVector: boolean;

  constructor(agentName: AgentName) {
    this.agentName = agentName;
    this.supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );
    // pgvector enabled — set via env or auto-detect
    this.usePgVector = Deno.env.get("ENABLE_PGVECTOR") === "true";
  }

  // ─── STORE: Save a new memory ─────────────────────────────────────

  async store(
    content: string,
    memoryType: MemoryType,
    opts: {
      domain?: string;
      importance?: number;
      tags?: string[];
      ttlDays?: number;
    } = {}
  ): Promise<string | null> {
    try {
      const expiresAt = opts.ttlDays
        ? new Date(Date.now() + opts.ttlDays * 86400000).toISOString()
        : null;

      // Generate embedding if pgvector is available
      let embedding: number[] | null = null;
      if (this.usePgVector) {
        embedding = await this.generateEmbedding(content);
      }

      const { data, error } = await this.supabase.from("agent_memories").insert({
        agent_name: this.agentName,
        memory_type: memoryType,
        content,
        domain: opts.domain || null,
        importance: opts.importance || 3,
        tags: opts.tags || [],
        embedding,
        access_count: 0,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      }).select("id").single();

      if (error) {
        console.error("[Memory] Store error:", error.message);
        return null;
      }

      return data?.id || null;
    } catch (e) {
      console.error("[Memory] Store exception:", e);
      return null;
    }
  }

  // ─── RECALL: Search for relevant memories ─────────────────────────

  async recall(
    query: string,
    opts: {
      memoryType?: MemoryType;
      domain?: string;
      minImportance?: number;
      limit?: number;
      includeExpired?: boolean;
    } = {}
  ): Promise<MemorySearchResult[]> {
    const limit = opts.limit || 5;

    try {
      // Phase 2: Semantic search via pgvector
      if (this.usePgVector) {
        return await this.semanticSearch(query, opts);
      }

      // Phase 1: Text-based search with scoring
      return await this.textSearch(query, opts);
    } catch (e) {
      console.error("[Memory] Recall exception:", e);
      return [];
    }
  }

  // ─── Text Search (Phase 1) ────────────────────────────────────────

  private async textSearch(
    query: string,
    opts: {
      memoryType?: MemoryType;
      domain?: string;
      minImportance?: number;
      limit?: number;
      includeExpired?: boolean;
    }
  ): Promise<MemorySearchResult[]> {
    const limit = opts.limit || 5;

    // Strategy 1: Try full-text search
    let results: Memory[] = [];
    try {
      let q = this.supabase.from("agent_memories")
        .select("*")
        .eq("agent_name", this.agentName)
        .textSearch("content", query, { type: "websearch" });

      if (opts.memoryType) q = q.eq("memory_type", opts.memoryType);
      if (opts.domain) q = q.eq("domain", opts.domain);
      if (opts.minImportance) q = q.gte("importance", opts.minImportance);
      if (!opts.includeExpired) {
        q = q.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      }

      const { data } = await q.order("importance", { ascending: false }).limit(limit);
      results = (data || []) as Memory[];
    } catch {
      // Full-text search might fail — fallback to ilike
    }

    // Strategy 2: Fallback to keyword matching
    if (results.length === 0) {
      const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      for (const keyword of keywords.slice(0, 3)) {
        let q = this.supabase.from("agent_memories")
          .select("*")
          .eq("agent_name", this.agentName)
          .ilike("content", `%${keyword}%`);

        if (opts.memoryType) q = q.eq("memory_type", opts.memoryType);
        if (opts.domain) q = q.eq("domain", opts.domain);

        const { data } = await q.order("importance", { ascending: false }).limit(limit);
        if (data) results.push(...(data as Memory[]));
      }

      // Deduplicate
      const seen = new Set<string>();
      results = results.filter(m => {
        if (seen.has(m.id!)) return false;
        seen.add(m.id!);
        return true;
      });
    }

    // Score results by relevance (simple keyword overlap)
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const scored: MemorySearchResult[] = results.map(memory => {
      const contentWords = new Set(memory.content.toLowerCase().split(/\s+/));
      let overlap = 0;
      for (const word of queryWords) {
        if (contentWords.has(word)) overlap++;
      }
      const relevance = Math.min(1, (overlap / queryWords.size) * 0.7 + (memory.importance / 5) * 0.3);
      return { memory, relevance };
    });

    // Update access counts
    const ids = scored.map(s => s.memory.id).filter(Boolean);
    if (ids.length > 0) {
      // Fire and forget
      this.supabase.rpc("increment_memory_access", { memory_ids: ids }).then(() => {}).catch(() => {});
    }

    return scored
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, opts.limit || 5);
  }

  // ─── Semantic Search (Phase 2 — pgvector) ─────────────────────────

  private async semanticSearch(
    query: string,
    opts: {
      memoryType?: MemoryType;
      domain?: string;
      minImportance?: number;
      limit?: number;
      includeExpired?: boolean;
    }
  ): Promise<MemorySearchResult[]> {
    const embedding = await this.generateEmbedding(query);
    if (!embedding) return this.textSearch(query, opts);

    try {
      const { data, error } = await this.supabase.rpc("match_memories", {
        query_embedding: embedding,
        match_agent: this.agentName,
        match_type: opts.memoryType || null,
        match_domain: opts.domain || null,
        min_importance: opts.minImportance || 1,
        match_limit: opts.limit || 5,
      });

      if (error) {
        console.error("[Memory] Semantic search error:", error.message);
        return this.textSearch(query, opts);
      }

      return (data || []).map((row: any) => ({
        memory: row as Memory,
        relevance: 1 - (row.distance || 0), // cosine distance → similarity
      }));
    } catch {
      return this.textSearch(query, opts);
    }
  }

  // ─── Generate Embedding (OpenAI) ──────────────────────────────────

  private async generateEmbedding(text: string): Promise<number[] | null> {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return null;

    try {
      const response = await robustFetch("https://api.openai.com/v1/embeddings", {
        timeoutMs: 10000,
        retries: 1,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: text.slice(0, 8000), // limit input
          }),
        },
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data.data?.[0]?.embedding || null;
    } catch {
      return null;
    }
  }

  // ─── CONSOLIDATE: Merge similar memories ──────────────────────────

  async consolidate(opts: { domain?: string; olderThanDays?: number } = {}): Promise<number> {
    const olderThan = new Date(Date.now() - (opts.olderThanDays || 30) * 86400000).toISOString();

    let query = this.supabase.from("agent_memories")
      .select("*")
      .eq("agent_name", this.agentName)
      .lte("created_at", olderThan)
      .order("memory_type")
      .order("domain");

    if (opts.domain) query = query.eq("domain", opts.domain);

    const { data: memories } = await query;
    if (!memories || memories.length < 3) return 0;

    // Group by type + domain
    const groups = new Map<string, Memory[]>();
    for (const m of memories as Memory[]) {
      const key = `${m.memory_type}:${m.domain || "general"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }

    let consolidated = 0;
    for (const [key, group] of groups) {
      if (group.length < 3) continue;

      // Use AI to consolidate
      const contents = group.map(m => `- [${m.created_at.split("T")[0]}] ${m.content}`).join("\n");
      const summary = await callOpenAI(
        "Tu es un système de consolidation de mémoire. Fusionne ces souvenirs similaires en 1-3 entrées concises et actionnables. Garde les insights uniques, supprime les doublons.",
        `Groupe: ${key}\n\nSouvenirs:\n${contents}`,
        300,
        { temperature: 0.2 }
      );

      if (summary) {
        // Store consolidated memory
        const maxImportance = Math.max(...group.map(m => m.importance));
        const allTags = [...new Set(group.flatMap(m => m.tags))];
        const [type, domain] = key.split(":");

        await this.store(summary, type as MemoryType, {
          domain: domain === "general" ? undefined : domain,
          importance: Math.min(5, maxImportance + 1), // boost importance
          tags: [...allTags, "consolidated"],
        });

        // Mark originals as consolidated (soft delete)
        const ids = group.map(m => m.id).filter(Boolean);
        await this.supabase.from("agent_memories")
          .update({ expires_at: new Date().toISOString() })
          .in("id", ids);

        consolidated += group.length;
      }
    }

    return consolidated;
  }

  // ─── FORGET: Decay old, unimportant memories ─────────────────────

  async decay(): Promise<number> {
    // Delete expired memories
    const { data: expired } = await this.supabase.from("agent_memories")
      .select("id")
      .eq("agent_name", this.agentName)
      .lt("expires_at", new Date().toISOString())
      .lt("importance", 4); // Never decay importance 4-5

    if (!expired?.length) return 0;

    const ids = expired.map((m: any) => m.id);
    await this.supabase.from("agent_memories").delete().in("id", ids);
    return ids.length;
  }

  // ─── Context Builder (for agent prompts) ──────────────────────────

  async buildContext(query: string, domain?: string): Promise<string> {
    const memories = await this.recall(query, { domain, limit: 5, minImportance: 2 });
    if (memories.length === 0) return "";

    let context = "## Relevant Memories\n";
    for (const { memory, relevance } of memories) {
      const date = memory.created_at.split("T")[0];
      const badge = memory.importance >= 4 ? "⭐" : "📝";
      context += `${badge} [${date}] ${memory.content} (relevance: ${(relevance * 100).toFixed(0)}%)\n`;
    }
    return context;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

const memoryInstances: Record<string, AgentMemoryStore> = {};

export function getMemoryStore(agentName: AgentName): AgentMemoryStore {
  if (!memoryInstances[agentName]) {
    memoryInstances[agentName] = new AgentMemoryStore(agentName);
  }
  return memoryInstances[agentName];
}
