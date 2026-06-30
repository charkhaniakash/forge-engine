"""
FastAPI router for Phase 5 planning endpoint.

POST /v1/agent/plan
  Protected by Backend JWT (ADR 0001).
  Body: PlanningRequest
  Response: streaming NDJSON (application/x-ndjson)

Event protocol (same versioned shape as Q&A):
  {"v":1, "event":"thinking", "seq":N, "request_id":"...",
   "stage":"intent_analysis|impact_analysis|arch_analysis|plan_generation",
   "message":"..."}
  {"v":1, "event":"plan",    "seq":N, "request_id":"...", "plan":{...}}
  {"v":1, "event":"error",   "seq":N, "request_id":"...", "message":"..."}

Go's AgentPlanClient reads this stream:
  - "thinking" events are fanned to the WebSocket hub for real-time UI updates.
  - "plan" event triggers plan persistence + work_item status → plan_ready.
  - "error" event triggers work_item status → planning_failed.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from src.auth import extract_token_from_header, verify_token
from src.planning.models import PlanningRequest
from src.planning.pipeline import PlanningPipeline

import structlog

logger = structlog.get_logger()

router = APIRouter()

# One pipeline instance per process — stateless and safe to share.
_pipeline = PlanningPipeline()


def _verify_token(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization",
        )
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization format",
        )
    return verify_token(token)


@router.post("/v1/agent/plan")
async def plan(
    request: Request,
    body: PlanningRequest,
    token_payload: dict = Depends(_verify_token),
) -> StreamingResponse:
    """Run the planning pipeline and stream NDJSON events back to Go."""
    trace_id = request.headers.get("X-Trace-ID", body.work_item_id)

    logger.info(
        "plan_request_received",
        work_item_id=body.work_item_id,
        repo_id=body.repo_id,
        commit_sha=body.commit_sha[:8] if body.commit_sha else "",
        planner_hint=body.planner_hint,
        has_prior_plan=body.prior_plan_body is not None,
        request_id=body.request_id,
        trace_id=trace_id,
    )

    return StreamingResponse(
        _pipeline.arun(body),
        media_type="application/x-ndjson",
        headers={"X-Trace-ID": trace_id},
    )
