"""
LangGraph nodes for the single-step ExecutionGraph.

Each node receives the full ExecutionState and returns a partial update.
The graph is scoped to ONE plan step — it never holds the full plan.

Node flow:
  gather_context → reason → call_tool → receive_result → [reason | complete_step]
                                                    ↘ check_deviation (if mismatch found)
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import structlog

from src.config import settings
from src.execution.context_builder import gather_context
from src.execution.models import ExecutionState, ToolCallResult
from src.execution.tool_client import ToolClient

logger = structlog.get_logger()

# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are an autonomous software engineer executing one implementation step inside \
an isolated workspace. You have read access to the repository and write access \
to modify files. You may NOT run shell commands in Phase 7.

Your job for this step:
1. Read the files you need to understand the current state.
2. Reason about what minimal change is required.
3. Write the changed files using the write_file or create_file tool.
4. Report the correct outcome when you cannot continue.
5. Never invent APIs, types, or behaviours not present in the codebase.
6. Output only the complete new file content — no explanation, no markdown fences.

Available tools:
  read_file(path)                         — read a file from /workspace
  write_file(path, content)               — overwrite a file (Go computes the diff)
  create_file(path, content)              — create a new file (parent dirs auto-created)
  delete_file(path)                       — delete a file
  rename_file(old_path, new_path)         — rename/move a file (dest parent auto-created)
  list_dir(path)                          — list directory; returns [{name,type,size,mod_time}]
  search_symbol(pattern, dir)             — search for a symbol; returns [{file_path,line,preview}]
  exists(path)                            — check if a path exists; returns {exists: bool}
  stat(path)                              — get file metadata; returns {exists,type,size,mod_time}

When done with a step, respond with:
  {"action": "complete", "summary": "what was accomplished"}

IMPORTANT — already satisfied:
  If you read the files and discover the desired state ALREADY EXISTS
  (e.g. the import is already present, the function is already implemented,
  the file already has the correct content), respond with:
  {"action": "already_satisfied", "summary": "what already exists and why no change is needed"}
  This is a SUCCESSFUL outcome, not a deviation. The step is complete with no modifications.
  Use this instead of plan_deviation when the code already has what the step asks for.

To call a tool, respond with:
  {"action": "tool", "tool": "<name>", "args": {...}, "reasoning": "why"}

Use these three distinct outcomes ONLY when you genuinely cannot complete the step:

1. plan_deviation — the repository structure no longer matches what the plan assumed,
   AND the desired state does NOT already exist. Use ONLY when the codebase itself
   has changed (file missing, API renamed, structure changed) and the approved plan
   needs to be reconsidered. Do NOT use this when the desired change is already done.
   {"action": "plan_deviation", "message": "what the plan assumed vs. what exists now"}

2. requires_human — you cannot proceed because the step needs human judgement
   or a capability you do not have (visual verification, external systems,
   ambiguous requirements that must be clarified).
   {"action": "requires_human", "message": "what decision or action is needed"}

3. execution_error — a technical failure prevented this step (tool failed,
   LLM error, workspace problem). Do NOT use this for plan mismatches.
   {"action": "execution_error", "message": "what failed and why"}
"""


# ── Node: gather_context ──────────────────────────────────────────────────────

async def node_gather_context(state: ExecutionState) -> dict:
    """Read affected files to populate retrieved_context before reasoning."""
    tool_client = _get_tool_client(state)
    context = await gather_context(state, tool_client)
    return {"retrieved_context": context}


# ── Node: reason ──────────────────────────────────────────────────────────────

def _detect_convergence(tool_history: list[dict], window: int = 4) -> bool:
    """Return True if the agent is looping without making progress.

    Two signals:
    1. The last `window` tool calls are identical (same tool + same args).
    2. The same file has been written more than 3 times with identical content.
    """
    if len(tool_history) < window:
        return False

    # Signal 1: last N calls are identical.
    tail = tool_history[-window:]
    first_req = tail[0].get("request") if tail[0] else None
    if first_req and all(
        e.get("request") == first_req for e in tail if e
    ):
        return True

    # Signal 2: same file written >3 times with the same content.
    write_ops: dict[str, list[str]] = {}
    for entry in tool_history:
        if not entry or not isinstance(entry, dict):
            continue
        req = entry.get("request") or {}
        tool = req.get("tool", "")
        args = req.get("args") or {}
        if tool in ("write_file", "create_file"):
            path = args.get("path", "")
            content = args.get("content", "")
            write_ops.setdefault(path, []).append(content)

    for path, contents in write_ops.items():
        if len(contents) > 3 and len(set(contents)) == 1:
            return True

    return False


async def _call_llm_for_reason(
    messages: list[dict],
    ctx,
    attempt: int,
) -> str:
    """Single LLM call for node_reason. Returns the raw string response."""
    from src.llm.chat_factory import get_chat_provider

    provider = get_chat_provider()
    content_parts: list[str] = []

    async for event in provider.stream(
        messages=messages,
        payload={},
        request_id=f"reason-{ctx.task_execution_id[:8]}-{ctx.step_id}-a{attempt}",
        response_format={"type": "json_object"},
    ):
        if event and isinstance(event, dict):
            evt_type = event.get("event")
            if evt_type == "token":
                content_parts.append(event.get("text", ""))
            elif evt_type in ("done", "error"):
                break

    return "".join(content_parts).strip()


async def node_reason(state: ExecutionState) -> dict:
    """Ask the LLM what to do next for this step.

    Improvements over the original:
    - Convergence detection: aborts with execution_error if the agent is
      repeating the same tool calls with no progress.
    - JSON parse retry: retries the LLM call up to _max_json_retries times
      before giving up. Failures are execution_error, not plan_deviation.
    - Structured logging: emits iteration, tool_calls_so_far, repeated_tool_detected.
    """
    ctx = state["ctx"]
    step = state["current_step"]
    tool_history = state["tool_history"]
    retrieved_context = state["retrieved_context"]

    iteration: int = state.get("_iteration", 0)  # type: ignore[call-overload]
    max_iterations: int = state.get("_max_iterations", 12)  # type: ignore[call-overload]
    json_retry_count: int = state.get("_json_retry_count", 0)  # type: ignore[call-overload]
    max_json_retries: int = state.get("_max_json_retries", 2)  # type: ignore[call-overload]
    tool_calls_so_far = len(tool_history)

    # ── Convergence detection ─────────────────────────────────────────────────
    repeated_tool_detected = _detect_convergence(tool_history)
    logger.info(
        "node_reason_start",
        step_id=ctx.step_id,
        iteration=iteration,
        tool_calls_so_far=tool_calls_so_far,
        repeated_tool_detected=repeated_tool_detected,
    )

    if repeated_tool_detected or iteration >= max_iterations:
        msg = (
            "Execution loop detected: agent is repeating the same tool calls without progress"
            if repeated_tool_detected
            else f"Maximum iteration limit ({max_iterations}) reached without completing the step"
        )
        logger.error(
            "node_reason_convergence_abort",
            step_id=ctx.step_id,
            iteration=iteration,
            repeated_tool_detected=repeated_tool_detected,
        )
        return {
            "_iteration": iteration + 1,
            "_pending_action": {"action": "execution_error", "message": msg},
        }

    # ── Build messages ────────────────────────────────────────────────────────
    messages = [{"role": "system", "content": _SYSTEM_PROMPT}]

    context_block = _format_context(retrieved_context)
    if context_block:
        messages.append({
            "role": "user",
            "content": f"Current file contents:\n\n{context_block}",
        })
        messages.append({
            "role": "assistant",
            "content": "I've reviewed the current file contents.",
        })

    for entry in tool_history:
        if entry and isinstance(entry, dict):
            req = entry.get("request")
            res = entry.get("result")
            if req is not None:
                messages.append({"role": "assistant", "content": json.dumps(req)})
            if res is not None:
                messages.append({"role": "user", "content": f"Tool result: {json.dumps(res)}"})

    step_title = step.get("title", "") if step else ""
    step_desc = step.get("description", "") if step else ""
    step_files = step.get("affected_files", []) if step else []
    messages.append({
        "role": "user",
        "content": (
            f"Step to execute:\n"
            f"Title: {step_title}\n"
            f"Description: {step_desc}\n"
            f"Affected files: {step_files}\n\n"
            "What should you do? Respond with a JSON object."
        ),
    })

    # ── LLM call with JSON-parse retry ────────────────────────────────────────
    action: dict = {}
    attempt = 0
    parse_error: str = ""

    while attempt <= max_json_retries:
        # On retry, append a correction message so the model knows what to fix.
        if attempt > 0:
            messages.append({
                "role": "user",
                "content": (
                    f"Your previous response could not be parsed as JSON: {parse_error}. "
                    "Please respond ONLY with a valid JSON object and nothing else."
                ),
            })

        raw = await _call_llm_for_reason(messages, ctx, attempt)
        logger.info(
            "node_reason_llm_response",
            step_id=ctx.step_id,
            attempt=attempt,
            raw_length=len(raw),
            raw_preview=raw[:200],
        )

        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError(f"Expected dict, got {type(parsed).__name__}")
            action = parsed
            logger.info(
                "node_reason_parsed",
                step_id=ctx.step_id,
                attempt=attempt,
                action_type=action.get("action", ""),
                action_preview=str(action)[:200],
            )
            # Successful parse — reset consecutive failure counter.
            return {
                "reasoning": (state.get("reasoning") or "") + "\n" + (action.get("reasoning", "") or action.get("summary", "")),
                "_pending_action": action,
                "_iteration": iteration + 1,
                "_json_retry_count": 0,
            }
        except (json.JSONDecodeError, ValueError) as e:
            parse_error = str(e)
            logger.warning(
                "node_reason_json_parse_failed",
                step_id=ctx.step_id,
                attempt=attempt,
                error=parse_error,
                raw_preview=raw[:200],
            )
            attempt += 1

    # All retries exhausted — emit execution_error (NOT plan_deviation).
    logger.error(
        "node_reason_json_retries_exhausted",
        step_id=ctx.step_id,
        max_json_retries=max_json_retries,
        last_error=parse_error,
    )
    return {
        "_iteration": iteration + 1,
        "_json_retry_count": json_retry_count + attempt,
        "_pending_action": {
            "action": "execution_error",
            "message": f"LLM produced non-JSON after {attempt} attempts: {parse_error}",
        },
    }


# ── Node: call_tool ───────────────────────────────────────────────────────────

async def node_call_tool(state: ExecutionState) -> dict:
    """Dispatch the tool call the LLM requested."""
    action: dict = state.get("_pending_action", {}) or {}  # type: ignore[assignment]
    if not isinstance(action, dict):
        action = {}
    ctx = state["ctx"]
    tool_client = _get_tool_client(state)

    tool_name = action.get("tool", "")
    tool_args = action.get("args", {})
    reasoning = action.get("reasoning", "")

    result = await tool_client.call(
        tool=tool_name,
        args=tool_args,
        reasoning=reasoning,
        step_id=ctx.step_id,
    )

    history_entry = {
        "request": {"action": "tool", "tool": tool_name, "args": tool_args},
        "result": result.model_dump(),
    }
    new_history = list(state["tool_history"]) + [history_entry]

    return {
        "tool_history": new_history,
        "latest_tool_result": result,
        "_pending_action": None,
    }


# ── Node: receive_result ──────────────────────────────────────────────────────

async def node_receive_result(state: ExecutionState) -> dict:
    """Process the tool result — no LLM call, just routing logic."""
    result: ToolCallResult | None = state.get("latest_tool_result")
    if result and not result.success:
        logger.warning(
            "tool_call_failed",
            tool=result.tool,
            error=result.error,
            step_id=state["ctx"].step_id,
        )
    # Routing happens in edges — this node is a pass-through for state.
    return {}


# ── Terminal nodes ────────────────────────────────────────────────────────────

async def node_plan_deviation(state: ExecutionState) -> dict:
    """Repository state differs from what the plan assumed.

    Triggers replanning in Phase 9. Not an error — the plan was correct
    when approved but the codebase has changed since.
    """
    action: dict = state.get("_pending_action", {}) or {}
    if not isinstance(action, dict):
        action = {}
    msg = action.get("message", "Repository state differs from plan assumptions")
    logger.warning("plan_deviation_detected",
                   message=msg, step_id=state["ctx"].step_id)
    return {"deviation": msg, "deviation_type": "plan_deviation",
            "complete": True, "_pending_action": None}


async def node_requires_human(state: ExecutionState) -> dict:
    """The step needs human judgement or an unsupported capability.

    Blocks execution until a human provides input or approval.
    Examples: visual verification, ambiguous requirements, external systems.
    """
    action: dict = state.get("_pending_action", {}) or {}
    if not isinstance(action, dict):
        action = {}
    msg = action.get("message", "Human input or verification required")
    logger.info("requires_human_detected",
                message=msg, step_id=state["ctx"].step_id)
    return {"deviation": msg, "deviation_type": "requires_human",
            "complete": True, "_pending_action": None}


async def node_execution_error(state: ExecutionState) -> dict:
    """A technical failure occurred — tool, LLM, workspace, or timeout.

    Retryable infrastructure failures. Distinct from plan mismatches
    or human-blocked situations.
    """
    action: dict = state.get("_pending_action", {}) or {}
    if not isinstance(action, dict):
        action = {}
    msg = action.get("message", "Execution error")
    logger.error("execution_error_detected",
                 message=msg, step_id=state["ctx"].step_id)
    return {"deviation": msg, "deviation_type": "execution_error",
            "complete": True, "_pending_action": None}


# ── Keep for backward compatibility (JSON parse failures fall here) ───────────
async def node_check_deviation(state: ExecutionState) -> dict:
    """Legacy catch-all for unclassified deviations (e.g. non-JSON LLM output).
    Routes to plan_deviation semantics as the safest default.
    """
    return await node_plan_deviation(state)


# ── Node: complete_step ───────────────────────────────────────────────────────

async def node_complete_step(state: ExecutionState) -> dict:
    """Mark the step as complete."""
    action: dict = state.get("_pending_action", {}) or {}  # type: ignore[assignment]
    if not isinstance(action, dict):
        action = {}
    summary = action.get("summary", "Step completed")
    return {
        "reasoning": (state.get("reasoning") or "") + "\n" + summary,
        "complete": True,
        "_pending_action": None,
    }


async def node_already_satisfied(state: ExecutionState) -> dict:
    """The desired state already exists — no modifications needed.

    This is a SUCCESSFUL completion. The step is marked complete with no diffs.
    It does NOT block downstream dependent steps.
    Distinct from plan_deviation: the plan was correct, the work was already done.
    """
    action: dict = state.get("_pending_action", {}) or {}
    if not isinstance(action, dict):
        action = {}
    summary = action.get("summary", "Desired state already exists — no changes required")
    logger.info("step_already_satisfied",
                summary=summary, step_id=state["ctx"].step_id)
    return {
        "reasoning": (state.get("reasoning") or "") + "\n[already satisfied] " + summary,
        "complete": True,
        "_pending_action": None,
    }


# ── Edge routing ──────────────────────────────────────────────────────────────

def route_after_reason(state: ExecutionState) -> str:
    """Decide the next node after reasoning."""
    logger.info("route_after_reason_start", state_type=type(state))
    if not state or not isinstance(state, dict):
        logger.error("route_after_reason_invalid_state", state_type=type(state))
        return "complete_step"

    action: dict = state.get("_pending_action") or {}
    if not isinstance(action, dict):
        logger.error("route_after_reason_invalid_action", action_type=type(action))
        action = {}

    a = action.get("action", "")
    logger.info("route_after_reason_decision", action=a)

    if a == "tool":
        return "call_tool"
    if a == "already_satisfied":
        return "already_satisfied"
    if a == "plan_deviation":
        return "plan_deviation"
    if a == "requires_human":
        return "requires_human"
    if a == "execution_error":
        return "execution_error"
    # Legacy "deviation" key → plan_deviation as safe default.
    if a == "deviation":
        return "plan_deviation"
    return "complete_step"  # "complete" or unknown


def route_after_result(state: ExecutionState) -> str:
    """Decide the next node after receiving a tool result."""
    result: ToolCallResult | None = state.get("latest_tool_result")
    # If the tool failed with a hard error, stop the step.
    if result and not result.success and result.error:
        return "complete_step"
    # Continue reasoning loop.
    return "reason"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_tool_client(state: ExecutionState) -> ToolClient:
    """Reconstruct ToolClient from state context."""
    ctx = state["ctx"]
    # Token comes from state — Go injected it.
    token = state.get("_agent_token", "")  # type: ignore[call-overload]
    return ToolClient(
        workspace_id=ctx.workspace_id,
        exec_id=ctx.task_execution_id,
        token=token,
        step_execution_id=ctx.step_execution_id,
    )


def _format_context(retrieved_context: list[dict]) -> str:
    parts: list[str] = []
    for entry in retrieved_context:
        if entry.get("exists") and entry.get("content"):
            header = f"// File: {entry['path']}"
            parts.append(f"{header}\n```\n{entry['content']}\n```")
    return "\n\n".join(parts)
