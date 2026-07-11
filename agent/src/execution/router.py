"""
FastAPI router for Phase 7 execution endpoint.

POST /v1/agent/execute-step
  - Protected by Backend JWT (ADR 0001)
  - Body: ExecuteStepRequest (one plan step + execution context)
  - Response: streaming NDJSON

Go calls this once per plan step and reads each event:
  reasoning    → persisted to execution_events, fanned to WebSocket
  tool_call    → Go dispatches tool, returns result to agent via /tool endpoint
  tool_result  → persisted
  deviation    → persisted, surfaced to user
  step_complete → Go marks step done, writes checkpoint, advances to next step
  error        → Go marks step failed
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from src.auth import extract_token_from_header, verify_token
from src.execution.models import ExecuteStepRequest
from src.execution.pipeline import ExecutionPipeline

import structlog

logger = structlog.get_logger()

router = APIRouter()
_pipeline = ExecutionPipeline()


def _verify_token(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Missing authorization")
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid authorization format")
    return verify_token(token)


@router.post("/v1/agent/execute-step")
async def execute_step(
    request: Request,
    body: ExecuteStepRequest,
    token_payload: dict = Depends(_verify_token),
) -> StreamingResponse:
    """Execute one plan step and stream NDJSON events back to Go."""
    trace_id = request.headers.get("X-Trace-ID", body.execution_context.task_execution_id)
    # Extract the raw JWT for the ToolClient to use when calling back to Go.
    auth_header = request.headers.get("Authorization", "")
    agent_token = auth_header.removeprefix("Bearer ").strip()

    logger.info(
        "execute_step_received",
        task_execution_id=body.execution_context.task_execution_id,
        step_id=body.execution_context.step_id,
        step_title=body.step.get("title", ""),
        request_id=body.request_id,
        trace_id=trace_id,
    )

    return StreamingResponse(
        _pipeline.arun(body, agent_token),
        media_type="application/x-ndjson",
        headers={"X-Trace-ID": trace_id},
    )
