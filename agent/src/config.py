"""
Agent configuration — all settings loaded from environment variables.

Structure:
  Settings holds three nested config objects:
    embedding  — provider/model for Phase 3 ingestion embeddings
    chat       — provider/model for Phase 4 Q&A LLM calls
    retrieval  — tuning knobs for the Phase 4 retrieval pipeline

Nested env vars use double-underscore delimiter:
  EMBEDDING__PROVIDER=openai
  CHAT__MODEL=gpt-4o-mini
  RETRIEVAL__CANDIDATE_K=100

Single-level keys remain unchanged:
  DATABASE_URL, OPENAI_API_KEY, GEMINI_API_KEY, ...
"""
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class EmbeddingConfig(BaseModel):
    """Configuration for the Phase 3 embedding provider."""
    # Provider name. Only the key for the selected provider needs to be set.
    # Supported: "ollama" | "gemini" | "openai"
    provider: str = "gemini"

    # Model identifier sent to the provider API and stored in
    # code_chunks.embedding_model. Must match the provider's model names.
    # ollama: nomic-embed-text = 768 dims
    # gemini: gemini-embedding-001 = 3072 dims
    # openai: text-embedding-3-small = 1536 dims
    model: str = "gemini-embedding-001"

    # Output dimension. Must match the vector(N) column in code_chunks.
    # Changing this after data exists requires a migration + full re-index.
    dimensions: int = 3072

    # Texts per embed() call.
    batch_size: int = 32


class ChatConfig(BaseModel):
    """Configuration for Phase 4 Q&A chat completions.

    Deliberately separate from EmbeddingConfig — embedding and chat serve
    different jobs (batch offline vs. real-time inference) and may use
    different providers, models, and rate-limit budgets.
    """
    # Provider name. Supported: "openai" | "gemini" | "anthropic" | "ollama" | "groq" | "openrouter" | "tokenrouter" | "mistral" | "cohere"
    provider: str = "openai"

    # Chat model identifier sent to the provider.
    # openai:      gpt-4o-mini (default), gpt-4o
    # gemini:      gemini-2.5-flash, gemini-1.5-pro
    # anthropic:   claude-3-haiku-20240307, claude-3-sonnet-20240229
    # ollama:      gemma3:12b, gemma3:27b, qwen2.5-coder:7b, codellama:13b, qwen2.5-coder:14b
    # groq:        qwen/qwen3.6-27b, llama-3.1-8b-instant, qwen/qwen3.6-27b
    # openrouter:  nvidia/nemotron-3-ultra-550b-a55b:free, anthropic/claude-3.5-sonnet, openai/gpt-4o
    # tokenrouter: moonshotai/kimi-k3-free
    # mistral:     mistral-medium-latest, mistral-large-latest, codestral-latest
    # cohere:      command-a-plus-05-2026, command-r-plus-08-2024, command-light-04-2024
    model: str = "command-a-plus-05-2026"


class RetrievalConfig(BaseModel):
    """Tuning knobs for the retrieval pipeline.

    Profile-driven: each capability (Q&A, planning, execution) selects
    its own profile. The RetrievalEngine is identical across all profiles.

    Pipeline: candidate_k → (filter) → rerank_k → (diversity) → final_k
    """
    # ── Q&A profile ───────────────────────────────────────────────────────────
    candidate_k: int = 50
    rerank_k: int = 15
    final_k: int = 8
    max_chunks_per_file: int = 3
    context_token_budget: int = 4096
    history_turns: int = 6

    # ── Planning profile ──────────────────────────────────────────────────────
    # Broader retrieval: more candidates, larger context, includes test files
    # so the planner understands existing test patterns and constraints.
    planning_candidate_k: int = 120
    planning_rerank_k: int = 30
    planning_final_k: int = 15
    planning_max_chunks_per_file: int = 5
    planning_context_token_budget: int = 8192
    planning_include_tests: bool = True


class Settings(BaseSettings):
    # ── Service ───────────────────────────────────────────────────────────────
    agent_port: int = 8000
    backend_url: str = "http://backend:8080"
    log_level: str = "info"

    # ── Database (Phase 3 direct pgvector writes + Phase 4 retrieval) ─────────
    database_url: str = "postgresql://forge:forge@postgres:5432/forge"

    # ── Provider API keys ─────────────────────────────────────────────────────
    # Only the keys for the active providers need to be set.
    openai_api_key: str = ""
    gemini_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    tokenrouter_api_key: str = ""
    mistral_api_key: str = ""
    cohere_api_key: str = ""

    # ── Ollama (local models — Gemma, CodeLlama, Qwen, etc.) ─────────────────
    # Base URL of the running Ollama instance. The /v1 suffix is appended
    # automatically by OllamaChatProvider if not already present.
    ollama_base_url: str = "http://localhost:11434"
    # Groq (hosted OpenAI-compatible API). Get a key at https://console.groq.com/keys
    groq_api_key: str = ""

    # ── Chunker (Phase 3) ─────────────────────────────────────────────────────
    chunk_token_limit: int = 512

    # ── Nested configs ────────────────────────────────────────────────────────
    embedding: EmbeddingConfig = EmbeddingConfig()
    chat: ChatConfig = ChatConfig()
    retrieval: RetrievalConfig = RetrievalConfig()

    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
    )

    # ── Back-compat shims for Phase 3 code that reads flat names ─────────────
    # Phase 3 modules (embedder, vector_store) read settings.embedding_model,
    # settings.embedding_dimensions, etc. These properties forward to the
    # nested object so existing code keeps working without changes.

    @property
    def embedding_provider(self) -> str:
        return self.embedding.provider

    @property
    def embedding_model(self) -> str:
        return self.embedding.model

    @property
    def embedding_dimensions(self) -> int:
        return self.embedding.dimensions

    @property
    def embedding_batch_size(self) -> int:
        return self.embedding.batch_size


settings = Settings()
