"""Per-request LLM credentials forwarded by the Go backend.

Forge does not ship a platform LLM. The backend stores the user's provider +
API key and sends them on every agent call via:

  X-Forge-LLM-Provider
  X-Forge-LLM-Model
  X-Forge-LLM-Key          (omitted for providers that do not need a key)

A ContextVar keeps the values scoped to the current request so get_chat_provider()
never leaks one user's key into another request.
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from src.config import settings


@dataclass(frozen=True)
class LLMRuntime:
    provider: str
    model: str
    api_key: str = ""


_current: ContextVar[LLMRuntime | None] = ContextVar("forge_llm_runtime", default=None)


def set_runtime(runtime: LLMRuntime | None):
    return _current.set(runtime)


def reset_runtime(token) -> None:
    _current.reset(token)


def current_runtime() -> LLMRuntime | None:
    return _current.get()


def resolve_runtime() -> LLMRuntime:
    """Request-scoped credentials, falling back to process env for local/dev."""
    runtime = current_runtime()
    if runtime is not None and runtime.provider:
        return runtime
    return LLMRuntime(
        provider=(settings.chat.provider or "").strip(),
        model=(settings.chat.model or "").strip(),
        api_key=_env_key_for(settings.chat.provider),
    )


def _env_key_for(provider: str) -> str:
    p = (provider or "").lower()
    mapping = {
        "openai": settings.openai_api_key,
        "gemini": settings.gemini_api_key,
        "anthropic": settings.anthropic_api_key,
        "groq": settings.groq_api_key,
        "openrouter": settings.openrouter_api_key,
        "tokenrouter": settings.tokenrouter_api_key,
        "mistral": settings.mistral_api_key,
        "cohere": settings.cohere_api_key,
        "ollama": "",
    }
    return mapping.get(p, "")
