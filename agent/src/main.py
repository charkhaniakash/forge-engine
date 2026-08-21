import os
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status

from src.auth import extract_token_from_header, verify_token
from src.ingestion.router import router as ingestion_router
from src.qa.router import router as qa_router
from src.planning.router import router as planning_router
from src.execution.router import router as execution_router
from src.validation.router import router as validation_router
from src.repair.router import router as repair_router
from src.summarization.router import router as summarization_router
from src.llm.runtime import LLMRuntime, reset_runtime, set_runtime
from src.llm.router import router as llm_router

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
async def llm_runtime_middleware(request: Request, call_next):
    """Bind per-request BYOK credentials from backend-forwarded headers."""
    provider = (request.headers.get("X-Forge-LLM-Provider") or "").strip()
    model = (request.headers.get("X-Forge-LLM-Model") or "").strip()
    api_key = (request.headers.get("X-Forge-LLM-Key") or "").strip()
    token = None
    if provider:
        token = set_runtime(LLMRuntime(provider=provider, model=model, api_key=api_key))
    try:
        return await call_next(request)
    finally:
        if token is not None:
            reset_runtime(token)


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

# ── Phase 5 — Planning ────────────────────────────────────────────────────────
# POST /v1/agent/plan  (streaming NDJSON — see planning/router.py)
app.include_router(planning_router)

# ── Phase 7 — Code Modification Execution ────────────────────────────────────
# POST /v1/agent/execute-step  (streaming NDJSON — see execution/router.py)
app.include_router(execution_router)

# ── Phase 8 — Validation Parsing ─────────────────────────────────────────────
# POST /v1/agent/parse-stage  (JSON — see validation/router.py)
app.include_router(validation_router)

# ── Phase 9 — Autonomous Self-Repair ─────────────────────────────────────────
# POST /v1/agent/repair  (streaming NDJSON — see repair/router.py)
app.include_router(repair_router)

# ── Phase 10 — Summarization (Commit Messages & PR Descriptions) ─────────────
# POST /v1/agent/summarize  (JSON — see summarization/router.py)
app.include_router(summarization_router)

# BYOK — validate a user-supplied provider + API key
# POST /v1/agent/llm/validate
app.include_router(llm_router)



if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", 8000))
    uvicorn.run("src.main:app", host="0.0.0.0", port=port, reload=True)
