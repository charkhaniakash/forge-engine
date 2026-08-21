"""
Planning domain models — request/response types for the planning pipeline.

PlanningRequest: what Go sends to POST /v1/agent/plan
PlanningResult:  what the pipeline produces internally
PlanSchema:      the PlanSchema v1 body persisted in plans.body (Pydantic model
                 used for validation before the raw dict is sent back as JSON)

The PlanSchema v1 is the central execution contract. Every field here is
consumed by at least one future phase:
  - steps.depends_on          → Phase 7 executor (parallel step dispatch)
  - steps.stable_id           → Phase 7/9 (resume after re-plan, retry tracking)
  - steps.user_edited         → re-plan context (preserve user constraints)
  - affected_files            → Phase 10 PR description assembly
  - risks / assumptions       → Phase 12 approval policy evaluation
  - planner_id / schema_ver   → Phase 13 observability / A-B comparison
"""
from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


# ── PlanSchema v1 types ───────────────────────────────────────────────────────

class PlanStep(BaseModel):
    id: str                              # UUID — unique within this plan version
    stable_id: str                       # deterministic slug — maps step across versions
    order: int                           # 1-based display order
    depends_on: list[str] = Field(default_factory=list)   # step IDs this step waits for
    title: str
    description: str
    type: Literal["edit", "test", "verify", "manual"] = "edit"
    affected_files: list[str] = Field(default_factory=list)
    estimated_risk: Literal["low", "medium", "high"] = "low"
    user_edited: bool = False            # True if a human edited this step's description
    metadata: dict[str, Any] = Field(default_factory=dict)  # opaque extension point


class PlanRisk(BaseModel):
    severity: Literal["low", "medium", "high"]
    description: str


class PlanAssumption(BaseModel):
    description: str
    user_verified: bool = False


class AffectedFile(BaseModel):
    path: str
    change_type: Literal["modify", "create", "delete", "rename"]
    rationale: str


class PlanBody(BaseModel):
    """Full PlanSchema v1 — persisted in plans.body and validated on both sides.

    This class is used only for validation. The pipeline serialises it back to
    a plain dict/JSON before emitting the plan event (so Go receives raw JSON).
    """
    schema_version: Literal["v1"] = "v1"
    plan_id: str
    work_item_id: str
    version: int = 1
    plan_type: str = "implementation"
    planner_id: str = "implementation_planner_v1"
    generated_at: str                    # ISO8601 UTC
    intent_summary: str
    risks: list[PlanRisk] = Field(default_factory=list)
    assumptions: list[PlanAssumption] = Field(default_factory=list)
    affected_files: list[AffectedFile] = Field(default_factory=list)
    steps: list[PlanStep]


# ── Pipeline I/O ─────────────────────────────────────────────────────────────

class WorkingFile(BaseModel):
    path: str
    content: str


class PlanningRequest(BaseModel):
    work_item_id: str
    repo_id: str
    commit_sha: str
    intent: str
    planner_hint: str = "implementation"
    prior_plan_body: dict[str, Any] | None = None   # for re-plans
    refinement_note: str | None = None              # user follow-up to refine the prior plan
    history: list[dict[str, Any]] | None = None
    working_tree: list[WorkingFile] = Field(default_factory=list)
    request_id: str


class ValidationResult(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
