"""
Ollama streaming chat provider.

Serves any model running locally via Ollama (https://ollama.com).
Ollama exposes an OpenAI-compatible REST API on http://localhost:11434,
so this provider reuses the openai SDK with a custom base_url.

Recommended local models for code tasks:
  gemma3:12b          — best balance of quality and speed on an M-series Mac
  gemma3:27b          — higher quality, needs ~20 GB RAM
  qwen2.5-coder:7b           — fastest, lower RAM (~5 GB), acceptable for simple tasks
  codellama:13b       — Meta's code-focused model
  qwen2.5-coder:14b   — strong at code, OpenAI-compatible via Ollama

JSON mode:
  Ollama honours the response_format={\"type\":\"json_object\"} param for models
  that support it (gemma3, qwen2.5-coder, llama3.x).  For models that do NOT
  support it, set OLLAMA_FORCE_JSON_PROMPT=true to inject a system-level hint
  instead (less reliable, but works as a fallback).

Configuration (via .env.local or environment):
  CHAT__PROVIDER=ollama
  CHAT__MODEL=gemma3:12b          # any model pulled with `ollama pull <model>`
  OLLAMA_BASE_URL=http://localhost:11434  # default; change if Ollama runs elsewhere
"""
from __future__ import annotations

import os
from typing import Any, AsyncIterator

import structlog
from openai import AsyncOpenAI

from src.config import settings

logger = structlog.get_logger()

# Fallback base URL — can be overridden by OLLAMA_BASE_URL env var.
_DEFAULT_BASE_URL = "http://localhost:11434/v1"


class OllamaChatProvider:
    """Streams chat completions from a locally-running Ollama instance."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        base_url = os.getenv("OLLAMA_BASE_URL", settings.ollama_base_url or _DEFAULT_BASE_URL)
        # Ensure the path ends with /v1 (Ollama's OpenAI-compat prefix).
        if not base_url.rstrip("/").endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

        # Ollama doesn't require a real API key; the SDK still needs a non-empty string.
        self._client = AsyncOpenAI(
            api_key=api_key or "ollama",
            base_url=base_url,
        )
        self._model = model or settings.chat.model
        self._force_json_prompt: bool = (
            os.getenv("OLLAMA_FORCE_JSON_PROMPT", "false").lower() == "true"
        )
        logger.info(
            "ollama_provider_init",
            model=self._model,
            base_url=base_url,
            force_json_prompt=self._force_json_prompt,
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

        # Build kwargs — Ollama uses the same OpenAI wire format.
        kwargs: dict[str, Any] = dict(
            model=effective_model,
            messages=self._maybe_inject_json_prompt(messages, response_format),
            stream=True,
        )

        # Pass response_format only when the model supports it and we're not
        # falling back to prompt injection.
        if response_format and not self._force_json_prompt:
            kwargs["response_format"] = response_format

        try:
            response = await self._client.chat.completions.create(**kwargs)

            async for chunk in response:
                # Ollama may or may not return usage; handle both.
                if hasattr(chunk, "usage") and chunk.usage:
                    total_tokens = getattr(chunk.usage, "completion_tokens", 0) or 0
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
                "ollama_chat_error",
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

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _maybe_inject_json_prompt(
        self,
        messages: list[dict],
        response_format: dict[str, Any] | None,
    ) -> list[dict]:
        """
        When OLLAMA_FORCE_JSON_PROMPT=true, prepend a system message that
        instructs the model to respond with valid JSON only.  This is a
        best-effort fallback for models that do not support response_format.
        """
        if not (self._force_json_prompt and response_format):
            return messages

        json_hint = {
            "role": "system",
            "content": (
                "IMPORTANT: You MUST respond with a single, valid JSON object only. "
                "Do not include any prose, markdown fences, or text outside the JSON."
            ),
        }
        # Prepend before any existing system message so it takes effect first.
        return [json_hint] + list(messages)
