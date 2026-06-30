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
      "type": "edit|test|verify|manual",
      "affected_files": ["relative/path/to/file.go"],
      "estimated_risk": "low|medium|high",
      "user_edited": false,
      "metadata": {}
    }
  ]
}

Rules:
- steps must be ordered so dependencies are satisfied (steps only depend on earlier steps).
- depends_on contains step IDs of steps that MUST complete before this one starts.
- Linear plans (no depends_on) are fine for straightforward tasks.
- Do not invent API surfaces, libraries, or behaviours not visible in the code context.
- If the context is insufficient to plan confidently, include an assumption documenting what is unknown.
- Be specific: affected_files should list real file paths visible in the context.
- Aim for 3-8 steps. More granular is better than too coarse.
"""

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
        user_message = _build_user_message(req.intent, context_block, prior_plan)

        yield "Generating implementation plan..."

        plan_body, validation = await self._generate_with_retry(
            req, user_message, max_retries=1
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
    ) -> str | None:
        """Call the configured chat provider with JSON mode enabled."""
        from src.llm.chat_factory import get_chat_provider

        provider = get_chat_provider()

        # Collect all tokens into a single string — plan generation is not
        # streamed to the user token-by-token, only "thinking" events are.
        content_parts: list[str] = []
        try:
            async for event in provider.stream(
                messages=messages,
                payload={},
                request_id=req.request_id,
                response_format={"type": "json_object"},
            ):
                if event.get("event") == "token":
                    content_parts.append(event.get("text", ""))
                elif event.get("event") in ("done", "error"):
                    break
        except Exception as exc:
            logger.error(
                "implementation_planner_llm_error",
                error=str(exc),
                work_item_id=req.work_item_id,
            )
            return None

        return "".join(content_parts) if content_parts else None


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
) -> str:
    parts = [f"Intent: {intent}"]

    if context_block:
        parts.append(f"\nRelevant code context:\n\n{context_block}")

    if prior_plan is not None:
        parts.append(
            "\nPrevious plan (rejected or edited by the user — use as context "
            "but improve upon it):\n\n"
            + json.dumps(prior_plan.model_dump(), indent=2)
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
        return None, [f"LLM output is not valid JSON: {exc}"]

    # Inject metadata the LLM doesn't produce.
    data["plan_id"] = str(uuid.uuid4())
    data["work_item_id"] = req.work_item_id
    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    data.setdefault("version", 1)
    data.setdefault("schema_version", "v1")
    data.setdefault("plan_type", "implementation")
    data.setdefault("planner_id", "implementation_planner_v1")

    # Ensure every step has a UUID id and a stable_id if missing.
    for step in data.get("steps", []):
        if not step.get("id"):
            step["id"] = str(uuid.uuid4())
        if not step.get("stable_id"):
            title_slug = step.get("title", "step").lower()
            title_slug = "".join(c if c.isalnum() else "-" for c in title_slug)[:40]
            step["stable_id"] = f"{title_slug}-{step.get('order', 0)}"
        step.setdefault("depends_on", [])
        step.setdefault("user_edited", False)
        step.setdefault("metadata", {})

    try:
        plan = PlanBody(**data)
    except Exception as exc:
        return None, [f"Plan does not match schema: {exc}"]

    return plan, []
