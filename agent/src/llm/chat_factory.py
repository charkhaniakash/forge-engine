"""
Factory for the ChatProvider selected by request-scoped credentials
(or CHAT__PROVIDER as a local/dev fallback).
"""
from __future__ import annotations

from src.llm.chat_provider import ChatProvider
from src.llm.runtime import LLMRuntime, resolve_runtime

# Env-based singleton only. Per-request BYOK instances are never cached.
_env_instance: ChatProvider | None = None
_env_fingerprint: str | None = None


def get_chat_provider() -> ChatProvider:
    runtime = resolve_runtime()
    if not runtime.provider:
        raise RuntimeError(
            "No LLM provider configured. Add an API key in Settings → Models, "
            "or set CHAT__PROVIDER for local development."
        )
    return create_chat_provider(runtime)


def create_chat_provider(runtime: LLMRuntime) -> ChatProvider:
    provider = runtime.provider.lower()
    model = runtime.model
    api_key = runtime.api_key

    if provider == "openai":
        from src.llm.openai_chat import OpenAIChatProvider
        return OpenAIChatProvider(api_key=api_key, model=model)

    if provider == "gemini":
        from src.llm.gemini_chat import GeminiChatProvider
        return GeminiChatProvider(api_key=api_key, model=model)

    if provider == "anthropic":
        from src.llm.anthropic_chat import AnthropicChatProvider
        return AnthropicChatProvider(api_key=api_key, model=model)

    if provider == "ollama":
        from src.llm.ollama_chat import OllamaChatProvider
        return OllamaChatProvider(model=model)

    if provider == "groq":
        from src.llm.groq_chat import GroqChatProvider
        return GroqChatProvider(api_key=api_key, model=model)

    if provider == "openrouter":
        from src.llm.openrouter_chat import OpenRouterChatProvider
        return OpenRouterChatProvider(api_key=api_key, model=model)

    if provider == "tokenrouter":
        from src.llm.tokenrouter_chat import TokenRouterChatProvider
        return TokenRouterChatProvider(api_key=api_key, model=model)

    if provider == "mistral":
        from src.llm.mistral_chat import MistralChatProvider
        return MistralChatProvider(api_key=api_key, model=model)

    if provider == "cohere":
        from src.llm.cohere_chat import CohereChatProvider
        return CohereChatProvider(api_key=api_key, model=model)

    raise ValueError(
        f"Unknown chat provider '{provider}'. "
        "Supported: openai, gemini, anthropic, ollama, groq, openrouter, tokenrouter, mistral, cohere"
    )
