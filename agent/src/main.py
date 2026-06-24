import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Header, HTTPException, status, Depends
from fastapi.responses import JSONResponse
import structlog

from src.config import settings
from src.auth import verify_token, extract_token_from_header
from src.llm.provider import LLMProvider

# Configure structlog
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
    # Startup
    logger.info("agent.startup")
    yield
    # Shutdown
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
    """Dependency to verify Bearer token on internal endpoints."""
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


@app.get("/health")
async def health(request: Request):
    logger.info("health_check", trace_id=request.state.trace_id)
    return {"status": "ok"}


@app.get("/readiness")
async def readiness(request: Request):
    logger.info("readiness_check", trace_id=request.state.trace_id)
    return {"status": "ready"}


@app.get("/version")
async def version(request: Request):
    return {"version": "0.1.0"}


@app.post("/v1/agent/plan")
async def create_plan(
    request: Request,
    payload: dict,
    token_payload: dict = Depends(verify_agent_token),
):
    """
    Create a task plan. Requires valid Backend JWT and org context.
    Stub endpoint for Phase 1.
    
    Agent trusts org_id/user_id from Backend, never from client.
    """
    trace_id = request.state.trace_id
    
    # TODO: Phase 5 — real planning logic
    # For now, agent just acknowledges the request with context
    
    logger.info(
        "plan_request_received",
        trace_id=trace_id,
        authenticated_as=token_payload.get("sub"),
    )
    
    return {
        "plan_id": "plan-stub-001",
        "status": "planning",
        "message": "Stub response — Phase 1",
        "trace_id": trace_id,
    }

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", 8000))
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )