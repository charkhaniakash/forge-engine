-- Migration 015: Resize embedding column for local Ollama embeddings.
-- nomic-embed-text produces 768-dimension vectors (was 1536 for OpenAI).
-- This migration:
--   1. Drops the existing ivfflat index (cannot ALTER vector dimensions with index present).
--   2. Deletes all existing embeddings (they were produced by a different model/dimension).
--   3. Changes the column type from vector(1536) to vector(768).
--   4. Recreates the ivfflat index.
-- After running, a full re-ingestion of all repositories is required.

-- Drop the old index
DROP INDEX IF EXISTS idx_code_chunks_embedding;

-- Delete existing chunks — they have incompatible embeddings.
-- Ingestion jobs will be re-queued by the user.
DELETE FROM code_chunks;

-- Alter column to 768 dimensions (nomic-embed-text)
ALTER TABLE code_chunks
    ALTER COLUMN embedding TYPE vector(768);

-- Recreate the ivfflat index
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
ON code_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
