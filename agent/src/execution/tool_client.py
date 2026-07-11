"""
ToolClient: calls Go's POST /v1/internal/workspaces/:workspaceID/tool endpoint.

This is the ONLY way the agent interacts with the workspace.
The agent never calls Docker, the filesystem, or Git directly.
Every tool call goes through Go, which validates, executes, persists, and returns.
"""
from __future__ import annotations

import uuid

import httpx
import structlog

from src.config import settings
from src.execution.models import ToolCallRequest, ToolCallResult

logger = structlog.get_logger()


class ToolClient:
    """Sends tool calls to Go and returns structured results."""

    def __init__(self, workspace_id: str, exec_id: str, token: str, step_execution_id: str = "") -> None:
        self._workspace_id = workspace_id
        self._exec_id = exec_id
        self._token = token
        self._step_execution_id = step_execution_id
        self._base_url = settings.backend_url

    async def call(
        self,
        tool: str,
        args: dict,
        reasoning: str,
        step_id: str,
    ) -> ToolCallResult:
        """Execute one tool call via the Go backend.

        tool_call_id is generated here and acts as an idempotency key:
        if Go has already executed this call (e.g. after a retry), it returns
        the cached result without re-executing.
        """
        tool_call_id = str(uuid.uuid4())

        req = ToolCallRequest(
            version=1,
            tool=tool,
            args=args,
            reasoning=reasoning,
            step_id=step_id,
            step_execution_id=self._step_execution_id,
            tool_call_id=tool_call_id,
            exec_id=self._exec_id,
        )

        url = f"{self._base_url}/v1/internal/workspaces/{self._workspace_id}/tool"

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    url,
                    json=req.model_dump(),
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                )

            if resp.status_code == 200:
                data = resp.json()
                return ToolCallResult(
                    tool=tool,
                    success=data.get("success", False),
                    result=data.get("result"),
                    error=data.get("error"),
                    duration_ms=data.get("duration_ms", 0),
                    cached=data.get("cached", False),
                )
            else:
                return ToolCallResult(
                    tool=tool,
                    success=False,
                    error=f"Go returned status {resp.status_code}: {resp.text[:256]}",
                )

        except Exception as exc:
            logger.error("tool_client_error",
                         tool=tool, workspace_id=self._workspace_id, error=str(exc))
            return ToolCallResult(
                tool=tool, success=False, error=str(exc)
            )
