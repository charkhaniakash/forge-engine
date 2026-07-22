"""
Node.js parser — handles:
  - Jest/Vitest JSON output (--json flag)
  - ESLint JSON output (--format json)
  - CRA / react-scripts / webpack build errors (text format)
  - Vite / esbuild build errors
  - npm build errors (text fallback)
"""
from __future__ import annotations
import json
import re
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


# ── Build output parsers ──────────────────────────────────────────────────
#
# CRA / react-scripts produces diagnostics in this format when CI=true:
#
#   Treating warnings as errors because process.env.CI = true.
#
#   Failed to compile.
#
#   src/App.js
#     Line 5:21:
#       'useEffect' is defined but never used  no-unused-vars
#
#   src/components/Header.js
#     Line 12:1:
#       'process' is not defined  no-undef
#
# Key patterns:
#   - "Failed to compile." signals the start of diagnostics
#   - File path on its own line (may have leading whitespace)
#   - "Line N:M:" for line:column (optional — some errors omit it)
#   - "Line N:" for line without column (less common but valid)
#   - Message with optional trailing rule name
#   - "(line:col)" suffix in message text (CSS errors use this)
#   - "Browserslist:" lines are informational — ignored when real diags exist
#
# Webpack output:
#   ERROR in ./src/App.js
#   Module not found: Error: Can't resolve './api'
#
# Vite / esbuild output:
#   ✘ [ERROR] Could not resolve "./api"
#       src/components/search/Search.js:2:30:
#         2 │ import { getGeocode } from './api'
#           ╵                           ~~~~~~~

# ── Pattern: file path on its own line ──────────────────────────────────
# Matches "src/App.js", "./src/App.js", "src/components/Header.jsx",
# "src/style.css", "src/App.test.tsx", "C:\path\to\file.js"
# Leading whitespace is allowed (CRA sometimes indents paths).
# NOTE: This intentionally requires a file extension — build diagnostics
# always reference files with extensions. Non-extension lines are skipped.
_FILE_PATH_RE = re.compile(
    r'^\s*\.?\/?([\w\-./\\]+\.[a-zA-Z]{1,8})\s*$'
)

# ── Pattern: "Line N:M:" with leading whitespace (CRA standard) ────────
_LINE_COL_RE = re.compile(r'^\s*Line\s+(\d+):(\d+):\s*$', re.IGNORECASE)

# ── Pattern: "Line N:" without column (less common but valid) ──────────
_LINE_ONLY_RE = re.compile(r'^\s*Line\s+(\d+):\s*$', re.IGNORECASE)

# ── Pattern: "(line:col)" suffix at end of message (CSS error format) ──
_PAREN_LINECOL_RE = re.compile(r'\((\d+):(\d+)\)\s*$')

# ── Pattern: "> N |" — error source line with line pointer ────────────
# Used by build tools to show the failing line:
#   > 1 | import React from 'react';
#       | ^^^^^^^^^^^^^^^^^^^^^^^^
_SOURCE_LINE_RE = re.compile(r'^\s*>\s*(\d+)\s+\|')

# ── Patterns: informational lines to skip ──────────────────────────────
_BROWSERSLIST_RE = re.compile(r'^\s*Browserslist:', re.IGNORECASE)
_TREAT_WARNINGS_HEADER = re.compile(r'Treating warnings as errors', re.IGNORECASE)
_NPM_ERR_RE = re.compile(r'^npm\s+ERR!', re.IGNORECASE)
_FAILED_TO_COMPILE_RE = re.compile(r'Failed to compile', re.IGNORECASE)

# ── Pattern: webpack "ERROR in ./path/file.js" ─────────────────────────
_WEBPACK_ERROR_RE = re.compile(r'^ERROR\s+in\s+(.+)$', re.IGNORECASE)

# ── Pattern: Vite / esbuild "✘ [ERROR] message" ───────────────────────
# Vite format:
#   ✘ [ERROR] Could not resolve "./api"
#       src/components/search/Search.js:2:30:
#         2 │ import { getGeocode } from './api'
#           ╵                           ~~~~~~~
_VITE_ERROR_RE = re.compile(r'^\s*✘\s*\[ERROR\]\s*(.+)$', re.IGNORECASE)

# ── Pattern: esbuild position line "file:line:col:" ────────────────────
# The line right after the Vite error title:
#   ✘ [ERROR] Could not resolve "./api"
#       src/components/search/Search.js:2:30:
_ESBUILD_POSITION_RE = re.compile(
    r'^\s*([\w\-./\\]+\.[a-zA-Z]{1,8}):(\d+):(\d+):\s*$'
)

# ── Pattern: "Stack:" lines — skip stack traces ────────────────────────
_STACK_TRACE_RE = re.compile(r'^\s*Stack\s*:', re.IGNORECASE)

# ── Pattern: node_modules paths — not diagnostic sources ──────────────
# When CRA shows resolved paths (e.g. css-loader chains), they include
# node_modules. We skip these because the actual source file is the
# user's code, not the loader path.
_NODE_MODULES_PATH_RE = re.compile(r'(?:^|/)node_modules/')


# ── Shared helpers ───────────────────────────────────────────────────────

def _extract_rule_name(message: str) -> tuple[str, str]:
    """Extract ESLint rule name from end of message if present.

    CRA appends the ESLint rule name after the message with 2+ spaces:
      "'useEffect' is defined but never used  no-unused-vars"

    Also handles:
      - Single-space or tab separators
      - Scoped rule names: "@typescript-eslint/no-unused-vars"
      - Rules in parentheses: "'foo' is not defined (no-undef)"

    Returns (cleaned_message, rule_name).
    """
    # Strategy 1: rule name after 1+ spaces/tabs at end of message
    # Supports @scope/rule format (e.g. @typescript-eslint/no-unused-vars)
    rule_match = re.search(r'[ \t]{1,}(@?[\w\-]+(?:/[\w\-]+)*)\s*$', message)
    if rule_match:
        candidate = rule_match.group(1)
        # Verify the match looks like a real rule name, not just a trailing word.
        # Rule names are at least 3 chars, kebab-case, optionally scoped.
        normalized = candidate.replace('-', '').replace('/', '').lstrip('@')
        if normalized.isalnum() and len(candidate) >= 3:
            clean = message[:rule_match.start()].strip()
            return clean, candidate

    # Strategy 2: rule name in parentheses at end (some formatters)
    paren_match = re.search(r'\s*\(@?[\w\-]+(?:/[\w\-]+)*\)\s*$', message)
    if paren_match:
        candidate = paren_match.group(0).strip().strip('()')
        normalized = candidate.replace('-', '').replace('/', '').lstrip('@')
        if normalized.isalnum() and len(candidate) >= 3:
            clean = message[:paren_match.start()].strip()
            return clean, candidate

    return message.strip(), ""


def _strip_path_prefix(raw_path: str) -> str:
    """Strip leading ./ and normalize path separators."""
    path = raw_path.strip()
    if path.startswith("./"):
        path = path[2:]
    elif path.startswith(".\\"):
        path = path[2:]
    # Normalize backslashes (shouldn't appear in Linux containers, but just in case)
    path = path.replace("\\", "/")
    return path


# ── CRA / react-scripts build parser ──────────────────────────────────────

def _is_message_line(line: str) -> bool:
    """Check if a line looks like an error message (not a path, line-marker, or control line)."""
    if not line.strip():
        return False
    if _FILE_PATH_RE.match(line):
        return False
    if _LINE_COL_RE.match(line):
        return False
    if _LINE_ONLY_RE.match(line):
        return False
    if _NPM_ERR_RE.match(line):
        return False
    if _BROWSERSLIST_RE.match(line):
        return False
    if _NODE_MODULES_PATH_RE.search(line):
        return False
    if _SOURCE_LINE_RE.match(line):
        return False
    if re.match(r'^\s*\d+\s+\|', line):
        return False
    if re.match(r'^\s*\|[\s\^~]+$', line):
        return False
    return True


def _extract_linecol_from_message(message: str) -> tuple[str, int, int]:
    """Extract (line:col) suffix from message text.

    CSS errors use format: "Unknown word (3:1)"
    Returns (cleaned_message, line, column).
    """
    m = _PAREN_LINECOL_RE.search(message)
    if m:
        clean = message[:m.start()].strip()
        return clean, int(m.group(1)), int(m.group(2))
    return message, 0, 0


def _tokenize_cra_lines(lines: list[str]) -> tuple[list[ParsedDiagnostic], list[str]]:
    """Tokenize CRA build output into structured diagnostics and leftover lines.

    The primary CRA parser. Returns (diagnostics, unparsed_lines).
    Unparsed lines are any lines NOT consumed by the CRA parser — they're
    passed to the webpack/Vite parser for a second pass.

    This separation is critical: CRA output may contain both "Failed to compile."
    style diagnostics AND webpack ERROR lines in the same output. The CRA parser
    must only consume what it recognizes and leave the rest.

    Key invariant: every file path encountered inside the diagnostics section
    produces at least one diagnostic, even without a subsequent Line N:M: or
    message line. This prevents silent drops of partial diagnostic info.
    """
    diags: list[ParsedDiagnostic] = []
    unparsed: list[str] = []
    i = 0
    in_failed_section = False

    while i < len(lines):
        line = lines[i]

        # ── Browserslist lines — skip unconditionally, even before
        #    "Failed to compile." section. These are never diagnostics.
        if _BROWSERSLIST_RE.match(line):
            i += 1
            continue

        # ── Detect entry into "Failed to compile." section ────────────
        if _FAILED_TO_COMPILE_RE.search(line):
            in_failed_section = True
            i += 1
            continue

        # ── Lines we always skip inside the diagnostics section ────────
        if in_failed_section:
            # Treating warnings as errors header
            if _TREAT_WARNINGS_HEADER.search(line):
                i += 1
                continue

            # Stack traces
            if _STACK_TRACE_RE.match(line):
                i += 1
                continue

            # Source pointer lines: "| ^^^^^^^^^^^^^^^^^^^^^^^^"
            if re.match(r'^\s*\|[\s\^~]+$', line):
                i += 1
                continue

            # Source line marker: "> N |" or "N |"
            if _SOURCE_LINE_RE.match(line) or re.match(r'^\s*\d+\s+\|', line):
                i += 1
                continue

            # node_modules paths — skip (resolved loader paths, not source)
            if _NODE_MODULES_PATH_RE.search(line):
                i += 1
                continue

            # Blank lines
            if not line.strip():
                i += 1
                continue

            # npm ERR! lines — stop scanning; diagnostics are complete
            if _NPM_ERR_RE.match(line):
                break

            # ── Parse a CRA diagnostic block ─────────────────────────
            # Format:
            #   src/App.js                   <- file path
            #     Line 5:21:                  <- line:column (optional)
            #       'message'  rule-name     <- message (optional)
            #
            # Also handles:
            #   src/App.css                   <- file path without line:col
            #     Unknown word (3:1)
            #
            # IMPORTANT: Message extraction is NOT gated on Line N:M: being
            # present. A file path always triggers message extraction from
            # subsequent lines. This is the fix for Bug #1 in the original
            # implementation (CSS errors and other non-line-col formats were
            # silently dropped).
            file_match = _FILE_PATH_RE.match(line)
            if file_match and not _NODE_MODULES_PATH_RE.search(line):
                file_path = _strip_path_prefix(file_match.group(1))
                i += 1

                line_num = 0
                col_num = 0
                message_text = ""
                symbol = ""

                # Check if next line is "Line N:M:" or "Line N:"
                if i < len(lines):
                    lc_match = _LINE_COL_RE.match(lines[i])
                    if lc_match:
                        line_num = int(lc_match.group(1))
                        col_num = int(lc_match.group(2))
                        i += 1
                    else:
                        line_only = _LINE_ONLY_RE.match(lines[i])
                        if line_only:
                            line_num = int(line_only.group(1))
                            col_num = 0
                            i += 1

                # Extract message from the next line (whether or not we
                # found a Line N:M: line). The message is the first
                # non-blank, non-control line after the file path.
                if i < len(lines):
                    next_line = lines[i]
                    if _is_message_line(next_line):
                        raw_msg = next_line.strip()
                        clean_msg, rule = _extract_rule_name(raw_msg)

                        # Try to extract (line:col) suffix from message
                        clean_msg, paren_line, paren_col = _extract_linecol_from_message(clean_msg)
                        if paren_line and not line_num:
                            line_num = paren_line
                            col_num = paren_col

                        symbol = _extract_symbol(clean_msg)
                        message_text = clean_msg
                        i += 1

                # Emit diagnostic whenever we have at least a file path
                # with some actionable information (line number or message).
                if not message_text and line_num == 0:
                    # No actionable info — skip and keep scanning.
                    # The file path line has been consumed but there may
                    # be more diagnostics later in the output.
                    continue

                severity = "error"
                if _is_browserslist_only_message(message_text):
                    severity = "info"

                diags.append(ParsedDiagnostic(
                    severity=severity,
                    category="compile_error",
                    file_path=file_path,
                    line_number=line_num,
                    column_number=col_num,
                    symbol_name=symbol,
                    message=message_text or f"Build error in {file_path}",
                    raw_output=(
                        f"{file_path}:{line_num}:{col_num}: {message_text}"
                        if message_text else file_path
                    ),
                    tool="react-scripts",
                    origin="stderr",
                    confidence=0.9,
                    repair_category="auto_fixable",
                ))
                continue

            # Webpack ERROR in — don't consume; leave for webpack parser
            if _WEBPACK_ERROR_RE.match(line):
                unparsed.extend(lines[i:])
                break

            # Vite/esbuild error — don't consume; leave for Vite parser
            if _VITE_ERROR_RE.match(line):
                unparsed.extend(lines[i:])
                break

        # Lines outside the "Failed to compile." section or unrecognized lines
        # inside it that aren't part of a diagnostic block.
        unparsed.append(line)
        i += 1

    return diags, unparsed


def _extract_symbol(message: str) -> str:
    """Extract the symbol name from a diagnostic message.

    Handles:
      "'useEffect' is defined but never used" → "useEffect"
      "'process' is not defined"              → "process"
      "Module not found: './api'"              → "" (no single-quoted identifier)
      "'React' is defined but never used"      → "React"
    """
    if not message:
        return ""
    # Look for a quoted identifier (most common in CRA/ESLint output)
    symbol_match = re.search(r"'([^']+)'", message)
    if symbol_match:
        name = symbol_match.group(1)
        # Filter out non-symbol matches like file paths with extensions
        if "." not in name or not re.search(r'\.\w+$', name):
            return name
    return ""


def _is_browserslist_only_message(message: str) -> bool:
    """Check if a message is solely about Browserslist."""
    return bool(re.search(r'Browserslist|caniuse-lite', message, re.IGNORECASE))


# ── Webpack error parser ──────────────────────────────────────────────────

def _parse_webpack_errors(lines: list[str]) -> list[ParsedDiagnostic]:
    """Parse webpack ERROR in format.

    Output:
      ERROR in ./src/App.js
      Module not found: Error: Can't resolve './api'
    """
    diags: list[ParsedDiagnostic] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        webpack_match = _WEBPACK_ERROR_RE.match(line)
        if webpack_match:
            file_path = _strip_path_prefix(webpack_match.group(1))
            i += 1

            msg_parts = []
            while i < len(lines):
                current = lines[i]
                stripped = current.strip()
                if not stripped or _WEBPACK_ERROR_RE.match(current):
                    break
                # Skip source lines, pointer lines, and npm ERR
                if _SOURCE_LINE_RE.match(current) or re.match(r'^\s*\|[\s\^~]+$', current):
                    i += 1
                    continue
                if _NPM_ERR_RE.match(current):
                    break
                if _NODE_MODULES_PATH_RE.search(current):
                    i += 1
                    continue
                msg_parts.append(stripped)
                i += 1

            message = " ".join(msg_parts) if msg_parts else "Build error"
            diags.append(ParsedDiagnostic(
                severity="error",
                category="compile_error",
                file_path=file_path,
                line_number=0,
                column_number=0,
                symbol_name="",
                message=message[:500],
                raw_output="",
                tool="webpack",
                origin="stderr",
                confidence=0.85,
                repair_category="auto_fixable",
            ))
            continue

        i += 1

    return diags


# ── Vite / esbuild error parser ───────────────────────────────────────────

def _parse_vite_errors(lines: list[str]) -> list[ParsedDiagnostic]:
    """Parse Vite / esbuild build errors.

    Format:
      ✘ [ERROR] Could not resolve "./api"
          src/components/search/Search.js:2:30:
            2 │ import { getGeocode } from './api'
              ╵                           ~~~~~~~

    Also handles:
      ✘ [ERROR] [plugin:vite:css] [postcss] Unknown word
          src/App.css:3:1:
            3 │ .foo
              │ ^^^^^
    """
    diags: list[ParsedDiagnostic] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        vite_match = _VITE_ERROR_RE.match(line)
        if vite_match:
            summary = vite_match.group(1).strip()
            i += 1

            # Next line should be "file:line:col:"
            file_path = ""
            line_num = 0
            col_num = 0
            msg_parts = [summary]

            if i < len(lines):
                pos_match = _ESBUILD_POSITION_RE.match(lines[i])
                if pos_match:
                    file_path = _strip_path_prefix(pos_match.group(1))
                    line_num = int(pos_match.group(2))
                    col_num = int(pos_match.group(3))
                    i += 1

                    # Collect remaining message lines until blank or next error
                    while i < len(lines):
                        current = lines[i].strip()
                        if not current or _VITE_ERROR_RE.match(lines[i]):
                            break
                        if _SOURCE_LINE_RE.match(lines[i]):
                            i += 1
                            continue
                        if re.match(r'^\s*\|[\s\^~]+$', lines[i]):
                            i += 1
                            continue
                        if _NODE_MODULES_PATH_RE.search(lines[i]):
                            i += 1
                            continue
                        msg_parts.append(current)
                        i += 1

            message = " ".join(msg_parts)[:500]
            diags.append(ParsedDiagnostic(
                severity="error",
                category="compile_error",
                file_path=file_path,
                line_number=line_num,
                column_number=col_num,
                symbol_name="",
                message=message,
                raw_output="",
                tool="vite",
                origin="stderr",
                confidence=0.85,
                repair_category="auto_fixable",
            ))
            continue

        i += 1

    return diags


# ── Diagnostic deduplication ───────────────────────────────────────────────

def _deduplicate_diagnostics(
    diags: list[ParsedDiagnostic],
) -> list[ParsedDiagnostic]:
    """Remove duplicate diagnostics across different parsers.

    Dedup key: (file_path, line_number, first 100 chars of message).
    This prevents the same error from being emitted twice when two
    parsers both recognise the same diagnostic (e.g. a CRA ESLint
    error that also matches the generic parser's patterns).

    Preserves insertion order — keeps the first occurrence.
    """
    seen: set[tuple] = set()
    result: list[ParsedDiagnostic] = []
    for d in diags:
        key = (d.file_path, d.line_number, d.message.strip()[:100])
        if key not in seen:
            seen.add(key)
            result.append(d)
    return result


# ── Main build entry point ────────────────────────────────────────────────

def parse_build(stdout: str, stderr: str) -> list[ParsedDiagnostic]:
    """Parse CRA / react-scripts / webpack / Vite build output.

    Multi-phase parsing to handle interleaved output formats:
    1. CRA "Failed to compile." format — extracts ESLint-style diagnostics
    2. Webpack ERROR in format — extracts module resolution errors
    3. Vite / esbuild ✘ [ERROR] format — extracts position-tagged errors
    4. Generic fallback — regex-based pattern matching

    All three structured parsers run independently and their results are
    aggregated. This ensures that mixed output (e.g. ESLint errors + a
    webpack module resolution error in the same build) produces complete
    diagnostics rather than stopping after the first parser's results.

    Deduplication removes overlapping diagnostics from different parsers.

    Priority: compiler diagnostics always win over informational messages.
    Browserslist advisories are ignored when real diagnostics exist.
    """
    combined = stderr + "\n" + stdout
    lines = combined.splitlines()

    # Phase 1: CRA format (most common for React projects)
    cra_diags, remaining = _tokenize_cra_lines(lines)

    # Phase 2: Webpack ERROR in format
    # Use remaining lines (the CRA parser hands off unrecognised lines
    # and explicitly defers webpack/Vite errors).
    webpack_diags = _parse_webpack_errors(remaining if remaining else lines)

    # Phase 3: Vite / esbuild ✘ [ERROR] format
    vite_diags = _parse_vite_errors(remaining if remaining else lines)

    # Aggregate — all parsers run, then we combine
    all_diags = cra_diags + webpack_diags + vite_diags
    if all_diags:
        return _deduplicate_diagnostics(all_diags)

    # Phase 4: Generic fallback — only when no structured parser produced
    # anything. This prevents the weak generic patterns from polluting
    # the rich structured diagnostics the repair pipeline depends on.
    return generic_parser.parse("build", 1, combined)
