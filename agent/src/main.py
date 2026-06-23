import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import structlog

from src.config import settings
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


@app.get("/health")
async def health(request: Request):
    logger.info("health_check", trace_id=request.state.trace_id)
    return {"status": "ok"}


@app.get("/readiness")
async def readiness(request: Request):
    # TODO: check Backend connectivity, etc.
    logger.info("readiness_check", trace_id=request.state.trace_id)
    return {"status": "ready"}


@app.get("/version")
async def version(request: Request):
    return {"version": "0.1.0"}


@app.post("/v1/agent/plan")
async def create_plan(request: Request):
    """
    Stub endpoint for task planning.
    In Phase 5, this becomes real.
    """
    logger.info("plan_request_received", trace_id=request.state.trace_id)
    return {
        "plan_id": "plan-stub-001",
        "status": "planning",
        "message": "Stub response — Phase 0",
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