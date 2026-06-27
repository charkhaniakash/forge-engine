"""
FastAPI router for the Phase 3 ingestion endpoint.

POST /v1/agent/ingest
  - Protected by Backend JWT (ADR 0001)
  - Body: {job_id, repo_id, commit_sha, clone_path}
  - Response: streaming NDJSON (application/x-ndjson)
    Each line: {"event": "progress"|"done"|"error", ...}

The Go worker holds this connection open for the duration of the job
and reads events line-by-line to update ingestion_jobs in the DB.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.auth import verify_token, extract_token_from_header
from fastapi import Header, HTTPException, status
from src.ingestion.job import run_ingestion

import structlog

logger = structlog.get_logger()

router = APIRouter()


class IngestRequest(BaseModel):
    job_id: str
    repo_id: str
    commit_sha: str
    clone_path: str


def _verify_token(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization")
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization format")
    return verify_token(token)


@router.post("/v1/agent/ingest")
async def ingest(
    request: Request,
    body: IngestRequest,
    token_payload: dict = Depends(_verify_token),
) -> StreamingResponse:
    """
    Start an ingestion job and stream NDJSON progress back to the caller.

    The response is a long-lived chunked HTTP response. The Go worker
    reads it line by line until it sees {"event": "done"} or
    {"event": "error"}, then closes the connection.
    """
    trace_id = request.headers.get("X-Trace-ID", body.job_id)

    logger.info(
        "ingest_request_received",
        job_id=body.job_id,
        repo_id=body.repo_id,
        commit_sha=body.commit_sha,
        clone_path=body.clone_path,
        trace_id=trace_id,
    )

    def event_stream():
        yield from run_ingestion(
            job_id=body.job_id,
            repo_id=body.repo_id,
            commit_sha=body.commit_sha,
            clone_path=body.clone_path,
        )

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"X-Trace-ID": trace_id},
    )
