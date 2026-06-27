"""
EmbeddingProvider — the single abstraction that the ingestion pipeline depends on.

Every concrete provider must implement this interface. The pipeline (job.py)
never imports a concrete provider directly — it always goes through the factory.

Adding a new provider (Voyage AI, Cohere, Azure OpenAI, Ollama, etc.) means:
  1. Create a new file in this package that subclasses EmbeddingProvider.
  2. Register it in factory.py.
  Nothing else changes.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    """
    Strategy interface for text embedding providers.

    Contract:
    - embed() receives a non-empty list of strings.
    - It returns one float vector per input string, in the same order.
    - The returned vectors must all have the same dimension.
    - Batching is the provider's responsibility — callers may pass any number
      of texts and should receive exactly len(texts) vectors back.
    - Raises on unrecoverable API error. The caller (job.py) handles the
      exception by writing NULL embeddings so content is not lost.
    """

    @property
    @abstractmethod
    def model_name(self) -> str:
        """
        The canonical model identifier stored in code_chunks.embedding_model.
        Must be stable — changing it after indexed data exists requires a
        full re-index of every affected repository.
        """

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """
        Embed a list of texts and return one vector per text.

        Args:
            texts: Non-empty list of strings to embed.

        Returns:
            List of float vectors, same length as texts, same order.

        Raises:
            RuntimeError: if the provider is not configured (missing API key).
            Exception: on API error — callers should handle and write NULLs.
        """
