"""
Validation domain models for Phase 8.

ParseStageRequest:  what Go sends to POST /v1/agent/parse-stage
ParsedDiagnostic:   one structured error/warning/info from a stage
ParseStageResponse: what the agent returns (JSON, non-streaming)
"""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


class ParseStageRequest(BaseModel):
    """Body of POST /v1/agent/parse-stage — one stage at a time."""
    validation_run_id: str
    stage: str               # install|build|test|lint|format
    stack: str               # go|node|python
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    combined_output: str = ""


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
