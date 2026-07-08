"""
Node.js parser — handles:
  - Jest/Vitest JSON output (--json flag)
  - ESLint JSON output (--format json)
  - npm build errors (text fallback)
"""
from __future__ import annotations
import json
from src.validation.models import ParsedDiagnostic
from src.validation.parsers import generic_parser


def parse_test(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse Jest/Vitest --json output.

    Jest writes a JSON object to stdout. It may be single-line or multi-line.
    """
    diags: list[ParsedDiagnostic] = []

    def _parse_jest_report(report: dict) -> list[ParsedDiagnostic]:
        parsed = []
        if "testResults" not in report:
            return parsed
        for suite in report.get("testResults", []):
            file_path = suite.get("testFilePath", "")
            for result in suite.get("testResults", []):
                if result.get("status") == "failed":
                    msg_parts = result.get("failureMessages", [])
                    message = msg_parts[0][:300] if msg_parts else "Test failed"
                    parsed.append(ParsedDiagnostic(
                        severity="error",
                        category="test_failure",
                        file_path=file_path,
                        symbol_name=result.get("fullName", ""),
                        message=message,
                        raw_output="",
                        tool="jest",
                        origin="stdout",
                        confidence=1.0,
                        repair_category="auto_fixable",
                    ))
        return parsed

    # Strategy 1: parse entire stdout as JSON
    stdout_stripped = stdout.strip()
    if stdout_stripped.startswith("{"):
        try:
            report = json.loads(stdout_stripped)
            diags = _parse_jest_report(report)
            if diags:
                return diags
        except json.JSONDecodeError:
            pass

    # Strategy 2: line-by-line
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            report = json.loads(line)
        except json.JSONDecodeError:
            continue
        diags = _parse_jest_report(report)
        if diags:
            return diags

    return diags


def parse_lint(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse ESLint --format json output.

    ESLint writes a JSON array to stdout. The output may be a single line
    or pretty-printed multi-line JSON. We try the whole stdout first,
    then fall back to line-by-line parsing for edge cases.
    """
    diags: list[ParsedDiagnostic] = []

    def _parse_eslint_results(results: list) -> list[ParsedDiagnostic]:
        parsed = []
        for file_result in results:
            file_path = file_result.get("filePath", "")
            for msg in file_result.get("messages", []):
                severity = "error" if msg.get("severity") == 2 else "warning"
                parsed.append(ParsedDiagnostic(
                    severity=severity,
                    category="lint_violation",
                    file_path=file_path,
                    line_number=msg.get("line", 0),
                    column_number=msg.get("column", 0),
                    symbol_name=msg.get("ruleId", ""),
                    message=msg.get("message", ""),
                    raw_output="",
                    tool="eslint",
                    origin="stdout",
                    confidence=1.0,
                    repair_category="auto_fixable" if severity == "error" else "unknown",
                ))
        return parsed

    # Strategy 1: parse the entire stdout as JSON (handles multi-line pretty output)
    stdout_stripped = stdout.strip()
    if stdout_stripped.startswith("["):
        try:
            results = json.loads(stdout_stripped)
            diags = _parse_eslint_results(results)
            if diags:
                return diags
        except json.JSONDecodeError:
            pass

    # Strategy 2: try each line individually (handles single-line minified output)
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not (line.startswith("[") or line.startswith("{")):
            continue
        try:
            results = json.loads(line if line.startswith("[") else f"[{line}]")
            diags = _parse_eslint_results(results)
            if diags:
                return diags
        except json.JSONDecodeError:
            continue

    # Strategy 3: ESLint sometimes writes to stderr with a non-zero exit;
    # try parsing stderr as JSON too
    stderr_stripped = stderr.strip()
    if stderr_stripped.startswith("["):
        try:
            results = json.loads(stderr_stripped)
            diags = _parse_eslint_results(results)
            if diags:
                return diags
        except json.JSONDecodeError:
            pass

    return diags


def parse_build(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Fallback: use generic parser for npm build output."""
    return generic_parser.parse("build", 1, stderr + "\n" + stdout)
