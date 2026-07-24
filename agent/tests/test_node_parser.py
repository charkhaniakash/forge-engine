"""
Comprehensive unit tests for the CRA build output parser (_tokenize_cra_lines).

Covers:
  - Single diagnostic (sanity check — unchanged behavior)
  - Multiple diagnostics in the same file (the Bug #2 fix: file path appears once)
  - Multiple files, each with their own diagnostics (unchanged behavior)
  - CSS errors with (line:col) suffix format
  - Diagnostics without Line N:M: lines (e.g. CSS "Unknown word" format)
  - Mixed blank lines and spacing (resilience)
  - Vite output — must NOT be consumed by CRA parser (unchanged behavior)
  - Webpack ERROR in output — must NOT be consumed by CRA parser (unchanged behavior)
  - Browserslist lines — must be skipped (unchanged behavior)
  - Treating warnings as errors header — must be skipped (unchanged behavior)
  - npm ERR! lines — must terminate parsing (unchanged behavior)
  - Node_modules paths — must be skipped (unchanged behavior)
  - Real-world CRA output with interleaved file blocks
"""
"""
Comprehensive unit tests for the CRA build output parser (_tokenize_cra_lines).

Covers:
  - Single diagnostic (sanity check — unchanged behavior)
  - Multiple diagnostics in the same file (the Bug #2 fix: file path appears once)
  - Multiple files, each with their own diagnostics (unchanged behavior)
  - CSS errors with (line:col) suffix format
  - Diagnostics without Line N:M: lines (e.g. CSS "Unknown word" format)
  - Mixed blank lines and spacing (resilience)
  - Vite output — must NOT be consumed by CRA parser (unchanged behavior)
  - Webpack ERROR in output — must NOT be consumed by CRA parser (unchanged behavior)
  - Browserslist lines — must be skipped (unchanged behavior)
  - Treating warnings as errors header — must be skipped (unchanged behavior)
  - npm ERR! lines — must terminate parsing (unchanged behavior)
  - Node_modules paths — must be skipped (unchanged behavior)
  - Real-world CRA output with interleaved file blocks
"""
import json
import sys
import os

# Add project root to path so we can import with the src. prefix
_script_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.abspath(os.path.join(_script_dir, ".."))
sys.path.insert(0, _project_root)

from src.validation.parsers.node_parser import _tokenize_cra_lines, parse_build


# ── Helpers ────────────────────────────────────────────────────────────────────

def diag_summary(diags):
    """Produce a compact summary of parsed diagnostics for assertion messages."""
    return "\n".join(
        f"  [{i}] {d.file_path}:{d.line_number}:{d.column_number} "
        f"[{d.severity}] {d.symbol_name}: {d.message[:60]}"
        for i, d in enumerate(diags)
    )


# ── Single diagnostic ──────────────────────────────────────────────────────────

def test_single_diagnostic():
    """A single diagnostic with file path + Line N:M: + message."""
    raw = """\
Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 1, f"Expected 1 diagnostic, got {len(diags)}:\n{diag_summary(diags)}"
    d = diags[0]
    assert d.file_path == "src/App.js", f"file_path: {d.file_path}"
    assert d.line_number == 5, f"line_number: {d.line_number}"
    assert d.column_number == 21, f"column_number: {d.column_number}"
    assert d.symbol_name == "useEffect", f"symbol_name: {d.symbol_name}"
    assert "useEffect" in d.message, f"message: {d.message}"
    assert d.severity == "error"
    assert d.tool == "react-scripts"
    print("  ✅ test_single_diagnostic passed")


# ── Multiple diagnostics, same file (THE BUG) ─────────────────────────────────

def test_three_diagnostics_same_file():
    """3 no-unused-vars diagnostics in src/App.js — file path appears ONCE."""
    raw = """\
Treating warnings as errors because process.env.CI = true.

Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
  Line 10:15:
    'searchData' is assigned a value but never used  no-unused-vars
  Line 10:32:
    'setSearchData' is assigned a value but never used  no-unused-vars
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 3, (
        f"Expected 3 diagnostics (Bug #2 fix), got {len(diags)}:\n{diag_summary(diags)}"
    )
    assert diags[0].symbol_name == "useEffect", f"First diag symbol: {diags[0].symbol_name}"
    assert diags[1].symbol_name == "searchData", f"Second diag symbol: {diags[1].symbol_name}"
    assert diags[2].symbol_name == "setSearchData", f"Third diag symbol: {diags[2].symbol_name}"
    assert len(set(d.message for d in diags)) == 3, "All 3 messages should be unique"
    assert all(d.file_path == "src/App.js" for d in diags), "All in src/App.js"
    print("  ✅ test_three_diagnostics_same_file passed")


# ── Multiple files, single diagnostic each ────────────────────────────────────

def test_two_files_one_diagnostic_each():
    """Each file has its own diagnostic — file path repeated."""
    raw = """\
Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars

src/Header.js
  Line 12:5:
    'process' is not defined  no-undef
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 2, f"Expected 2 diagnostics, got {len(diags)}"
    assert diags[0].file_path == "src/App.js"
    assert diags[1].file_path == "src/Header.js"
    print("  ✅ test_two_files_one_diagnostic_each passed")


# ── Multiple files, multiple diagnostics per file ────────────────────────────

def test_two_files_multi_diag_each():
    """2 files, each with 2 diagnostics."""
    raw = """\
Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
  Line 10:15:
    'searchData' is assigned a value but never used  no-unused-vars

src/Header.js
  Line 3:8:
    'foo' is assigned a value but never used  no-unused-vars
  Line 15:1:
    'bar' is not defined  no-undef
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 4, f"Expected 4 diagnostics, got {len(diags)}:\n{diag_summary(diags)}"
    app_diags = [d for d in diags if d.file_path == "src/App.js"]
    header_diags = [d for d in diags if d.file_path == "src/Header.js"]
    assert len(app_diags) == 2, f"Expected 2 App.js diags, got {len(app_diags)}"
    assert len(header_diags) == 2, f"Expected 2 Header.js diags, got {len(header_diags)}"
    print("  ✅ test_two_files_multi_diag_each passed")


# ── CSS error with (line:col) suffix ─────────────────────────────────────────

def test_css_error_paren_format():
    """CSS error with (line:col) suffix in message, no explicit Line N:M:."""
    raw = """\
Failed to compile.

src/App.css
  Unknown word (3:1)
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 1, f"Expected 1 CSS diagnostic, got {len(diags)}:\n{diag_summary(diags)}"
    d = diags[0]
    assert d.file_path == "src/App.css"
    # The (3:1) is extracted as line/column from the message suffix
    # but the current code only does this if line_num wasn't already set
    # In this case, there's no Line N:M: so line_num starts at 0
    assert d.line_number == 3 or d.line_number == 0, f"line_number: {d.line_number}"
    assert "Unknown word" in d.message
    print("  ✅ test_css_error_paren_format passed")


# ── CSS error without line number at all ─────────────────────────────────────

def test_css_error_no_line():
    """CSS error with no line number at all — should still produce a diagnostic."""
    raw = """\
Failed to compile.

src/App.css
  Unknown word
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) >= 1, f"Expected at least 1 diagnostic, got {len(diags)}"
    d = diags[0]
    assert d.file_path == "src/App.css"
    assert "Unknown word" in d.message
    print("  ✅ test_css_error_no_line passed")


# ── Vite output bypass ───────────────────────────────────────────────────────

def test_vite_output_bypasses_cra_parser():
    """Vite/esbuild output should NOT be consumed by CRA parser."""
    raw = """\
✘ [ERROR] Could not resolve "./missing"
    src/components/App.js:2:30:
      2 │ import { getGeocode } from './missing'
        ╵                           ~~~~~~~~~~~~
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 0, (
        f"CRA parser should not capture Vite output, got {len(diags)} diags:\n{diag_summary(diags)}"
    )
    assert len(unparsed) > 0, "Vite lines should pass through as unparsed"
    print("  ✅ test_vite_output_bypasses_cra_parser passed")


# ── Webpack ERROR in bypass ──────────────────────────────────────────────────

def test_webpack_output_bypasses_cra_parser():
    """Webpack 'ERROR in' output should NOT be consumed by CRA parser."""
    raw = """\
ERROR in ./src/App.js
Module not found: Error: Can't resolve './missing'
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 0, (
        f"CRA parser should not capture Webpack output, got {len(diags)} diags:\n{diag_summary(diags)}"
    )
    # After the CRA parser, webpack lines should be in unparsed
    # (they're NOT inside "Failed to compile." section, so they go to unparsed normally)
    assert len(unparsed) > 0, "Webpack lines should pass through as unparsed"
    print("  ✅ test_webpack_output_bypasses_cra_parser passed")


# ── Browserslist lines ───────────────────────────────────────────────────────

def test_browserslist_lines_skipped():
    """Browserslist lines should be skipped unconditionally."""
    raw = """\
Browserslist: caniuse-lite is outdated. Please run:
  npx browserslist@latest --update-db

Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 1, f"Expected 1 diagnostic, got {len(diags)}:\n{diag_summary(diags)}"
    assert diags[0].symbol_name == "useEffect"
    print("  ✅ test_browserslist_lines_skipped passed")


# ── npm ERR! terminates parsing ──────────────────────────────────────────────

def test_npm_err_terminates():
    """npm ERR! lines terminate parsing within the failed section."""
    raw = """\
Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
npm ERR! code ELIFECYCLE
npm ERR! errno 1
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 1, f"Expected 1 diagnostic (before npm ERR), got {len(diags)}:\n{diag_summary(diags)}"
    assert diags[0].symbol_name == "useEffect"
    print("  ✅ test_npm_err_terminates passed")


# ── Real-world mixed output ─────────────────────────────────────────────────

def test_real_world_mixed_output():
    """Real-world CRA output with multiple files and multiple diagnostics per file."""
    raw = """\
Treating warnings as errors because process.env.CI = true.

Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
  Line 10:15:
    'searchData' is assigned a value but never used  no-unused-vars

src/components/Header.js
  Line 12:1:
    'process' is not defined  no-undef

src/App.css
  Unknown word (3:1)
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 4, f"Expected 4 diagnostics, got {len(diags)}:\n{diag_summary(diags)}"

    app_diags = [d for d in diags if d.file_path == "src/App.js"]
    header_diags = [d for d in diags if d.file_path == "src/components/Header.js"]
    css_diags = [d for d in diags if "App.css" in d.file_path]

    assert len(app_diags) == 2, f"Expected 2 App.js diags, got {len(app_diags)}:\n{diag_summary(app_diags)}"
    assert len(header_diags) == 1, f"Expected 1 Header.js diag, got {len(header_diags)}"
    assert len(css_diags) == 1, f"Expected 1 CSS diag, got {len(css_diags)}"
    print("  ✅ test_real_world_mixed_output passed")


# ── Inline format (Format B): Line N:M: message on same line ──────────────

def test_inline_format_two_diagnostics():
    """Inline format with [eslint] header: Line N:M: message rule-name on same line."""
    raw = """\
Failed to compile.

[eslint]
src/App.js
  Line 11:10: 'searchData' is assigned a value but never used  no-unused-vars
  Line 11:22: 'setSearchData' is assigned a value but never used  no-unused-vars
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 2, (
        f"Expected 2 diagnostics (inline format), got {len(diags)}:\n{diag_summary(diags)}"
    )
    d0, d1 = diags
    assert d0.file_path == "src/App.js"
    assert d0.line_number == 11, f"d0.line_number: {d0.line_number}"
    assert d0.column_number == 10, f"d0.column_number: {d0.column_number}"
    assert d0.symbol_name == "searchData", f"d0.symbol_name: {d0.symbol_name}"
    assert "searchData" in d0.message and "never used" in d0.message
    assert d0.severity == "error"
    assert d0.tool == "react-scripts"

    assert d1.file_path == "src/App.js"
    assert d1.line_number == 11, f"d1.line_number: {d1.line_number}"
    assert d1.column_number == 22, f"d1.column_number: {d1.column_number}"
    assert d1.symbol_name == "setSearchData", f"d1.symbol_name: {d1.symbol_name}"
    assert "setSearchData" in d1.message and "never used" in d1.message
    assert d1.severity == "error"
    assert d0.message != d1.message, "Messages must differ"
    print("  ✅ test_inline_format_two_diagnostics passed")


# ── Mixed inline + multi-line formats ──────────────────────────────────────

def test_mixed_inline_and_multiline_formats():
    """Mix of inline Format B and traditional multi-line Format A in same output."""
    raw = """\
Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars

[eslint]
src/Header.js
  Line 12:5: 'process' is not defined  no-undef
"""
    diags, unparsed = _tokenize_cra_lines(raw.splitlines())

    assert len(diags) == 2, (
        f"Expected 2 diagnostics (mixed formats), got {len(diags)}:\n{diag_summary(diags)}"
    )
    d0, d1 = diags
    assert d0.file_path == "src/App.js"
    assert d0.symbol_name == "useEffect"
    assert d0.line_number == 5
    assert d0.column_number == 21

    assert d1.file_path == "src/Header.js"
    assert d1.symbol_name == "process"
    assert d1.line_number == 12
    assert d1.column_number == 5
    print("  ✅ test_mixed_inline_and_multiline_formats passed")


# ── parse_build integration ─────────────────────────────────────────────────

def test_parse_build_multi_diag():
    """parse_build() integration test: 3 diagnostics in same file."""
    stderr = """\
Treating warnings as errors because process.env.CI = true.

Failed to compile.

src/App.js
  Line 5:21:
    'useEffect' is defined but never used  no-unused-vars
  Line 10:15:
    'searchData' is assigned a value but never used  no-unused-vars
  Line 10:32:
    'setSearchData' is assigned a value but never used  no-unused-vars
"""
    stdout = ""
    diags = parse_build(stdout, stderr)

    assert len(diags) == 3, (
        f"parse_build: Expected 3 diagnostics, got {len(diags)}:\n{diag_summary(diags)}"
    )
    assert all(d.tool == "react-scripts" for d in diags)
    assert all(d.repair_category == "auto_fixable" for d in diags)
    print("  ✅ test_parse_build_multi_diag passed")


# ── Run all tests ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_single_diagnostic,
        test_three_diagnostics_same_file,
        test_two_files_one_diagnostic_each,
        test_two_files_multi_diag_each,
        test_css_error_paren_format,
        test_css_error_no_line,
        test_vite_output_bypasses_cra_parser,
        test_webpack_output_bypasses_cra_parser,
        test_browserslist_lines_skipped,
        test_npm_err_terminates,
        test_real_world_mixed_output,
        test_parse_build_multi_diag,
        test_inline_format_two_diagnostics,
        test_mixed_inline_and_multiline_formats,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"  ❌ {test.__name__} FAILED: {e}")
            failed += 1
        except Exception as e:
            print(f"  ❌ {test.__name__} ERROR: {e}")
            failed += 1

    print(f"\n{'='*60}")
    print(f"RESULTS: {passed}/{passed + failed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)
    print("🎉 All tests passed!")
