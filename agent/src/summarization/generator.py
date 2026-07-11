"""
Phase 10: Summary generation logic.

Generates commit messages and PR descriptions from structured execution data.
Uses the configured LLM provider for natural-language generation.
Falls back to template-based generation if the LLM is unavailable.
"""
from __future__ import annotations

from src.llm.chat_factory import get_chat_provider
from src.config import settings


def generate_commit_message(
    intent: str,
    diffs: list,
    validation_result: str | None = None,
) -> tuple[str, str]:
    """Generate a commit subject + body from execution data.

    Returns:
        (subject, body) — subject is ≤72 chars, body has details.
    """
    # Build context for the LLM
    file_changes = []
    for d in diffs:
        op = d.operation if hasattr(d, "operation") else d.get("operation", "modify")
        path = d.file_path if hasattr(d, "file_path") else d.get("file_path", "")
        added = d.lines_added if hasattr(d, "lines_added") else d.get("lines_added", 0)
        removed = d.lines_removed if hasattr(d, "lines_removed") else d.get("lines_removed", 0)
        file_changes.append(f"  {op}: {path} (+{added}/-{removed})")

    files_section = "\n".join(file_changes) if file_changes else "  (no files)"

    prompt = f"""Generate a git commit message for the following change.

Intent: {intent}

Files changed:
{files_section}

Validation: {validation_result or 'passed'}

Rules:
- Subject line: imperative mood, ≤72 characters, no trailing period
- Body: 1-3 sentences explaining what was done and why
- Do NOT include file lists in the body (they're in the diff)
- Be specific about what changed, not generic

Output format (exactly):
SUBJECT: <subject line>
BODY: <body text>
"""

    try:
        provider = get_chat_provider()
        response = provider.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=256,
        )
        return _parse_commit_response(response, intent)
    except Exception:
        # Fallback: template-based
        subject = _truncate(intent, 72)
        body = f"Automated implementation by Forge Engine.\n\nFiles changed: {len(diffs)}"
        if validation_result:
            body += f"\nValidation: {validation_result}"
        return subject, body


def generate_pr_description(
    intent: str,
    diffs: list,
    plan_summary: str = "",
    steps: list | None = None,
    validation_result: str | None = None,
    repair_history: list | None = None,
    work_item_id: str = "",
    task_execution_id: str = "",
) -> tuple[str, str]:
    """Generate a PR title + body from execution data.

    Returns:
        (title, body) — title is concise, body is full GitHub Markdown.
    """
    file_changes = []
    total_added = 0
    total_removed = 0
    for d in diffs:
        path = d.file_path if hasattr(d, "file_path") else d.get("file_path", "")
        op = d.operation if hasattr(d, "operation") else d.get("operation", "modify")
        added = d.lines_added if hasattr(d, "lines_added") else d.get("lines_added", 0)
        removed = d.lines_removed if hasattr(d, "lines_removed") else d.get("lines_removed", 0)
        total_added += added
        total_removed += removed
        file_changes.append(f"| `{path}` | {op} | +{added}/-{removed} |")

    files_table = "\n".join(file_changes) if file_changes else "| (none) | — | — |"

    # Build step summary
    step_lines = ""
    if steps:
        for i, s in enumerate(steps, 1):
            title = s.get("title", s.get("description", f"Step {i}"))
            step_lines += f"{i}. {title}\n"

    # Build repair section
    repair_section = ""
    if repair_history:
        repair_section = "\n## 🔧 Repair History\n\n"
        for attempt in repair_history:
            num = attempt.get("attempt_number", "?")
            outcome = attempt.get("outcome", "unknown")
            repair_section += f"- Attempt {num}: {outcome}\n"

    prompt = f"""Generate a Pull Request title and description for the following implementation.

Intent: {intent}
Plan summary: {plan_summary or 'N/A'}
Files changed: {len(diffs)} (+{total_added}/-{total_removed})
Validation: {validation_result or 'passed'}

Rules:
- Title: concise (≤72 chars), describes the change not the process
- Description: GitHub Markdown, structured with sections
- Include: summary, what changed, validation status
- Do NOT include raw diffs or code
- Be factual — never invent details not in the input

Output format (exactly):
TITLE: <title>
DESCRIPTION:
<full markdown body>
"""

    try:
        provider = get_chat_provider()
        response = provider.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=1024,
        )
        title, body = _parse_pr_response(response, intent)
    except Exception:
        title = _truncate(intent, 72)
        body = ""

    # Always append structured metadata sections (not LLM-generated)
    metadata_body = f"""
## 📋 Summary

{body if body else intent}

## 📁 Changed Files

| File | Operation | Lines |
|------|-----------|-------|
{files_table}

**Total:** +{total_added}/-{total_removed} across {len(diffs)} file(s)

## ✅ Validation

Result: **{validation_result or 'passed'}**
{repair_section}
## 🔗 Implementation Plan

{step_lines if step_lines else '_Single-step implementation_'}

---

<details>
<summary>Forge Engine Metadata</summary>

- Work Item: `{work_item_id}`
- Execution: `{task_execution_id}`
- Generated by [Forge Engine](https://github.com/charkhaniakash/forge-engine)

</details>
"""

    return title, metadata_body


def _parse_commit_response(response: str, fallback_intent: str) -> tuple[str, str]:
    """Parse LLM response into subject + body."""
    lines = response.strip().split("\n")
    subject = fallback_intent
    body = ""

    for i, line in enumerate(lines):
        if line.startswith("SUBJECT:"):
            subject = line[len("SUBJECT:"):].strip()
        elif line.startswith("BODY:"):
            body = "\n".join(lines[i:]).replace("BODY:", "", 1).strip()
            break

    return _truncate(subject, 72), body


def _parse_pr_response(response: str, fallback_intent: str) -> tuple[str, str]:
    """Parse LLM response into title + description."""
    lines = response.strip().split("\n")
    title = fallback_intent
    body = ""

    for i, line in enumerate(lines):
        if line.startswith("TITLE:"):
            title = line[len("TITLE:"):].strip()
        elif line.startswith("DESCRIPTION:"):
            body = "\n".join(lines[i + 1:]).strip()
            break

    return _truncate(title, 72), body


def _truncate(s: str, max_len: int) -> str:
    """Truncate string to max_len."""
    if len(s) <= max_len:
        return s
    return s[:max_len - 3] + "..."
