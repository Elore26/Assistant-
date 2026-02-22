-- ============================================================
-- AGENTIC FRAMEWORK: ReAct agents, tool registry, guardrails, memory
-- Phase 1: Core tables for agentic AI capabilities
-- ============================================================

-- 1. AGENT MEMORIES — Long-term memory for agent reasoning
CREATE TABLE IF NOT EXISTS agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,                    -- which agent stored this
  memory_type TEXT NOT NULL CHECK (memory_type IN (
    'episodic', 'semantic', 'procedural', 'decision', 'preference'
  )),
  content TEXT NOT NULL,                       -- the memory content
  domain TEXT,                                 -- career, health, finance, etc.
  importance INT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  tags TEXT[] NOT NULL DEFAULT '{}',           -- searchable tags
  embedding VECTOR(1536),                      -- OpenAI text-embedding-3-small (Phase 2)
  access_count INT NOT NULL DEFAULT 0,         -- how often recalled
  last_accessed TIMESTAMPTZ,                   -- last recall time
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ                       -- null = never expires
);

-- Indexes for memory search
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_memories_type ON agent_memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_domain ON agent_memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON agent_memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON agent_memories USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_memories_content_search ON agent_memories USING gin(to_tsvector('english', content));

-- Phase 2: HNSW index for vector similarity search
-- CREATE INDEX IF NOT EXISTS idx_memories_embedding ON agent_memories USING hnsw(embedding vector_cosine_ops);

-- 2. AGENT EXECUTIONS — Audit log for every agent run
CREATE TABLE IF NOT EXISTS agent_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  goal TEXT NOT NULL,                          -- what the agent was trying to do
  success BOOLEAN NOT NULL DEFAULT false,
  output TEXT,                                 -- agent's final output (truncated)
  tool_calls_count INT NOT NULL DEFAULT 0,
  loops_count INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  trace JSONB,                                 -- reasoning trace (loops, tools, observations)
  error TEXT,                                  -- error if failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_executions_agent ON agent_executions(agent_name);
CREATE INDEX IF NOT EXISTS idx_executions_created ON agent_executions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_success ON agent_executions(success);

-- 3. AGENT BUDGETS — Daily budget tracking per agent
CREATE TABLE IF NOT EXISTS agent_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  date DATE NOT NULL,
  tokens_used INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  runs INT NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,
  is_circuit_broken BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_name, date)
);

CREATE INDEX IF NOT EXISTS idx_budgets_agent_date ON agent_budgets(agent_name, date);

-- 4. HELPER FUNCTION: Increment memory access count
CREATE OR REPLACE FUNCTION increment_memory_access(memory_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE agent_memories
  SET access_count = access_count + 1,
      last_accessed = now()
  WHERE id = ANY(memory_ids);
END;
$$ LANGUAGE plpgsql;

-- 5. HELPER FUNCTION: Match memories by vector similarity (Phase 2)
-- Uncomment after enabling pgvector extension
/*
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(1536),
  match_agent TEXT,
  match_type TEXT DEFAULT NULL,
  match_domain TEXT DEFAULT NULL,
  min_importance INT DEFAULT 1,
  match_limit INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  agent_name TEXT,
  memory_type TEXT,
  content TEXT,
  domain TEXT,
  importance INT,
  tags TEXT[],
  access_count INT,
  created_at TIMESTAMPTZ,
  distance FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.agent_name, m.memory_type, m.content, m.domain,
    m.importance, m.tags, m.access_count, m.created_at,
    m.embedding <=> query_embedding AS distance
  FROM agent_memories m
  WHERE m.agent_name = match_agent
    AND m.importance >= min_importance
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND (match_type IS NULL OR m.memory_type = match_type)
    AND (match_domain IS NULL OR m.domain = match_domain)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;
*/

-- 6. AUTO-CLEANUP: Delete expired memories older than 7 days
-- Can be called via pg_cron or a Supabase scheduled function
CREATE OR REPLACE FUNCTION cleanup_expired_memories()
RETURNS INT AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM agent_memories
  WHERE expires_at < now() - INTERVAL '7 days'
    AND importance < 4;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_budgets ENABLE ROW LEVEL SECURITY;

-- Service role policies
CREATE POLICY "service_all_agent_memories" ON agent_memories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_agent_executions" ON agent_executions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_agent_budgets" ON agent_budgets FOR ALL USING (true) WITH CHECK (true);
