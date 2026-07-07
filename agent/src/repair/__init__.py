"""
Phase 9 — Autonomous Self-Repair & Recovery Loop

This package implements the RepairGraph: a LangGraph-based reasoning engine that
analyzes validation failures, performs root-cause analysis, and generates targeted
code fixes.

Design principle:
    The graph executes ONCE per Go invocation and returns a RepairResult.
    It never loops internally. Go owns the retry loop and budget enforcement.
    The graph is stateless between Go's invocations — previous attempt summaries
    are passed IN by Go as input context, not accumulated by the graph.

Graph structure:
    START
    → gather_context      (read affected files + surrounding context)
    → select_strategy     (pick ONE strategy for THIS attempt)
    → [cannot_repair]     (if confidence < threshold)
    → apply_fix           (tool calls — write_file / create_file)
    → complete_repair     (emit repair_complete with summary)
    END

The graph receives diagnostics + previous_attempts from Go, selects a repair
strategy at the start, executes it, and returns control to Go.
"""

__all__ = [
    "RepairContext",
    "RepairRequest",
    "RepairResult",
    "RepairState",
    "RepairPipeline",
    "router",
]
