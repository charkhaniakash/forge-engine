"""
FailureDiagnosis — deterministic failure classification for Phase 8.

When a validation stage fails, this module examines:
  - stderr / stdout content
  - exit code
  - repository evidence (engines field, .nvmrc, lockfiles, etc.)

And classifies the failure as one of:
  "environment" — the execution environment cannot run this project
                  (wrong runtime version, missing system package, etc.)
  "code"        — the repository's code/tests are genuinely failing
  "unknown"     — insufficient evidence to classify

Rules:
  - All classification is deterministic pattern matching. No LLM calls.
  - Never misclassify a code failure as an environment failure.
  - When uncertain, return "unknown" rather than guess.
  - Each classification includes a human-readable explanation.

This module never modifies code or performs repairs. It only classifies.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import structlog

from src.validation.models import RepoEvidence

logger = structlog.get_logger()


@dataclass
class DiagnosisResult:
    """Result of a failure classification."""
    failure_origin: str      # "environment" | "code" | "unknown"
    failure_class: str       # short slug: "runtime_version_mismatch", "missing_package", etc.
    explanation: str         # human-readable explanation for the UI
    confidence: float        # 0.0–1.0


# ── Environment failure patterns ──────────────────────────────────────────────
# Each entry: (regex, failure_class, explanation_template)
# Applied in order; first match wins.

_NODE_ENV_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    # node-sass, canvas, bcrypt, etc. require native build tools
    (re.compile(r"gyp ERR!", re.IGNORECASE),
     "native_build_failure",
     "A native Node.js module failed to compile. This requires system build tools "
     "(make, g++, python2) that are not available in the validation container. "
     "Consider replacing the native dependency or pre-building it."),

    # node-sass + Node 17+ incompatibility
    (re.compile(r"node-sass.*does not yet support.*Node", re.IGNORECASE),
     "runtime_version_mismatch",
     "node-sass is not compatible with the Node version in the sandbox. "
     "This is an environment mismatch, not a code error. "
     "Consider migrating to sass (the pure-JS replacement)."),

    # Generic version mismatch
    (re.compile(r"engine.*node.*incompatible|requires node.*>=|unsupported engine", re.IGNORECASE),
     "runtime_version_mismatch",
     "The package requires a different Node.js version than what is available "
     "in the validation container. This is an environment limitation."),

    # peer dep conflicts (npm 7+)
    (re.compile(r"ERESOLVE|peer dep.*conflict|conflicting peer dependency", re.IGNORECASE),
     "dependency_conflict",
     "npm detected peer dependency conflicts. This is an environment/dependency "
     "issue that may not reflect a code change. The conflict may pre-exist."),

    # network / registry failures
    (re.compile(r"ENOTFOUND|ETIMEDOUT|network error|registry.*unreachable|getaddrinfo", re.IGNORECASE),
     "network_restriction",
     "npm could not reach the registry. The validation container runs with "
     "restricted network access. Pre-bundled or offline-mode packages are required."),

    # missing system package (ldconfig, libssl, etc.)
    (re.compile(r"cannot find.*\.so\.|ldconfig|ENOENT.*lib|libssl|libc\.so", re.IGNORECASE),
     "missing_system_library",
     "A required system library is missing from the validation container. "
     "This is an environment dependency issue."),

    # missing build tools
    (re.compile(r"make: not found|g\+\+: not found|python: not found|command not found.*make", re.IGNORECASE),
     "missing_build_tool",
     "A required build tool (make, g++, python) is not available in the container."),
]

_PYTHON_ENV_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"requires.*python.*>=|python_requires", re.IGNORECASE),
     "runtime_version_mismatch",
     "The package requires a different Python version than what is installed."),

    (re.compile(r"error: command.*gcc.*failed|error: Microsoft Visual C\+\+", re.IGNORECASE),
     "native_build_failure",
     "A C extension could not be compiled. The validation container may be "
     "missing build tools."),

    (re.compile(r"Could not find a version that satisfies|No matching distribution", re.IGNORECASE),
     "package_unavailable",
     "pip could not find a package version that satisfies the requirements. "
     "This may be a network restriction or a package that targets a different "
     "Python version."),
]

_GO_ENV_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"go: module.*requires go.*\d+\.\d+", re.IGNORECASE),
     "runtime_version_mismatch",
     "The module requires a newer Go version than what is installed in the sandbox."),

    (re.compile(r"lookup.*no such host|dial tcp.*connection refused", re.IGNORECASE),
     "network_restriction",
     "go mod download could not reach the module proxy. The sandbox runs with "
     "restricted network access."),
]


# ── Node version mismatch from .nvmrc / engines field ─────────────────────────

_NODE_VERSION_RE = re.compile(r"v?(\d+)\.\d+")


def _node_version_mismatch(evidence: RepoEvidence | None) -> DiagnosisResult | None:
    """Detect Node version mismatch using repository metadata."""
    if not evidence:
        return None

    sandbox_ver_str = evidence.node_version_in_sandbox.strip().lstrip("v")
    if not sandbox_ver_str:
        return None
    sandbox_major_m = re.match(r"(\d+)", sandbox_ver_str)
    if not sandbox_major_m:
        return None
    sandbox_major = int(sandbox_major_m.group(1))

    # Check .nvmrc / .node-version
    required_str = evidence.node_version_file.strip().lstrip("v")
    if required_str:
        req_m = re.match(r"(\d+)", required_str)
        if req_m:
            required_major = int(req_m.group(1))
            if required_major != sandbox_major:
                return DiagnosisResult(
                    failure_origin="environment",
                    failure_class="runtime_version_mismatch",
                    explanation=(
                        f"The repository targets Node {required_major} "
                        f"(from {'.nvmrc' if evidence.node_version_file else '.node-version'}), "
                        f"but the validation sandbox provides Node {sandbox_major}. "
                        f"This is an environment mismatch, not a code error."
                    ),
                    confidence=0.95,
                )

    # Check package.json "engines" field
    engines = evidence.engines_field.strip()
    if engines:
        # e.g. {"node": ">=16 <18"} or {"node": "^18"}
        node_range_m = re.search(r'"node"\s*:\s*"([^"]+)"', engines)
        if node_range_m:
            node_range = node_range_m.group(1)
            # Check if sandbox version is explicitly excluded
            # Simple heuristic: look for "<N" where N <= sandbox_major
            lt_m = re.search(r"<\s*(\d+)", node_range)
            if lt_m and int(lt_m.group(1)) <= sandbox_major:
                return DiagnosisResult(
                    failure_origin="environment",
                    failure_class="runtime_version_mismatch",
                    explanation=(
                        f"package.json engines field requires Node {node_range!r}, "
                        f"but the validation sandbox provides Node {sandbox_major}. "
                        f"This is an environment mismatch, not a code error."
                    ),
                    confidence=0.9,
                )

    return None


# ── Main diagnosis entry point ─────────────────────────────────────────────────

class FailureDiagnosis:
    """Classifies stage failures as environment or code issues.

    All methods are synchronous and deterministic — no LLM calls.
    """

    def diagnose(
        self,
        stage: str,
        stack: str,
        exit_code: int,
        stdout: str,
        stderr: str,
        combined: str,
        evidence: RepoEvidence | None,
    ) -> DiagnosisResult:
        """Classify a failed stage.

        Returns a DiagnosisResult. When the origin is "environment", the
        ValidationParser will produce diagnostics with repair_category=
        "environment_limitation" instead of "auto_fixable", and the overall
        result will use "failed_environment" rather than "failed_repairable".
        """
        if exit_code == 0:
            # Caller should not call diagnose for passing stages.
            return DiagnosisResult(
                failure_origin="unknown",
                failure_class="no_failure",
                explanation="Stage passed.",
                confidence=1.0,
            )

        stack_lower = stack.lower()
        text = (stderr + "\n" + stdout).strip()

        # ── Check evidence-based version mismatch first (highest confidence) ──
        if stack_lower in ("javascript", "node"):
            version_result = _node_version_mismatch(evidence)
            if version_result:
                logger.info(
                    "failure_diagnosis_environment",
                    stage=stage,
                    stack=stack,
                    class_=version_result.failure_class,
                    confidence=version_result.confidence,
                )
                return version_result

        # ── Apply stack-specific pattern matching ─────────────────────────────
        patterns = {
            "go": _GO_ENV_PATTERNS,
            "javascript": _NODE_ENV_PATTERNS,
            "node": _NODE_ENV_PATTERNS,
            "python": _PYTHON_ENV_PATTERNS,
        }.get(stack_lower, [])

        for pattern, failure_class, explanation in patterns:
            if pattern.search(text):
                result = DiagnosisResult(
                    failure_origin="environment",
                    failure_class=failure_class,
                    explanation=explanation,
                    confidence=0.85,
                )
                logger.info(
                    "failure_diagnosis_environment",
                    stage=stage,
                    stack=stack,
                    class_=failure_class,
                    pattern=pattern.pattern[:60],
                )
                return result

        # ── Exit code 127 is always an environment failure ────────────────────
        if exit_code == 127:
            return DiagnosisResult(
                failure_origin="environment",
                failure_class="missing_executable",
                explanation=(
                    "A required executable was not found in the validation container. "
                    "This is an environment setup issue, not a code error."
                ),
                confidence=1.0,
            )

        # ── Exit code 137 = OOM kill ──────────────────────────────────────────
        if exit_code == 137:
            return DiagnosisResult(
                failure_origin="environment",
                failure_class="oom_killed",
                explanation=(
                    "The validation process was killed by the OS (exit 137). "
                    "This typically indicates an out-of-memory condition in the "
                    "validation container, not a code error."
                ),
                confidence=0.9,
            )

        # ── No environment pattern matched — likely a code failure ─────────────
        logger.info(
            "failure_diagnosis_code",
            stage=stage,
            stack=stack,
            exit_code=exit_code,
        )
        return DiagnosisResult(
            failure_origin="code",
            failure_class="code_error",
            explanation=(
                f"Stage '{stage}' failed with exit code {exit_code}. "
                "No environment failure pattern was matched. "
                "This is likely caused by a code issue in the repository."
            ),
            confidence=0.75,
        )
