"""
Google Gemini embedding provider.

Wraps the Google Generative AI embeddings API using the
google-generativeai SDK. Supports any model accessible via
genai.embed_content() (e.g. models/text-embedding-004).

Batching: the Gemini embed_content API accepts one text per call.
This provider handles batching internally — embed() loops over
each text individually and returns all vectors in order.

Default model: models/text-embedding-004
  - 768-dimensional output
  - Optimised for retrieval tasks (task_type=RETRIEVAL_DOCUMENT)

⚠️  Dimension mismatch warning:
  code_chunks.embedding is declared as vector(1536) to match
  text-embedding-3-small. If you switch to Gemini (768-dim), you
  must run a migration to change the column type and re-index all
  existing repositories. See Requirement.md §Embedding Providers.
"""
from __future__ import annotations

import google.generativeai as genai

from src.ingestion.embedding.base import EmbeddingProvider

# Task type for retrieval-optimised embeddings.
# RETRIEVAL_DOCUMENT is the correct type when indexing corpus content.
_TASK_TYPE = "RETRIEVAL_DOCUMENT"


class GeminiEmbeddingProvider(EmbeddingProvider):
    """Embedding provider backed by the Google Gemini embeddings API."""

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise RuntimeError(
                "GeminiEmbeddingProvider requires GEMINI_API_KEY to be set"
            )
        genai.configure(api_key=api_key)
        self._model = model

    @property
    def model_name(self) -> str:
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        vectors: list[list[float]] = []
        for text in texts:
            result = genai.embed_content(
                model=self._model,
                content=text,
                task_type=_TASK_TYPE,
            )
            vectors.append(result["embedding"])

        return vectors
