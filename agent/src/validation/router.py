"""
FastAPI router for Phase 8 validation parsing endpoint.

POST /v1/agent/parse-stage
  - Protected by Backend JWT (ADR 0001)
  - Body: ParseStageRequest (one stage at a time)
  - Response: ParseStageResponse (JSON, non-streaming)

Go calls this once per completed validation stage.
The agent parses raw stdout/stderr and returns structured diagnostics.
This is synchronous JSON (not streaming) — parsing is fast and Phase 9
needs the complete result before it can plan repairs.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from src.auth import extract_token_from_header, verify_token
from src.validation.models import ParseStageRequest, ParseStageResponse
from src.validation.parser import ValidationParser

import structlog

logger = structlog.get_logger()

router = APIRouter()
_parser = ValidationParser()


def _verify_token(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Missing authorization")
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid authorization format")
    return verify_token(token)


@router.post("/v1/agent/parse-stage", response_model=ParseStageResponse)
async def parse_stage(
    request: Request,
    body: ParseStageRequest,
    token_payload: dict = Depends(_verify_token),
) -> ParseStageResponse:
    """Parse one completed validation stage and return structured diagnostics."""
    trace_id = request.headers.get("X-Trace-ID", body.validation_run_id)

    logger.info(
        "parse_stage_received",
        validation_run_id=body.validation_run_id,
        stage=body.stage,
        stack=body.stack,
        exit_code=body.exit_code,
        trace_id=trace_id,
    )

    result = _parser.parse(body)

    logger.info(
        "parse_stage_complete",
        validation_run_id=body.validation_run_id,
        stage=body.stage,
        diagnostics=len(result.diagnostics),
        errors=result.error_count,
        warnings=result.warning_count,
        trace_id=trace_id,
    )

    return result
