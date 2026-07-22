package engine

import (
	"context"
	"fmt"
	"strings"
)

// ── Plan types (assembly output) ─────────────────────────────────────────────

// StageSpec is one resolved capability, ready to execute. When State !=
// Supported it carries no command — the Runtime skips it and the Classifier
// reports the corresponding non-run Outcome.
type StageSpec struct {
	Capability Capability
	State      SupportState
	Command    []string
	Mode       ExecutionMode
	TimeoutSec int
	Env        map[string]string
	WorkingDir string
	DependsOn  []Capability
	Provenance Provenance
	Confidence float64
	Reason     string
	ProviderID string
}

// UnitPlan is the ordered plan for one validation unit.
type UnitPlan struct {
	Unit   Unit
	Stages []StageSpec
}

// ValidationPlan is the full, pure, inspectable plan for a repository. It has no
// behavior — it is produced by planning and consumed by execution. (Content
// hashing / caching is a later phase.)
type ValidationPlan struct {
	Units []UnitPlan
}

// capabilityOrder is the fixed evaluation order; also the base for DAG edges.
var capabilityOrder = []Capability{CapInstall, CapBuild, CapTypecheck, CapLint, CapTest}

// dependsOn encodes intra-unit ordering. install gates everything; test also
// waits on build (a broken build makes tests meaningless); lint/typecheck only
// need install (they should still run when the build fails, to surface issues).
func dependsOn(cap Capability) []Capability {
	switch cap {
	case CapInstall:
		return nil
	case CapBuild, CapLint, CapTypecheck:
		return []Capability{CapInstall}
	case CapTest:
		return []Capability{CapInstall, CapBuild}
	default:
		return []Capability{CapInstall}
	}
}

func defaultTimeout(cap Capability) int {
	switch cap {
	case CapInstall, CapBuild:
		return 180
	case CapTest:
		return 300
	case CapLint, CapTypecheck:
		return 120
	default:
		return 120
	}
}

// provenanceRank ranks the precedence ladder (higher wins). Manifest is defined
// for completeness though v1 has no manifest provider yet.
func provenanceRank(p Provenance) int {
	switch p {
	case ProvManifest:
		return 3
	case ProvScript:
		return 2
	case ProvInference:
		return 1
	default:
		return 0
	}
}

// DefaultRegistry returns the built-in provider set. Adding a language is a
// single extra registration here — no other change to the engine.
func DefaultRegistry() *Registry {
	r := NewRegistry()
	RegisterManifestProvider(r) // top of the precedence ladder
	RegisterNodeProviders(r)
	RegisterGoProviders(r)
	RegisterPythonProviders(r)
	return r
}

// PlanForLanguage plans a single root unit scoped to exactly one language. This
// is the entry point the orchestrator uses, since the legacy detector has
// already chosen the primary language + matching sandbox image; it prevents
// cross-language contamination (e.g. running go commands in a node image) until
// true multi-unit execution exists.
func PlanForLanguage(ctx context.Context, fs *RepoFS, reg *Registry, language string) ValidationPlan {
	unit := Unit{ID: "root", Path: ".", Languages: []string{language}}
	return ValidationPlan{Units: []UnitPlan{planUnit(ctx, fs, reg, unit)}}
}

// Discover finds the validation units in a repository. v1 handles the common
// single-unit case (the repo root) but returns a slice so multi-unit is
// additive. Candidate languages are tagged from root markers.
func Discover(ctx context.Context, fs *RepoFS) []Unit {
	unit := Unit{ID: "root", Path: "."}
	markers := []struct {
		file string
		lang string
	}{
		{"package.json", "javascript"},
		{"go.mod", "go"},
		{"pyproject.toml", "python"},
		{"requirements.txt", "python"},
	}
	for _, m := range markers {
		if ok, _ := fs.Exists(ctx, m.file); ok {
			unit.Languages = append(unit.Languages, m.lang)
		}
	}
	if len(unit.Languages) == 0 {
		return nil // nothing recognizable at the root
	}
	return []Unit{unit}
}

// Plan builds the full ValidationPlan: Discovery → Resolution → Assembly. It is
// pure (no execution, no side effects) and deterministic for a given repository.
func Plan(ctx context.Context, fs *RepoFS, reg *Registry) ValidationPlan {
	var plan ValidationPlan
	for _, unit := range Discover(ctx, fs) {
		plan.Units = append(plan.Units, planUnit(ctx, fs, reg, unit))
	}
	return plan
}

func planUnit(ctx context.Context, fs *RepoFS, reg *Registry, unit Unit) UnitPlan {
	// Resolution: only providers that claim relevance participate.
	relevant := make([]Provider, 0)
	for _, p := range reg.Providers() {
		if p.Detect(ctx, unit, fs).Relevant {
			relevant = append(relevant, p)
		}
	}

	up := UnitPlan{Unit: unit}
	for _, cap := range capabilityOrder {
		// Gather every provider's resolution for this capability.
		var candidates []Resolution
		for _, p := range relevant {
			candidates = append(candidates, p.Resolve(ctx, cap, unit, fs)...)
		}
		up.Stages = append(up.Stages, assemble(cap, candidates))
	}
	return up
}

// assemble picks the winning resolution for a capability and turns it into a
// StageSpec. Precedence:
//  1. The manifest is authoritative — if it addresses the capability (a command
//     OR an explicit skip), it wins outright over scripts and inference.
//  2. Otherwise the best Supported resolution wins (provenance, then confidence).
//  3. Otherwise a Misconfigured resolution is surfaced (so it's reported, not
//     silently dropped).
//  4. Otherwise the capability is Unsupported.
func assemble(cap Capability, candidates []Resolution) StageSpec {
	base := StageSpec{Capability: cap, DependsOn: dependsOn(cap)}

	// 1. Manifest authority (covers Supported and explicit Skipped).
	for i := range candidates {
		if candidates[i].Provenance == ProvManifest {
			return applyResolution(base, candidates[i])
		}
	}

	// 2/3. Best Supported, else Misconfigured.
	var best, misconfigured *Resolution
	for i := range candidates {
		c := &candidates[i]
		switch c.State {
		case StateSupported:
			if best == nil || better(*c, *best) {
				best = c
			}
		case StateMisconfigured:
			if misconfigured == nil || c.Confidence > misconfigured.Confidence {
				misconfigured = c
			}
		}
	}
	switch {
	case best != nil:
		return applyResolution(base, *best)
	case misconfigured != nil:
		return applyResolution(base, *misconfigured)
	default:
		base.State = StateUnsupported
		base.Reason = "no provider resolved this capability for the repository"
		return base
	}
}

// applyResolution copies a chosen resolution onto a stage, filling execution
// fields only for Supported commands.
func applyResolution(base StageSpec, r Resolution) StageSpec {
	base.State = r.State
	base.Command = r.Command
	base.Provenance = r.Provenance
	base.Confidence = r.Confidence
	base.Reason = r.Reason
	base.ProviderID = r.ProviderID
	if r.State == StateSupported {
		base.Mode = orDefaultMode(r.Mode)
		base.TimeoutSec = orDefault(r.TimeoutSec, defaultTimeout(base.Capability))
		base.Env = r.Env
		base.WorkingDir = r.WorkingDir
	}
	return base
}

func better(a, b Resolution) bool {
	ra, rb := provenanceRank(a.Provenance), provenanceRank(b.Provenance)
	if ra != rb {
		return ra > rb
	}
	return a.Confidence > b.Confidence
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func orDefaultMode(m ExecutionMode) ExecutionMode {
	if m == "" {
		return ModeOneShot
	}
	return m
}

// Summary renders a compact, human-readable view of the plan for shadow-mode
// logging and diffing.
func (p ValidationPlan) Summary() string {
	var b strings.Builder
	if len(p.Units) == 0 {
		return "(no validation units discovered)"
	}
	for _, u := range p.Units {
		fmt.Fprintf(&b, "unit %s [%s]:\n", u.Unit.Path, strings.Join(u.Unit.Languages, ","))
		for _, s := range u.Stages {
			switch s.State {
			case StateSupported:
				fmt.Fprintf(&b, "  %-9s %-11s %v (%s)\n", s.Capability, s.State, s.Command, s.Provenance)
			default:
				fmt.Fprintf(&b, "  %-9s %-11s — %s\n", s.Capability, s.State, s.Reason)
			}
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
