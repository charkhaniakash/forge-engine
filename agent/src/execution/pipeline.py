"""
ExecutionPipeline: runs the LangGraph for one step and yields NDJSON bytes.

Go calls POST /v1/agent/execute-step once per step.
This pipeline:
  1. Initialises the LangGraph state from the request.
  2. Runs the graph asynchronously, streaming NDJSON events as nodes execute.
  3. Emits step_complete or error as the final event.

Event protocol (same versioned shape as Phase 4 Q&A and Phase 5 planning):
  {"version":1, "event":"reasoning",   "seq":N, "step_id":"...", "message":"..."}
  {"version":1, "event":"tool_call",   "seq":N, "step_id":"...", "tool":"...", "args":{...}, "tool_call_id":"..."}
  {"version":1, "event":"tool_result", "seq":N, "step_id":"...", "tool":"...", "result":{...}, "success":true}
  {"version":1, "event":"deviation",   "seq":N, "step_id":"...", "message":"..."}
  {"version":1, "event":"step_complete","seq":N, "step_id":"...", "summary":"..."}
  {"version":1, "event":"error",       "seq":N, "message":"..."}
"""
from __future__ import annotations

import json
import time
import uuid
from typing import AsyncIterator

import structlog

from src.execution.graph import execution_graph
from src.execution.models import ExecuteStepRequest, ExecutionState

logger = structlog.get_logger()


class ExecutionPipeline:
    """Stateless pipeline — one instance per process."""

    async def arun(
        self,
        req: ExecuteStepRequest,
        agent_token: str,
    ) -> AsyncIterator[bytes]:
        """Async generator: yields NDJSON lines for each execution event."""
        t0 = time.monotonic()
        seq = 0

        def _event(event_type: str, **kwargs) -> bytes:
            nonlocal seq
            payload = {
                "version": 1,
                "event": event_type,
                "seq": seq,
                "request_id": req.request_id,
                "step_id": req.execution_context.step_id,
                **kwargs,
            }
            seq += 1
            return (json.dumps(payload) + "\n").encode()

        try:
            # Initialise LangGraph state — the graph only knows about THIS step.
            initial_state: ExecutionState = {
                "ctx": req.execution_context,
                "current_step": req.step,
                "retrieved_context": [],
                "tool_history": [],
                "reasoning": "",
                "latest_tool_result": None,
                "deviation": None,
                "complete": False,
                "_pending_action": None,
                "_agent_token": agent_token,  # read by _get_tool_client in nodes
                # Convergence and JSON-retry tracking
                "_iteration": 0,
                "_max_iterations": 12,
                "_json_retry_count": 0,
                "_max_json_retries": 2,
                # Repository state tracking
                "_file_hashes": {},
                "_file_cache": {},
                "_no_progress_write_cycles": 0,
                "_convergence_triggered": False,
            }

            # Run the graph with astream — yields state snapshots per node.
            # Collect the final state from the last snapshot to avoid running twice.
            final_state: dict = {}
            async for snapshot in execution_graph.astream(
                initial_state,
                config={"recursion_limit": 30},
            ):
                final_state = snapshot
                for node_name, update in snapshot.items():
                    for ev in _emit_node_events(node_name, update, req, seq, _event):
                        yield ev

            if final_state.get("deviation"):
                # Emit the typed terminal event from the final state.
                # already_satisfied is NOT a deviation — skip it here.
                dev_type = final_state.get("deviation_type") or "plan_deviation"
                if dev_type != "already_satisfied":
                    yield _event(dev_type, message=final_state["deviation"])

            summary = _extract_summary(final_state)
            yield _event("step_complete", summary=summary)
        except Exception as exc:
            logger.error(
                "execution_pipeline_error",
                step_id=req.execution_context.step_id,
                error=str(exc),
            )
            yield _event("error", message=f"Execution pipeline error: {exc}")

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "step_execution_complete",
            step_id=req.execution_context.step_id,
            elapsed_ms=elapsed_ms,
        )


def _emit_node_events(
    node_name: str,
    update: dict,
    req: ExecuteStepRequest,
    seq: int,
    event_fn,
) -> list[bytes]:
    """Convert a LangGraph node update into NDJSON events.

    All field accesses use safe guards — LangGraph snapshots may contain
    partial updates where expected fields are absent or None.
    """
    events: list[bytes] = []
    logger.info("_emit_node_events", node_name=node_name, update_type=type(update), update_keys=list(update.keys()) if isinstance(update, dict) else "N/A")

    # Guard against None updates from LangGraph
    if update is None:
        logger.warning("_emit_node_events_none_update", node_name=node_name)
        return []

    if node_name == "reason":
        new_reasoning = update.get("reasoning") or ""
        if new_reasoning:
            last_line = new_reasoning.strip().split("\n")[-1].strip()
            if last_line:
                events.append(event_fn("reasoning", message=last_line))

    elif node_name == "call_tool":
        history = update.get("tool_history") or []
        if history and isinstance(history, list) and len(history) > 0:
            last = history[-1]
            if last and isinstance(last, dict):
                tool_req = last.get("request") or {}
                if tool_req and isinstance(tool_req, dict):
                    tool_call_id = str(uuid.uuid4())  # real UUID for this event
                    events.append(event_fn(
                        "tool_call",
                        tool=tool_req.get("tool", ""),
                        args=tool_req.get("args", {}),
                        tool_call_id=tool_call_id,
                    ))

    elif node_name == "receive_result":
        result = update.get("latest_tool_result")
        # Guard against None or non-ToolCallResult values from partial updates.
        if result is not None and hasattr(result, "tool"):
            events.append(event_fn(
                "tool_result",
                tool=result.tool,
                result=result.result or {},
                success=bool(result.success),
                error=result.error or "",
            ))

    elif node_name == "check_deviation":
        # Legacy catch-all → emit as plan_deviation (safest default).
        msg = update.get("deviation") or ""
        if msg:
            events.append(event_fn("plan_deviation", message=msg))

    elif node_name in ("plan_deviation", "requires_human", "execution_error"):
        # Typed terminal nodes — emit the specific event so Go and the
        # frontend receive the correct semantic category.
        msg = update.get("deviation") or ""
        if msg:
            events.append(event_fn(node_name, message=msg))

    return events


def _extract_summary(final_state: dict) -> str:
    reasoning = final_state.get("reasoning", "")
    if reasoning:
        lines = [l.strip() for l in reasoning.strip().split("\n") if l.strip()]
        return lines[-1] if lines else "Step completed"
    return "Step completed"
