"""
ImplementationPlanner — Phase 5's only registered planner.

Generates a PlanSchema v1 body for a feature implementation task.
Uses JSON-mode / structured output so the LLM is constrained to emit
valid JSON matching PlanBody. Retries once if validation fails.

The planner yields intermediate reasoning strings during generation so
the pipeline can stream "thinking" events to the frontend in real time.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator

import structlog

from src.core.models import AssembledContext
from src.planning.models import (
    AffectedFile,
    PlanAssumption,
    PlanBody,
    PlanRisk,
    PlanStep,
    PlanningRequest,
    ValidationResult,
)
from src.planning.validator import validate

logger = structlog.get_logger()

# ── Prompts ───────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are a senior software engineer performing implementation planning.
Given a user's intent and relevant code context from the repository,
produce a structured implementation plan.

Your response MUST be a single JSON object matching this schema exactly.
Do not include any prose, markdown fences, or explanation outside the JSON.

CRITICAL CONSTRAINT — CHECK EXISTING CODE BEFORE CREATING STEPS:
The code context below contains the ACTUAL current state of the repository.
If a WORKING TREE section is present, it is the live workspace AFTER the previous
mission (including the last PR). It OVERRIDES any older indexed snippets.
Before creating any step, check whether the change already exists.
Before creating any step, check whether the change already exists in the code context.

Rules for step inclusion:
  - If an import already exists in the file → do NOT add a step to add that import.
  - If a function already exists with the correct signature → do NOT add a step to create it.
  - If a variable, constant, or hook is already declared → do NOT add a step to add it.
  - Only include steps for changes that are ACTUALLY MISSING from the code context.
  - If the entire intent is already implemented, produce an empty steps array.

CRITICAL CONSTRAINT — ONLY INCLUDE EXECUTABLE STEPS:
The execution engine can ONLY perform these operations on the repository:
  - Read, write, create, delete, rename files
  - Search for symbols and patterns in code

Do NOT include steps that require:
  - Running the application (npm start, go run, etc.)
  - Starting development servers or long-running processes
  - Browser interaction or visual UI verification
  - Manual human observation or testing
  - Visual confirmation of any kind
  - Any operation that cannot be performed by reading or writing files

Phase 8 (automated build/test/lint validation) runs automatically after execution.
You do not need to include test or build steps in this plan.
Focus exclusively on repository file modifications that are MISSING from the current codebase.

Schema:
{
  "schema_version": "v1",
  "plan_type": "implementation",
  "planner_id": "implementation_planner_v1",
  "intent_summary": "<one-sentence restatement of the user's intent>",
  "risks": [
    {"severity": "low|medium|high", "description": "..."}
  ],
  "assumptions": [
    {"description": "...", "user_verified": false}
  ],
  "affected_files": [
    {"path": "relative/path/to/file.go", "change_type": "modify|create|delete|rename", "rationale": "..."}
  ],
  "steps": [
    {
      "id": "<uuid>",
      "stable_id": "<short-slug-based-on-title>",
      "order": 1,
      "depends_on": [],
      "title": "<short imperative title>",
      "description": "<detailed rationale and approach>",
      "type": "edit",
      "affected_files": ["relative/path/to/file.go"],
      "estimated_risk": "low|medium|high",
      "user_edited": false,
      "metadata": {}
    }
  ]
}

Rules:
- All steps must have type "edit" — the only executable type in Phase 7.
- steps must be ordered so dependencies are satisfied (steps only depend on earlier steps).
- depends_on contains step IDs of steps that MUST complete before this one starts.
- Use depends_on when a step cannot proceed without an earlier step's output.
- Linear plans (no depends_on) are fine for straightforward tasks.
- Do not invent API surfaces, libraries, or behaviours not visible in the code context.
- If the context is insufficient to plan confidently, include an assumption documenting what is unknown.
- Be specific: affected_files should list real file paths visible in the context.
- Aim for 3-8 steps. Each step should modify one or more files.
- NEVER include a step for something that is already present in the code context.
"""

# Alternate key names small/local models use instead of the schema's names.
# Checked in order; the first match wins.
_STEP_KEY_ALIASES = ("implementation_steps", "plan_steps", "tasks", "actions", "step_list")
_TITLE_KEY_ALIASES = ("name", "step", "action", "summary", "step_title")

_RETRY_SUFFIX = """

The previous attempt produced an invalid plan. Validation errors:
{errors}

Please correct the plan and respond with valid JSON only.
"""


class ImplementationPlanner:
    plan_type = "implementation"
    planner_id = "implementation_planner_v1"

    async def generate(
        self,
        req: PlanningRequest,
        context: AssembledContext,
        prior_plan: PlanBody | None,
    ) -> AsyncIterator[str | PlanBody]:
        yield "Preparing code context for planning..."

        context_block = _build_context_block(context)
        user_message = _build_user_message(
            req.intent, context_block, prior_plan, req.refinement_note, req.working_tree
        )

        yield "Generating implementation plan..."

        plan_body, validation = await self._generate_with_retry(
            req, user_message, max_retries=2
        )

        if plan_body is None:
            # Yield the errors as a string — pipeline will emit an error event.
            raise ValueError(
                f"Plan generation failed after retries. "
                f"Validation errors: {validation.errors}"
            )

        if validation.warnings:
            logger.warning(
                "plan_validation_warnings",
                warnings=validation.warnings,
                work_item_id=req.work_item_id,
            )

        yield plan_body

    async def _generate_with_retry(
        self,
        req: PlanningRequest,
        user_message: str,
        max_retries: int = 1,
    ) -> tuple[PlanBody | None, ValidationResult]:
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ]

        for attempt in range(max_retries + 1):
            raw_json = await self._call_llm(messages, req)
            if raw_json is None:
                return None, ValidationResult(valid=False, errors=["LLM returned no content"])

            plan_body, parse_errors = _parse_plan(raw_json, req)
            if parse_errors:
                if attempt < max_retries:
                    logger.warning(
                        "plan_parse_failed_retrying",
                        errors=parse_errors,
                        attempt=attempt,
                        work_item_id=req.work_item_id,
                    )
                    messages.append({"role": "assistant", "content": raw_json})
                    messages.append({
                        "role": "user",
                        "content": _RETRY_SUFFIX.format(errors="\n".join(parse_errors)),
                    })
                    continue
                return None, ValidationResult(valid=False, errors=parse_errors)

            result = validate(plan_body)
            if not result.valid:
                if attempt < max_retries:
                    logger.warning(
                        "plan_validation_failed_retrying",
                        errors=result.errors,
                        attempt=attempt,
                        work_item_id=req.work_item_id,
                    )
                    messages.append({"role": "assistant", "content": raw_json})
                    messages.append({
                        "role": "user",
                        "content": _RETRY_SUFFIX.format(errors="\n".join(result.errors)),
                    })
                    continue
                return None, result

            return plan_body, result

        return None, ValidationResult(valid=False, errors=["max retries exceeded"])

    async def _call_llm(
        self,
        messages: list[dict],
        req: PlanningRequest,
        max_retries: int = 6,
    ) -> str | None:
        """Call the configured chat provider with JSON mode enabled.

        Retries up to max_retries times on network/server errors (disconnects,
        timeouts, rate limits) with exponential backoff — same strategy as the
        repair graph's _call_llm_with_retry.
        """
        import asyncio
        from src.llm.chat_factory import get_chat_provider

        provider = get_chat_provider()

        for attempt in range(max_retries):
            if attempt > 0:
                delay = 2 ** (attempt - 1)  # 1, 2, 4, 8, 16, 32 s
                logger.warning(
                    "planning_llm_retry",
                    attempt=attempt + 1,
                    max_retries=max_retries,
                    delay_seconds=delay,
                    work_item_id=req.work_item_id,
                )
                await asyncio.sleep(delay)

            content_parts: list[str] = []
            had_error = False
            try:
                async for event in provider.stream(
                    messages=messages,
                    payload={},
                    request_id=req.request_id,
                    response_format={"type": "json_object"},
                ):
                    evt = event.get("event")
                    if evt == "token":
                        content_parts.append(event.get("text", ""))
                    elif evt == "done":
                        break
                    elif evt == "error":
                        logger.warning(
                            "planning_llm_error_event",
                            error=event.get("message", ""),
                            attempt=attempt + 1,
                            work_item_id=req.work_item_id,
                        )
                        had_error = True
                        break
            except Exception as exc:
                logger.warning(
                    "planning_llm_exception",
                    error=str(exc),
                    attempt=attempt + 1,
                    work_item_id=req.work_item_id,
                )
                had_error = True

            if not had_error and content_parts:
                return "".join(content_parts)

        logger.error(
            "planning_llm_retries_exhausted",
            max_retries=max_retries,
            work_item_id=req.work_item_id,
        )
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_context_block(context: AssembledContext) -> str:
    """Format assembled chunks as annotated code blocks."""
    parts: list[str] = []
    for chunk in context.chunks:
        header = f"// File: {chunk.file_path} (lines {chunk.start_line}–{chunk.end_line})"
        lang = chunk.language or ""
        parts.append(f"{header}\n```{lang}\n{chunk.content}\n```")
    return "\n\n".join(parts)


def _build_user_message(
    intent: str,
    context_block: str,
    prior_plan: PlanBody | None,
    refinement_note: str | None = None,
    working_tree: list | None = None,
) -> str:
    parts = [f"Intent: {intent}"]

    if working_tree:
        overlay = []
        for f in working_tree:
            path = getattr(f, "path", None) or (f.get("path") if isinstance(f, dict) else "")
            content = getattr(f, "content", None) or (f.get("content") if isinstance(f, dict) else "")
            if path and content:
                overlay.append(f"// LIVE FILE (after previous mission): {path}\n```\n{content}\n```")
        if overlay:
            parts.append(
                "\nWORKING TREE — this is the current code on the mission branch / workspace. "
                "Indexed snippets below may be STALE. Prefer this tree.\n\n"
                + "\n\n".join(overlay)
            )

    if context_block:
        parts.append(
            f"\nRelevant code context (CURRENT repository state — check this before creating steps):\n\n{context_block}"
        )
        parts.append(
            "\nIMPORTANT: The code context above shows the ACTUAL current state of the files. "
            "Do NOT create steps for things that are already present. "
            "Only create steps for changes that are MISSING from the code above."
        )

    if prior_plan is not None:
        # When there's a refinement note the prior plan is a starting point to
        # adjust, not something to discard — say so explicitly below.
        label = (
            "Previous plan (the user is reviewing it and asked for the changes below "
            "— keep what still applies and revise accordingly):"
            if refinement_note
            else "Previous plan (rejected or edited by the user — use as context but improve upon it):"
        )
        parts.append("\n" + label + "\n\n" + json.dumps(prior_plan.model_dump(), indent=2))

    if refinement_note:
        parts.append(
            "\nThe user reviewed the previous plan and requested the following change. "
            "Produce a revised plan that incorporates this feedback while preserving the "
            "steps that are still correct:\n\n"
            f'"{refinement_note.strip()}"'
        )

    parts.append("\nProduce the implementation plan as a JSON object.")
    return "\n".join(parts)


def _parse_plan(
    raw_json: str,
    req: PlanningRequest,
) -> tuple[PlanBody | None, list[str]]:
    """Parse and normalise raw LLM JSON into a PlanBody. Returns errors on failure."""
    try:
        data = json.loads(raw_json.strip())
    except json.JSONDecodeError as exc:
        logger.warning(
            "plan_raw_output_not_json",
            work_item_id=req.work_item_id,
            raw_output=raw_json[:2000],
        )
        return None, [f"LLM output is not valid JSON: {exc}"]

    # Log the raw parsed structure so we can see exactly what a small/local
    # model (qwen2.5-coder:7b) produced when a plan ends up empty or malformed.
    # NOTE: temporarily at WARNING level for diagnosis — drop to debug once
    # the small-model output shape is understood.
    logger.warning(
        "plan_raw_output_parsed",
        work_item_id=req.work_item_id,
        top_level_keys=list(data.keys()) if isinstance(data, dict) else None,
        raw_output=raw_json[:2000],
    )

    if not isinstance(data, dict):
        return None, ["LLM output is not a JSON object"]

    # Local models (like qwen2.5-coder:7b) sometimes wrap the whole plan in a single
    # root key like {"implementation_plan": {...}} or {"plan": {...}} despite
    # the system prompt. Unwrap up to a couple of levels until we find the body.
    for _ in range(2):
        if len(data) == 1:
            root_key = next(iter(data))
            inner = data[root_key]
            if isinstance(inner, dict) and (
                "steps" in inner
                or "intent_summary" in inner
                or any(k in inner for k in _STEP_KEY_ALIASES)
            ):
                data = inner
                continue
        break

    # ── Sanitise for small / local models (qwen2.5-coder:7b) ─────────────────────
    # These models frequently omit required fields or produce malformed
    # sub-objects. We fix what we can before Pydantic validation.

    # Inject metadata the LLM doesn't produce.
    data["plan_id"] = str(uuid.uuid4())
    data["work_item_id"] = req.work_item_id
    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    data.setdefault("version", 1)
    data.setdefault("schema_version", "v1")
    data.setdefault("plan_type", "implementation")
    data.setdefault("planner_id", "implementation_planner_v1")

    # Small models often emit the steps array under a different key
    # (implementation_steps, plan_steps, tasks, actions, ...). Adopt the first
    # non-empty alias we find so we don't discard an otherwise-valid plan.
    if not data.get("steps"):
        for alias in _STEP_KEY_ALIASES:
            if isinstance(data.get(alias), list) and data[alias]:
                data["steps"] = data[alias]
                break

    # Default top-level fields the model sometimes omits entirely.
    data.setdefault("intent_summary", req.intent)
    data.setdefault("steps", [])
    data.setdefault("risks", [])
    data.setdefault("assumptions", [])
    data.setdefault("affected_files", [])

    # Normalise each step's title: small models label it name/step/action/etc.
    # Do this BEFORE the title filter below, otherwise valid steps get dropped.
    for step in data["steps"]:
        if isinstance(step, dict) and not step.get("title"):
            for alias in _TITLE_KEY_ALIASES:
                if step.get(alias):
                    step["title"] = step[alias]
                    break

    # Filter out malformed assumptions (missing required 'description').
    data["assumptions"] = [
        a for a in data["assumptions"]
        if isinstance(a, dict) and a.get("description")
    ]
    # Ensure every assumption has user_verified.
    for a in data["assumptions"]:
        a.setdefault("user_verified", False)

    # Filter out malformed risks (missing required 'description' or 'severity').
    data["risks"] = [
        r for r in data["risks"]
        if isinstance(r, dict) and r.get("description") and r.get("severity")
    ]

    # Filter out malformed affected_files.
    data["affected_files"] = [
        f for f in data["affected_files"]
        if isinstance(f, dict) and f.get("path") and f.get("change_type")
    ]
    for f in data["affected_files"]:
        f.setdefault("rationale", "")

    # Ensure every step has a UUID id and a stable_id if missing.
    # Also filter out non-dict entries and steps missing a title.
    steps_before = len(data["steps"]) if isinstance(data["steps"], list) else 0
    data["steps"] = [s for s in data["steps"] if isinstance(s, dict) and s.get("title")]
    if steps_before and not data["steps"]:
        logger.warning(
            "plan_all_steps_filtered_out",
            work_item_id=req.work_item_id,
            steps_before=steps_before,
            raw_output=raw_json[:2000],
        )
    for i, step in enumerate(data["steps"]):
        if not step.get("id"):
            step["id"] = str(uuid.uuid4())
        if not step.get("stable_id"):
            title_slug = step.get("title", "step").lower()
            title_slug = "".join(c if c.isalnum() else "-" for c in title_slug)[:40]
            step["stable_id"] = f"{title_slug}-{step.get('order', i + 1)}"
        step.setdefault("order", i + 1)
        step.setdefault("description", step.get("title", ""))
        step.setdefault("type", "edit")
        step.setdefault("depends_on", [])
        step.setdefault("user_edited", False)
        step.setdefault("metadata", {})
        step.setdefault("affected_files", [])
        step.setdefault("estimated_risk", "low")

    try:
        plan = PlanBody(**data)
    except Exception as exc:
        return None, [f"Plan does not match schema: {exc}"]

    return plan, []
