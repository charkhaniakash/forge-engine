"""
PlanValidator — deterministic validation of a PlanBody.

No LLM calls. Checks:
  1. Required fields present and correctly typed (Pydantic already handled this
     if the planner used PlanBody, but we re-validate raw dicts from user edits).
  2. At least one step.
  3. No duplicate step IDs or stable_IDs.
  4. All depends_on references point to real step IDs within the same plan.
  5. No dependency cycles (DFS with colour marking).
  6. No steps reference files not in affected_files (warning only — not an error).

The validator is called twice in the pipeline:
  - After the planner generates a plan (before emitting the plan event).
  - After the user submits an edited plan via PUT .../plan (Go-side validation
    also runs, but the agent validator is the richer check).
"""
from __future__ import annotations

from src.planning.models import PlanBody, ValidationResult


def validate(plan: PlanBody) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []

    # Must have steps.
    if not plan.steps:
        errors.append("plan must contain at least one step")
        return ValidationResult(valid=False, errors=errors)

    # Collect step IDs and stable_IDs.
    step_ids: set[str] = set()
    stable_ids: set[str] = set()
    for step in plan.steps:
        if step.id in step_ids:
            errors.append(f"duplicate step id: {step.id}")
        step_ids.add(step.id)

        if step.stable_id in stable_ids:
            warnings.append(f"duplicate stable_id: {step.stable_id} (may affect cross-version tracking)")
        stable_ids.add(step.stable_id)

    # Validate depends_on references.
    for step in plan.steps:
        for dep in step.depends_on:
            if dep not in step_ids:
                errors.append(
                    f"step '{step.id}' depends_on unknown step id: '{dep}'"
                )

    if errors:
        return ValidationResult(valid=False, errors=errors, warnings=warnings)

    # Cycle detection (DFS with white/grey/black colouring).
    dep_map: dict[str, list[str]] = {s.id: list(s.depends_on) for s in plan.steps}
    WHITE, GREY, BLACK = 0, 1, 2
    colour: dict[str, int] = {sid: WHITE for sid in step_ids}

    def dfs(node: str) -> bool:
        if colour[node] == BLACK:
            return False
        if colour[node] == GREY:
            return True   # back-edge → cycle
        colour[node] = GREY
        for neighbour in dep_map.get(node, []):
            if dfs(neighbour):
                return True
        colour[node] = BLACK
        return False

    for sid in step_ids:
        if dfs(sid):
            errors.append("plan steps contain a dependency cycle in depends_on")
            break

    # Warn if a step references a file not in affected_files.
    affected_paths = {af.path for af in plan.affected_files}
    for step in plan.steps:
        for fp in step.affected_files:
            if affected_paths and fp not in affected_paths:
                warnings.append(
                    f"step '{step.title}' references file '{fp}' "
                    f"not listed in plan.affected_files"
                )

    return ValidationResult(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
    )
