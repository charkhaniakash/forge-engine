"""
Phase 9 — Repair models

Design:
    Go starts a brand-new RepairGraph for every attempt. The graph never
    accumulates cross-attempt state. Previous attempt summaries are passed IN
    by Go via RepairRequest, not held inside the graph.

    The graph is an opaque reasoning engine from Go's perspective. Go sends a
    RepairRequest and reads NDJSON events. It never knows about nodes, edges,
    or internal state.
"""
from __future__ import annotations

from typing import TypedDict, List, Dict, Any, Optional
from dataclasses import dataclass


# ── Wire contract ─────────────────────────────────────────────────────────────

@dataclass
class RepairContext:
    """Immutable context injected by Go for one repair attempt."""
    repair_session_id: str
    task_execution_id: str
    workspace_id: str
    attempt_number: int
    trace_id: str
    model: str
    temperature: float
    max_tokens: int


@dataclass
class RepairRequest:
    """Request sent from Go to POST /v1/agent/repair."""
    version: int  # always 1
    repair_context: RepairContext
    diagnostics: List[Dict[str, Any]]  # ValidationDiagnostic[]
    previous_attempts: List[Dict[str, Any]]  # summary of prior attempts
    request_id: str


# ── Internal graph state ──────────────────────────────────────────────────────

class RepairState(TypedDict, total=False):
    """
    LangGraph state for the RepairGraph.

    Architecture:
        - Go starts a brand-new graph for every attempt (stateless between invocations)
        - The graph receives previous_attempt_summaries from Go (passed in RepairRequest)
        - Strategy is selected once by root_cause_analysis/select_strategy
        - Confidence evolves during the attempt as fix quality becomes clearer
        - The pipeline (not nodes) executes tool calls; nodes only set _pending_tool_call

    Node responsibilities:
        gather_context      → populate retrieved_context via reasoning loop
        root_cause_analysis → determine root cause, classify, set confidence
        select_strategy     → pick ONE repair strategy for THIS attempt
        generate_fix        → produce EditPlan (file edits), pure LLM, no I/O
        apply_fix           → emit _pending_tool_call entries; pipeline executes them
        complete_repair     → produce final summary; set complete=True
        cannot_repair       → escalate; set complete=True
    """
    # ── Immutable context ─────────────────────────────────────────────────────
    ctx: RepairContext

    # ── Input from Go ─────────────────────────────────────────────────────────
    diagnostics: List[Dict[str, Any]]

    # Passed IN by Go — not accumulated by graph across invocations
    previous_attempt_summaries: List[Dict[str, Any]]

    # ── Accumulated within THIS attempt ───────────────────────────────────────
    retrieved_context: List[Dict[str, Any]]  # files + symbols read so far
    root_cause: str                          # narrative from root_cause_analysis
    reasoning: str                           # accumulated reasoning log

    # ── Strategy (set once, never changed mid-attempt) ────────────────────────
    strategy: str    # "targeted_fix" | "minimal_rewrite" | "cannot_repair"
    confidence: float  # 0.0–1.0; may decrease during apply if errors arise

    # ── Edit plan: what the LLM wants to write ────────────────────────────────
    # List of {path, content} dicts — generate_fix produces these
    # apply_fix drains them into _pending_tool_call
    edit_plan: List[Dict[str, Any]]

    # ── Results ───────────────────────────────────────────────────────────────
    modified_files: List[str]
    repair_summary: str
    complete: bool

    # ── Escalation ────────────────────────────────────────────────────────────
    cannot_repair: bool
    cannot_repair_reason: str

    # ── Internal pipeline state (prefixed _) ──────────────────────────────────
    # Token injected by Go; pipeline passes it to the tool client
    _agent_token: str

    # The next tool call the graph wants executed.
    # Set by nodes; consumed and cleared by the pipeline.
    # Shape: {tool: str, args: dict, reasoning: str} or None
    _pending_tool_call: Optional[Dict[str, Any]]

    # Result of the most recently completed tool call.
    # Injected by the pipeline after Go executes the tool.
    # Shape: {tool: str, success: bool, result: dict|None, error: str|None}
    _last_tool_result: Optional[Dict[str, Any]]

    # Per-file content cache (path → content) built by gather_context loop.
    # The cache prevents redundant read_file calls.
    _file_cache: Dict[str, str]

    # Gather loop control
    _gather_iteration: int
    _max_gather_iterations: int

    # Apply loop control — counts the index of the next edit to apply
    _apply_index: int


# ── Output contract ───────────────────────────────────────────────────────────

@dataclass
class RepairResult:
    """Output returned by the RepairPipeline to Go (carried in NDJSON events)."""
    agent_version: str
    strategy: Optional[str]
    confidence: Optional[float]
    modified_files: List[str]
    root_cause: str
    summary: str
    cannot_repair: bool
    cannot_repair_reason: str
