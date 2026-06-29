"""
QAPipeline: orchestrates the full Q&A flow for one question.

Steps:
  1. Embed the question using the configured embedding provider.
  2. Retrieve relevant chunks via RetrievalEngine.
  3. Assemble context within the token budget.
  4. Build a grounded prompt (system + context + history + question).
  5. Stream the LLM answer, yielding NDJSON lines.
  6. Emit a 'done' event with citations and usage metadata.

The pipeline exposes an async generator (arun) so FastAPI's StreamingResponse
can forward tokens to the client as they arrive, without any buffering.
The pipeline is stateless — session persistence is owned by Go.
"""
from __future__ import annotations

import json
import time
from typing import AsyncIterator

import structlog

from src.config import settings
from src.core.context_assembler import LinearContextAssembler
from src.core.models import AssembledContext, RetrievalScope
from src.core.retrieval_engine import RetrievalEngine
from src.ingestion.embedder import embed_batch
from src.llm.chat_factory import get_chat_provider
from src.qa.models import HistoryMessage, QARequest

logger = structlog.get_logger()

_SYSTEM_PROMPT = """\
You are an expert software engineer assistant. You answer questions about a \
codebase by reasoning carefully over the provided code excerpts.

Rules:
- Ground every claim in the provided code. Do not invent APIs, variables, or \
  behaviour that are not shown.
- If the excerpts are insufficient to answer confidently, say so and explain \
  what additional context would help.
- Be concise but complete. Use code snippets where helpful.
- Refer to files by their path (e.g. `src/auth/middleware.go`) and line \
  numbers when citing specific behaviour.
"""


def _build_context_block(context: AssembledContext) -> str:
    parts: list[str] = []
    for chunk in context.chunks:
        header = f"// File: {chunk.file_path} (lines {chunk.start_line}–{chunk.end_line})"
        lang = chunk.language or ""
        parts.append(f"{header}\n```{lang}\n{chunk.content}\n```")
    return "\n\n".join(parts)


def _build_messages(
    context_block: str,
    history: list[HistoryMessage],
    question: str,
) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": _SYSTEM_PROMPT}]

    if context_block:
        messages.append({
            "role": "user",
            "content": f"Here are the relevant code excerpts:\n\n{context_block}",
        })
        messages.append({
            "role": "assistant",
            "content": "I have reviewed the code excerpts. Please ask your question.",
        })

    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})

    messages.append({"role": "user", "content": question})
    return messages


class QAPipeline:
    """Stateless Q&A pipeline. One instance per process is fine."""

    def __init__(self) -> None:
        self._retrieval_engine = RetrievalEngine()
        self._assembler = LinearContextAssembler()

    async def arun(self, req: QARequest) -> AsyncIterator[bytes]:
        """Async generator — yields NDJSON lines as bytes, one per token.

        Using an async generator means FastAPI's StreamingResponse forwards
        each token to the HTTP client immediately as it is produced by the LLM,
        with no buffering at any layer.
        """
        t0 = time.monotonic()

        try:
            async for chunk in self._arun(req, t0):
                yield chunk
        except Exception as exc:
            logger.error(
                "qa_pipeline_error",
                session_id=req.session_id,
                request_id=req.request_id,
                error=str(exc),
            )
            error_event = {
                "v": 1,
                "event": "error",
                "seq": 0,
                "request_id": req.request_id,
                "message": f"Pipeline error: {exc}",
            }
            yield (json.dumps(error_event) + "\n").encode()

    async def _arun(self, req: QARequest, t0: float) -> AsyncIterator[bytes]:
        cfg = settings.retrieval

        # ── Step 1: embed question (sync — runs in threadpool implicitly) ─────
        vectors = embed_batch([req.question])
        if not vectors or not vectors[0]:
            raise ValueError("Failed to embed question — empty vector returned")
        query_vector = vectors[0]

        # ── Step 2: retrieve ──────────────────────────────────────────────────
        scope = RetrievalScope.single(
            org_id="",
            repo_id=req.repo_id,
            commit_sha=req.commit_sha,
        )

        logger.info(
            "qa_retrieve_scope",
            session_id=req.session_id,
            repo_id=req.repo_id,
            commit_sha=req.commit_sha,
            request_id=req.request_id,
        )

        retrieval_result = self._retrieval_engine.retrieve(
            query_vector=query_vector,
            question=req.question,
            scope=scope,
        )

        # ── Step 3: assemble context ──────────────────────────────────────────
        context = self._assembler.assemble(
            retrieval_result.chunks,
            budget=cfg.context_token_budget,
        )

        # ── Step 4: build prompt ──────────────────────────────────────────────
        context_block = _build_context_block(context)
        messages = _build_messages(context_block, req.history, req.question)

        # ── Step 5 + 6: stream LLM → yield NDJSON immediately ────────────────
        citations_payload = {
            "citations": [c.to_dict() for c in context.citations],
        }

        provider = get_chat_provider()

        # stream() is an async generator — each token is yielded as it arrives
        # from the LLM API. We immediately encode and yield it so FastAPI's
        # StreamingResponse flushes it to the HTTP client without any buffering.
        async for event in provider.stream(
            messages=messages,
            payload=citations_payload,
            request_id=req.request_id,
        ):
            yield (json.dumps(event) + "\n").encode()
            if event.get("event") in ("done", "error"):
                break

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "qa_pipeline_complete",
            session_id=req.session_id,
            request_id=req.request_id,
            retrieval_timing_ms=retrieval_result.timing_ms,
            total_timing_ms=elapsed_ms,
            candidate_count=retrieval_result.candidate_count,
            final_count=retrieval_result.final_count,
            context_tokens=context.total_tokens,
        )
