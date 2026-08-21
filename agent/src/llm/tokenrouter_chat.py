"""
TokenRouter streaming chat provider.

TokenRouter provides access to various models through an OpenAI-compatible API
at https://api.tokenrouter.com/v1. This provider reuses the openai SDK with a
custom base_url — same approach as OpenRouter and Groq.

Get a key and set TOKENROUTER_API_KEY.

Popular models for planning / code tasks (as of 2026):
  moonshotai/kimi-k3-free   — free Moonshot AI model

JSON mode:
  TokenRouter honours response_format={"type": "json_object"} for models that
  support it, which the planning pipeline relies on for structured output.

Configuration (via .env.local or environment):
  CHAT__PROVIDER=tokenrouter
  CHAT__MODEL=moonshotai/kimi-k3-free
  TOKENROUTER_API_KEY=...             # required
  TOKENROUTER_BASE_URL=https://api.tokenrouter.com/v1   # default; rarely changed
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, AsyncIterator

import structlog
from openai import AsyncOpenAI

from src.config import settings

logger = structlog.get_logger()

# TokenRouter's OpenAI-compatible endpoint. Overridable via TOKENROUTER_BASE_URL.
_DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1"


class TokenRouterChatProvider:
    """Streams chat completions from TokenRouter's OpenAI-compatible API."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        key = api_key if api_key is not None else settings.tokenrouter_api_key
        if not key:
            raise RuntimeError("TokenRouter API key is not set. Add it in Settings → Models.")

        base_url = os.getenv("TOKENROUTER_BASE_URL", _DEFAULT_BASE_URL)
        self._client = AsyncOpenAI(api_key=key, base_url=base_url)
        self._model = model or settings.chat.model
        self._max_retries = 6
        self._base_delay = 1.0  # 1+2+4+8+16+32 = 63 seconds total before giving up
        logger.info(
            "tokenrouter_provider_init",
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

        last_error: Exception | None = None
        for attempt in range(self._max_retries):
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

                # Success — break out of retry loop
                break

            except Exception as exc:
                last_error = exc
                error_msg = str(exc).lower()
                is_transient = any(
                    kw in error_msg
                    for kw in ["connection", "timeout", "unavailable", "rate limit",
                                "overloaded", "502", "503", "504", "peer closed"]
                )

                if is_transient and attempt < self._max_retries - 1:
                    delay = self._base_delay * (2 ** attempt)
                    logger.warning(
                        "tokenrouter_chat_connection_error_retrying",
                        error=str(exc),
                        attempt=attempt + 1,
                        max_retries=self._max_retries,
                        delay_seconds=delay,
                        request_id=request_id,
                    )
                    await asyncio.sleep(delay)
                    continue
                else:
                    logger.error(
                        "tokenrouter_chat_error",
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
