import os
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status

from src.auth import extract_token_from_header, verify_token
from src.ingestion.router import router as ingestion_router
from src.qa.router import router as qa_router

# Configure structlog — structured JSON, ISO timestamps, trace ID on every line.
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("agent.startup")
    yield
    logger.info("agent.shutdown")


app = FastAPI(
    title="Forge Engine Agent",
    version="0.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def trace_id_middleware(request: Request, call_next):
    trace_id = request.headers.get("X-Trace-ID", f"req-{os.getpid()}")
    request.state.trace_id = trace_id
    response = await call_next(request)
    response.headers["X-Trace-ID"] = trace_id
    return response


def verify_agent_token(authorization: str = Header(None)) -> dict:
    """FastAPI dependency — verifies the Backend-issued Bearer JWT."""
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header",
        )
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header format",
        )
    return verify_token(token)


# ── Utility endpoints (Phase 0) ───────────────────────────────────────────────

@app.get("/health")
async def health(request: Request):
    logger.info("health_check", trace_id=request.state.trace_id)
    return {"status": "ok"}


@app.get("/readiness")
async def readiness(request: Request):
    logger.info("readiness_check", trace_id=request.state.trace_id)
    return {"status": "ready"}


@app.get("/version")
async def version():
    return {"version": "0.1.0"}


# ── Phase 3 — ingestion ───────────────────────────────────────────────────────
# POST /v1/agent/ingest  (streaming NDJSON — see ingestion/router.py)
app.include_router(ingestion_router)

# ── Phase 4 — Q&A ────────────────────────────────────────────────────────────
# POST /v1/agent/qa  (streaming NDJSON — see qa/router.py)
app.include_router(qa_router)


# ── Phase 5 stub — planning (not yet implemented) ─────────────────────────────
@app.post("/v1/agent/plan")
async def create_plan(
    request: Request,
    payload: dict,
    token_payload: dict = Depends(verify_agent_token),
):
    """Stub — real planning logic is Phase 5."""
    return {
        "plan_id": "plan-stub-001",
        "status": "planning",
        "message": "Stub — Phase 5 not yet implemented",
        "trace_id": request.state.trace_id,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", 8000))
    uvicorn.run("src.main:app", host="0.0.0.0", port=port, reload=True)
