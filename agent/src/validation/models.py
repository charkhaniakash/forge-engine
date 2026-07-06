"""
Validation domain models for Phase 8.

ParseStageRequest:  what Go sends to POST /v1/agent/parse-stage
ParsedDiagnostic:   one structured error/warning/info from a stage
ParseStageResponse: what the agent returns (JSON, non-streaming)
"""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


class RepoEvidence(BaseModel):
    """Repository metadata collected by Go before calling parse-stage.

    This evidence is gathered from the workspace filesystem by the
    ValidationOrchestrator when a stage fails. It gives the FailureDiagnosis
    engine the context it needs to distinguish environment failures from
    code failures without reading the repository itself.
    """
    # Node.js evidence
    node_version_file: str = ""       # contents of .nvmrc or .node-version if present
    engines_field: str = ""           # package.json "engines" field as JSON string
    node_version_in_sandbox: str = "" # output of `node --version` in the container

    # Python evidence
    python_requires: str = ""         # pyproject.toml python_requires if present

    # Go evidence
    go_version_in_mod: str = ""       # "go X.Y" line from go.mod

    # General
    lockfile_present: bool = False    # package-lock.json / yarn.lock / Pipfile.lock etc.
    lockfile_name: str = ""


class ParseStageRequest(BaseModel):
    """Body of POST /v1/agent/parse-stage — one stage at a time."""
    validation_run_id: str
    stage: str               # install|build|test|lint|format
    stack: str               # go|node|python
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    combined_output: str = ""
    # Evidence collected from the repository — used for failure diagnosis.
    # Only populated when exit_code != 0 (no overhead on success).
    repo_evidence: Optional[RepoEvidence] = None


class ParsedDiagnostic(BaseModel):
    """One structured diagnostic produced by a parser."""
    severity: str = "error"          # error|warning|info
    category: str = "unknown"        # compile_error|test_failure|lint_violation|...
    file_path: str = ""
    line_number: int = 0
    column_number: int = 0
    symbol_name: str = ""
    message: str
    raw_output: str = ""
    tool: str = "unknown"            # go_compiler|go_test|eslint|pytest|ruff|generic_parser
    origin: str = "stderr"           # stdout|stderr
    confidence: float = 1.0          # 1.0=structured; 0.6=regex; 0.3=generic
    repair_category: str = "unknown" # auto_fixable|needs_human|unknown


class ParseStageResponse(BaseModel):
    """Returned by the agent for one completed stage."""
    diagnostics: list[ParsedDiagnostic] = Field(default_factory=list)
    stage_passed: bool = True
    error_count: int = 0
    warning_count: int = 0
    # Failure origin — only set when stage_passed=False.
    # "code"        → the failure is caused by the repository's code/tests.
    # "environment" → the failure is caused by the execution environment,
    #                 not the repository contents.
    # "unknown"     → could not be determined with confidence.
    failure_origin: str = "unknown"   # code|environment|unknown
    # Human-readable explanation of WHY the stage failed and what category
    # of failure this is. Shown in the UI and used by Phase 9.
    failure_explanation: str = ""
