"""
ValidationParser: routes each stage's raw output to the correct language-specific parser.

Design rules:
  - One parser call per completed stage (not a batch).
  - Structured parsers have confidence=1.0 (Go, Node, Python use structured JSON output).
  - Generic regex fallback has confidence=0.3.
  - This module never calls LLM APIs — all parsing is deterministic.
  - The agent produces structured diagnostics; Go persists them and counts them.
"""
from __future__ import annotations

import structlog

from src.validation.models import ParseStageRequest, ParseStageResponse, ParsedDiagnostic
from src.validation.parsers import generic_parser

logger = structlog.get_logger()


class ValidationParser:
    """Routes stage output to the correct language-specific parser."""

    def parse(self, req: ParseStageRequest) -> ParseStageResponse:
        """Parse one stage's output and return structured diagnostics."""
        try:
            diags = self._dispatch(req)
        except Exception as exc:
            logger.error(
                "validation_parser_error",
                stage=req.stage, stack=req.stack, error=str(exc),
            )
            # Non-fatal — return empty diagnostics rather than crashing.
            diags = []

        errors = sum(1 for d in diags if d.severity == "error")
        warnings = sum(1 for d in diags if d.severity == "warning")
        stage_passed = req.exit_code == 0

        # Ensure failed stages always surface at least one diagnostic so
        # the UI never shows an empty result for a broken stage.
        if not stage_passed and len(diags) == 0:
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
        )

        return ParseStageResponse(
            diagnostics=diags,
            stage_passed=stage_passed,
            error_count=errors,
            warning_count=warnings,
        )

    def _dispatch(self, req: ParseStageRequest) -> list[ParsedDiagnostic]:
        stack = req.stack.lower()
        stage = req.stage.lower()
        # Always build combined from stderr+stdout if combined_output not provided.
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
