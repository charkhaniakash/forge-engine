"""
ValidationParser: routes each stage's raw output to the correct language-specific parser.

Design rules:
  - One parser call per completed stage (not a batch).
  - Structured parsers have confidence=1.0 (Go, Node, Python use structured JSON output).
  - Generic regex fallback has confidence=0.3.
  - This module never calls LLM APIs — all parsing is deterministic.
  - The agent produces structured diagnostics; Go persists them and counts them.

Phase 8 enhancement:
  - When a stage fails, FailureDiagnosis classifies the root cause BEFORE parsing.
  - Environment failures produce diagnostics with repair_category="environment_limitation"
    and set failure_origin="environment" in the response.
  - Code failures go through the normal structured parsing path.
  - The distinction is propagated to Go via ParseStageResponse.failure_origin.
"""
from __future__ import annotations

import structlog

from src.validation.failure_diagnosis import FailureDiagnosis
from src.validation.models import ParseStageRequest, ParseStageResponse, ParsedDiagnostic
from src.validation.parsers import generic_parser

logger = structlog.get_logger()

_diagnosis = FailureDiagnosis()


class ValidationParser:
    """Routes stage output to the correct language-specific parser.

    On failure, runs FailureDiagnosis first to classify whether the failure
    is environmental or code-related. This changes how diagnostics are
    categorized and what repair_category is assigned.
    """

    def parse(self, req: ParseStageRequest) -> ParseStageResponse:
        """Parse one stage's output and return structured diagnostics."""
        stage_passed = req.exit_code == 0
        failure_origin = "unknown"
        failure_explanation = ""

        # ── Step 1: Diagnose failure origin before parsing ─────────────────────
        # Only run diagnosis when the stage actually failed — zero overhead on
        # passing stages.
        diagnosis_result = None
        if not stage_passed:
            combined = req.combined_output or (req.stderr + "\n" + req.stdout).strip()
            diagnosis_result = _diagnosis.diagnose(
                stage=req.stage,
                stack=req.stack,
                exit_code=req.exit_code,
                stdout=req.stdout,
                stderr=req.stderr,
                combined=combined,
                evidence=req.repo_evidence,
            )
            failure_origin = diagnosis_result.failure_origin
            failure_explanation = diagnosis_result.explanation
            logger.info(
                "validation_failure_diagnosed",
                stage=req.stage,
                stack=req.stack,
                failure_origin=failure_origin,
                failure_class=diagnosis_result.failure_class,
                confidence=diagnosis_result.confidence,
            )

        # ── Step 2: Parse diagnostics ─────────────────────────────────────────
        try:
            diags = self._dispatch(req)
        except Exception as exc:
            logger.error(
                "validation_parser_error",
                stage=req.stage, stack=req.stack, error=str(exc),
            )
            diags = []

        # ── Step 3: Enrich environment-failure diagnostics ────────────────────
        # When the failure is environmental, override repair_category on all
        # diagnostics to "environment_limitation" so Phase 9 never tries to
        # auto-repair environment issues by modifying code.
        if failure_origin == "environment":
            enriched = []
            for d in diags:
                enriched.append(d.model_copy(update={
                    "repair_category": "environment_limitation",
                    "category": d.category if d.category not in ("unknown",) else "environment_error",
                }))
            diags = enriched

        # ── Step 4: Fallback diagnostic for failed stages with no output ──────
        if not stage_passed and len(diags) == 0:
            if failure_origin == "environment" and diagnosis_result:
                # Use the diagnosis explanation for the fallback message.
                fallback_msg = f"[exit {req.exit_code}] {diagnosis_result.explanation}"
                diags = [ParsedDiagnostic(
                    severity="error",
                    category="environment_error",
                    message=fallback_msg,
                    raw_output=(req.stderr or req.stdout)[:500],
                    tool="failure_diagnosis",
                    origin="stderr" if req.stderr.strip() else "stdout",
                    confidence=diagnosis_result.confidence,
                    repair_category="environment_limitation",
                )]
            else:
                logger.warning(
                    "validation_parser_fallback_diagnostic",
                    stage=req.stage,
                    stack=req.stack,
                    exit_code=req.exit_code,
                )
                diags = generic_parser.parse_failed_stage(
                    req.stage, req.exit_code, req.stdout, req.stderr
                )

        errors = sum(1 for d in diags if d.severity == "error")
        warnings = sum(1 for d in diags if d.severity == "warning")

        logger.info(
            "validation_parsed",
            stage=req.stage,
            stack=req.stack,
            diagnostics=len(diags),
            errors=errors,
            warnings=warnings,
            stage_passed=stage_passed,
            failure_origin=failure_origin,
        )

        return ParseStageResponse(
            diagnostics=diags,
            stage_passed=stage_passed,
            error_count=errors,
            warning_count=warnings,
            failure_origin=failure_origin,
            failure_explanation=failure_explanation,
        )

    def _dispatch(self, req: ParseStageRequest) -> list[ParsedDiagnostic]:
        stack = req.stack.lower()
        stage = req.stage.lower()
        combined = req.combined_output or (req.stderr + "\n" + req.stdout).strip()

        # ── Go ────────────────────────────────────────────────────────────────
        if stack == "go":
            from src.validation.parsers import go_parser
            try:
                if stage == "build":
                    return go_parser.parse_build(req.stdout, req.stderr)
                if stage == "test":
                    return go_parser.parse_test(req.stdout, req.stderr)
            except Exception as exc:
                logger.error(
                    "go_parser_failed_fallback_to_generic",
                    stage=stage, stack=stack, error=str(exc),
                )
                return generic_parser.parse(stage, req.exit_code, combined)
            return generic_parser.parse(stage, req.exit_code, combined)

        # ── Node.js ───────────────────────────────────────────────────────────
        if stack in ("node", "javascript"):
            from src.validation.parsers import node_parser
            try:
                if stage == "test":
                    return node_parser.parse_test(req.stdout, req.stderr)
                if stage == "lint":
                    return node_parser.parse_lint(req.stdout, req.stderr)
                if stage == "build":
                    return node_parser.parse_build(req.stdout, req.stderr)
            except Exception as exc:
                logger.error(
                    "node_parser_failed_fallback_to_generic",
                    stage=stage, stack=stack, error=str(exc),
                )
                return generic_parser.parse(stage, req.exit_code, combined)
            return generic_parser.parse(stage, req.exit_code, combined)

        # ── Python ────────────────────────────────────────────────────────────
        if stack == "python":
            from src.validation.parsers import python_parser
            try:
                if stage == "test":
                    return python_parser.parse_test(req.stdout, req.stderr)
                if stage == "lint":
                    return python_parser.parse_lint(req.stdout, req.stderr)
            except Exception as exc:
                logger.error(
                    "python_parser_failed_fallback_to_generic",
                    stage=stage, stack=stack, error=str(exc),
                )
                return generic_parser.parse(stage, req.exit_code, combined)
            return generic_parser.parse(stage, req.exit_code, combined)

        # Unknown stack — generic fallback.
        return generic_parser.parse(stage, req.exit_code, combined)
