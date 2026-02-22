-- ============================================================
-- PHASE 2: pgvector Semantic Memory
-- Enables embedding-based similarity search for agent memories
-- ============================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add HNSW index for fast cosine similarity search
-- Only if column exists (created in agentic_framework migration)
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON agent_memories
  USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 3. Semantic search function
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
    (m.embedding <=> query_embedding)::FLOAT AS distance
  FROM agent_memories m
  WHERE m.agent_name = match_agent
    AND m.importance >= min_importance
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND (match_type IS NULL OR m.memory_type = match_type)
    AND (match_domain IS NULL OR m.domain = match_domain)
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;

-- 4. Hybrid search: combines text + vector similarity
CREATE OR REPLACE FUNCTION hybrid_memory_search(
  query_text TEXT,
  query_embedding VECTOR(1536),
  match_agent TEXT,
  match_domain TEXT DEFAULT NULL,
  match_limit INT DEFAULT 5,
  text_weight FLOAT DEFAULT 0.3,
  vector_weight FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  memory_type TEXT,
  domain TEXT,
  importance INT,
  tags TEXT[],
  hybrid_score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT m.id, m.content, m.memory_type, m.domain, m.importance, m.tags,
           1.0 - (m.embedding <=> query_embedding)::FLOAT AS vec_score
    FROM agent_memories m
    WHERE m.agent_name = match_agent
      AND (match_domain IS NULL OR m.domain = match_domain)
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_limit * 3
  ),
  text_results AS (
    SELECT m.id, m.content, m.memory_type, m.domain, m.importance, m.tags,
           ts_rank(to_tsvector('english', m.content), websearch_to_tsquery('english', query_text))::FLOAT AS txt_score
    FROM agent_memories m
    WHERE m.agent_name = match_agent
      AND (match_domain IS NULL OR m.domain = match_domain)
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND to_tsvector('english', m.content) @@ websearch_to_tsquery('english', query_text)
    LIMIT match_limit * 3
  ),
  combined AS (
    SELECT
      COALESCE(v.id, t.id) AS id,
      COALESCE(v.content, t.content) AS content,
      COALESCE(v.memory_type, t.memory_type) AS memory_type,
      COALESCE(v.domain, t.domain) AS domain,
      COALESCE(v.importance, t.importance) AS importance,
      COALESCE(v.tags, t.tags) AS tags,
      (COALESCE(v.vec_score, 0) * vector_weight + COALESCE(t.txt_score, 0) * text_weight)
        + (COALESCE(v.importance, t.importance)::FLOAT / 50.0) AS hybrid_score
    FROM vector_results v
    FULL OUTER JOIN text_results t ON v.id = t.id
  )
  SELECT c.id, c.content, c.memory_type, c.domain, c.importance, c.tags, c.hybrid_score
  FROM combined c
  ORDER BY c.hybrid_score DESC
  LIMIT match_limit;
END;
$$;

-- 5. Batch embedding backfill function
-- Call this to generate embeddings for existing memories without them
CREATE OR REPLACE FUNCTION get_memories_needing_embeddings(batch_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, content TEXT)
LANGUAGE sql
AS $$
  SELECT m.id, m.content
  FROM agent_memories m
  WHERE m.embedding IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.importance DESC, m.created_at DESC
  LIMIT batch_limit;
$$;
