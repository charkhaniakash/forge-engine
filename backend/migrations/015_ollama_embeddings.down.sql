-- Rollback migration 015: Revert embedding column to 1536 dimensions (OpenAI).
-- After rolling back, a full re-ingestion is required with the OpenAI provider.

DROP INDEX IF EXISTS idx_code_chunks_embedding;

DELETE FROM code_chunks;

ALTER TABLE code_chunks
    ALTER COLUMN embedding TYPE vector(1536);

CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
ON code_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
