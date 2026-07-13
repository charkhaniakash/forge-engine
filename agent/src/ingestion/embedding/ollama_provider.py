"""
Ollama embedding provider.

Uses Ollama's OpenAI-compatible /v1/embeddings endpoint to generate
embeddings from locally-running models. No API key required.

Recommended models:
  nomic-embed-text   — 768 dims, excellent quality, ~274 MB
  mxbai-embed-large  — 1024 dims, slightly larger
  all-minilm         — 384 dims, very small and fast

Configuration (via .env.local or environment):
  EMBEDDING__PROVIDER=ollama
  EMBEDDING__MODEL=nomic-embed-text
  EMBEDDING__DIMENSIONS=768
  OLLAMA_BASE_URL=http://localhost:11434   # default
"""
from __future__ import annotations

import os

import openai
import structlog

from src.ingestion.embedding.base import EmbeddingProvider

logger = structlog.get_logger()

# Same default as the chat provider.
_DEFAULT_BASE_URL = "http://localhost:11434/v1"


class OllamaEmbeddingProvider(EmbeddingProvider):
    """Embedding provider backed by a locally-running Ollama instance."""

    def __init__(self, model: str) -> None:
        base_url = os.getenv("OLLAMA_BASE_URL", _DEFAULT_BASE_URL)
        # Ensure the path ends with /v1 (Ollama's OpenAI-compat prefix).
        if not base_url.rstrip("/").endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

        # Ollama doesn't require a real API key; the SDK still needs a non-empty string.
        self._client = openai.OpenAI(
            api_key="ollama",
            base_url=base_url,
        )
        self._model = model
        logger.info(
            "ollama_embedding_provider_init",
            model=self._model,
            base_url=base_url,
        )

    @property
    def model_name(self) -> str:
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        response = self._client.embeddings.create(
            model=self._model,
            input=texts,
        )
        # The response order matches the input order.
        return [item.embedding for item in response.data]
