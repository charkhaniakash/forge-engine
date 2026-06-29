from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Service
    agent_port: int = 8000
    backend_url: str = "http://backend:8080"
    log_level: str = "info"

    # Phase 3 — database (direct writes for pgvector)
    database_url: str = "postgresql://forge:forge@postgres:5432/forge"

    # ── Embedding provider ────────────────────────────────────────────────────
    # Selects which embedding backend to use. The only place that reads this
    # is src/ingestion/embedding/factory.py — no other module branches on it.
    #
    # Supported values: "gemini" (default), "openai"
    # Adding a new provider: implement EmbeddingProvider and register in factory.py.
    embedding_provider: str = "gemini"

    # The model identifier sent to the provider API and stored in
    # code_chunks.embedding_model. Must match the provider's model names.
    #
    # Gemini:  gemini-embedding-001 (1536-dim) — current recommended model
    # OpenAI:  text-embedding-3-small (1536-dim)
    #
    # ⚠️  All chunks for a repository must use the same embedding model.
    #     Changing this after a repository has been indexed requires running
    #     a re-index job for every affected repository.
    embedding_model: str = "gemini-embedding-001"

    # Output dimension of the embedding model.
    # Must match the vector(N) column type in code_chunks.
    # gemini-embedding-001 = 1536 dims (matches pgvector column default).
    # Changing this requires a database migration.
    embedding_dimensions: int = 1536

    # Number of texts per embed() call. Each provider handles this internally.
    embedding_batch_size: int = 32

    # Maximum tokens per chunk before the chunker splits it.
    chunk_token_limit: int = 512

    # ── Provider API keys ─────────────────────────────────────────────────────
    # Only the key for the selected provider needs to be set.
    openai_api_key: str = ""
    gemini_api_key: str = ""

    class Config:
        env_file = ".env.local"
        env_file_encoding = "utf-8"


settings = Settings()
