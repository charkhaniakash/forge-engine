"""
Factory for the ChatProvider selected by CHAT__PROVIDER.

The only place in the codebase that branches on the chat provider name.
Adding a new provider: implement ChatProvider and add a case here.
"""
from __future__ import annotations

from src.config import settings
from src.llm.chat_provider import ChatProvider

# Module-level singleton — avoids recreating API clients (and their connection
# pools) on every LLM call. Safe in asyncio (single-threaded event loop).
_instance: ChatProvider | None = None


def get_chat_provider() -> ChatProvider:
    """Return the shared ChatProvider instance for the configured CHAT__PROVIDER."""
    global _instance
    if _instance is not None:
        return _instance

    provider = settings.chat.provider.lower()

    if provider == "openai":
        from src.llm.openai_chat import OpenAIChatProvider
        _instance = OpenAIChatProvider()

    elif provider == "gemini":
        from src.llm.gemini_chat import GeminiChatProvider
        _instance = GeminiChatProvider()

    elif provider == "anthropic":
        from src.llm.anthropic_chat import AnthropicChatProvider
        _instance = AnthropicChatProvider()

    elif provider == "ollama":
        from src.llm.ollama_chat import OllamaChatProvider
        _instance = OllamaChatProvider()

    elif provider == "groq":
        from src.llm.groq_chat import GroqChatProvider
        _instance = GroqChatProvider()

    elif provider == "openrouter":
        from src.llm.openrouter_chat import OpenRouterChatProvider
        _instance = OpenRouterChatProvider()

    elif provider == "tokenrouter":
        from src.llm.tokenrouter_chat import TokenRouterChatProvider
        _instance = TokenRouterChatProvider()

    elif provider == "mistral":
        from src.llm.mistral_chat import MistralChatProvider
        _instance = MistralChatProvider()

    elif provider == "cohere":
        from src.llm.cohere_chat import CohereChatProvider
        _instance = CohereChatProvider()

    else:
        raise ValueError(
            f"Unknown CHAT__PROVIDER '{provider}'. "
            "Supported values: openai, gemini, anthropic, ollama, groq, openrouter, tokenrouter, mistral, cohere"
        )

    return _instance
