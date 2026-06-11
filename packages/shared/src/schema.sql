CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(384),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (type, name)
);

CREATE TABLE IF NOT EXISTS relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  UNIQUE (source_entity_id, target_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS sync_state (
  path TEXT PRIMARY KEY,
  last_hash TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hybrid retrieval: keyword search alongside vector search, so exact tokens
-- (service names, Kafka topics) are always findable.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS frontmatter JSONB NOT NULL DEFAULT '{}';
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS ts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS chunks_ts_idx ON chunks USING gin(ts);

-- Semantic extractor: which relations came from which document's LLM
-- extraction, so re-extraction can replace exactly its own output.
ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS origin_document_id UUID REFERENCES documents(id) ON DELETE CASCADE;

-- Audit log for agent edits of human notes: full attribution plus stepwise
-- undo (old_fragment is the inverse of the edit).
CREATE TABLE IF NOT EXISTS note_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL,
  agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  edit_kind TEXT NOT NULL DEFAULT 'replace',
  old_fragment TEXT,
  new_fragment TEXT NOT NULL,
  reverted_at TIMESTAMPTZ,
  reverted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_edits_path_idx ON note_edits(path, created_at DESC);

CREATE TABLE IF NOT EXISTS extraction_state (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  last_hash TEXT NOT NULL,
  model TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks(document_id);
CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_entity_id);
