"""
Gemini streaming chat provider.

response_format={"type":"json_object"} maps to MIME type application/json
in the Gemini generation config.
"""
from __future__ import annotations

from typing import Any, AsyncIterator

import structlog
from google import genai
from google.genai import types as genai_types

from src.config import settings

logger = structlog.get_logger()


class GeminiChatProvider:
    """Streams chat completions using the Google Gemini API."""

    def __init__(self) -> None:
        self._client = genai.Client(api_key=settings.gemini_api_key)
        self._model = settings.chat.model

    @property
    def model_name(self) -> str:
        return self._model

    async def stream(
        self,
        messages: list[dict],
        payload: dict,
        request_id: str,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0

        gemini_contents = _to_gemini_contents(messages)

        # Build generation config — use JSON MIME type when requested.
        gen_config: dict[str, Any] = {}
        if response_format and response_format.get("type") == "json_object":
            gen_config["response_mime_type"] = "application/json"

        try:
            async for chunk in await self._client.aio.models.generate_content_stream(
                model=self._model,
                contents=gemini_contents,
                config=genai_types.GenerateContentConfig(**gen_config) if gen_config else None,
            ):
                if chunk.usage_metadata:
                    total_tokens = chunk.usage_metadata.candidates_token_count or 0
                text = chunk.text
                if text:
                    yield {
                        "v": 1, "event": "token", "seq": seq,
                        "request_id": request_id, "text": text,
                    }
                    seq += 1

        except Exception as exc:
            logger.error("gemini_chat_error", error=str(exc), request_id=request_id)
            yield {
                "v": 1, "event": "error", "seq": seq,
                "request_id": request_id, "message": str(exc),
            }
            return

        done: dict = {
            "v": 1, "event": "done", "seq": seq,
            "request_id": request_id, "model": self._model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done


def _to_gemini_contents(messages: list[dict]) -> list[genai_types.Content]:
    contents = []
    for m in messages:
        role = m.get("role", "user")
        text = m.get("content", "")
        gemini_role = "model" if role == "assistant" else "user"
        contents.append(
            genai_types.Content(
                role=gemini_role,
                parts=[genai_types.Part(text=text)],
            )
        )
    return contents
