package engine

import "strings"

// classify maps a raw CommandResult to a typed Outcome + FailureOrigin. This is
// the heart of "the repair engine never receives a misleading failure": it
// separates real code failures from timeouts, missing tools, environment
// problems, and empty test runs.
func Classify(cap Capability, r CommandResult) (Outcome, FailureOrigin, []Diagnostic) {
	combined := r.Stdout + "\n" + r.Stderr

	// 1. Environment / infrastructure — never a code failure; retry/escalate.
	if r.TimedOut {
		return OutcomeInfraError, OriginInfrastructure,
			diag("error", "validation", "stage exceeded its time budget and was terminated")
	}
	if r.ExitCode == 127 {
		return OutcomeInfraError, OriginTooling,
			diag("error", "validation", "required executable not found in the sandbox image")
	}
	if cat, ok := environmentSignature(combined); ok {
		return OutcomeInfraError, OriginInfrastructure,
			diag("error", "validation", "infrastructure failure: "+cat)
	}

	// 2. Success — but a test run that collected nothing is NoTests, not Passed.
	if r.ExitCode == 0 {
		if cap == CapTest && noTestsCollected(combined) {
			return OutcomeNoTests, OriginNone, nil
		}
		return OutcomePassed, OriginNone, nil
	}

	// 3. Non-zero exit with no environment signature → a real, repairable failure.
	// Lint/typecheck/build/test failures are all code/config-level for the repo.
	return OutcomeFailed, OriginCode, diag("error", string(cap), tail(combined, 4000))
}

// environmentSignature detects language-agnostic infrastructure failures in
// command output. Kept inline so the engine stays self-contained.
func environmentSignature(output string) (string, bool) {
	lower := strings.ToLower(output)
	patterns := map[string]string{
		"no space left on device": "disk full",
		"cannot allocate memory":  "out of memory",
		"out of memory":           "out of memory",
		"oom killer":              "out of memory",
		"connection refused":      "network failure",
		"could not resolve host":  "network failure",
		"network is unreachable":  "network failure",
		"connection timed out":    "network failure",
	}
	for needle, cat := range patterns {
		if strings.Contains(lower, needle) {
			return cat, true
		}
	}
	return "", false
}

// noTestsCollected reports whether a passing test run actually ran zero tests.
// Runner-agnostic phrase set (jest, pytest, go, vitest, mocha).
func noTestsCollected(output string) bool {
	lower := strings.ToLower(output)
	phrases := []string{
		"no tests found",
		"no tests ran",
		"no test files",       // go: "no test files"
		"no tests to run",
		"no test suites found",
		"0 passed, 0 failed",
		"collected 0 items",   // pytest
	}
	for _, p := range phrases {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

func diag(sev, tool, msg string) []Diagnostic {
	return []Diagnostic{{Severity: sev, Tool: tool, Message: msg}}
}

// tail returns the last n bytes of s (the most relevant part of a failure log).
func tail(s string, n int) string {
	if len(s) <= n {
		return strings.TrimSpace(s)
	}
	return "…" + strings.TrimSpace(s[len(s)-n:])
}
