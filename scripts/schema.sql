-- scripts/schema.sql
-- LocalCode v2 memory schema

CREATE EXTENSION IF NOT EXISTS vector;

-- Cross-terminal session awareness
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  working_on TEXT,
  model TEXT,
  context_used REAL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions (last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project);

-- File conflict detection
CREATE TABLE IF NOT EXISTS file_claims (
  file_path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (file_path, session_id)
);

-- Archival memory with vector search
CREATE TABLE IF NOT EXISTS archival_memory (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'WORKING_SOLUTION', 'FAILED_APPROACH', 'ARCHITECTURAL_DECISION',
    'CODEBASE_PATTERN', 'ERROR_FIX', 'USER_PREFERENCE', 'OPEN_THREAD'
  )),
  content TEXT NOT NULL,
  context TEXT,
  tags TEXT[] DEFAULT '{}',
  confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  embedding vector(384),  -- 384-dim for BGE-small (default). Upgrading to BGE-large (1024-dim) requires ALTER COLUMN + re-embed.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archival_memory_type ON archival_memory (type);
CREATE INDEX IF NOT EXISTS idx_archival_memory_tags ON archival_memory USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_archival_memory_embedding
  ON archival_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Session handoff persistence
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  topic TEXT,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoffs_project ON handoffs (project, created_at DESC);
