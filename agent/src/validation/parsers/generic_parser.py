"""
Generic fallback parser — extracts errors from any output using regex patterns.
Confidence is 0.3 (low) — structured parsers should be preferred where available.
"""
from __future__ import annotations
import re
from src.validation.models import ParsedDiagnostic

# Common error/warning patterns across many compilers and tools.
# Each pattern tuple: (regex, category)
_ERROR_PATTERNS = [
    # file:line:col: error: message  (GCC, Clang, Rust) → compile_error
    (re.compile(r'^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$', re.IGNORECASE), "compile_error"),
    # file:line: error: message → compile_error
    (re.compile(r'^(.+?):(\d+):\s*(error|warning):\s*(.+)$', re.IGNORECASE), "compile_error"),
    # FAILED test_name → test_failure
    (re.compile(r'^FAILED\s+(.+)$'), "test_failure"),
    # FAIL: TestName → test_failure
    (re.compile(r'^(FAIL|FAILED):\s*(.+)$', re.IGNORECASE), "test_failure"),
    # panic: → runtime_panic
    (re.compile(r'^panic:\s*(.+)$', re.IGNORECASE), "runtime_panic"),
    # ERROR: message (standalone, no file location) → runtime_panic
    (re.compile(r'^(ERROR|error):\s*(.+)$'), "runtime_panic"),
    # fatal error → runtime_panic
    (re.compile(r'^fatal error:\s*(.+)$', re.IGNORECASE), "runtime_panic"),
    # Traceback / exception → runtime_panic
    (re.compile(r'^(Traceback|Exception|Error):\s*(.+)$', re.IGNORECASE), "runtime_panic"),
]

_SEVERITY_MAP = {
    "error": "error", "warning": "warning", "note": "info",
    "failed": "error", "fail": "error",
}


def parse(stage: str, exit_code: int, combined_output: str) -> list[ParsedDiagnostic]:
    """Extract diagnostics from any output using pattern matching."""
    diags: list[ParsedDiagnostic] = []
    seen: set[str] = set()

    for line in combined_output.splitlines():
        line = line.strip()
        if not line:
            continue

        for pat, category in _ERROR_PATTERNS:
            m = pat.match(line)
            if not m:
                continue

            g = m.groups()
            if len(g) >= 5:
                file_path, line_num, _col, sev, msg = g[0], int(g[1]), int(g[2]), g[3], g[4]
                col_num = int(g[2])
            elif len(g) == 4:
                file_path, line_num, sev, msg = g[0], int(g[1]), g[2], g[3]
                col_num = 0
            elif len(g) == 2:
                file_path, msg = "", g[1]
                line_num, col_num = 0, 0
                sev = "error"
            else:
                continue

            key = f"{file_path}:{line_num}:{msg[:40]}"
            if key in seen:
                continue
            seen.add(key)

            severity = _SEVERITY_MAP.get(sev.lower(), "error")
            # Override category for warnings to lint_violation
            diag_category = category
            if severity == "warning":
                diag_category = "lint_violation"

            diags.append(ParsedDiagnostic(
                severity=severity,
                category=diag_category,
                file_path=file_path,
                line_number=line_num,
                column_number=col_num,
                message=msg.strip(),
                raw_output=line,
                tool="generic_parser",
                origin="combined",
                confidence=0.3,
                repair_category="unknown",
            ))
            break

    return diags
