// Package engine is the next-generation, repository-driven validation engine.
//
// It replaces the static profile + fixed-detection design (see
// docs/validation-engine-architecture.md) with a repository-aware pipeline:
//
//	Evidence (RepoFS) → Planning (Discovery → Resolution → Assembly) →
//	Execution (Runtime) → Result (Classifier → Verdict → RepairSignal)
//
// This file defines the shared vocabulary — the pure value types every plane
// speaks. Phase 2 introduces only these types plus RepoFS and the provider
// Registry; no behavior is wired in yet.
package engine

// Capability is a thing a repository can be validated for. Providers resolve
// capabilities into concrete commands; the classifier reports outcomes per
// capability.
type Capability string

const (
	CapInstall   Capability = "install"
	CapBuild     Capability = "build"
	CapTypecheck Capability = "typecheck"
	CapLint      Capability = "lint"
	CapTest      Capability = "test"
)

// ExecutionMode declares how a command behaves so the Runtime can treat it
// correctly — one-shot commands are expected to exit, services never do, and
// interactive commands must be neutralized (CI env, stdin closed, no TTY).
type ExecutionMode string

const (
	ModeOneShot     ExecutionMode = "one_shot"
	ModeService     ExecutionMode = "service"     // long-running; not scheduled by default
	ModeInteractive ExecutionMode = "interactive" // must be neutralized before running
)

// SupportState is the PLANNING-time verdict for a capability on a unit: whether
// we found a legitimate command to run, and if not, why. It is distinct from
// the execution Outcome (below) — a capability is first resolved to a support
// state, and only Supported capabilities are executed.
type SupportState string

const (
	StateSupported     SupportState = "supported"     // resolved to a concrete command
	StateUnsupported   SupportState = "unsupported"   // repo genuinely doesn't do this
	StateMisconfigured SupportState = "misconfigured" // tool present but config missing/invalid
	StateSkipped       SupportState = "skipped"       // intentionally not run (gated/integration)
)

// Provenance records WHY a command was chosen — the rung of the precedence
// ladder it came from. Higher rungs win during assembly. (CI config is a future
// rung, deliberately absent in v1.)
type Provenance string

const (
	ProvManifest  Provenance = "manifest"       // .forge/validation.yaml (explicit intent)
	ProvScript    Provenance = "package_script" // repo's declared script (npm run lint, …)
	ProvInference Provenance = "tool_inference" // dependency + matching config present
)

// Claim is a provider's statement of relevance to a unit.
type Claim struct {
	Relevant   bool
	Confidence float64 // 0..1
	Reason     string
}

// Resolution is a provider's proposal for a single capability on a single unit.
// Exactly one resolution per capability survives assembly (highest provenance /
// confidence wins). When State != Supported, Command is empty and Reason
// explains the decision — this is what keeps the repair engine from ever seeing
// a fabricated command.
type Resolution struct {
	Capability Capability
	State      SupportState
	Command    []string          // argv (never a shell string); empty unless Supported
	Mode       ExecutionMode     // defaults to one-shot for Supported commands
	TimeoutSec int               // 0 → planner default
	Env        map[string]string // command-specific overrides (layered over the runtime baseline)
	WorkingDir string            // relative to the unit root; "" == unit root
	Provenance Provenance
	Confidence float64 // 0..1
	Reason     string  // human-readable justification (required for non-Supported states)
	ProviderID string  // provider that produced this resolution
}

// Unit is a Validation Unit — a single project root within a repository. A repo
// yields 1..N units (monorepos/workspaces/cross-language). v1 executes only the
// single-unit case, but the abstraction is present from day one so multi-unit
// is additive, not a redesign.
type Unit struct {
	ID        string   // stable id (derived from Path)
	Path      string   // repo-relative root; "." for the single-unit case
	Languages []string // candidate languages found during discovery
}

// HasLanguage reports whether the unit targets a language. Providers gate on
// this so a repo that happens to contain markers for several languages only
// gets planned for the one this unit targets (the sandbox image is
// single-language until multi-unit execution lands).
func (u Unit) HasLanguage(lang string) bool {
	for _, l := range u.Languages {
		if l == lang {
			return true
		}
	}
	return false
}

// ── Result vocabulary (used by the Classifier / repair contract) ─────────────

// Outcome is the EXECUTION-time result of a stage — the 7-state taxonomy the
// repair engine consumes. It is deliberately richer than pass/fail so that
// "unsupported", "misconfigured", and "no tests" are never mistaken for a real
// code failure.
type Outcome string

const (
	OutcomePassed        Outcome = "passed"
	OutcomeFailed        Outcome = "failed"
	OutcomeNoTests       Outcome = "no_tests"
	OutcomeSkipped       Outcome = "skipped"
	OutcomeUnsupported   Outcome = "unsupported"
	OutcomeMisconfigured Outcome = "misconfigured"
	OutcomeInfraError    Outcome = "infrastructure_error"
	OutcomeCached        Outcome = "cached" // stage not re-run; previous result reused (incremental validation)
)

// FailureOrigin attributes a failing outcome to a layer, so the repair
// orchestrator can route the response (repair code vs fix config vs retry).
type FailureOrigin string

const (
	OriginNone           FailureOrigin = ""
	OriginCode           FailureOrigin = "code"
	OriginConfiguration  FailureOrigin = "configuration"
	OriginInfrastructure FailureOrigin = "infrastructure"
	OriginTooling        FailureOrigin = "tooling"
)

// Diagnostic is a single structured finding. The repair engine consumes these,
// never raw terminal output.
type Diagnostic struct {
	Severity string // error | warning | info
	File     string // repo-relative, if known
	Line     int    // 0 if unknown
	Column   int    // 0 if unknown
	Rule     string // tool rule/code, if any
	Message  string
	Tool     string // producing tool (eslint, tsc, pytest, …)
}

// RepairSignal is the contract handed to the repair orchestrator for one
// capability. It carries structured meaning only — no raw command output.
type RepairSignal struct {
	Capability  Capability
	Outcome     Outcome
	Origin      FailureOrigin
	Diagnostics []Diagnostic
}
