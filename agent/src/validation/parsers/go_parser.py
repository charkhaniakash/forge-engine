"""
Go parser — handles:
  - go build/vet compiler output (text format)
  - go test -json output (structured JSON per line)
"""
from __future__ import annotations
import json, re
from src.validation.models import ParsedDiagnostic

# go build error: path/to/file.go:42:8: undefined: Foo
_BUILD_ERR = re.compile(r'^(.+?\.go):(\d+):(\d+):\s*(.+)$')
# go build package error: # pkg\npath/to/file.go:42:8: msg
_PKG_HEADER = re.compile(r'^#\s+.+$')


def parse_build(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    diags: list[ParsedDiagnostic] = []
    for line in (stderr + "\n" + stdout).splitlines():
        line = line.strip()
        if not line or _PKG_HEADER.match(line):
            continue
        m = _BUILD_ERR.match(line)
        if not m:
            continue
        file_path, line_num, col_num, msg = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
        severity = "warning" if "warning:" in msg.lower() else "error"
        diags.append(ParsedDiagnostic(
            severity=severity,
            category="compile_error",
            file_path=file_path,
            line_number=line_num,
            column_number=col_num,
            message=msg.strip(),
            raw_output=line,
            tool="go_compiler",
            origin="stderr",
            confidence=1.0,
            repair_category="auto_fixable" if severity == "error" else "unknown",
        ))
    return diags


def parse_test(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse go test -json output."""
    diags: list[ParsedDiagnostic] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        action = event.get("action", "")
        if action not in ("fail", "output"):
            continue
        if action == "fail":
            test_name = event.get("test", "")
            pkg = event.get("package", "")
            if test_name:
                diags.append(ParsedDiagnostic(
                    severity="error",
                    category="test_failure",
                    symbol_name=test_name,
                    file_path=_pkg_to_path(pkg),
                    message=f"FAIL {test_name} ({pkg})",
                    raw_output=line,
                    tool="go_test",
                    origin="stdout",
                    confidence=1.0,
                    repair_category="auto_fixable",
                ))
        elif action == "output":
            output = event.get("output", "").strip()
            # Panic detection
            if "panic:" in output or "goroutine" in output:
                diags.append(ParsedDiagnostic(
                    severity="error",
                    category="runtime_panic",
                    message=output[:200],
                    raw_output=line,
                    tool="go_test",
                    origin="stdout",
                    confidence=0.9,
                    repair_category="needs_human",
                ))
    return diags


def _pkg_to_path(pkg: str) -> str:
    """Convert a Go package path to a rough file path hint."""
    if not pkg:
        return ""
    parts = pkg.split("/")
    return "/".join(parts) + "/" if parts else ""
