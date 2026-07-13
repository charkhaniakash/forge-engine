"""
LangGraph nodes for the single-step ExecutionGraph.

Each node receives the full ExecutionState and returns a partial update.
The graph is scoped to ONE plan step — it never holds the full plan.

Node flow:
  gather_context → reason → call_tool → receive_result → [reason | complete_step]
                                                    ↘ check_deviation (if mismatch found)
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import structlog

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
3. Apply the change by calling the write_file or create_file tool (see the
   response protocol below). Actually completing a step almost always requires
   at least one write_file/create_file call — do not end the step without one
   unless the change genuinely already exists.
4. Report the correct outcome when you cannot continue.
5. Never invent APIs, types, or behaviours not present in the codebase.
6. ALWAYS respond with exactly ONE JSON action object and nothing else — never
   raw prose, raw file content, or markdown fences. When writing a file, put the
   ENTIRE new file content inside the tool call's "args"."content" field.

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

IMPORTANT — already satisfied (use sparingly, only after reading the files):
  ONLY after you have actually read the relevant file(s) with read_file AND
  confirmed that EVERY part of the requested change is already present, respond with:
  {"action": "already_satisfied", "summary": "what already exists and why no change is needed"}
  This is a SUCCESSFUL outcome, not a deviation. The step is complete with no modifications.
  If ANY part of the requested change is missing, do NOT use this — make the change
  with write_file/create_file instead. Never assume the change already exists without
  reading the file first.

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

def _hash_content(content: str) -> str:
    """Return a short SHA-256 hex digest of the given content string."""
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def _detect_tool_repetition(tool_history: list[dict], window: int = 4) -> bool:
    """Return True if the last `window` tool calls are identical (same tool + same args).

    This is a fast early-detection heuristic. The authoritative convergence
    signal is repository-state change tracking (see `_no_progress_write_cycles`).
    """
    if len(tool_history) < window:
        return False
    tail = tool_history[-window:]
    first_req = tail[0].get("request") if tail[0] else None
    if first_req and all(
        e.get("request") == first_req for e in tail if e
    ):
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
    no_progress_cycles: int = state.get("_no_progress_write_cycles", 0)  # type: ignore[call-overload]
    tool_calls_so_far = len(tool_history)

    # ── Convergence detection ─────────────────────────────────────────────────
    # Primary signal: repository state stopped changing (content-hash based).
    # Secondary signal: tool-repetition heuristic for early detection.
    repo_stalled = no_progress_cycles >= 2
    repeated_tool_detected = _detect_tool_repetition(tool_history)
    convergence_detected = repo_stalled or repeated_tool_detected

    logger.info(
        "node_reason_start",
        step_id=ctx.step_id,
        iteration=iteration,
        tool_calls_so_far=tool_calls_so_far,
        repeated_tool_detected=repeated_tool_detected,
        repo_stalled=repo_stalled,
        no_progress_cycles=no_progress_cycles,
    )

    if convergence_detected or iteration >= max_iterations:
        if repo_stalled:
            msg = (
                "Repository state stopped changing: the agent wrote files but the "
                "content did not differ from what was already on disk. "
                "No further progress is possible without a different approach."
            )
            reason = "repo_state_unchanged"
        elif repeated_tool_detected:
            msg = (
                "Execution loop detected: agent is repeating the same tool calls "
                "without making progress."
            )
            reason = "tool_repetition"
        else:
            msg = f"Maximum iteration limit ({max_iterations}) reached without completing the step."
            reason = "max_iterations"
        logger.error(
            "node_reason_convergence_abort",
            step_id=ctx.step_id,
            iteration=iteration,
            reason=reason,
            repeated_tool_detected=repeated_tool_detected,
            repo_stalled=repo_stalled,
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
    """Dispatch the tool call the LLM requested.

    Fix 1 — Read-after-write cache:
    After a successful write_file / create_file, the agent already knows the
    exact file contents because it generated them. We cache the content in
    _file_cache. When read_file is called for a cached path we return the
    cached content immediately, eliminating the round-trip to Go and the
    read→write→read loop pattern entirely.
    The cache is invalidated by delete_file and rename_file on the same path.

    Fix 2 — Identical-content write skip (convergence):
    For write_file / create_file: hash the new content and compare to the
    last-known hash. If identical, skip the write and increment
    _no_progress_write_cycles. Two cycles → convergence abort.
    """
    action: dict = state.get("_pending_action", {}) or {}  # type: ignore[assignment]
    if not isinstance(action, dict):
        action = {}
    ctx = state["ctx"]
    tool_client = _get_tool_client(state)

    tool_name = action.get("tool", "")
    tool_args = action.get("args", {})
    reasoning = action.get("reasoning", "")

    file_hashes: dict = dict(state.get("_file_hashes") or {})  # type: ignore[call-overload]
    file_cache: dict = dict(state.get("_file_cache") or {})    # type: ignore[call-overload]
    no_progress_cycles: int = state.get("_no_progress_write_cycles", 0)  # type: ignore[call-overload]

    # ── Fix 1: serve read_file from cache when content is known ──────────────
    if tool_name == "read_file":
        path = tool_args.get("path", "")
        if path in file_cache:
            cached_content = file_cache[path]
            logger.info(
                "node_call_tool_read_from_cache",
                step_id=ctx.step_id,
                path=path,
                content_len=len(cached_content),
            )
            cached_result = ToolCallResult(
                tool=tool_name,
                success=True,
                result={"content": cached_content, "bytes": len(cached_content), "cached": True},
                cached=True,
            )
            history_entry = {
                "request": {"action": "tool", "tool": tool_name, "args": tool_args},
                "result": cached_result.model_dump(),
            }
            return {
                "tool_history": list(state["tool_history"]) + [history_entry],
                "latest_tool_result": cached_result,
                "_pending_action": None,
            }

    # ── Fix 2: identical-content skip for write / create ─────────────────────
    if tool_name in ("write_file", "create_file"):
        path = tool_args.get("path", "")
        content = tool_args.get("content", "")
        new_hash = _hash_content(content)
        old_hash = file_hashes.get(path)

        if old_hash is not None and old_hash == new_hash:
            logger.warning(
                "node_call_tool_identical_content_skipped",
                step_id=ctx.step_id,
                tool=tool_name,
                path=path,
                hash=new_hash,
                no_progress_cycles=no_progress_cycles + 1,
            )
            skipped_result = ToolCallResult(
                tool=tool_name,
                success=True,
                result={"skipped": True, "reason": "content_unchanged", "path": path},
                cached=True,
            )
            history_entry = {
                "request": {"action": "tool", "tool": tool_name, "args": tool_args},
                "result": skipped_result.model_dump(),
            }
            return {
                "tool_history": list(state["tool_history"]) + [history_entry],
                "latest_tool_result": skipped_result,
                "_pending_action": None,
                "_no_progress_write_cycles": no_progress_cycles + 1,
                # NOTE: _convergence_triggered is set so route_after_result
                # can terminate the step immediately without re-entering reason.
                "_convergence_triggered": True,
            }

    # ── Execute the tool via Go ───────────────────────────────────────────────
    result = await tool_client.call(
        tool=tool_name,
        args=tool_args,
        reasoning=reasoning,
        step_id=ctx.step_id,
    )

    new_no_progress = no_progress_cycles
    updates: dict = {
        "tool_history": list(state["tool_history"]) + [{
            "request": {"action": "tool", "tool": tool_name, "args": tool_args},
            "result": result.model_dump(),
        }],
        "latest_tool_result": result,
        "_pending_action": None,
    }

    if result.success:
        if tool_name in ("write_file", "create_file"):
            path = tool_args.get("path", "")
            content = tool_args.get("content", "")
            new_hash = _hash_content(content)
            old_hash = file_hashes.get(path)
            file_hashes[path] = new_hash
            # Cache the written content so future read_file calls are free.
            file_cache[path] = content
            updates["_file_hashes"] = file_hashes
            updates["_file_cache"] = file_cache
            if old_hash != new_hash:
                new_no_progress = 0
                logger.info(
                    "node_call_tool_write_changed",
                    step_id=ctx.step_id,
                    path=path,
                    old_hash=old_hash,
                    new_hash=new_hash,
                )
            else:
                new_no_progress = no_progress_cycles + 1
            updates["_no_progress_write_cycles"] = new_no_progress

        elif tool_name in ("delete_file", "rename_file"):
            # Invalidate cache for affected paths.
            path = tool_args.get("path", tool_args.get("old_path", ""))
            new_path = tool_args.get("new_path", "")
            file_cache.pop(path, None)
            file_hashes.pop(path, None)
            if new_path:
                file_cache.pop(new_path, None)
                file_hashes.pop(new_path, None)
            updates["_file_hashes"] = file_hashes
            updates["_file_cache"] = file_cache

    return updates


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
    """Decide the next node after receiving a tool result.

    Fix 2 — Immediate convergence termination:
    If node_call_tool detected that the write was skipped (identical content),
    it sets _convergence_triggered=True. We route directly to already_satisfied
    here instead of re-entering node_reason, saving one full LLM call and
    preventing the "detect convergence → one more LLM round → abort" pattern.
    """
    # Immediate convergence: skip re-entering reason.
    convergence: bool = state.get("_convergence_triggered", False)  # type: ignore[call-overload]
    if convergence:
        logger.info(
            "route_after_result_convergence_immediate",
            step_id=state["ctx"].step_id,
        )
        return "already_satisfied"

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
