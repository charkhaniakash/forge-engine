"""
ExecutionGraph: LangGraph StateGraph scoped to ONE plan step.

The graph never holds the full plan or remaining steps.
Go calls this once per step, waits for it to complete, then decides
what to do next (advance, retry, pause, skip).

Node flow:
  START
    → gather_context
    → reason
    → [call_tool → receive_result → reason]  (loop)
    → [check_deviation | complete_step]
    → END

The graph streams NDJSON events via the pipeline's async generator —
each node yields events before returning so Go gets real-time feedback.
"""
from __future__ import annotations

from langgraph.graph import StateGraph, END

from src.execution.models import ExecutionState
from src.execution.nodes import (
    node_gather_context,
    node_reason,
    node_call_tool,
    node_receive_result,
    node_check_deviation,
    node_plan_deviation,
    node_requires_human,
    node_execution_error,
    node_already_satisfied,
    node_complete_step,
    route_after_reason,
    route_after_result,
    route_after_already_satisfied,
)


def build_execution_graph() -> StateGraph:
    """Build and compile the single-step execution graph."""
    graph = StateGraph(ExecutionState)

    # Register nodes.
    graph.add_node("gather_context",    node_gather_context)
    graph.add_node("reason",            node_reason)
    graph.add_node("call_tool",         node_call_tool)
    graph.add_node("receive_result",    node_receive_result)
    graph.add_node("plan_deviation",    node_plan_deviation)
    graph.add_node("requires_human",    node_requires_human)
    graph.add_node("execution_error",   node_execution_error)
    graph.add_node("check_deviation",   node_check_deviation)   # legacy catch-all
    graph.add_node("already_satisfied", node_already_satisfied)
    graph.add_node("complete_step",     node_complete_step)

    # Entry point.
    graph.set_entry_point("gather_context")

    # Static edges.
    graph.add_edge("gather_context", "reason")
    graph.add_edge("call_tool",      "receive_result")

    # Conditional edges.
    graph.add_conditional_edges(
        "reason",
        route_after_reason,
        {
            "call_tool":        "call_tool",
            "already_satisfied":"already_satisfied",
            "plan_deviation":   "plan_deviation",
            "requires_human":   "requires_human",
            "execution_error":  "execution_error",
            "check_deviation":  "check_deviation",   # legacy
            "complete_step":    "complete_step",
        },
    )
    graph.add_conditional_edges(
        "receive_result",
        route_after_result,
        {
            "reason":           "reason",
            "complete_step":    "complete_step",
            "already_satisfied":"already_satisfied",
        },
    )

    # Terminal nodes → END (already_satisfied has a conditional re-verify path).
    graph.add_edge("plan_deviation",   END)
    graph.add_edge("requires_human",   END)
    graph.add_edge("execution_error",  END)
    graph.add_edge("check_deviation",  END)
    graph.add_conditional_edges(
        "already_satisfied",
        route_after_already_satisfied,
        {"reason": "reason", "__end__": END},
    )
    graph.add_edge("complete_step",    END)

    return graph.compile()


# Module-level compiled graph — one instance, stateless between invocations.
execution_graph = build_execution_graph()
