"""
Phase 7 execution domain models.

ExecutionContext:   injected by Go — the agent never modifies it.
ExecuteStepRequest: what Go sends to POST /v1/agent/execute-step.
ToolCallRequest:   what the agent sends to Go's /tool endpoint.
ToolCallResult:    what Go returns after executing the tool.
ExecutionState:    LangGraph state for one step — never holds the full plan.
"""
from __future__ import annotations

from typing import Any, TypedDict
from pydantic import BaseModel


class ExecutionContext(BaseModel):
    """Injected by Go at execution start. Immutable — agent reads, never writes."""
    task_execution_id: str
    step_execution_id: str = ""  # current step execution ID (set per step)
    workspace_id: str
    step_id: str = ""          # current step stable_id (set per step)
    plan_version: int = 1
    trace_id: str = ""
    org_id: str = ""
    user_id: str = ""
    # LLM config resolved from org policy
    model: str = "gpt-4o"
    temperature: float = 0.1
    max_tokens: int = 4096
    execution_mode: str = "autonomous"
    autonomy_level: str = "full"


class ExecuteStepRequest(BaseModel):
    """Body of POST /v1/agent/execute-step."""
    version: int = 1
    execution_context: ExecutionContext
    step: dict[str, Any]       # one plan step — never the full plan
    request_id: str


class ToolCallRequest(BaseModel):
    """Sent by the agent to Go's POST /v1/internal/workspaces/:id/tool."""
    version: int = 1
    tool: str
    args: dict[str, Any]
    reasoning: str
    step_id: str
    step_execution_id: str = ""  # for diff persistence
    tool_call_id: str          # UUIDv4 — idempotency key
    exec_id: str               # task_execution_id for event persistence


class ToolCallResult(BaseModel):
    """Go's response to a ToolCallRequest."""
    version: int = 1
    tool: str
    success: bool
    result: dict[str, Any] | None = None
    error: str | None = None
    duration_ms: int = 0
    cached: bool = False


# ── LangGraph state ───────────────────────────────────────────────────────────

class ExecutionState(TypedDict):
    """
    State for the LangGraph single-step execution graph.

    Scope: exactly ONE plan step.
    The graph never holds the full plan or remaining steps —
    Go decides which step comes next.

    NOTE: _agent_token MUST be declared here so LangGraph preserves it
    across node transitions. TypedDict keys prefixed with _ are treated
    as internal state and are never sent to the LLM.
    """
    ctx: ExecutionContext                # immutable — injected by Go
    current_step: dict[str, Any]        # the one step being executed

    # Accumulated within this step
    retrieved_context: list[dict[str, Any]]   # files/symbols read so far
    tool_history: list[dict[str, Any]]         # tool calls made this step
    reasoning: str                             # accumulated reasoning text
    latest_tool_result: ToolCallResult | None  # result from last tool call

    # Terminal flags
    deviation: str | None        # message — set for any non-complete terminal outcome
    deviation_type: str | None   # "plan_deviation" | "requires_human" | "execution_error" | None
    complete: bool               # True when the step is done

    # Internal — must be declared so LangGraph preserves across node hops.
    # LangGraph drops undeclared keys on state merge; declaring here keeps token alive.
    _agent_token: str        # Backend JWT forwarded from Go → ToolClient
    _pending_action: dict[str, Any] | None  # current LLM action awaiting dispatch

    # Convergence and retry tracking
    _iteration: int           # current reasoning iteration, starts at 0
    _max_iterations: int      # default 12
    _json_retry_count: int    # tracks consecutive JSON parse failures
    _max_json_retries: int    # default 2

    # Repository state tracking for content-based convergence detection.
    # Maps file_path → sha256 hash of last-known content.
    # Updated after every successful write_file / create_file.
    # If a write produces no hash change we skip the write immediately.
    _file_hashes: dict[str, str]

    # In-memory file content cache.
    # Maps file_path → content string of the last-known file state.
    # Populated on successful write_file / create_file so subsequent
    # read_file calls for the same path never need a round-trip to Go.
    # Invalidated only by delete_file or rename_file on the same path.
    _file_cache: dict[str, str]

    # Count of write iterations that produced no repository state change.
    # Two consecutive no-change write cycles → abort.
    _no_progress_write_cycles: int

    # Set to True by node_call_tool when a write is skipped due to identical
    # content. route_after_result reads this flag to terminate the step
    # immediately without re-entering node_reason, saving one full LLM call.
    _convergence_triggered: bool
