"""
Phase 9 — Repair router

FastAPI router for POST /v1/agent/repair endpoint.
"""

import json
import logging
from fastapi import APIRouter, Request, Header
from fastapi.responses import StreamingResponse
from typing import Optional

from .models import RepairRequest, RepairContext
from .pipeline import RepairPipeline

logger = logging.getLogger(__name__)

router = APIRouter()
pipeline = RepairPipeline()


@router.post("/v1/agent/repair")
async def repair_endpoint(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    """
    POST /v1/agent/repair
    
    Executes one repair attempt (brand-new RepairGraph invocation).
    Streams NDJSON events back to Go.
    
    Request body:
        {
            "version": 1,
            "repair_context": {...},
            "diagnostics": [...],
            "previous_attempts": [...],
            "request_id": "repair-..."
        }
    
    Response:
        Streaming NDJSON with events:
            - reasoning
            - tool_call
            - tool_result
            - repair_complete
            - cannot_repair
            - error
    """
    try:
        # Parse request body
        body = await request.json()
        
        # Extract agent token from Authorization header
        agent_token = ""
        if authorization and authorization.startswith("Bearer "):
            agent_token = authorization[7:]
        
        # Build RepairRequest
        ctx_data = body["repair_context"]
        repair_ctx = RepairContext(
            repair_session_id=ctx_data["repair_session_id"],
            task_execution_id=ctx_data["task_execution_id"],
            workspace_id=ctx_data["workspace_id"],
            attempt_number=ctx_data["attempt_number"],
            trace_id=ctx_data["trace_id"],
            model=ctx_data.get("model", "gemini-2.0-flash-exp"),
            temperature=ctx_data.get("temperature", 0.1),
            max_tokens=ctx_data.get("max_tokens", 4096),
        )
        
        repair_req = RepairRequest(
            version=body.get("version", 1),
            repair_context=repair_ctx,
            diagnostics=body.get("diagnostics", []),
            previous_attempts=body.get("previous_attempts", []),
            request_id=body.get("request_id", ""),
        )
        
        logger.info(
            "repair_request_received",
            extra={
                "repair_session_id": repair_ctx.repair_session_id,
                "attempt_number": repair_ctx.attempt_number,
                "diagnostic_count": len(repair_req.diagnostics),
            }
        )
        
        # Stream NDJSON response
        async def generate():
            async for event in pipeline.run(repair_req, agent_token):
                yield json.dumps(event) + "\n"
        
        return StreamingResponse(
            generate(),
            media_type="application/x-ndjson",
        )
        
    except Exception as e:
        logger.exception("repair_endpoint_error")
        # Return error as NDJSON
        error_event = {
            "version": 1,
            "event": "error",
            "error": str(e),
        }
        return StreamingResponse(
            iter([json.dumps(error_event) + "\n"]),
            media_type="application/x-ndjson",
            status_code=500,
        )
