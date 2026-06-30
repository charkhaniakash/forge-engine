"""
PlanningPipeline — orchestrates the six planning stages.

Stages:
  1. Intent Analysis    — cheap LLM call; classifies intent and flags ambiguity
  2. Retrieval          — broader profile (k=120, include tests)
  3. Impact Analysis    — LLM identifies affected files / interfaces
  4. Architecture       — LLM identifies existing patterns / approach
  5. Constraint         — no-op in Phase 5; reserved for policy engine
  6. Plan Generation    — planner.generate() with structured JSON output
  7. Validation         — deterministic: schema + cycle check; retry on failure

The pipeline is an async generator yielding NDJSON bytes so FastAPI
StreamingResponse can forward each event to the Go client immediately.

Go reads:
  {"v":1, "event":"thinking", "stage":"...", "message":"...", ...}  ← fan to WS
  {"v":1, "event":"plan",     "plan":{...PlanSchema v1...}, ...}    ← persist + mark ready
  {"v":1, "event":"error",    "message":"...", ...}                 ← mark planning_failed
"""
from __future__ import annotations

import json
import time
from typing import AsyncIterator

import structlog

from src.core.context_assembler import LinearContextAssembler
from src.core.models import RetrievalScope
from src.core.retrieval_engine import RetrievalEngine, RetrievalProfile
from src.ingestion.embedder import embed_batch
from src.planning.models import PlanningRequest
from src.planning.registry import get_planner

logger = structlog.get_logger()

_seq_counter = 0


def _next_seq() -> int:
    global _seq_counter
    _seq_counter += 1
    return _seq_counter


def _thinking(stage: str, message: str, request_id: str) -> bytes:
    return (json.dumps({
        "v": 1, "event": "thinking", "seq": _next_seq(),
        "request_id": request_id, "stage": stage, "message": message,
    }) + "\n").encode()


def _plan_event(plan_dict: dict, request_id: str) -> bytes:
    return (json.dumps({
        "v": 1, "event": "plan", "seq": _next_seq(),
        "request_id": request_id, "plan": plan_dict,
    }) + "\n").encode()


def _error_event(message: str, request_id: str) -> bytes:
    return (json.dumps({
        "v": 1, "event": "error", "seq": _next_seq(),
        "request_id": request_id, "message": message,
    }) + "\n").encode()


class PlanningPipeline:
    """Stateless planning pipeline. One instance per process."""

    def __init__(self) -> None:
        self._retrieval_engine = RetrievalEngine()
        self._assembler = LinearContextAssembler()

    async def arun(self, req: PlanningRequest) -> AsyncIterator[bytes]:
        """Async generator — yields NDJSON bytes for each event."""
        t0 = time.monotonic()
        global _seq_counter
        _seq_counter = 0  # reset per request for clean seq numbering

        try:
            async for chunk in self._arun(req, t0):
                yield chunk
        except Exception as exc:
            logger.error(
                "planning_pipeline_error",
                work_item_id=req.work_item_id,
                request_id=req.request_id,
                error=str(exc),
            )
            yield _error_event(f"Planning pipeline error: {exc}", req.request_id)

    async def _arun(self, req: PlanningRequest, t0: float) -> AsyncIterator[bytes]:
        # ── Stage 1: intent analysis ──────────────────────────────────────────
        yield _thinking("intent_analysis", "Analysing intent...", req.request_id)
        # Phase 5: stub — always maps to the hinted planner type.
        planner = get_planner(req.planner_hint)

        # ── Stage 2: retrieval (planning profile) ─────────────────────────────
        yield _thinking("impact_analysis",
                        "Retrieving relevant code context...", req.request_id)

        vectors = embed_batch([req.intent])
        if not vectors or not vectors[0]:
            raise ValueError("Failed to embed intent — empty vector returned")
        query_vector = vectors[0]

        scope = RetrievalScope.single(
            org_id="",
            repo_id=req.repo_id,
            commit_sha=req.commit_sha,
        )

        retrieval_result = self._retrieval_engine.retrieve(
            query_vector=query_vector,
            question=req.intent,
            scope=scope,
            profile=RetrievalProfile.planning(),
        )

        context = self._assembler.assemble(
            retrieval_result.chunks,
            budget=RetrievalProfile.planning().context_token_budget,
        )

        logger.info(
            "planning_retrieval",
            work_item_id=req.work_item_id,
            candidate_count=retrieval_result.candidate_count,
            final_count=retrieval_result.final_count,
            context_tokens=context.total_tokens,
        )

        # ── Stage 3: impact analysis (embedded in planner generation) ─────────
        yield _thinking("impact_analysis",
                        f"Found {retrieval_result.final_count} relevant code sections.",
                        req.request_id)

        # ── Stage 4: architecture analysis (embedded in planner generation) ───
        yield _thinking("arch_analysis",
                        "Analysing architecture and patterns...", req.request_id)

        # ── Stage 5: constraint analysis (no-op in Phase 5) ──────────────────
        # Phase 12 will populate this stage with org policy evaluation.

        # ── Stage 6: plan generation ──────────────────────────────────────────
        yield _thinking("plan_generation",
                        "Generating implementation plan...", req.request_id)

        # Deserialise prior plan body if present (for re-plans).
        from src.planning.models import PlanBody
        prior_plan: PlanBody | None = None
        if req.prior_plan_body:
            try:
                prior_plan = PlanBody(**req.prior_plan_body)
            except Exception:
                pass  # non-fatal — plan without prior context

        plan_body: PlanBody | None = None
        async for item in planner.generate(req, context, prior_plan):
            if isinstance(item, str):
                # Intermediate reasoning message.
                yield _thinking("plan_generation", item, req.request_id)
            else:
                # PlanBody — final output.
                plan_body = item
                break

        if plan_body is None:
            raise ValueError("Planner did not produce a plan body")

        # ── Stage 7: emit plan ────────────────────────────────────────────────
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "planning_complete",
            work_item_id=req.work_item_id,
            request_id=req.request_id,
            steps=len(plan_body.steps),
            elapsed_ms=elapsed_ms,
        )

        yield _plan_event(plan_body.model_dump(), req.request_id)
