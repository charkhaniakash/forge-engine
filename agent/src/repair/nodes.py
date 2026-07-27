"""
Phase 9 — RepairGraph nodes

Design contract:
    Nodes are pure reasoning functions: (state) → partial_state_update.
    They NEVER execute HTTP requests, call asyncio, or touch the filesystem.
    Tool execution is delegated to the pipeline via _pending_tool_call.

    Pipeline ↔ Graph interaction:
        1. Node sets _pending_tool_call = {tool, args, reasoning}
        2. Pipeline sees _pending_tool_call, emits tool_call event to Go
        3. Go executes the tool and sends back tool_result NDJSON event
        4. Pipeline injects result into _last_tool_result and resumes graph
        5. Routing node reads _last_tool_result and decides next node

    This is identical to the Phase 7 execution graph pattern and keeps
    LangGraph as a pure reasoning engine with zero I/O authority.

Node flow:
    START
      → gather_context          (LLM decides what to read; loop until satisfied)
      → [call_tool]             (pipeline executes; result injected)
      → [receive_context_result] (accumulate into retrieved_context)
      ↑─────────────────────────┘  (loop)
      → root_cause_analysis     (LLM analyses context; produces root_cause)
      → select_strategy         (LLM picks ONE strategy)
      → [cannot_repair]         (if confidence < threshold)
      → generate_fix            (LLM produces edit_plan; no I/O)
      → apply_fix               (drains edit_plan into _pending_tool_call)
      → [call_tool]             (pipeline executes write_file)
      → [receive_fix_result]    (record modified_files; loop for next edit)
      ↑─────────────────────────┘  (loop)
      → complete_repair
      END
"""
from __future__ import annotations

import json
import logging
from typing import Any

import structlog

logger = structlog.get_logger()

# Confidence below which we escalate immediately rather than attempt repair
CONFIDENCE_THRESHOLD = 0.30

# Maximum times to retry generate_fix when the LLM returns valid JSON but
# with an empty edits array (common after Gemini connection recovery — the
# retried call may produce structurally-valid JSON with zero actual edits).
_GENERATE_FIX_EMPTY_RETRIES = 3


# ── LLM helper ────────────────────────────────────────────────────────────────

_MAX_LLM_RETRIES = 4


async def _call_llm(messages: list[dict], ctx, request_tag: str) -> str:
    """Single LLM call. Returns raw string response, or empty string on error."""
    from src.llm.chat_factory import get_chat_provider

    provider = get_chat_provider()
    parts: list[str] = []
    had_error = False

    model_override = getattr(ctx, "model", None) or None

    async for event in provider.stream(
        messages=messages,
        payload={},
        request_id=f"repair-{ctx.repair_session_id[:8]}-{request_tag}",
        response_format={"type": "json_object"},
        model=model_override,
    ):
        if event and isinstance(event, dict):
            evt = event.get("event")
            if evt == "token":
                parts.append(event.get("text", ""))
            elif evt == "done":
                break
            elif evt == "error":
                # Return empty so the caller's retry loop kicks in, not partial garbage.
                logger.warning(
                    "llm_error_event",
                    request_tag=request_tag,
                    error=event.get("message", ""),
                )
                had_error = True
                break

    if had_error:
        return ""
    return "".join(parts).strip()


def _repair_truncated_json(raw: str) -> str:
    """
    Attempt to repair truncated JSON by appending missing closing brackets,
    braces, and quotes. The LLM stream is often cut off mid-response, leaving
    unclosed delimiters that make json.loads() fail.

    This handles the common case where the LLM produced complete key-value
    content but the final closing delimiters were cut off.
    """
    if not raw or raw.isspace():
        return raw

    stack: list[str] = []
    in_string = False
    escaped = False

    for ch in raw:
        if escaped:
            escaped = False
            continue
        if ch == '\\':
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in '{[':
            stack.append(ch)
        elif ch == '}':
            if stack and stack[-1] == '{':
                stack.pop()
            else:
                # Unmatched closing brace — might be noise, ignore
                pass
        elif ch == ']':
            if stack and stack[-1] == '[':
                stack.pop()
            else:
                pass

    # If at the end we're still inside a string, close it
    if in_string:
        raw += '"'

    # Append missing closing delimiters in reverse order
    closer = {'{': '}', '[': ']'}
    for delim in reversed(stack):
        raw += closer.get(delim, '')

    return raw


def _strip_fences(text: str) -> str:
    """Remove markdown code fences if LLM added them despite instructions."""
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]  # drop ``` or ```lang
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines)
    return text


async def _call_llm_with_retry(
    messages: list[dict],
    ctx,
    request_tag: str,
    max_retries: int = _MAX_LLM_RETRIES,
) -> str:
    """
    Call the LLM with retry logic and JSON repair.

    The LLM streaming API frequently returns truncated JSON because the
    connection closes mid-stream (network issues, token limits, rate limits).
    This helper:
      1. Calls the LLM
      2. Strips markdown fences
      3. Attempts JSON repair on truncated output (closes unclosed brackets)
      4. If parsing still fails, retries up to max_retries times
      5. Returns the raw string (repaired) on success, or empty on exhaustion
    """
    last_error = ""
    for attempt in range(max_retries):
        if attempt > 0:
            logger.info("llm_retry", request_tag=request_tag, attempt=attempt + 1, reason=last_error[:100])

        raw = await _call_llm(messages, ctx, request_tag)
        if not raw:
            last_error = "empty response"
            continue

        # Strip markdown fences before any parsing
        stripped = _strip_fences(raw)

        # Quick check: if it parses cleanly, return immediately
        try:
            json.loads(stripped)
            return stripped
        except json.JSONDecodeError:
            pass

        # Attempt JSON repair for truncated output
        repaired = _repair_truncated_json(stripped)
        try:
            json.loads(repaired)
            logger.info("llm_json_repaired", request_tag=request_tag, original_len=len(stripped), repaired_len=len(repaired))
            return repaired
        except json.JSONDecodeError as e:
            last_error = str(e)
            continue

    logger.warning("llm_retries_exhausted", request_tag=request_tag, error=last_error[:200])
    return ""


# ── System prompts ────────────────────────────────────────────────────────────

_GATHER_SYSTEM = """\
You are a code repair agent investigating a repository to understand a build/test failure.
You have access to workspace tools. Decide what to read next.

Available tools:
  read_file(path)              — read a source file
  search_symbol(pattern, dir)  — find where a symbol is defined or used
  list_dir(path)               — list directory contents

Respond with ONE of:
  {"action": "tool", "tool": "<name>", "args": {...}, "reasoning": "why"}
  {"action": "done", "summary": "what you now understand about the failure"}

IMPORTANT — path format:
  All paths must be RELATIVE to the workspace root. Do NOT use absolute paths.
  CORRECT:   "path": "src/App.tsx"
  CORRECT:   "path": "package.json"
  CORRECT:   "path": "."
  INCORRECT: "path": "/workspace/src/App.tsx"
  INCORRECT: "path": "/workspace"

Rules:
- Follow imports and dependencies — don't stop at the file named in the diagnostic
- Search for symbol definitions when you see an undefined-symbol error
- Read at most 8 files total before declaring done
- Do NOT read test files unless the diagnostic is inside a test
"""

_ROOT_CAUSE_SYSTEM = """\
You are a code repair agent performing root cause analysis.
Given repository context and diagnostics from multiple validation stages, analyse ALL failures.

Group the diagnostics by independent failure cause and classify each group.

Respond with JSON:
{
  "groups": [
    {
      "group_id": "lint_errors",
      "description": "<short description of this failure group>",
      "diagnostic_indices": [0, 1, 2],
      "root_cause": "<one sentence>",
      "root_cause_class": "code_error" | "dependency" | "environment" | "configuration" | "unknown",
      "repair_scope": "single_file" | "multi_file" | "too_large",
      "confidence": 0.0–1.0,
      "reasoning": "<explanation>"
    },
    ...
  ],
  "overall_reasoning": "<summary of what is repairable vs not>"
}

root_cause_class guide:
  code_error     — a bug or mistake in source files that can be fixed by editing code
  dependency     — an outdated, missing, or incompatible package/dependency
  environment    — a runtime, build toolchain, or configuration issue
  configuration  — missing scripts in package.json, wrong config values, build setup issues
  unknown        — cannot determine

Repair rules:
  Only "code_error" groups should be repaired by editing source files.
  "dependency", "environment", "configuration" groups cannot be fixed by editing code.
  If repair_scope is "too_large", treat the group as non-repairable.

Confidence guide:
  0.9+ — obvious syntactic/type error with a clear fix
  0.7   — logic error with a likely fix
  0.5   — unclear root cause, repair is a guess
  < 0.3 — should escalate to human
"""

_STRATEGY_SYSTEM = """\
You are a code repair agent selecting a repair strategy.
Given root cause analysis and previous attempts, select ONE strategy.

Available strategies:
  targeted_fix    — minimal surgical change at the exact error location
  minimal_rewrite — small refactor of the affected function/block

Respond with JSON:
{
  "strategy": "targeted_fix" | "minimal_rewrite" | "cannot_repair",
  "confidence": 0.0–1.0,
  "reasoning": "<why this strategy>",
  "cannot_repair_reason": "<only if cannot_repair>"
}

Rules:
- If a previous attempt used targeted_fix and failed, try minimal_rewrite
- If both strategies were tried and failed, use cannot_repair
- If repair_scope is "too_large", use cannot_repair
- Never suggest adding test-disabling comments or build config changes
"""

_GENERATE_FIX_SYSTEM = """\
You are a code repair agent generating minimal file edits.
Produce the MINIMUM change required to fix the identified error.

STRICT CONSTRAINTS:
- NEVER modify test files
- NEVER disable linting rules or add suppression comments
- NEVER change build configuration to bypass failures
- NEVER add TODO placeholders
- Output ONLY complete file content for files that must change

Respond with JSON:
{
  "edits": [
    {"path": "relative/path/to/file.ext", "content": "<complete new file content>"},
    ...
  ],
  "explanation": "<one sentence describing the change>"
}

Only include files that actually need to change.
"""


# ── Node: gather_context ──────────────────────────────────────────────────────

async def gather_context(state: dict) -> dict:
    """
    Reasoning loop: LLM decides which files/symbols to read next.

    The node does NOT execute tool calls itself. Instead it sets
    _pending_tool_call for the pipeline to execute, then resumes
    when _last_tool_result is injected.

    Loop termination:
        - LLM responds {"action": "done"} when it has enough context
        - _gather_iteration reaches _max_gather_iterations
    """
    ctx = state["ctx"]
    diagnostics = state["diagnostics"]
    retrieved_context: list = list(state.get("retrieved_context") or [])
    file_cache: dict = dict(state.get("_file_cache") or {})
    iteration: int = state.get("_gather_iteration", 0)
    max_iter: int = state.get("_max_gather_iterations", 8)

    # Build context block from what we have so far
    context_block = _format_context_for_llm(retrieved_context)

    diag_text = _format_diagnostics(diagnostics)
    diag_paths = _extract_diagnostic_paths(diagnostics)
    paths_hint = ""
    if diag_paths:
        paths_hint = (
            "\nFiles mentioned in diagnostics (use EXACTLY these paths):\n  "
            + "\n  ".join(diag_paths)
            + "\n\n"
        )

    messages = [
        {"role": "system", "content": _GATHER_SYSTEM},
        {"role": "user", "content": (
            f"Diagnostics:\n{diag_text}\n\n"
            + paths_hint
            + (f"Files read so far:\n{context_block}\n\n" if context_block else "")
            + f"Iteration {iteration + 1} of {max_iter}. What should you read next?"
        )},
    ]

    raw = await _call_llm_with_retry(messages, ctx, f"gather-{iteration}")

    if not raw:
        logger.warning("gather_context_retries_exhausted")
        # Bail out of gather loop; proceed with what we have
        return {"_gather_iteration": max_iter}

    try:
        action = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("gather_context_json_parse_failed", raw=raw[:200])
        # Bail out of gather loop; proceed with what we have
        return {"_gather_iteration": max_iter}

    if action.get("action") == "done" or iteration >= max_iter - 1:
        logger.info("gather_context_done",
                    iteration=iteration, summary=action.get("summary", ""))
        return {
            "retrieved_context": retrieved_context,
            "reasoning": (state.get("reasoning") or "") + f"\n[gather] {action.get('summary', 'context gathered')}",
            "_gather_iteration": max_iter,  # signal loop exit
            "_file_cache": file_cache,
        }

    # Tool call requested — delegate to pipeline
    if action.get("action") == "tool":
        args = action.get("args", {})
        # Normalize path: strip leading /workspace/ prefix if the LLM added it.
        # WorkspaceManager prepends /workspace/ itself — a double prefix causes
        # "find: /workspace/workspace: No such file or directory".
        if "path" in args:
            p = args["path"]
            if isinstance(p, str):
                # Strip any /workspace prefix the LLM may have added
                for prefix in ("/workspace/", "/workspace"):
                    if p.startswith(prefix):
                        p = p[len(prefix):] or "."
                        break
                args = {**args, "path": p}
        if "dir" in args:
            d = args["dir"]
            if isinstance(d, str):
                for prefix in ("/workspace/", "/workspace"):
                    if d.startswith(prefix):
                        d = d[len(prefix):] or "."
                        break
                args = {**args, "dir": d}
        return {
            "retrieved_context": retrieved_context,
            "_gather_iteration": iteration + 1,
            "_file_cache": file_cache,
            "_pending_tool_call": {
                "tool": action["tool"],
                "args": args,
                "reasoning": action.get("reasoning", ""),
            },
        }

    # Unknown action — stop gathering
    return {"_gather_iteration": max_iter}


# ── Node: receive_context_result ──────────────────────────────────────────────

async def receive_context_result(state: dict) -> dict:
    """
    Accumulates one tool result into retrieved_context.
    Clears _pending_tool_call and _last_tool_result.
    Routing decides whether to loop back to gather_context or continue.
    """
    result = state.get("_last_tool_result") or {}
    retrieved_context: list = list(state.get("retrieved_context") or [])
    file_cache: dict = dict(state.get("_file_cache") or {})

    tool = result.get("tool", "")
    success = result.get("success", False)
    data = result.get("result") or {}

    if success:
        if tool == "read_file":
            path = data.get("path") or result.get("args", {}).get("path", "")
            content = data.get("content", "")
            file_cache[path] = content
            retrieved_context.append({
                "type": "file",
                "path": path,
                "content": content,
            })
            logger.info("gather_read_file_ok", path=path)

        elif tool == "search_symbol":
            matches = data.get("matches", [])
            retrieved_context.append({
                "type": "symbol_search",
                "matches": matches,
            })
            logger.info("gather_search_symbol_ok", match_count=len(matches))

        elif tool == "list_dir":
            entries = data.get("entries", [])
            path = result.get("args", {}).get("path", ".")
            retrieved_context.append({
                "type": "dir_listing",
                "path": path,
                "entries": entries,
            })
    else:
        logger.warning("gather_tool_failed", tool=tool, error=result.get("error"))

    return {
        "retrieved_context": retrieved_context,
        "_file_cache": file_cache,
        "_pending_tool_call": None,
        "_last_tool_result": None,
    }


# ── Node: root_cause_analysis ─────────────────────────────────────────────────

async def root_cause_analysis(state: dict) -> dict:
    """
    Pure LLM reasoning: groups ALL diagnostics by failure cause, classifies
    each group as repairable (code_error) or non-repairable, and filters to
    only the repairable diagnostics.

    Key behaviours:
    - Analyses ALL diagnostics, not just the first failure.
    - Non-repairable groups (dependency, environment, configuration) are silently
      dropped — the graph only attempts to fix code_error groups.
    - If NO repairable groups exist → escalate with a clear reason.
    - If SOME groups are repairable → continue with only those diagnostics.
    - Confidence is the average across all repairable groups.

    This node has NO I/O.
    """
    ctx = state["ctx"]
    diagnostics = state["diagnostics"]
    retrieved_context = state.get("retrieved_context") or []
    previous_attempts = state.get("previous_attempt_summaries") or []

    context_block = _format_context_for_llm(retrieved_context)
    diag_text = _format_diagnostics_indexed(diagnostics)
    prev_text = _format_previous_attempts(previous_attempts)

    messages = [
        {"role": "system", "content": _ROOT_CAUSE_SYSTEM},
        {"role": "user", "content": (
            f"Diagnostics (indexed):\n{diag_text}\n\n"
            f"Repository context:\n{context_block}\n\n"
            + (f"Previous repair attempts:\n{prev_text}\n\n" if prev_text else "")
            + "Analyse ALL failures and group them."
        )},
    ]

    raw = await _call_llm_with_retry(messages, ctx, "root-cause")

    if not raw:
        logger.warning("root_cause_retries_exhausted")
        return {
            "root_cause": "Could not parse root cause analysis (retries exhausted)",
            "confidence": 0.5,
            "reasoning": (state.get("reasoning") or "") + "\n[root_cause] retries exhausted",
        }

    try:
        analysis = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("root_cause_json_parse_failed", raw=raw[:200])
        return {
            "root_cause": "Could not parse root cause analysis",
            "confidence": 0.5,
            "reasoning": (state.get("reasoning") or "") + "\n[root_cause] parse failed",
        }

    groups = analysis.get("groups", [])
    overall_reasoning = analysis.get("overall_reasoning", "")

    if not groups:
        # Fallback: treat all diagnostics as a single unknown group
        return {
            "root_cause": "Unknown failure — could not group diagnostics",
            "confidence": 0.5,
            "reasoning": (state.get("reasoning") or "") + "\n[root_cause] no groups produced",
        }

    # Separate repairable groups (code_error only) from non-repairable
    repairable_groups = []
    skipped_groups = []
    for g in groups:
        cls = g.get("root_cause_class", "unknown")
        scope = g.get("repair_scope", "single_file")
        confidence = float(g.get("confidence", 0.5))
        if cls == "code_error" and scope != "too_large" and confidence >= CONFIDENCE_THRESHOLD:
            repairable_groups.append(g)
        else:
            skipped_groups.append(g)

    logger.info("root_cause_analysis_groups",
                total=len(groups),
                repairable=len(repairable_groups),
                skipped=len(skipped_groups))

    if not repairable_groups:
        # Every group is non-repairable
        skip_reasons = "; ".join(
            f"{g.get('group_id','?')}: {g.get('root_cause_class','?')} — {g.get('root_cause','?')}"
            for g in skipped_groups
        )
        logger.info("root_cause_all_non_repairable", reason=skip_reasons)
        return {
            "root_cause": "All failures are non-repairable by source code edits",
            "confidence": 0.0,
            "cannot_repair": True,
            "cannot_repair_reason": (
                f"No repairable source-code defects found. "
                f"Skipped groups: {skip_reasons}"
            ),
            "reasoning": (state.get("reasoning") or "") + f"\n[root_cause] all non-repairable: {skip_reasons}",
        }

    # Collect only diagnostics from repairable groups
    repairable_indices: set[int] = set()
    for g in repairable_groups:
        for idx in g.get("diagnostic_indices", []):
            if isinstance(idx, int) and 0 <= idx < len(diagnostics):
                repairable_indices.add(idx)

    if repairable_indices:
        repairable_diagnostics = [diagnostics[i] for i in sorted(repairable_indices)]
    else:
        # Group indices were missing or out of range — use all diagnostics
        repairable_diagnostics = diagnostics

    # Combined root cause from all repairable groups
    combined_root_cause = "; ".join(g.get("root_cause", "") for g in repairable_groups)
    avg_confidence = sum(float(g.get("confidence", 0.5)) for g in repairable_groups) / len(repairable_groups)

    skipped_summary = ""
    if skipped_groups:
        skipped_summary = " Skipped (non-repairable): " + ", ".join(
            f"{g.get('group_id','?')}({g.get('root_cause_class','?')})"
            for g in skipped_groups
        )

    logger.info("root_cause_analysis_complete",
                root_cause=combined_root_cause,
                confidence=avg_confidence,
                repairable_diags=len(repairable_diagnostics))

    return {
        "root_cause": combined_root_cause,
        "confidence": avg_confidence,
        # Replace diagnostics with only the repairable subset
        "diagnostics": repairable_diagnostics,
        "reasoning": (
            (state.get("reasoning") or "")
            + f"\n[root_cause] {combined_root_cause} (confidence={avg_confidence:.2f})"
            + skipped_summary
        ),
    }


# ── Node: select_strategy ─────────────────────────────────────────────────────

async def select_strategy(state: dict) -> dict:
    """
    Pure LLM reasoning: picks ONE repair strategy for this attempt.

    Reads root_cause + confidence + previous_attempt_summaries and outputs
    strategy. No I/O.
    """
    ctx = state["ctx"]
    root_cause = state.get("root_cause", "")
    confidence = float(state.get("confidence", 0.5))
    previous_attempts = state.get("previous_attempt_summaries") or []
    diagnostics = state["diagnostics"]

    # Below threshold → escalate without asking LLM
    if confidence < CONFIDENCE_THRESHOLD:
        logger.info("select_strategy_low_confidence", confidence=confidence)
        return {
            "strategy": "cannot_repair",
            "cannot_repair": True,
            "cannot_repair_reason": f"Confidence too low to attempt autonomous repair ({confidence:.2f})",
        }

    diag_text = _format_diagnostics(diagnostics)
    prev_text = _format_previous_attempts(previous_attempts)

    messages = [
        {"role": "system", "content": _STRATEGY_SYSTEM},
        {"role": "user", "content": (
            f"Root cause: {root_cause}\n"
            f"Current confidence: {confidence:.2f}\n\n"
            f"Diagnostics:\n{diag_text}\n\n"
            + (f"Previous attempts:\n{prev_text}\n\n" if prev_text else "")
            + "Select ONE repair strategy."
        )},
    ]

    raw = await _call_llm_with_retry(messages, ctx, "strategy")

    if not raw:
        logger.warning("select_strategy_retries_exhausted")
        return {
            "strategy": "cannot_repair",
            "cannot_repair": True,
            "cannot_repair_reason": "Strategy selection retries exhausted",
        }

    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("select_strategy_json_parse_failed", raw=raw[:200])
        return {
            "strategy": "cannot_repair",
            "cannot_repair": True,
            "cannot_repair_reason": "Strategy selection parse failed",
        }

    strategy = result.get("strategy", "cannot_repair")
    new_confidence = float(result.get("confidence", confidence))
    reasoning = result.get("reasoning", "")
    cannot_repair_reason = result.get("cannot_repair_reason", "")

    logger.info("select_strategy_complete", strategy=strategy, confidence=new_confidence)

    return {
        "strategy": strategy,
        "confidence": new_confidence,
        "cannot_repair": strategy == "cannot_repair",
        "cannot_repair_reason": cannot_repair_reason,
        "reasoning": (state.get("reasoning") or "") + f"\n[strategy] {strategy} ({reasoning})",
    }


# ── Node: cannot_repair ───────────────────────────────────────────────────────

async def cannot_repair(state: dict) -> dict:
    """
    Terminal escalation node. Signals Go to stop repair and surface to user.
    Sets complete=True so the pipeline emits cannot_repair event.
    """
    reason = state.get("cannot_repair_reason", "Repair not possible")
    logger.info("cannot_repair", reason=reason)
    return {
        "complete": True,
        "repair_summary": f"Cannot repair: {reason}",
    }


def _strip_workspace_prefix(path: str) -> str:
    """Normalize an edit path to be RELATIVE to the workspace root.

    The LLM occasionally emits an absolute "/workspace/..." path despite the
    prompt. The backend's WriteFile prepends "/workspace/" itself, so an absolute
    path would double into "/workspace/workspace/..." and the write would fail.
    The read/gather path already strips this; do the same for fix edits so the
    bad path never reaches the backend (defense-in-depth alongside the backend's
    own containerPath guard).
    """
    if not isinstance(path, str):
        return path
    for prefix in ("/workspace/", "/workspace"):
        if path.startswith(prefix):
            return path[len(prefix):].lstrip("/")
    return path


# ── Node: generate_fix ────────────────────────────────────────────────────────

async def generate_fix(state: dict) -> dict:
    """
    Pure LLM reasoning: generates an edit_plan (list of {path, content}).

    This node has NO I/O. It only reads state and returns edit_plan.
    The pipeline does not execute tools at this stage.
    apply_fix drains edit_plan into _pending_tool_call entries.
    """
    ctx = state["ctx"]
    diagnostics = state["diagnostics"]
    retrieved_context = state.get("retrieved_context") or []
    root_cause = state.get("root_cause", "")
    strategy = state.get("strategy", "targeted_fix")

    context_block = _format_context_for_llm(retrieved_context)
    diag_text = _format_diagnostics(diagnostics)
    diag_paths = _extract_diagnostic_paths(diagnostics)
    paths_hint = ""
    if diag_paths:
        paths_hint = (
            "\nIMPORTANT — use EXACTLY these file paths from the diagnostics "
            "(do NOT guess extensions like .tsx vs .jsx):\n  "
            + "\n  ".join(diag_paths)
            + "\n\n"
        )

    messages = [
        {"role": "system", "content": _GENERATE_FIX_SYSTEM},
        {"role": "user", "content": (
            f"Strategy: {strategy}\n"
            f"Root cause: {root_cause}\n\n"
            f"Diagnostics:\n{diag_text}\n\n"
            + paths_hint
            + f"Repository context:\n{context_block}\n\n"
            "Generate the minimal edit plan to fix this."
        )},
    ]

    # Retry loop: the LLM may return valid JSON with an empty edits array if
    # the connection was flaky (Gemini API disconnections are common) and the
    # retried call produced a structurally-valid-but-empty response. We retry
    # the LLM call when edits are empty (up to _GENERATE_FIX_EMPTY_RETRIES)
    # before giving up. On retry we append a feedback message so the model
    # knows why it's being re-asked instead of silently repeating itself.
    valid_edits = []
    explanation = ""
    last_attempt_reason = ""
    last_raw = ""
    active_messages = messages

    for attempt in range(_GENERATE_FIX_EMPTY_RETRIES):
        if attempt > 0:
            logger.info(
                "generate_fix_empty_edits_retry",
                attempt=attempt + 1,
                reason=last_attempt_reason,
            )
            # Tell the LLM why the previous attempt failed so it can self-correct.
            feedback = (
                f"Your previous response was not usable: {last_attempt_reason}. "
                "Please respond with a valid JSON object containing an 'edits' array. "
                "Each edit MUST have 'path' (relative to workspace root, e.g. 'src/App.tsx') "
                "and 'content' (the complete new file content as a string). "
                "Do not return an empty edits array."
            )
            active_messages = active_messages + [
                {"role": "assistant", "content": last_raw or "{}"},
                {"role": "user", "content": feedback},
            ]

        raw = await _call_llm_with_retry(active_messages, ctx, f"generate-fix-{attempt}")
        last_raw = raw

        if not raw:
            last_attempt_reason = "empty response after retries"
            continue

        try:
            result = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            last_attempt_reason = f"JSON parse failed: {raw[:100]}"
            continue

        edits = result.get("edits", [])
        explanation = result.get("explanation", "")

        # Validate edits — must have path and content — and normalize each path
        # to be workspace-relative so apply_fix, receive_fix_result, and
        # modified_files all carry clean paths.
        valid_edits = [
            {**e, "path": _strip_workspace_prefix(e["path"])}
            for e in edits
            if isinstance(e, dict) and e.get("path") and e.get("content") is not None
        ]

        if valid_edits:
            break  # Got real edits — exit retry loop

        last_attempt_reason = f"no valid edits in response (edits={len(edits)}, valid={len(valid_edits)})"

    if not valid_edits:
        logger.warning(
            "generate_fix_empty_edits_exhausted",
            reason=last_attempt_reason,
        )
        return {
            "edit_plan": [],
            "cannot_repair": True,
            "cannot_repair_reason": f"LLM produced no valid file edits: {last_attempt_reason}",
        }

    logger.info("generate_fix_complete", edit_count=len(valid_edits), explanation=explanation)

    return {
        "edit_plan": valid_edits,
        "_apply_index": 0,
        "reasoning": (state.get("reasoning") or "") + f"\n[generate_fix] {explanation} ({len(valid_edits)} edits)",
    }


# ── Node: apply_fix ───────────────────────────────────────────────────────────

async def apply_fix(state: dict) -> dict:
    """
    Drains one entry from edit_plan into _pending_tool_call.

    The pipeline executes the tool call, injects _last_tool_result, and
    routes back here (via receive_fix_result) until edit_plan is exhausted.

    This node sets exactly one _pending_tool_call per invocation.
    """
    edit_plan: list = list(state.get("edit_plan") or [])
    apply_index: int = state.get("_apply_index", 0)

    if apply_index >= len(edit_plan):
        # All edits applied — proceed to complete_repair
        return {"_pending_tool_call": None}

    edit = edit_plan[apply_index]
    path = edit["path"]
    content = edit["content"]

    # Check if file exists to decide write_file vs create_file
    # We use write_file as default; Go handles create-or-overwrite at the workspace layer
    tool = "write_file"

    logger.info("apply_fix_enqueue", path=path, edit_index=apply_index)

    return {
        "_pending_tool_call": {
            "tool": tool,
            "args": {"path": path, "content": content},
            "reasoning": f"Applying fix edit {apply_index + 1}/{len(edit_plan)}: {path}",
        },
        # _apply_index is advanced by receive_fix_result after tool completes
    }


# ── Node: receive_fix_result ──────────────────────────────────────────────────

async def receive_fix_result(state: dict) -> dict:
    """
    Records the result of one write_file tool call.
    Advances _apply_index and updates modified_files + confidence.
    Routing loops back to apply_fix until edit_plan is exhausted.

    If the write fails with a non-retryable error (e.g. DB constraint),
    escalate immediately rather than continuing to drain the edit plan.
    """
    result = state.get("_last_tool_result") or {}
    apply_index: int = state.get("_apply_index", 0)
    modified_files: list = list(state.get("modified_files") or [])
    confidence: float = float(state.get("confidence", 0.5))

    success = result.get("success", False)
    error = result.get("error")

    # Determine the path from the edit_plan
    edit_plan = state.get("edit_plan") or []
    path = ""
    if apply_index < len(edit_plan):
        path = edit_plan[apply_index].get("path", "")

    if success:
        if path and path not in modified_files:
            modified_files.append(path)
        logger.info("apply_fix_write_ok", path=path)
    else:
        # Lower confidence on write failure
        confidence = max(0.0, confidence - 0.15)
        logger.warning("apply_fix_write_failed", path=path, error=error, new_confidence=confidence)

        # If confidence has dropped below threshold after a failed write,
        # escalate immediately — repeated failures won't improve.
        if confidence < 0.15:
            logger.warning("apply_fix_escalating_after_failures",
                          path=path, error=error, confidence=confidence)
            return {
                "modified_files": modified_files,
                "confidence": confidence,
                "_apply_index": apply_index + 1,
                "_pending_tool_call": None,
                "_last_tool_result": None,
                "cannot_repair": True,
                "cannot_repair_reason": f"File write failed and confidence dropped too low: {error}",
            }

    return {
        "modified_files": modified_files,
        "confidence": confidence,
        "_apply_index": apply_index + 1,
        "_pending_tool_call": None,
        "_last_tool_result": None,
    }


# ── Node: complete_repair ─────────────────────────────────────────────────────

async def complete_repair(state: dict) -> dict:
    """
    Terminal success node. Builds the final summary and signals completion.
    """
    strategy = state.get("strategy", "unknown")
    confidence = state.get("confidence", 0.0)
    modified_files = state.get("modified_files") or []
    root_cause = state.get("root_cause", "")

    summary = (
        f"Repair complete: {strategy} strategy applied "
        f"{len(modified_files)} file(s) fixed. "
        f"Root cause: {root_cause}. "
        f"Confidence: {confidence:.2f}"
    )
    logger.info("complete_repair", strategy=strategy, files=len(modified_files), confidence=confidence)

    return {
        "complete": True,
        "repair_summary": summary,
    }


# ── Routing functions ─────────────────────────────────────────────────────────

def route_gather_loop(state: dict) -> str:
    """
    After gather_context or receive_context_result:
    - If _pending_tool_call is set  → pipeline must execute it (route to call_tool_gather)
    - If gather loop is done        → proceed to root_cause_analysis
    """
    if state.get("_pending_tool_call"):
        return "call_tool_gather"
    iteration = state.get("_gather_iteration", 0)
    max_iter = state.get("_max_gather_iterations", 8)
    if iteration < max_iter:
        return "gather_context"
    return "root_cause_analysis"


def route_after_root_cause(state: dict) -> str:
    """After root_cause_analysis: escalate on non-code causes, low confidence, or cannot_repair flag."""
    # Explicit escalation set by root_cause_analysis (e.g. dependency/environment class)
    if state.get("cannot_repair", False):
        return "escalate_repair"
    confidence = float(state.get("confidence", 0.5))
    if confidence < CONFIDENCE_THRESHOLD:
        return "escalate_repair"
    return "select_strategy"


def route_after_strategy(state: dict) -> str:
    """After select_strategy: if cannot_repair flag is set → escalate_repair, else generate_fix."""
    if state.get("cannot_repair", False):
        return "escalate_repair"
    return "generate_fix"


def route_after_generate(state: dict) -> str:
    """After generate_fix: if escalating → escalate_repair, else apply_fix."""
    if state.get("cannot_repair", False):
        return "escalate_repair"
    edit_plan = state.get("edit_plan") or []
    if not edit_plan:
        return "escalate_repair"
    return "apply_fix"


def route_apply_loop(state: dict) -> str:
    """
    After apply_fix or receive_fix_result:
    - If cannot_repair was set (e.g. DB failure threshold) → escalate immediately
    - If _pending_tool_call is set → pipeline executes the write_file
    - If all edits applied        → complete_repair
    - Else                        → apply_fix (next edit)
    """
    if state.get("cannot_repair", False):
        return "escalate_repair"
    if state.get("_pending_tool_call"):
        return "call_tool_fix"
    apply_index = state.get("_apply_index", 0)
    edit_plan = state.get("edit_plan") or []
    if apply_index < len(edit_plan):
        return "apply_fix"
    return "complete_repair"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_diagnostic_paths(diagnostics: list) -> list[str]:
    """Extract unique, non-empty file paths from diagnostics in order."""
    seen: set[str] = set()
    paths: list[str] = []
    for d in diagnostics:
        p = d.get("file_path", "")
        if p and p not in seen:
            seen.add(p)
            paths.append(p)
    return paths


def _format_diagnostics(diagnostics: list) -> str:
    parts = []
    for d in diagnostics:
        line = d.get("line_number", "?")
        sev = d.get("severity", "error")
        msg = d.get("message", "")
        path = d.get("file_path", "")
        parts.append(f"  {path}:{line} [{sev}] {msg}")
    return "\n".join(parts) if parts else "(none)"


def _format_diagnostics_indexed(diagnostics: list) -> str:
    """Format diagnostics with 0-based index so the LLM can reference them by index."""
    parts = []
    for i, d in enumerate(diagnostics):
        line = d.get("line_number", "?")
        sev = d.get("severity", "error")
        msg = d.get("message", "")
        path = d.get("file_path", "")
        stage = d.get("stage", "")
        parts.append(f"  [{i}] {stage} {path}:{line} [{sev}] {msg}")
    return "\n".join(parts) if parts else "(none)"


def _format_context_for_llm(retrieved_context: list) -> str:
    parts = []
    for entry in retrieved_context:
        kind = entry.get("type")
        if kind == "file":
            path = entry.get("path", "")
            content = entry.get("content") or ""
            if content:
                parts.append(f"// File: {path}\n```\n{content[:4000]}\n```")
        elif kind == "symbol_search":
            matches = entry.get("matches", [])
            if matches:
                lines = [f"  {m.get('file_path', '')}:{m.get('line', '')} — {m.get('preview', '')}"
                         for m in matches[:10]]
                parts.append("// Symbol search results:\n" + "\n".join(lines))
        elif kind == "dir_listing":
            path = entry.get("path", ".")
            entries = entry.get("entries", [])
            names = [e.get("name", "") for e in entries[:20]]
            parts.append(f"// Directory: {path}\n  {', '.join(names)}")
    return "\n\n".join(parts) if parts else "(no context yet)"


def _format_previous_attempts(previous_attempts: list) -> str:
    if not previous_attempts:
        return ""
    parts = []
    for att in previous_attempts:
        num = att.get("attempt_number", "?")
        strategy = att.get("strategy", "?")
        outcome = att.get("outcome", "?")
        parts.append(f"  Attempt {num}: strategy={strategy} outcome={outcome}")
    return "\n".join(parts)
