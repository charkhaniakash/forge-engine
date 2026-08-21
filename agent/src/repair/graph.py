"""
Phase 9 — RepairGraph (LangGraph StateGraph)

The graph executes ONCE per Go invocation (one repair attempt).
Go treats this as an opaque reasoning engine: RepairRequest in → NDJSON stream out.

Tool execution does NOT happen inside the graph. Instead:
  1. A node sets _pending_tool_call = {tool, args, reasoning}
  2. The pipeline's tool-call broker sees _pending_tool_call
  3. Pipeline emits a tool_call NDJSON event to Go
  4. Go executes the workspace tool and sends back a tool_result NDJSON event
  5. Pipeline injects result into _last_tool_result and resumes the graph

This is identical to the Phase 7 execution graph pattern.

Graph topology:
    START
      ── gather_context ──┐
            ↓             │  (loop: LLM decides what to read)
      call_tool_gather    │
            ↓             │
      receive_context_result
            ↓ ────────────┘
      root_cause_analysis
            ↓
      select_strategy ──→ cannot_repair ──→ END
            ↓
      generate_fix ──→ cannot_repair ──→ END
            ↓
      apply_fix ──┐
          ↓       │  (loop: drain edit_plan)
      call_tool_fix │
          ↓       │
      receive_fix_result
          ↓ ──────┘
      complete_repair
          ↓
        END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, END
from typing import Literal

from .models import RepairState
from . import nodes

# Version embedded in NDJSON events and persisted by Go
REPAIR_GRAPH_VERSION = "repair_graph_v1"


def _make_call_tool_gather_node():
    """
    Placeholder node: the pipeline intercepts _pending_tool_call before this
    node runs. The node itself is a pass-through — state is already updated
    by the pipeline with _last_tool_result when the graph resumes.
    """
    async def call_tool_gather(state: dict) -> dict:
        # Pipeline has already injected _last_tool_result.
        # Nothing to do here; routing sends us to receive_context_result.
        return {}
    return call_tool_gather


def _make_call_tool_fix_node():
    """Same pattern as call_tool_gather but for the apply loop."""
    async def call_tool_fix(state: dict) -> dict:
        return {}
    return call_tool_fix


def build_repair_graph(
    interrupt_before: list[str] | None = None,
    checkpointer=None,
):
    """
    Build and compile the RepairGraph StateGraph.

    Args:
        interrupt_before: node names at which LangGraph pauses before execution.
        checkpointer:     LangGraph checkpointer (e.g. MemorySaver) that enables
                          graph.aupdate_state() and resume-from-checkpoint.
                          Required for the tool broker to inject results without
                          restarting from the entry point.
    """
    graph = StateGraph(RepairState)

    # ── Register nodes ────────────────────────────────────────────────────────
    graph.add_node("gather_context",          nodes.gather_context)
    graph.add_node("call_tool_gather",        _make_call_tool_gather_node())
    graph.add_node("receive_context_result",  nodes.receive_context_result)
    graph.add_node("root_cause_analysis",     nodes.root_cause_analysis)
    graph.add_node("select_strategy",         nodes.select_strategy)
    graph.add_node("generate_fix",            nodes.generate_fix)
    graph.add_node("apply_fix",               nodes.apply_fix)
    graph.add_node("call_tool_fix",           _make_call_tool_fix_node())
    graph.add_node("receive_fix_result",      nodes.receive_fix_result)
    graph.add_node("complete_repair",         nodes.complete_repair)
    graph.add_node("escalate_repair",         nodes.cannot_repair)  # node renamed to avoid conflict with state key 'cannot_repair'

    # ── Entry point ───────────────────────────────────────────────────────────
    graph.set_entry_point("gather_context")

    # ── Gather loop ───────────────────────────────────────────────────────────
    graph.add_conditional_edges(
        "gather_context",
        nodes.route_gather_loop,
        {
            "call_tool_gather":    "call_tool_gather",
            "gather_context":      "gather_context",
            "root_cause_analysis": "root_cause_analysis",
        },
    )
    graph.add_edge("call_tool_gather", "receive_context_result")
    graph.add_conditional_edges(
        "receive_context_result",
        nodes.route_gather_loop,
        {
            "call_tool_gather":    "call_tool_gather",   # shouldn't happen but safe
            "gather_context":      "gather_context",
            "root_cause_analysis": "root_cause_analysis",
        },
    )

    # ── Root cause → strategy ─────────────────────────────────────────────────
    graph.add_conditional_edges(
        "root_cause_analysis",
        nodes.route_after_root_cause,
        {
            "escalate_repair": "escalate_repair",
            "select_strategy": "select_strategy",
        },
    )

    # ── Strategy → fix ────────────────────────────────────────────────────────
    graph.add_conditional_edges(
        "select_strategy",
        nodes.route_after_strategy,
        {
            "escalate_repair": "escalate_repair",
            "generate_fix":    "generate_fix",
        },
    )

    # ── Generate → apply ──────────────────────────────────────────────────────
    graph.add_conditional_edges(
        "generate_fix",
        nodes.route_after_generate,
        {
            "escalate_repair": "escalate_repair",
            "apply_fix":       "apply_fix",
        },
    )

    # ── Apply loop ────────────────────────────────────────────────────────────
    graph.add_conditional_edges(
        "apply_fix",
        nodes.route_apply_loop,
        {
            "call_tool_fix":   "call_tool_fix",
            "apply_fix":       "apply_fix",
            "complete_repair": "complete_repair",
            "escalate_repair": "escalate_repair",
        },
    )
    graph.add_edge("call_tool_fix", "receive_fix_result")
    graph.add_conditional_edges(
        "receive_fix_result",
        nodes.route_apply_loop,
        {
            "call_tool_fix":   "call_tool_fix",
            "apply_fix":       "apply_fix",
            "complete_repair": "complete_repair",
            "escalate_repair": "escalate_repair",
        },
    )

    # ── Terminal nodes ────────────────────────────────────────────────────────
    graph.add_edge("complete_repair", END)
    graph.add_edge("escalate_repair", END)

    return graph.compile(
        interrupt_before=interrupt_before or [],
        checkpointer=checkpointer,
    )
