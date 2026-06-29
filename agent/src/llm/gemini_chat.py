"""
Gemini streaming chat provider for Phase 4 Q&A.
"""
from __future__ import annotations

from typing import AsyncIterator

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
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0

        # Convert OpenAI-style messages to Gemini content format.
        gemini_contents = _to_gemini_contents(messages)

        try:
            response = await self._client.aio.models.generate_content_stream(
                model=self._model,
                contents=gemini_contents,
            )
            async for chunk in response:
                if chunk.usage_metadata:
                    total_tokens = chunk.usage_metadata.candidates_token_count or 0

                text = chunk.text
                if text:
                    yield {
                        "v": 1,
                        "event": "token",
                        "seq": seq,
                        "request_id": request_id,
                        "text": text,
                    }
                    seq += 1

        except Exception as exc:
            logger.error("gemini_chat_error", error=str(exc), request_id=request_id)
            yield {
                "v": 1,
                "event": "error",
                "seq": seq,
                "request_id": request_id,
                "message": str(exc),
            }
            return

        done: dict = {
            "v": 1,
            "event": "done",
            "seq": seq,
            "request_id": request_id,
            "model": self._model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done


def _to_gemini_contents(messages: list[dict]) -> list[genai_types.Content]:
    """Convert OpenAI-style messages to Gemini Content objects.

    System messages are prepended as a user turn (Gemini doesn't have a
    dedicated system role in the contents list).
    """
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
