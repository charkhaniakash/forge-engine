"""
Cohere streaming chat provider.

Cohere provides access to various models through their API at
https://api.cohere.ai/v2/chat. This provider uses Cohere's native API format.

Get a key at https://dashboard.cohere.com/api-keys and set COHERE_API_KEY.

Popular models for planning / code tasks (as of 2026):
  command-a-plus-05-2026   — Cohere's latest command model
  command-r-plus-08-2024   — Cohere's command R+ model
  command-light-04-2024    — Cohere's lightweight model

JSON mode:
  Cohere supports structured output through their API, which the planning
  pipeline relies on for structured output.

Configuration (via .env.local or environment):
  CHAT__PROVIDER=cohere
  CHAT__MODEL=command-a-plus-05-2026
  COHERE_API_KEY=...             # required
  COHERE_BASE_URL=https://api.cohere.ai/v2   # default; rarely changed
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, AsyncIterator

import structlog
import httpx

from src.config import settings

logger = structlog.get_logger()

# Cohere's API endpoint. Overridable via COHERE_BASE_URL.
_DEFAULT_BASE_URL = "https://api.cohere.ai/v2"


class CohereChatProvider:
    """Streams chat completions from Cohere's API."""

    def __init__(self) -> None:
        api_key = settings.cohere_api_key
        if not api_key:
            raise RuntimeError(
                "COHERE_API_KEY is not set. Get a key at "
                "https://dashboard.cohere.com/api-keys and set COHERE_API_KEY "
                "(or add it to agent/.env.local)."
            )

        base_url = os.getenv("COHERE_BASE_URL", _DEFAULT_BASE_URL)
        self._base_url = base_url
        self._api_key = api_key
        self._model = settings.chat.model
        self._max_retries = 6
        self._base_delay = 1.0  # 1+2+4+8+16+32 = 63 seconds total before giving up
        logger.info(
            "cohere_provider_init",
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

        # Log the incoming messages for debugging
        logger.info("cohere_chat_stream_start", messages_count=len(messages), request_id=request_id)

        # Convert OpenAI-style messages to Cohere format
        cohere_messages = []
        for msg in messages:
            if not isinstance(msg, dict):
                logger.warning("cohere_chat_invalid_message_type", type=type(msg), request_id=request_id)
                continue
            role = msg.get("role", "user")
            content = msg.get("content", "")
            # Handle case where content might be a dict or other type
            if isinstance(content, dict):
                logger.warning("cohere_chat_dict_content", role=role, content_keys=list(content.keys()), request_id=request_id)
                content = str(content)
            elif content is None:
                content = ""
            elif not isinstance(content, str):
                logger.warning("cohere_chat_non_string_content", type=type(content), role=role, request_id=request_id)
                content = str(content)
            if role == "system":
                cohere_messages.append({"role": "system", "content": content})
            elif role == "user":
                cohere_messages.append({"role": "user", "content": content})
            elif role == "assistant":
                cohere_messages.append({"role": "assistant", "content": content})

        request_body: dict[str, Any] = {
            "model": effective_model,
            "messages": cohere_messages,
            "stream": True,
        }

        if response_format and response_format.get("type") == "json_object":
            request_body["response_format"] = {"type": "json_object"}

        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "POST",
                        f"{self._base_url}/chat",
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "Content-Type": "application/json",
                        },
                        json=request_body,
                        timeout=60.0,
                    ) as response:
                        response.raise_for_status()

                        async for line in response.aiter_lines():
                            if not line.strip():
                                continue
                            if line.startswith("data: "):
                                data_str = line[6:]
                                if data_str == "[DONE]":
                                    break
                                try:
                                    import json
                                    data = json.loads(data_str)
                                    if data.get("type") == "content-delta":
                                        delta = data.get("delta", {}).get("message", {}).get("content", "")
                                        # Cohere returns delta as a dict with 'text' key
                                        if isinstance(delta, dict):
                                            delta = delta.get("text", "")
                                        if not isinstance(delta, str):
                                            logger.warning("cohere_chat_non_string_delta", type=type(delta), delta=str(delta)[:200], request_id=request_id)
                                            delta = str(delta) if delta else ""
                                        if delta:
                                            yield {
                                                "v": 1, "event": "token", "seq": seq,
                                                "request_id": request_id, "text": delta,
                                            }
                                            seq += 1
                                    elif data.get("type") == "usage":
                                        total_tokens = data.get("usage", {}).get("output_tokens", 0)
                                except json.JSONDecodeError as e:
                                    logger.warning("cohere_chat_json_decode_error", error=str(e), line=data_str[:100], request_id=request_id)
                                    continue
                                except Exception as e:
                                    logger.error("cohere_chat_stream_parse_error", error=str(e), line=data_str[:100], request_id=request_id)
                                    continue

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
                        "cohere_chat_connection_error_retrying",
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
                        "cohere_chat_error",
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
