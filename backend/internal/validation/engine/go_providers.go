package engine

import (
	"context"
	"path"
)

// Go provider set. Go is convention-driven (no per-repo script block), so
// install/build/test come from the standard toolchain and lint is inferred from
// a golangci-lint config. Adding these is a pure registration — no engine change.

func isGoUnit(ctx context.Context, fs *RepoFS, unit Unit) bool {
	if !unit.HasLanguage("go") {
		return false
	}
	ok, _ := fs.Exists(ctx, path.Join(unit.Path, "go.mod"))
	return ok
}

// ── Language ────────────────────────────────────────────────────────────────

type goLanguageProvider struct{}

func (goLanguageProvider) ID() string         { return "go.language" }
func (goLanguageProvider) Kind() ProviderKind { return KindLanguage }
func (goLanguageProvider) Signals() []Signal  { return []Signal{{Pattern: "go.mod"}} }
func (goLanguageProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	if isGoUnit(ctx, fs, unit) {
		return Claim{Relevant: true, Confidence: 1.0, Reason: "go.mod present"}
	}
	return Claim{}
}
func (goLanguageProvider) Resolve(context.Context, Capability, Unit, *RepoFS) []Resolution {
	return nil
}

// ── Toolchain: install / build / test (standard go commands) ──────────────────

type goToolchainProvider struct{}

func (goToolchainProvider) ID() string         { return "go.toolchain" }
func (goToolchainProvider) Kind() ProviderKind { return KindTool }
func (goToolchainProvider) Signals() []Signal  { return []Signal{{Pattern: "go.mod"}} }
func (goToolchainProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isGoUnit(ctx, fs, unit)}
}
func (p goToolchainProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if !isGoUnit(ctx, fs, unit) {
		return nil
	}
	mk := func(cmd []string, t int, reason string) []Resolution {
		return []Resolution{{
			Capability: cap, State: StateSupported, Command: cmd, Mode: ModeOneShot,
			TimeoutSec: t, Provenance: ProvInference, Confidence: 1.0,
			Reason: reason, ProviderID: p.ID(),
		}}
	}
	switch cap {
	case CapInstall:
		return mk([]string{"go", "mod", "download"}, 180, "go module download")
	case CapBuild:
		return mk([]string{"go", "build", "./..."}, 180, "go build (all packages)")
	case CapTest:
		return mk([]string{"go", "test", "./..."}, 300, "go test (all packages)")
	default:
		return nil
	}
}

// ── Lint: golangci-lint (inference) ──────────────────────────────────────────

type goLintProvider struct{}

func (goLintProvider) ID() string         { return "go.golangcilint" }
func (goLintProvider) Kind() ProviderKind { return KindTool }
func (goLintProvider) Signals() []Signal  { return []Signal{{Pattern: ".golangci.*"}} }
func (goLintProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isGoUnit(ctx, fs, unit)}
}
func (p goLintProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapLint || !isGoUnit(ctx, fs, unit) {
		return nil
	}
	// Only lint when the repo declares golangci-lint config — don't impose a
	// linter the project hasn't opted into (go build/vet already catch the rest).
	if !hasAnyConfig(ctx, fs, unit.Path, ".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json") {
		return nil
	}
	return []Resolution{{
		Capability: CapLint, State: StateSupported,
		Command: []string{"golangci-lint", "run"}, Mode: ModeOneShot,
		TimeoutSec: 180, Provenance: ProvInference, Confidence: 0.9,
		Reason: "golangci-lint config present", ProviderID: p.ID(),
	}}
}

// RegisterGoProviders adds the built-in Go provider set to a registry.
func RegisterGoProviders(r *Registry) {
	r.Register(goLanguageProvider{})
	r.Register(goToolchainProvider{})
	r.Register(goLintProvider{})
}
