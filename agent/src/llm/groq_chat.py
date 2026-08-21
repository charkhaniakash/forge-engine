"""
Groq streaming chat provider.

Groq serves open models (Llama, Mixtral, Gemma, gpt-oss, …) on its LPU
inference hardware and exposes an OpenAI-compatible REST API at
https://api.groq.com/openai/v1, so this provider reuses the openai SDK
with a custom base_url — same approach as OllamaChatProvider, but Groq is
a hosted service and DOES require an API key.

Get a key at https://console.groq.com/keys and set GROQ_API_KEY.

Recommended models for planning / code tasks (as of 2026):
  qwen/qwen3.6-27b   — strong general model, good JSON adherence
  llama-3.1-8b-instant      — fastest, cheapest, weaker on strict schemas
  qwen/qwen3.6-27b       — high quality, larger context
  qwen-2.5-coder-32b        — code-focused (if available on your account)

JSON mode:
  Groq honours response_format={"type": "json_object"} for most models,
  which the planning pipeline relies on for structured output.

Configuration (via .env.local or environment):
  CHAT__PROVIDER=groq
  CHAT__MODEL=qwen/qwen3.6-27b
  GROQ_API_KEY=gsk_...                       # required
  GROQ_BASE_URL=https://api.groq.com/openai/v1   # default; rarely changed
"""
from __future__ import annotations

import os
from typing import Any, AsyncIterator

import structlog
from openai import AsyncOpenAI

from src.config import settings

logger = structlog.get_logger()

# Groq's OpenAI-compatible endpoint. Overridable via GROQ_BASE_URL.
_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"


class GroqChatProvider:
    """Streams chat completions from Groq's OpenAI-compatible API."""

    def __init__(self) -> None:
        api_key = settings.groq_api_key
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Get a key at "
                "https://console.groq.com/keys and set GROQ_API_KEY "
                "(or add it to agent/.env.local)."
            )

        base_url = os.getenv("GROQ_BASE_URL", _DEFAULT_BASE_URL)
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._model = settings.chat.model
        logger.info(
            "groq_provider_init",
            model=self._model,
            base_url=base_url,
        )

    @property
    def model_name(self) -> str:
        return self._model

    async def stream(
        self,
        messages: list[dict],
        payload: dict,
        request_id: str,
        response_format: dict[str, Any] | None = None,
        model: str | None = None,
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0
        effective_model = model or self._model

        kwargs: dict[str, Any] = dict(
            model=effective_model,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
        )
        if response_format:
            kwargs["response_format"] = response_format

        try:
            response = await self._client.chat.completions.create(**kwargs)

            async for chunk in response:
                if getattr(chunk, "usage", None):
                    total_tokens = chunk.usage.completion_tokens or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    yield {
                        "v": 1, "event": "token", "seq": seq,
                        "request_id": request_id, "text": delta.content,
                    }
                    seq += 1

        except Exception as exc:
            logger.error(
                "groq_chat_error",
                error=str(exc),
                request_id=request_id,
                model=effective_model,
            )
            yield {
                "v": 1, "event": "error", "seq": seq,
                "request_id": request_id, "message": str(exc),
            }
            return

        done: dict = {
            "v": 1, "event": "done", "seq": seq,
            "request_id": request_id, "model": effective_model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done
