"""
Embedding provider factory — the single point where provider selection occurs.

This is the ONLY place in the codebase that contains provider-specific
conditional logic. Every other module depends on EmbeddingProvider (the
abstract base class), never on a concrete implementation.

Supported providers (EMBEDDING_PROVIDER env var):
  openai   → OpenAIEmbeddingProvider   (default)
  gemini   → GeminiEmbeddingProvider

Adding a new provider:
  1. Create src/ingestion/embedding/<name>_provider.py implementing EmbeddingProvider.
  2. Add an entry to _REGISTRY below.
  3. Set EMBEDDING_PROVIDER=<name> in your environment.
  Nothing else changes.

The factory is called once at module import time (via get_embedding_provider()).
The resulting singleton is reused for every batch in a job to avoid
re-initialising API clients on each call.
"""
from __future__ import annotations

from src.config import settings
from src.ingestion.embedding.base import EmbeddingProvider

# Registry maps provider name → (import thunk, default model attr on settings)
# Using thunks (lambdas) so we only import the concrete module that is actually
# selected — avoids import errors for providers whose SDK is not installed.
_REGISTRY: dict[str, tuple] = {
    "openai": (
        lambda: _make_openai(),
    ),
    "gemini": (
        lambda: _make_gemini(),
    ),
}


def _make_openai() -> EmbeddingProvider:
    from src.ingestion.embedding.openai_provider import OpenAIEmbeddingProvider
    return OpenAIEmbeddingProvider(
        api_key=settings.openai_api_key,
        model=settings.embedding_model,
    )


def _make_gemini() -> EmbeddingProvider:
    from src.ingestion.embedding.gemini_provider import GeminiEmbeddingProvider
    return GeminiEmbeddingProvider(
        api_key=settings.gemini_api_key,
        model=settings.embedding_model,
    )


# Module-level singleton — initialised on first call.
_provider: EmbeddingProvider | None = None


def get_embedding_provider() -> EmbeddingProvider:
    """
    Return the configured embedding provider singleton.

    Reads EMBEDDING_PROVIDER from settings (default: "openai").
    Raises ValueError for unknown provider names.
    Raises RuntimeError if the selected provider is not configured
    (e.g. missing API key).
    """
    global _provider
    if _provider is not None:
        return _provider

    name = settings.embedding_provider.lower().strip()
    entry = _REGISTRY.get(name)
    if entry is None:
        supported = ", ".join(sorted(_REGISTRY.keys()))
        raise ValueError(
            f"Unknown embedding provider {name!r}. "
            f"Supported providers: {supported}. "
            f"Set EMBEDDING_PROVIDER to one of these values."
        )

    factory_fn = entry[0]
    _provider = factory_fn()
    return _provider


def reset_provider() -> None:
    """
    Reset the singleton. Intended for use in tests only — allows
    a test to swap the provider between test cases without side effects.
    """
    global _provider
    _provider = None
