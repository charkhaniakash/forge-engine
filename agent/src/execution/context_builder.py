"""
ContextBuilder: gathers repository context before a step executes.

Reads each file listed in step.affected_files and optionally searches
for related symbols. All reads go through ToolClient → Go → workspace.
The agent never reads the filesystem directly.
"""
from __future__ import annotations

import structlog

from src.execution.models import ExecutionState
from src.execution.tool_client import ToolClient

logger = structlog.get_logger()


async def gather_context(
    state: ExecutionState,
    tool_client: ToolClient,
) -> list[dict]:
    """Read every file in step.affected_files via tool calls.

    Returns a list of context entries, each containing the file path
    and its current content. Missing files are noted but don't abort
    the step — the agent may need to create them.
    """
    step = state["current_step"]
    affected_files: list[str] = step.get("affected_files", [])

    if not affected_files:
        return []

    ctx = state["ctx"]
    results: list[dict] = []

    for path in affected_files:
        # Check existence first so the agent knows whether to create vs modify.
        exists_result = await tool_client.call(
            tool="exists",
            args={"path": path},
            reasoning=f"Checking if file exists before reading: {path}",
            step_id=ctx.step_id,
        )

        # Distinguish auth/transport failures from genuine missing files.
        # A failed tool call (success=False) is NOT the same as file-not-found.
        if not exists_result.success:
            logger.error(
                "context_exists_tool_failed",
                path=path,
                step_id=ctx.step_id,
                error=exists_result.error,
            )
            # Treat as unknown — don't assume missing; the step may still work.
            results.append({
                "path": path,
                "content": "",
                "exists": None,   # None = unknown due to tool failure
                "error": f"exists check failed: {exists_result.error}",
            })
            continue

        file_exists = (
            exists_result.result is not None and
            isinstance(exists_result.result, dict) and
            exists_result.result.get("exists", False)
        )

        if not file_exists:
            # The planned path doesn't exist. This is frequently a wrong
            # extension from the planner (e.g. App.tsx vs the real App.jsx), so
            # list the parent directory and hand the model the real siblings —
            # otherwise it has no way to discover the correct file and either
            # writes a stub at the wrong path or fails the step doing nothing.
            parent = path.rsplit("/", 1)[0] if "/" in path else "."
            siblings: list[str] = []
            dir_result = await tool_client.call(
                tool="list_dir",
                args={"path": parent},
                reasoning=f"Planned file {path} is missing — listing {parent} to find the real file",
                step_id=ctx.step_id,
            )
            if (
                dir_result.success
                and isinstance(dir_result.result, dict)
                and isinstance(dir_result.result.get("entries"), list)
            ):
                for e in dir_result.result["entries"]:
                    if isinstance(e, dict) and e.get("name"):
                        name = e["name"]
                        siblings.append(f"{name}/" if e.get("type") == "directory" else name)
            results.append({
                "path": path,
                "content": "",
                "exists": False,
                "error": None,   # genuinely missing — agent should create it
                "dir": parent,
                "siblings": siblings,
            })
            logger.info(
                "context_file_not_found",
                path=path,
                step_id=ctx.step_id,
                dir=parent,
                sibling_count=len(siblings),
            )
            continue

        result = await tool_client.call(
            tool="read_file",
            args={"path": path},
            reasoning=f"Gathering context before executing step: {step.get('title', '')}",
            step_id=ctx.step_id,
        )
        if result.success and result.result and isinstance(result.result, dict):
            results.append({
                "path": path,
                "content": result.result.get("content", ""),
                "bytes": result.result.get("bytes", 0),
                "exists": True,
            })
        else:
            logger.error(
                "context_read_failed",
                path=path,
                step_id=ctx.step_id,
                error=result.error,
            )
            results.append({
                "path": path,
                "content": "",
                "exists": True,   # exists but read failed (permissions, etc.)
                "error": f"read failed: {result.error}",
            })

    logger.info(
        "context_gathered",
        step_id=ctx.step_id,
        files_read=len([r for r in results if r["exists"]]),
        files_missing=len([r for r in results if not r["exists"]]),
    )
    return results
