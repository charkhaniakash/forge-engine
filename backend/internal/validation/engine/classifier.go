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

	// 3. Non-zero exit: check for "no tests found" before treating as a real
	// failure. react-scripts and some other runners exit 1 (not 0) when they
	// find no test files — that is advisory, not a code error, and must NOT
	// trigger the repair loop.
	if cap == CapTest && noTestsCollected(combined) {
		return OutcomeNoTests, OriginNone, nil
	}

	// 4. Non-zero exit with no environment signature → a real, repairable failure.
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

// noTestsCollected reports whether a test run found no test files/cases.
// Runner-agnostic phrase set — covers jest, react-scripts, pytest, go test,
// vitest, mocha.  Checked for both exit 0 (some runners) and exit 1 (react-
// scripts / jest when --passWithNoTests is absent).
func noTestsCollected(output string) bool {
	lower := strings.ToLower(output)
	phrases := []string{
		"no tests found",          // react-scripts / jest (exit 1)
		"no tests ran",
		"no test files",           // go test: "no test files"
		"no tests to run",
		"no test suites found",    // jest
		"0 passed, 0 failed",
		"collected 0 items",       // pytest
		"run with `--passwithonotests` to exit with code 0", // jest hint line
		"passwithonotests",        // substring of the flag name in any context
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
