"""
Public embedding interface used by the ingestion pipeline.

This module is the stable API boundary between job.py and the embedding
subsystem. job.py calls embed_batch() exactly as before — the provider
abstraction is entirely hidden behind this shim.

Provider selection happens in src/ingestion/embedding/factory.py.
To change providers, set EMBEDDING_PROVIDER in the environment.
"""
from __future__ import annotations

from src.ingestion.embedding.factory import get_embedding_provider


def embed_batch(texts: list[str]) -> list[list[float]]:
    """
    Embed a batch of texts using the configured provider.

    Returns one float vector per input text, in the same order.
    Raises on API error — job.py catches and writes NULL embeddings
    so parsed content is never lost.

    The provider and model are selected via config (EMBEDDING_PROVIDER,
    EMBEDDING_MODEL). This function contains no provider-specific logic.
    """
    if not texts:
        return []
    provider = get_embedding_provider()
    return provider.embed(texts)


def active_model_name() -> str:
    """
    Return the model name stored in code_chunks.embedding_model for
    chunks embedded in the current process.

    job.py does not call this — vector_store.py reads settings.embedding_model
    directly. This is provided as a convenience for tests and diagnostics.
    """
    return get_embedding_provider().model_name
