"""
Factory for the ChatProvider selected by CHAT__PROVIDER.

The only place in the codebase that branches on the chat provider name.
Adding a new provider: implement ChatProvider and add a case here.
"""
from __future__ import annotations

from src.config import settings
from src.llm.chat_provider import ChatProvider


def get_chat_provider() -> ChatProvider:
    """Return the ChatProvider instance for the configured CHAT__PROVIDER."""
    provider = settings.chat.provider.lower()

    if provider == "openai":
        from src.llm.openai_chat import OpenAIChatProvider
        return OpenAIChatProvider()

    if provider == "gemini":
        from src.llm.gemini_chat import GeminiChatProvider
        return GeminiChatProvider()

    if provider == "anthropic":
        from src.llm.anthropic_chat import AnthropicChatProvider
        return AnthropicChatProvider()

    if provider == "ollama":
        from src.llm.ollama_chat import OllamaChatProvider
        return OllamaChatProvider()

    if provider == "groq":
        from src.llm.groq_chat import GroqChatProvider
        return GroqChatProvider()

    raise ValueError(
        f"Unknown CHAT__PROVIDER '{provider}'. "
        "Supported values: openai, gemini, anthropic, ollama, groq"
    )
