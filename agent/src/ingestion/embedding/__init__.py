# Embedding provider package.
# Import from this package to access the provider abstraction and factory.
from src.ingestion.embedding.base import EmbeddingProvider
from src.ingestion.embedding.factory import get_embedding_provider

__all__ = ["EmbeddingProvider", "get_embedding_provider"]
