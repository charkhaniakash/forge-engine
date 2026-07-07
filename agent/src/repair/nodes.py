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


# ── LLM helper ────────────────────────────────────────────────────────────────

async def _call_llm(messages: list[dict], ctx, request_tag: str) -> str:
    """Single LLM call. Returns raw string response."""
    from src.llm.chat_factory import get_chat_provider

    provider = get_chat_provider()
    parts: list[str] = []

    async for event in provider.stream(
        messages=messages,
        payload={},
        request_id=f"repair-{ctx.repair_session_id[:8]}-{request_tag}",
        response_format={"type": "json_object"},
    ):
        if event and isinstance(event, dict):
            evt = event.get("event")
            if evt == "token":
                parts.append(event.get("text", ""))
            elif evt in ("done", "error"):
                break

    return "".join(parts).strip()


def _strip_fences(text: str) -> str:
    """Remove markdown code fences if LLM added them despite instructions."""
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]  # drop ``` or ```lang
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines)
    return text


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

Rules:
- Follow imports and dependencies — don't stop at the file named in the diagnostic
- Search for symbol definitions when you see an undefined-symbol error
- Read at most 8 files total before declaring done
- Do NOT read test files unless the diagnostic is inside a test
"""

_ROOT_CAUSE_SYSTEM = """\
You are a code repair agent performing root cause analysis.
Given repository context and diagnostics, identify the true root cause.

Respond with JSON:
{
  "root_cause": "<one sentence describing the true cause>",
  "affected_components": ["file_or_symbol", ...],
  "repair_scope": "single_file" | "multi_file" | "too_large",
  "confidence": 0.0–1.0,
  "reasoning": "<detailed explanation>"
}

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

    messages = [
        {"role": "system", "content": _GATHER_SYSTEM},
        {"role": "user", "content": (
            f"Diagnostics:\n{diag_text}\n\n"
            + (f"Files read so far:\n{context_block}\n\n" if context_block else "")
            + f"Iteration {iteration + 1} of {max_iter}. What should you read next?"
        )},
    ]

    raw = await _call_llm(messages, ctx, f"gather-{iteration}")

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
        return {
            "retrieved_context": retrieved_context,
            "_gather_iteration": iteration + 1,
            "_file_cache": file_cache,
            "_pending_tool_call": {
                "tool": action["tool"],
                "args": action.get("args", {}),
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
    Pure LLM reasoning: analyses retrieved_context + diagnostics and produces
    a structured root cause summary and updated confidence.

    This node has NO I/O. It only reads state and returns updated reasoning fields.
    """
    ctx = state["ctx"]
    diagnostics = state["diagnostics"]
    retrieved_context = state.get("retrieved_context") or []
    previous_attempts = state.get("previous_attempt_summaries") or []

    context_block = _format_context_for_llm(retrieved_context)
    diag_text = _format_diagnostics(diagnostics)
    prev_text = _format_previous_attempts(previous_attempts)

    messages = [
        {"role": "system", "content": _ROOT_CAUSE_SYSTEM},
        {"role": "user", "content": (
            f"Diagnostics:\n{diag_text}\n\n"
            f"Repository context:\n{context_block}\n\n"
            + (f"Previous repair attempts:\n{prev_text}\n\n" if prev_text else "")
            + "Analyse the root cause."
        )},
    ]

    raw = await _call_llm(messages, ctx, "root-cause")

    try:
        analysis = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("root_cause_json_parse_failed", raw=raw[:200])
        return {
            "root_cause": "Could not parse root cause analysis",
            "confidence": 0.5,
            "reasoning": (state.get("reasoning") or "") + "\n[root_cause] parse failed",
        }

    root_cause = analysis.get("root_cause", "Unknown")
    confidence = float(analysis.get("confidence", 0.5))
    repair_scope = analysis.get("repair_scope", "single_file")
    explanation = analysis.get("reasoning", "")

    # Scope too large → escalate immediately
    if repair_scope == "too_large":
        confidence = 0.0

    logger.info("root_cause_analysis_complete",
                root_cause=root_cause, confidence=confidence, scope=repair_scope)

    return {
        "root_cause": root_cause,
        "confidence": confidence,
        "reasoning": (state.get("reasoning") or "") + f"\n[root_cause] {root_cause} (confidence={confidence:.2f})",
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

    raw = await _call_llm(messages, ctx, "strategy")

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

    messages = [
        {"role": "system", "content": _GENERATE_FIX_SYSTEM},
        {"role": "user", "content": (
            f"Strategy: {strategy}\n"
            f"Root cause: {root_cause}\n\n"
            f"Diagnostics:\n{diag_text}\n\n"
            f"Repository context:\n{context_block}\n\n"
            "Generate the minimal edit plan to fix this."
        )},
    ]

    raw = await _call_llm(messages, ctx, "generate-fix")

    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("generate_fix_json_parse_failed", raw=raw[:200])
        return {
            "edit_plan": [],
            "cannot_repair": True,
            "cannot_repair_reason": "Fix generation parse failed",
        }

    edits = result.get("edits", [])
    explanation = result.get("explanation", "")

    # Validate edits — must have path and content
    valid_edits = [
        e for e in edits
        if isinstance(e, dict) and e.get("path") and e.get("content") is not None
    ]

    if not valid_edits:
        return {
            "edit_plan": [],
            "cannot_repair": True,
            "cannot_repair_reason": "LLM produced no valid file edits",
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
    """
    result = state.get("_last_tool_result") or {}
    apply_index: int = state.get("_apply_index", 0)
    modified_files: list = list(state.get("modified_files") or [])
    confidence: float = float(state.get("confidence", 0.5))

    success = result.get("success", False)
    data = result.get("result") or {}
    error = result.get("error")

    # Determine the path from the edit_plan (not the tool result, which may omit it)
    edit_plan = state.get("edit_plan") or []
    path = ""
    if apply_index < len(edit_plan):
        path = edit_plan[apply_index].get("path", "")

    if success:
        if path and path not in modified_files:
            modified_files.append(path)
        logger.info("apply_fix_write_ok", path=path)
    else:
        # Write failed — lower confidence
        confidence = max(0.0, confidence - 0.15)
        logger.warning("apply_fix_write_failed", path=path, error=error, new_confidence=confidence)

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
    """After root_cause_analysis: low confidence → cannot_repair, else select_strategy."""
    confidence = float(state.get("confidence", 0.5))
    if confidence < CONFIDENCE_THRESHOLD:
        return "cannot_repair"
    return "select_strategy"


def route_after_strategy(state: dict) -> str:
    """After select_strategy: if cannot_repair flag is set → cannot_repair, else generate_fix."""
    if state.get("cannot_repair", False):
        return "cannot_repair"
    return "generate_fix"


def route_after_generate(state: dict) -> str:
    """After generate_fix: if escalating → cannot_repair, else apply_fix."""
    if state.get("cannot_repair", False):
        return "cannot_repair"
    edit_plan = state.get("edit_plan") or []
    if not edit_plan:
        return "cannot_repair"
    return "apply_fix"


def route_apply_loop(state: dict) -> str:
    """
    After apply_fix or receive_fix_result:
    - If _pending_tool_call is set → pipeline executes the write_file
    - If all edits applied        → complete_repair
    - Else                        → apply_fix (next edit)
    """
    if state.get("_pending_tool_call"):
        return "call_tool_fix"
    apply_index = state.get("_apply_index", 0)
    edit_plan = state.get("edit_plan") or []
    if apply_index < len(edit_plan):
        return "apply_fix"
    return "complete_repair"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _format_diagnostics(diagnostics: list) -> str:
    parts = []
    for d in diagnostics:
        line = d.get("line_number", "?")
        sev = d.get("severity", "error")
        msg = d.get("message", "")
        path = d.get("file_path", "")
        parts.append(f"  {path}:{line} [{sev}] {msg}")
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
