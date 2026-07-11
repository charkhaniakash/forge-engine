"""
Python parser — handles:
  - pytest --json-report output
  - ruff check --output-format json
  - Generic Python tracebacks (fallback)
"""
from __future__ import annotations
import json, re
from src.validation.models import ParsedDiagnostic
from src.validation.parsers import generic_parser

# Python traceback: File "path/to/file.py", line 42, in func_name
_TRACEBACK = re.compile(r'File "(.+?)", line (\d+), in (\S+)')


def parse_test(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse pytest --json-report output (written to .pytest-report.json).
    The combined_output may contain the JSON inline if -p no:json was not set.
    Falls back to parsing stderr for tracebacks.
    """
    diags: list[ParsedDiagnostic] = []

    # Try to parse JSON report from stdout
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            report = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "tests" not in report:
            continue
        for test in report.get("tests", []):
            if test.get("outcome") not in ("failed", "error"):
                continue
            node_id = test.get("nodeid", "")
            file_path = node_id.split("::")[0] if "::" in node_id else ""
            symbol = node_id.split("::")[-1] if "::" in node_id else node_id
            call = test.get("call") or test.get("setup") or {}
            longrepr = call.get("longrepr", "") if isinstance(call, dict) else ""
            diags.append(ParsedDiagnostic(
                severity="error",
                category="test_failure",
                file_path=file_path,
                symbol_name=symbol,
                message=longrepr[:300] if longrepr else f"Test failed: {node_id}",
                raw_output=node_id,
                tool="pytest",
                origin="stdout",
                confidence=1.0,
                repair_category="auto_fixable",
            ))
        return diags  # parsed successfully

    # Fallback: extract tracebacks from stderr
    for m in _TRACEBACK.finditer(stderr):
        file_path, line_num, func_name = m.group(1), int(m.group(2)), m.group(3)
        diags.append(ParsedDiagnostic(
            severity="error",
            category="runtime_panic",
            file_path=file_path,
            line_number=line_num,
            symbol_name=func_name,
            message=f"Exception in {func_name}",
            raw_output=m.group(0),
            tool="pytest",
            origin="stderr",
            confidence=0.7,
            repair_category="unknown",
        ))
    return diags


def parse_lint(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse ruff check --output-format json output."""
    diags: list[ParsedDiagnostic] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("["):
            continue
        try:
            results = json.loads(line)
        except json.JSONDecodeError:
            continue
        for item in results:
            loc = item.get("location", {})
            end_loc = item.get("end_location", {})
            severity = "warning" if item.get("fix") else "error"
            diags.append(ParsedDiagnostic(
                severity=severity,
                category="lint_violation",
                file_path=item.get("filename", ""),
                line_number=loc.get("row", 0),
                column_number=loc.get("column", 0),
                symbol_name=item.get("code", ""),
                message=item.get("message", ""),
                raw_output="",
                tool="ruff",
                origin="stdout",
                confidence=1.0,
                repair_category="auto_fixable" if item.get("fix") else "unknown",
            ))
        return diags
    # Fallback
    return generic_parser.parse("lint", 1, stderr + "\n" + stdout)
