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
    """Parse Jest/Vitest --json output."""
    diags: list[ParsedDiagnostic] = []
    # Jest writes JSON to stdout with --json flag
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            report = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "testResults" not in report:
            continue
        for suite in report.get("testResults", []):
            file_path = suite.get("testFilePath", "")
            for result in suite.get("testResults", []):
                if result.get("status") == "failed":
                    msg_parts = result.get("failureMessages", [])
                    message = msg_parts[0][:300] if msg_parts else "Test failed"
                    diags.append(ParsedDiagnostic(
                        severity="error",
                        category="test_failure",
                        file_path=file_path,
                        symbol_name=result.get("fullName", ""),
                        message=message,
                        raw_output=line[:200],
                        tool="jest",
                        origin="stdout",
                        confidence=1.0,
                        repair_category="auto_fixable",
                    ))
        break  # only first JSON object
    return diags


def parse_lint(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse ESLint --format json output."""
    diags: list[ParsedDiagnostic] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not (line.startswith("[") or line.startswith("{")):
            continue
        try:
            results = json.loads(line if line.startswith("[") else f"[{line}]")
        except json.JSONDecodeError:
            continue
        for file_result in results:
            file_path = file_result.get("filePath", "")
            for msg in file_result.get("messages", []):
                severity = "error" if msg.get("severity") == 2 else "warning"
                diags.append(ParsedDiagnostic(
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
        break
    return diags


def parse_build(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Fallback: use generic parser for npm build output."""
    return generic_parser.parse("build", 1, stderr + "\n" + stdout)
