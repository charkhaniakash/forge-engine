"""
FastAPI router for Phase 4 Q&A endpoint.

POST /v1/agent/qa
  - Protected by Backend JWT (ADR 0001)
  - Body: QARequest
  - Response: streaming NDJSON (application/x-ndjson)

Streaming contract:
  Each NDJSON line is flushed to the HTTP client immediately as the LLM
  produces it — no buffering at any layer. The Go AgentQAClient reads
  line-by-line and fans each token event to the WebSocket immediately.

  {"v":1, "event":"token", "seq":N, "request_id":"...", "text":"..."}
  {"v":1, "event":"done",  "seq":N, "request_id":"...", "citations":[...],
   "model":"...", "token_count":N}
  {"v":1, "event":"error", "seq":N, "request_id":"...", "message":"..."}
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from src.auth import extract_token_from_header, verify_token
from src.qa.models import QARequest
from src.qa.pipeline import QAPipeline

import structlog

logger = structlog.get_logger()

router = APIRouter()

# One pipeline instance — stateless, safe to share across requests.
_pipeline = QAPipeline()


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


@router.post("/v1/agent/qa")
async def qa(
    request: Request,
    body: QARequest,
    token_payload: dict = Depends(_verify_token),
) -> StreamingResponse:
    """Stream a Q&A response for the given question.

    Uses an async generator so each token is forwarded to the client the
    moment the LLM produces it — no buffering at any layer.
    """
    trace_id = request.headers.get("X-Trace-ID", body.session_id)

    logger.info(
        "qa_request_received",
        session_id=body.session_id,
        repo_id=body.repo_id,
        commit_sha=body.commit_sha,
        request_id=body.request_id,
        history_turns=len(body.history) // 2,
        trace_id=trace_id,
    )

    # arun() is an async generator — StreamingResponse accepts it directly.
    # FastAPI/Starlette flushes each yielded chunk immediately without any
    # internal buffering, giving true token-by-token streaming.
    return StreamingResponse(
        _pipeline.arun(body),
        media_type="application/x-ndjson",
        headers={"X-Trace-ID": trace_id},
    )
