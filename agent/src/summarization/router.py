"""
Phase 10: Summarization endpoint for commit messages and PR descriptions.

POST /v1/agent/summarize

Accepts structured execution data (diffs, plan, validation results) and
generates human-readable commit messages or PR descriptions. The Agent
never invents information — all summaries are derived from the input data.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.summarization.generator import generate_commit_message, generate_pr_description


router = APIRouter()


class DiffSummary(BaseModel):
    file_path: str
    operation: str  # create | modify | delete | rename
    lines_added: int = 0
    lines_removed: int = 0


class SummaryRequest(BaseModel):
    work_item_id: str
    task_execution_id: str
    intent: str = ""
    plan_summary: str = ""
    steps: list[dict] = []
    diffs: list[DiffSummary] = []
    validation_result: str | None = None
    repair_history: list[dict] = []
    request_type: str  # "commit_message" | "pr_description"
    request_id: str = ""


class SummaryResponse(BaseModel):
    commit_subject: str = ""
    commit_body: str = ""
    pr_title: str = ""
    pr_body: str = ""


@router.post("/v1/agent/summarize")
async def summarize(req: SummaryRequest) -> SummaryResponse:
    """Generate a commit message or PR description from structured execution data."""
    if req.request_type == "commit_message":
        subject, body = generate_commit_message(
            intent=req.intent,
            diffs=req.diffs,
            validation_result=req.validation_result,
        )
        return SummaryResponse(commit_subject=subject, commit_body=body)

    elif req.request_type == "pr_description":
        title, body = generate_pr_description(
            intent=req.intent,
            diffs=req.diffs,
            plan_summary=req.plan_summary,
            steps=req.steps,
            validation_result=req.validation_result,
            repair_history=req.repair_history,
            work_item_id=req.work_item_id,
            task_execution_id=req.task_execution_id,
        )
        return SummaryResponse(pr_title=title, pr_body=body)

    else:
        raise HTTPException(status_code=400, detail=f"Unknown request_type: {req.request_type}")
