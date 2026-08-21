"""
Phase 9 — RepairPipeline

Runs the RepairGraph and streams NDJSON events back to Go.
This file is the ONLY place in Phase 9 where tool calls are executed.

Tool broker design (interrupt_before + MemorySaver):
    The graph is compiled with interrupt_before=["call_tool_gather","call_tool_fix"]
    and a MemorySaver checkpointer. When LangGraph hits an intercepted node it
    pauses and returns control here. The pipeline executes the tool via
    RepairToolClient, injects _last_tool_result into the state, then calls
    astream() again with the SAME thread_id — LangGraph resumes from the
    checkpoint rather than restarting from the entry point.

    Without a checkpointer, every astream() call would restart from gather_context,
    causing the apply loop to repeat indefinitely.

Go sees:  reasoning | tool_call | tool_result | repair_complete | cannot_repair | error
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import AsyncGenerator, Dict, Any

from langgraph.checkpoint.memory import MemorySaver

from .graph import build_repair_graph, REPAIR_GRAPH_VERSION
from .models import RepairRequest, RepairState
from .tool_client import RepairToolClient

logger = logging.getLogger(__name__)

_TOOL_INTERCEPTED_NODES = {"call_tool_gather", "call_tool_fix"}


class RepairPipeline:
    """
    Stateless pipeline — one instance per process.
    Each call to run() creates a fresh attempt-scoped thread with its own
    MemorySaver checkpointer so LangGraph can resume after each tool interrupt.
    """

    def __init__(self) -> None:
        # NOTE: the graph is compiled WITHOUT interrupt_before here.
        # We pass interrupt_before per-invocation via the config, together with
        # a fresh MemorySaver, so each attempt gets isolated checkpoint state.
        self._graph = build_repair_graph(
            interrupt_before=list(_TOOL_INTERCEPTED_NODES)
        )

    async def run(
        self,
        request: RepairRequest,
        agent_token: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        ctx = request.repair_context
        t0 = time.monotonic()

        logger.info("repair_pipeline_start",
                    repair_session_id=ctx.repair_session_id,
                    attempt_number=ctx.attempt_number)

        initial_state: RepairState = {
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
            task_execution_id=ctx.task_execution_id,
            token=agent_token,
        )

        try:
            async for event in self._run_with_tool_broker(
                initial_state, request.request_id, tool_client
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
        Core execution loop.

        Uses a fresh MemorySaver checkpointer per attempt. Each time the graph
        hits an interrupt_before node, LangGraph saves a checkpoint.  The
        pipeline executes the tool, injects the result via graph.update_state(),
        then calls astream() again with the same thread_id. LangGraph resumes
        from the saved checkpoint — it does NOT restart from gather_context.
        """
        # Fresh checkpointer per attempt — no state leaks between attempts.
        checkpointer = MemorySaver()
        thread_id = f"repair-{request_id}"
        config = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": 100,
        }

        # Rebuild the graph with this attempt's checkpointer.
        # We rebuild here so each attempt has a completely isolated checkpoint store.
        graph = build_repair_graph(
            interrupt_before=list(_TOOL_INTERCEPTED_NODES),
            checkpointer=checkpointer,
        )

        MAX_TOOL_ROUNDS = 40
        input_state = initial_state  # first invocation passes the full state
        last_reasoning = ""

        for round_num in range(MAX_TOOL_ROUNDS + 1):
            interrupted = False
            final_this_run = False

            async for snapshot in graph.astream(input_state, config=config):
                for node_name, update in snapshot.items():
                    if node_name == "__interrupt__":
                        interrupted = True
                        continue
                    if not isinstance(update, dict):
                        continue

                    # Emit reasoning fragments
                    new_reasoning = update.get("reasoning")
                    if new_reasoning and isinstance(new_reasoning, str) and new_reasoning != last_reasoning:
                        last_line = new_reasoning.strip().split("\n")[-1].strip()
                        if last_line:
                            yield _ev("reasoning", request_id, message=last_line)
                        last_reasoning = new_reasoning

                    if update.get("complete") or update.get("cannot_repair"):
                        final_this_run = True

            if final_this_run:
                break

            if not interrupted:
                # Graph ran to END with no interrupt
                break

            # Graph is paused at an intercepted node.
            # Get current state from the checkpointer to find _pending_tool_call.
            current = await graph.aget_state(config)
            pending = current.values.get("_pending_tool_call")

            # The node the graph is paused *before* (interrupt_before). We must
            # attribute the result injection to THIS node so LangGraph resumes at
            # its successor (receive_*_result). Without as_node, aupdate_state
            # defaults to the last executed node (apply_fix / gather_context),
            # which re-runs that node's routing and never advances the loop.
            paused_node = current.next[0] if current.next else None

            if not pending:
                logger.warning("repair_interrupted_but_no_pending_tool_call")
                break

            # Execute the tool externally
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
            # Go's read_file result is {content, bytes} with no path. Stash the
            # call args so receive_context_result can key the file cache.
            tool_result["args"] = pending.get("args") or {}

            yield _ev("tool_result", request_id,
                      tool=tool_result["tool"],
                      tool_call_id=tool_call_id,
                      success=tool_result["success"],
                      error=tool_result.get("error") or "")

            # Inject the result into the checkpoint via update_state, attributed
            # to the interrupted node (as_node). This marks call_tool_fix /
            # call_tool_gather as executed so the graph resumes at their
            # successor (receive_fix_result / receive_context_result) instead of
            # re-running apply_fix / gather_context and looping on the same edit.
            update_values = {
                "_pending_tool_call": None,
                "_last_tool_result": tool_result,
            }
            if paused_node:
                await graph.aupdate_state(config, update_values, as_node=paused_node)
            else:
                await graph.aupdate_state(config, update_values)

            # Subsequent astream calls pass None (resume from checkpoint, not restart)
            input_state = None

        # Read final state and emit terminal event
        final = await graph.aget_state(config)
        vals = final.values if final else {}

        if vals.get("cannot_repair"):
            yield _ev("cannot_repair", request_id,
                      cannot_repair_reason=vals.get("cannot_repair_reason", "Unknown"))
        elif vals.get("complete"):
            yield _ev("repair_complete", request_id,
                      agent_version=REPAIR_GRAPH_VERSION,
                      strategy=vals.get("strategy", "unknown"),
                      confidence=vals.get("confidence", 0.0),
                      modified_files=vals.get("modified_files") or [],
                      summary=vals.get("repair_summary", ""))
        else:
            yield _ev("error", request_id,
                      error="Repair loop exhausted without completing")


def _ev(event_type: str, request_id: str, **kwargs) -> dict:
    return {"version": 1, "event": event_type, "request_id": request_id, **kwargs}