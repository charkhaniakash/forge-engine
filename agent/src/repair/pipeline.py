"""
Phase 9 — RepairPipeline

Runs the RepairGraph and streams NDJSON events back to Go.
This file is the ONLY place in Phase 9 where tool calls are executed.

Architectural contract:
    Nodes set _pending_tool_call = {tool, args, reasoning}.
    The pipeline's tool-broker loop:
        1. Detects _pending_tool_call in the LangGraph snapshot
        2. Emits tool_call NDJSON event to Go
        3. Calls RepairToolClient → Go executes workspace tool
        4. Receives result; emits tool_result NDJSON event
        5. Injects result into state as _last_tool_result
        6. Resumes the graph with updated state

    The graph is driven via LangGraph's interrupt_before mechanism on the two
    placeholder tool-execution nodes (call_tool_gather, call_tool_fix).
    When LangGraph reaches either node, the pipeline intercepts, executes the
    tool, injects the result, and resumes. The placeholder nodes themselves are
    no-ops — they never see or execute tool calls.

    Go sees:  reasoning | tool_call | tool_result | repair_complete | cannot_repair | error
    Go never sees LangGraph internals.

NDJSON event shapes:
    {"version":1,"event":"reasoning",      "request_id":"...","message":"..."}
    {"version":1,"event":"tool_call",      "request_id":"...","tool":"...","args":{...},"tool_call_id":"..."}
    {"version":1,"event":"tool_result",    "request_id":"...","tool":"...","tool_call_id":"...","success":true,"error":""}
    {"version":1,"event":"repair_complete","request_id":"...","strategy":"...","confidence":0.9,...}
    {"version":1,"event":"cannot_repair",  "request_id":"...","cannot_repair_reason":"..."}
    {"version":1,"event":"error",          "request_id":"...","error":"..."}
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import AsyncGenerator, Dict, Any

from .graph import build_repair_graph, REPAIR_GRAPH_VERSION
from .models import RepairRequest, RepairState
from .tool_client import RepairToolClient

logger = logging.getLogger(__name__)

# Nodes that are intercepted by the pipeline before execution.
# The pipeline executes the tool and injects the result before these nodes run.
_TOOL_INTERCEPTED_NODES = {"call_tool_gather", "call_tool_fix"}


class RepairPipeline:
    """
    Stateless pipeline — one instance per process.
    Each call to run() creates a fresh graph invocation with no cross-attempt state.
    """

    def __init__(self) -> None:
        # Graph compiled with interrupt_before on the two tool-execution placeholders
        # so the pipeline can intercept, execute the tool, and resume.
        self._graph = build_repair_graph(
            interrupt_before=list(_TOOL_INTERCEPTED_NODES)
        )

    async def run(
        self,
        request: RepairRequest,
        agent_token: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Execute the RepairGraph for ONE attempt and stream NDJSON events.

        Args:
            request:     RepairRequest from Go
            agent_token: JWT for calling Go's internal tool API

        Yields:
            NDJSON-compatible dicts (one per event)
        """
        ctx = request.repair_context
        t0 = time.monotonic()

        logger.info("repair_pipeline_start",
                    repair_session_id=ctx.repair_session_id,
                    attempt_number=ctx.attempt_number)

        state: RepairState = {
            "ctx": ctx,
            "diagnostics": request.diagnostics,
            "previous_attempt_summaries": request.previous_attempts,
            "retrieved_context": [],
            "root_cause": "",
            "reasoning": "",
            "strategy": "",
            "confidence": 0.5,
            "edit_plan": [],
            "modified_files": [],
            "repair_summary": "",
            "complete": False,
            "cannot_repair": False,
            "cannot_repair_reason": "",
            "_agent_token": agent_token,
            "_pending_tool_call": None,
            "_last_tool_result": None,
            "_file_cache": {},
            "_gather_iteration": 0,
            "_max_gather_iterations": 8,
            "_apply_index": 0,
        }

        tool_client = RepairToolClient(
            workspace_id=ctx.workspace_id,
            repair_session_id=ctx.repair_session_id,
            token=agent_token,
        )

        try:
            async for event in self._run_with_tool_broker(
                state, request.request_id, tool_client
            ):
                yield event
        except Exception as exc:
            logger.exception("repair_pipeline_error")
            yield _ev("error", request.request_id, error=str(exc))

        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("repair_pipeline_done",
                    repair_session_id=ctx.repair_session_id,
                    elapsed_ms=elapsed)

    async def _run_with_tool_broker(
        self,
        initial_state: RepairState,
        request_id: str,
        tool_client: RepairToolClient,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Core execution loop with tool broker.

        Uses LangGraph interrupt_before on call_tool_gather and call_tool_fix
        to pause the graph before those nodes, execute the tool externally,
        inject the result into state, and resume.

        The graph never touches the network. The pipeline is the sole HTTP caller.
        """
        current_state = dict(initial_state)
        config = {"recursion_limit": 50}
        MAX_TOOL_ROUNDS = 40  # total tool calls allowed per attempt

        for round_num in range(MAX_TOOL_ROUNDS + 1):
            # Run the graph forward; it will stop at the next interrupt_before
            # node or run to completion if no more tool calls are needed.
            interrupted_at = None
            final_this_run = False

            async for snapshot in self._graph.astream(current_state, config=config):
                for node_name, update in snapshot.items():
                    if not isinstance(update, dict):
                        continue

                    # Merge update into current state
                    current_state.update(update)

                    # Emit reasoning events
                    new_reasoning = update.get("reasoning")
                    if new_reasoning and isinstance(new_reasoning, str):
                        last_line = new_reasoning.strip().split("\n")[-1].strip()
                        if last_line:
                            yield _ev("reasoning", request_id, message=last_line)

                    # Terminal node reached
                    if current_state.get("complete") or current_state.get("cannot_repair"):
                        final_this_run = True

                # Check if graph paused at an intercepted node
                # LangGraph signals interrupt via __interrupt__ key in snapshot
                if "__interrupt__" in snapshot:
                    interrupted_at = snapshot["__interrupt__"]
                    break

            if final_this_run:
                break

            # Graph ran to END with no interrupt → done
            if interrupted_at is None:
                break

            # We're interrupted before a tool-execution node.
            # _pending_tool_call was set by the node that ran just before the interrupt.
            pending = current_state.get("_pending_tool_call")
            if not pending:
                logger.warning("interrupted_but_no_pending_tool_call",
                               interrupted_at=str(interrupted_at))
                break

            # Execute the tool (pipeline owns all I/O)
            tool_call_id = str(uuid.uuid4())

            yield _ev("tool_call", request_id,
                      tool=pending["tool"],
                      args=pending["args"],
                      tool_call_id=tool_call_id)

            tool_result = await tool_client.call(
                tool=pending["tool"],
                args=pending["args"],
                reasoning=pending.get("reasoning", ""),
            )

            yield _ev("tool_result", request_id,
                      tool=tool_result["tool"],
                      tool_call_id=tool_call_id,
                      success=tool_result["success"],
                      error=tool_result.get("error") or "")

            # Inject result and clear pending call — graph will continue from here
            current_state["_pending_tool_call"] = None
            current_state["_last_tool_result"] = tool_result

        # Emit final event
        if current_state.get("cannot_repair"):
            yield _ev("cannot_repair", request_id,
                      cannot_repair_reason=current_state.get("cannot_repair_reason", "Unknown"))
        elif current_state.get("complete"):
            yield _ev("repair_complete", request_id,
                      agent_version=REPAIR_GRAPH_VERSION,
                      strategy=current_state.get("strategy", "unknown"),
                      confidence=current_state.get("confidence", 0.0),
                      modified_files=current_state.get("modified_files") or [],
                      summary=current_state.get("repair_summary", ""))
        else:
            yield _ev("error", request_id,
                      error="Repair loop exhausted without completing")


# ── Module-level helper ───────────────────────────────────────────────────────

def _ev(event_type: str, request_id: str, **kwargs) -> dict:
    """Build a versioned NDJSON event dict."""
    return {"version": 1, "event": event_type, "request_id": request_id, **kwargs}