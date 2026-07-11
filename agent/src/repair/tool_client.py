"""
Repair ToolClient — called ONLY by RepairPipeline, never by graph nodes.

Architectural boundary:
    Nodes set _pending_tool_call = {tool, args, reasoning}.
    The pipeline reads _pending_tool_call, calls this client, emits NDJSON events,
    then injects the result back into the graph as _last_tool_result.

    Nodes NEVER import or call this module directly.
    All workspace I/O is owned by the pipeline layer, not the reasoning layer.

Reuses the Phase 7 ToolCallRequest wire format so the same Go
/v1/internal/workspaces/:workspaceID/tool endpoint handles both execution
and repair tool calls without modification.

exec_id contract:
    Go's ToolDispatch inserts exec_id into execution_events.task_execution_id,
    which has a FK constraint referencing task_executions.id.
    For repair tool calls we pass task_execution_id (NOT repair_session_id)
    so the FK is satisfied.  repair_session_id is a different identity.
"""
from __future__ import annotations

import uuid
import httpx
import structlog

from src.config import settings

logger = structlog.get_logger()


class RepairToolClient:
    """Sends tool calls to Go during repair and returns structured results."""

    def __init__(self, workspace_id: str, task_execution_id: str, token: str) -> None:
        self._workspace_id = workspace_id
        self._task_execution_id = task_execution_id  # used as exec_id — satisfies FK
        self._token = token
        self._base_url = settings.backend_url

    async def call(
        self,
        tool: str,
        args: dict,
        reasoning: str = "",
    ) -> dict:
        """
        Execute one tool call via the Go backend.

        tool_call_id is generated here and acts as an idempotency key.
        exec_id is set to task_execution_id so Go can insert the event row
        into execution_events without violating the task_execution_id FK.
        """
        tool_call_id = str(uuid.uuid4())

        req = {
            "version": 1,
            "tool": tool,
            "args": args,
            "reasoning": reasoning,
            "step_id": "",             # not applicable for repair
            "step_execution_id": "",   # not applicable for repair
            "tool_call_id": tool_call_id,
            "exec_id": self._task_execution_id,  # FK-safe: references task_executions.id
        }

        url = f"{self._base_url}/v1/internal/workspaces/{self._workspace_id}/tool"

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    url,
                    json=req,
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                )

            if resp.status_code == 200:
                data = resp.json()
                return {
                    "tool": tool,
                    "success": data.get("success", False),
                    "result": data.get("result"),
                    "error": data.get("error"),
                    "duration_ms": data.get("duration_ms", 0),
                    "cached": data.get("cached", False),
                }
            else:
                return {
                    "tool": tool,
                    "success": False,
                    "result": None,
                    "error": f"Go returned status {resp.status_code}: {resp.text[:256]}",
                    "duration_ms": 0,
                    "cached": False,
                }

        except Exception as exc:
            logger.error("repair_tool_client_error",
                         tool=tool, workspace_id=self._workspace_id, error=str(exc))
            return {
                "tool": tool,
                "success": False,
                "result": None,
                "error": str(exc),
                "duration_ms": 0,
                "cached": False,
            }
