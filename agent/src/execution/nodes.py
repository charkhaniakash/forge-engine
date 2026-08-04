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

# The write/read tools the LLM may invoke. Used to normalize protocol variants
# where a model puts the tool name directly in the "action" field.
_TOOL_NAMES = frozenset({
    "read_file", "write_file", "create_file", "delete_file", "rename_file",
    "list_dir", "search_symbol", "exists", "stat",
})

# The recognized control actions (everything that is NOT a tool dispatch).
_CONTROL_ACTIONS = frozenset({
    "tool", "already_satisfied", "plan_deviation", "requires_human",
    "execution_error", "complete", "deviation",
})


def _normalize_action(action: dict) -> dict:
    """Rewrite common LLM protocol variations into the canonical action shape.

    The canonical tool-call shape is {"action": "tool", "tool": "<name>", "args": {...}}.
    Smaller / non-Gemini models frequently emit instead:
      {"action": "write_file", "tool": "write_file", "args": {...}}   (tool name in action)
      {"action": "write_file", "args": {...}}                          (no tool field)
    Left unhandled, route_after_reason does not match "tool" and silently routes
    to complete_step — the edit is dropped and the step ends with NO changes.
    This normalization makes the graph robust to any configured chat model.
    """
    if not isinstance(action, dict):
        return action
    act_val = action.get("action", "")
    # Case 1: action is a tool name → canonicalize to action="tool".
    if act_val in _TOOL_NAMES:
        if not action.get("tool"):
            action["tool"] = act_val
        action["action"] = "tool"
        return action
    # Case 2: action is missing/unknown but a valid tool field is present.
    if act_val not in _CONTROL_ACTIONS and action.get("tool") in _TOOL_NAMES:
        action["action"] = "tool"
    return action


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
    """Read affected files to populate retrieved_context before reasoning.

    Also seeds _file_cache and _file_hashes from the gathered content so that
    subsequent write_file calls can detect unchanged content (old_hash != null)
    and read_file calls can be served from cache without a round-trip to Go.
    """
    tool_client = _get_tool_client(state)
    context = await gather_context(state, tool_client)

    file_cache: dict = {}
    file_hashes: dict = {}
    for entry in context:
        if entry.get("exists") and entry.get("content"):
            path = entry["path"]
            content = entry["content"]
            file_cache[path] = content
            file_hashes[path] = _hash_content(content)

    return {
        "retrieved_context": context,
        "_file_cache": file_cache,
        "_file_hashes": file_hashes,
    }


# ── Node: reason ──────────────────────────────────────────────────────────────

def _hash_content(content: str) -> str:
    """Return a short SHA-256 hex digest of the given content string."""
    if content is None:
        content = ""
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def _detect_tool_repetition(tool_history: list[dict], window: int = 6) -> bool:
    """Return True if the last `window` tool calls are identical (same tool + same args).

    Window of 6 prevents false positives from legitimate patterns like:
      read_file A → read_file B → read_file A (gathering context across files)
    while still catching genuine loops where the agent re-reads the same file
    repeatedly without making progress.
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

    # Use a generous max_tokens so large file writes (CSS, JS, etc.) are never
    # truncated mid-JSON. 16384 tokens ~ 12000 words — enough for full-file
    # rewrites of large stylesheets, components, or config files.
    async for event in provider.stream(
        messages=messages,
        payload={"max_tokens": 16384},
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

    verify_required: bool = state.get("_verify_required", False)  # type: ignore[call-overload]
    if verify_required:
        # The LLM previously claimed already_satisfied without calling any tools.
        # Inject a hard challenge: it MUST call read_file explicitly and justify
        # why the runtime error cannot occur, or else fix the code.
        messages.append({
            "role": "user",
            "content": (
                "VERIFICATION REQUIRED — your previous 'already_satisfied' response was rejected.\n\n"
                "You claimed the step was already done without calling a single tool. "
                "The pre-loaded file context is NOT sufficient proof — you must actively verify.\n\n"
                f"The step involves these files: {step_files}\n\n"
                "You MUST now call read_file on each affected file and carefully check:\n"
                "1. Is the exact bug described in the step title actually absent from the code?\n"
                "2. Trace the full call path — not just 'the prop is passed' but WHY the runtime error cannot occur.\n"
                "3. If ANY doubt remains, make the fix.\n\n"
                "Respond with a read_file tool call to start your verification. "
                "Only respond with already_satisfied AFTER you have read the files AND "
                "can cite the exact line that proves the bug is absent."
            ),
        })
    else:
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
            action = _normalize_action(parsed)
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
            # Detect truncation: if the raw response is long and ends mid-JSON,
            # the LLM hit max_tokens. Tell it to use smaller file content.
            is_truncated = (
                len(raw) > 4000 and
                ("Expecting ',' delimiter" in parse_error or
                 "Extra data" in parse_error or
                 "Unterminated string" in parse_error or
                 raw.count("{") != raw.count("}"))
            )
            if is_truncated:
                parse_error = (
                    f"{parse_error}. "
                    "Your response was TRUNCATED because the file content was too large "
                    "for a single JSON response. Write the file in SMALLER sections: "
                    "first write_file with the top portion of the file, then do another "
                    "write_file with the complete content, or focus on changing only the "
                    "specific lines that need modification rather than rewriting the "
                    "entire file."
                )
            logger.warning(
                "node_reason_json_parse_failed",
                step_id=ctx.step_id,
                attempt=attempt,
                error=str(e),
                is_truncated=is_truncated,
                raw_length=len(raw),
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
    # Fallback: if the model put the tool name in "action" and omitted "tool"
    # (a variation _normalize_action already handles, but this guards any path).
    if not tool_name and action.get("action", "") in _TOOL_NAMES:
        tool_name = action["action"]
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
        content = tool_args.get("content") or ""
        # Guard: LLM may hallucinate null content — reject immediately.
        if not content:
            logger.warning(
                "node_call_tool_null_content_rejected",
                step_id=ctx.step_id,
                tool=tool_name,
                path=path,
            )
            rejected_result = ToolCallResult(
                tool=tool_name,
                success=False,
                result={"error": "content cannot be null or empty", "path": path},
                cached=False,
            )
            history_entry = {
                "request": {"action": "tool", "tool": tool_name, "args": tool_args},
                "result": rejected_result.model_dump(),
            }
            return {
                "tool_history": list(state["tool_history"]) + [history_entry],
                "latest_tool_result": rejected_result,
                "_pending_action": None,
            }
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
            content = tool_args.get("content") or ""
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

        elif tool_name == "read_file":
            # Cache the read content so repeated reads of the same file are free.
            # This is the primary fix for the read-loop bug: once the LLM reads a
            # file, subsequent read_file calls for the same path return instantly
            # from cache, so the tool_history grows but the content is stable.
            path = tool_args.get("path", "")
            content_val = result.result or {}
            if isinstance(content_val, dict):
                content_str = content_val.get("content", "")
            else:
                content_str = str(content_val)
            if path and content_str:
                file_cache[path] = content_str
                updates["_file_cache"] = file_cache
                logger.info(
                    "node_call_tool_read_cached",
                    step_id=ctx.step_id,
                    path=path,
                    content_len=len(content_str),
                )

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
    """Process the tool result — no LLM call, just routing logic.

    Returns the latest_tool_result explicitly so the LangGraph snapshot always
    has a non-empty update for this node, which ensures _emit_node_events can
    emit the tool_result event correctly (it reads from the update dict).
    Without this, the snapshot is `{"receive_result": {}}` and the pipeline
    logs `_emit_node_events_none_update`, dropping the tool_result stream event.
    """
    result: ToolCallResult | None = state.get("latest_tool_result")
    if result and not result.success:
        logger.warning(
            "tool_call_failed",
            tool=result.tool,
            error=result.error,
            step_id=state["ctx"].step_id,
        )
    # Return the result explicitly so the snapshot update is non-empty.
    # This keeps the tool_result event visible to the pipeline emitter.
    return {"latest_tool_result": result} if result is not None else {}


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

    Guardrail: if the LLM claimed already_satisfied without having called a
    SINGLE tool (i.e. it relied only on gather_context's pre-loaded files and
    never verified anything itself), we reject the claim and force one more
    reason pass with an explicit verification challenge. This prevents the
    common failure mode where the LLM reads pre-loaded context, decides the
    code "looks correct", and exits without actually fixing anything.
    """
    action: dict = state.get("_pending_action", {}) or {}
    if not isinstance(action, dict):
        action = {}
    summary = action.get("summary", "Desired state already exists — no changes required")

    tool_history = state.get("tool_history") or []
    if len(tool_history) == 0:
        # Premature claim — no tools called in the reason loop at all.
        # Force a verification pass: route_after_already_satisfied will redirect
        # back to reason with _verify_required=True so node_reason adds a
        # challenge message demanding explicit file reads.
        logger.warning(
            "already_satisfied_blocked_no_tools_called",
            step_id=state["ctx"].step_id,
            summary=summary,
        )
        return {
            "_verify_required": True,
            "_pending_action": None,
            "complete": False,
        }

    logger.info("step_already_satisfied",
                summary=summary, step_id=state["ctx"].step_id)
    return {
        "reasoning": (state.get("reasoning") or "") + "\n[already satisfied] " + summary,
        "complete": True,
        "_pending_action": None,
        "_verify_required": False,
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
    # Defense-in-depth: a tool-name that slipped through un-normalized still
    # dispatches as a tool call instead of silently completing with no changes.
    if a in _TOOL_NAMES or (a not in _CONTROL_ACTIONS and action.get("tool") in _TOOL_NAMES):
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
    # A failed tool call (e.g. read_file on a wrong path) is NOT a reason to end
    # the step doing nothing — let the model see the error and retry with a
    # corrected path (it has the directory listing to self-correct). The
    # repeated-tool and max-iteration guards in node_reason bound any looping,
    # and the model can still emit execution_error/requires_human itself if it
    # genuinely cannot proceed.
    if result and not result.success and result.error:
        logger.info(
            "route_after_result_tool_failed_retrying",
            step_id=state["ctx"].step_id,
            error=str(result.error)[:200],
        )
        return "reason"
    # Continue reasoning loop.
    return "reason"


def route_after_already_satisfied(state: ExecutionState) -> str:
    """Route after node_already_satisfied.

    Normally the step ends here (→ END). But if the LLM made a premature
    already_satisfied claim with zero tool calls, node_already_satisfied sets
    _verify_required=True and complete=False so we can redirect back to reason
    for one mandatory verification pass.
    """
    if state.get("_verify_required"):
        logger.info("already_satisfied_redirecting_to_verify", step_id=state["ctx"].step_id)
        return "reason"
    return "__end__"


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
        elif entry.get("exists") is False:
            # Missing planned file — tell the model, and show the real files in
            # that directory so it can pick the correct one (the planner often
            # gets the extension wrong, e.g. App.tsx vs App.jsx).
            path = entry.get("path", "")
            siblings = entry.get("siblings") or []
            note = f"// NOTE: {path} does not exist."
            if siblings:
                listing = ", ".join(siblings)
                note += (
                    f" Directory '{entry.get('dir', '.')}' actually contains: {listing}.\n"
                    f"// If one of these is the file the step means (e.g. a different extension), "
                    f"read and edit THAT file instead of assuming {path}."
                )
            else:
                note += " Create it if the step requires a new file."
            parts.append(note)
    return "\n\n".join(parts)
