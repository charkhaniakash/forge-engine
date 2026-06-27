"""
OpenAI embedding provider.

Wraps the OpenAI embeddings API. Supports any model accessible via
the /v1/embeddings endpoint (text-embedding-3-small, text-embedding-3-large,
text-embedding-ada-002, etc.).

Batching: delegates to the caller — embed() sends all texts in one API call.
The ingestion pipeline (job.py) slices its work into batches before calling
embed(), so individual calls here are already batch-sized.
"""
from __future__ import annotations

import openai

from src.ingestion.embedding.base import EmbeddingProvider


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """Embedding provider backed by the OpenAI embeddings API."""

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise RuntimeError(
                "OpenAIEmbeddingProvider requires OPENAI_API_KEY to be set"
            )
        self._client = openai.OpenAI(api_key=api_key)
        self._model = model

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
        # OpenAI guarantees the response order matches the input order.
        return [item.embedding for item in response.data]
