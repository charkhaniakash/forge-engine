"""
Google Gemini embedding provider.

Uses the google-genai SDK (pip: google-genai), which is the current
recommended SDK for the Gemini API. This replaces the deprecated
google-generativeai package that used the v1beta endpoint where
embedding models are no longer available.

SDK:    google-genai  (from google.genai import Client)
API:    v1  (not v1beta)
Model:  gemini-embedding-001  (1536-dim)

Usage:
    EMBEDDING_PROVIDER=gemini
    GEMINI_API_KEY=your-api-key
    EMBEDDING_MODEL=gemini-embedding-001
    EMBEDDING_DIMENSIONS=1536
"""
from __future__ import annotations

from google import genai
from google.genai import types

from src.ingestion.embedding.base import EmbeddingProvider

import structlog

logger = structlog.get_logger()


class GeminiEmbeddingProvider(EmbeddingProvider):
    """
    Embedding provider backed by the Gemini Developer API via google-genai SDK.

    The new SDK uses a Client object with client.models.embed_content().
    It targets the v1 API endpoint where embedding models are available.

    Batching: the embed_content call accepts a list of strings directly,
    so we send the full batch in one request rather than looping.
    """

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise RuntimeError(
                "GeminiEmbeddingProvider requires GEMINI_API_KEY to be set"
            )
        self._client = genai.Client(api_key=api_key)
        self._model = model
        logger.info(
            "gemini_provider_initialised",
            model=self._model,
            sdk="google-genai",
        )

    @property
    def model_name(self) -> str:
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        logger.info(
            "gemini_embed_batch_start",
            model=self._model,
            count=len(texts),
        )

        response = self._client.models.embed_content(
            model=self._model,
            contents=texts,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT",
                output_dimensionality=768,
            ),
        )

        vectors = [e.values for e in response.embeddings]

        logger.info(
            "gemini_embed_batch_done",
            model=self._model,
            count=len(vectors),
            dims=len(vectors[0]) if vectors else 0,
        )

        return vectors
