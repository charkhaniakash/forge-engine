"""
LLM Provider abstraction — stub for Phase 0.
Real implementation depends on Phase 0 ADR decision.
"""

from abc import ABC, abstractmethod
from typing import AsyncIterator


class LLMProvider(ABC):
    """Abstract base for LLM providers."""

    @abstractmethod
    async def generate(self, prompt: str) -> AsyncIterator[str]:
        """Generate text streaming."""
        pass


class StubProvider(LLMProvider):
    """Stub provider for Phase 0 — no real calls."""

    async def generate(self, prompt: str) -> AsyncIterator[str]:
        yield "Stub LLM response (Phase 0)"