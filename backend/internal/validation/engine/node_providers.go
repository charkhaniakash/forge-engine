package engine

import (
	"context"
	"path"
)

// This file implements the Node provider set. Each provider owns exactly one
// piece of knowledge and is registered independently — adding Biome, Oxlint,
// bun, Ava, etc. is a new provider here, never an edit to a switch or profile.

// isNodeUnit reports whether a unit is a Node project the planner should handle:
// it targets JavaScript and has a package.json. The language gate keeps a
// mixed-marker repo from being planned for the wrong toolchain.
func isNodeUnit(ctx context.Context, fs *RepoFS, unit Unit) bool {
	if !unit.HasLanguage("javascript") {
		return false
	}
	ok, _ := fs.Exists(ctx, path.Join(unit.Path, "package.json"))
	return ok
}

// ── Language ────────────────────────────────────────────────────────────────

type nodeLanguageProvider struct{}

func (nodeLanguageProvider) ID() string             { return "node.language" }
func (nodeLanguageProvider) Kind() ProviderKind     { return KindLanguage }
func (nodeLanguageProvider) Signals() []Signal      { return []Signal{{Pattern: "package.json"}} }
func (nodeLanguageProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	if isNodeUnit(ctx, fs, unit) {
		return Claim{Relevant: true, Confidence: 1.0, Reason: "package.json present"}
	}
	return Claim{}
}
func (nodeLanguageProvider) Resolve(context.Context, Capability, Unit, *RepoFS) []Resolution {
	return nil
}

// ── Package manager (resolves install) ───────────────────────────────────────

type nodePackageManagerProvider struct{}

func (nodePackageManagerProvider) ID() string         { return "node.packagemanager" }
func (nodePackageManagerProvider) Kind() ProviderKind { return KindPackageManager }
func (nodePackageManagerProvider) Signals() []Signal {
	return []Signal{{Pattern: "package.json"}, {Pattern: "*lock*"}}
}
func (nodePackageManagerProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	if isNodeUnit(ctx, fs, unit) {
		pm := detectPackageManager(ctx, fs, unit.Path)
		return Claim{Relevant: true, Confidence: 1.0, Reason: "package manager: " + pm.Name}
	}
	return Claim{}
}
func (p nodePackageManagerProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapInstall || !isNodeUnit(ctx, fs, unit) {
		return nil
	}
	pm := detectPackageManager(ctx, fs, unit.Path)
	return []Resolution{{
		Capability: CapInstall,
		State:      StateSupported,
		Command:    pm.Install,
		Mode:       ModeOneShot,
		TimeoutSec: 180,
		Provenance: ProvInference,
		Confidence: 1.0,
		Reason:     "install via detected package manager: " + pm.Name,
		ProviderID: p.ID(),
	}}
}

// ── Package scripts (repo convention — highest non-manifest precedence) ───────

type nodeScriptProvider struct{}

func (nodeScriptProvider) ID() string         { return "node.scripts" }
func (nodeScriptProvider) Kind() ProviderKind { return KindTool }
func (nodeScriptProvider) Signals() []Signal  { return []Signal{{Pattern: "package.json"}} }
func (nodeScriptProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	if isNodeUnit(ctx, fs, unit) {
		return Claim{Relevant: true, Confidence: 1.0}
	}
	return Claim{}
}

// scriptNamesFor maps a capability to the package.json script names to look for,
// in priority order.
func scriptNamesFor(cap Capability) []string {
	switch cap {
	case CapBuild:
		return []string{"build"}
	case CapTest:
		return []string{"test"}
	case CapLint:
		return []string{"lint"}
	case CapTypecheck:
		return []string{"typecheck", "type-check", "tsc"}
	default:
		return nil
	}
}

func (p nodeScriptProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	names := scriptNamesFor(cap)
	if names == nil || !isNodeUnit(ctx, fs, unit) {
		return nil
	}
	pj := readPackageJSON(ctx, fs, unit.Path)
	if pj == nil {
		return nil
	}
	pm := detectPackageManager(ctx, fs, unit.Path)
	for _, name := range names {
		if _, ok := pj.script(name); ok {
			cmd := append(append([]string{}, pm.RunPrefix...), name)
			return []Resolution{{
				Capability: cap,
				State:      StateSupported,
				Command:    cmd,
				Mode:       ModeOneShot,
				Provenance: ProvScript, // repo's declared convention — beats inference
				Confidence: 0.95,
				Reason:     "repository script: " + name,
				ProviderID: p.ID(),
			}}
		}
	}
	return nil
}

// ── Lint: ESLint (inference) ──────────────────────────────────────────────────

type nodeESLintProvider struct{}

func (nodeESLintProvider) ID() string         { return "node.eslint" }
func (nodeESLintProvider) Kind() ProviderKind { return KindTool }
func (nodeESLintProvider) Signals() []Signal {
	return []Signal{{Pattern: "package.json"}, {Pattern: "*eslint*"}}
}
func (nodeESLintProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isNodeUnit(ctx, fs, unit)}
}
func (p nodeESLintProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapLint {
		return nil
	}
	pj := readPackageJSON(ctx, fs, unit.Path)
	if !pj.hasDep("eslint") {
		return nil // repo doesn't use ESLint — say nothing
	}
	hasConfig := hasAnyConfig(ctx, fs, unit.Path,
		"eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
		".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml")
	if !hasConfig {
		// Dependency present but no resolvable config → misconfigured, NOT a code
		// failure. This is exactly the case that produced false "import reserved"
		// errors when we forced ESLint with defaults.
		return []Resolution{{
			Capability: CapLint,
			State:      StateMisconfigured,
			Provenance: ProvInference,
			Confidence: 0.9,
			Reason:     "eslint is a dependency but no ESLint configuration file was found",
			ProviderID: p.ID(),
		}}
	}
	return []Resolution{{
		Capability: CapLint,
		State:      StateSupported,
		Command:    localBin("eslint", ".", "--format", "json"),
		Mode:       ModeOneShot,
		Provenance: ProvInference,
		Confidence: 0.8,
		Reason:     "eslint dependency + config present",
		ProviderID: p.ID(),
	}}
}

// ── Lint: Biome (inference) ───────────────────────────────────────────────────

type nodeBiomeProvider struct{}

func (nodeBiomeProvider) ID() string         { return "node.biome" }
func (nodeBiomeProvider) Kind() ProviderKind { return KindTool }
func (nodeBiomeProvider) Signals() []Signal  { return []Signal{{Pattern: "biome.json*"}} }
func (nodeBiomeProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isNodeUnit(ctx, fs, unit)}
}
func (p nodeBiomeProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapLint {
		return nil
	}
	pj := readPackageJSON(ctx, fs, unit.Path)
	if !pj.hasDep("@biomejs/biome") {
		return nil
	}
	if !hasAnyConfig(ctx, fs, unit.Path, "biome.json", "biome.jsonc") {
		return []Resolution{{
			Capability: CapLint, State: StateMisconfigured, Provenance: ProvInference,
			Confidence: 0.9, Reason: "biome dependency but no biome.json", ProviderID: p.ID(),
		}}
	}
	return []Resolution{{
		Capability: CapLint, State: StateSupported,
		Command: localBin("biome", "check", "."), Mode: ModeOneShot,
		Provenance: ProvInference, Confidence: 0.8,
		Reason: "biome dependency + config present", ProviderID: p.ID(),
	}}
}

// ── Test runners (inference) ──────────────────────────────────────────────────

// nodeTestRunnerProvider is a parameterized test-runner provider so each runner
// is one tiny registration rather than a switch.
type nodeTestRunnerProvider struct {
	id      string
	dep     string
	command []string
}

func (t nodeTestRunnerProvider) ID() string         { return t.id }
func (t nodeTestRunnerProvider) Kind() ProviderKind { return KindTool }
func (t nodeTestRunnerProvider) Signals() []Signal  { return []Signal{{Pattern: "package.json"}} }
func (t nodeTestRunnerProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isNodeUnit(ctx, fs, unit)}
}
func (t nodeTestRunnerProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapTest {
		return nil
	}
	pj := readPackageJSON(ctx, fs, unit.Path)
	if !pj.hasDep(t.dep) {
		return nil
	}
	return []Resolution{{
		Capability: CapTest, State: StateSupported,
		Command: t.command, Mode: ModeOneShot,
		Provenance: ProvInference, Confidence: 0.7,
		Reason: "test runner dependency: " + t.dep, ProviderID: t.id,
	}}
}

// ── Typecheck: tsc (inference) ────────────────────────────────────────────────

type nodeTscProvider struct{}

func (nodeTscProvider) ID() string         { return "node.tsc" }
func (nodeTscProvider) Kind() ProviderKind { return KindTool }
func (nodeTscProvider) Signals() []Signal  { return []Signal{{Pattern: "tsconfig*.json"}} }
func (nodeTscProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isNodeUnit(ctx, fs, unit)}
}
func (p nodeTscProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapTypecheck {
		return nil
	}
	pj := readPackageJSON(ctx, fs, unit.Path)
	if !pj.hasDep("typescript") {
		return nil
	}
	if !hasAnyConfig(ctx, fs, unit.Path, "tsconfig.json") {
		return []Resolution{{
			Capability: CapTypecheck, State: StateMisconfigured, Provenance: ProvInference,
			Confidence: 0.9, Reason: "typescript dependency but no tsconfig.json", ProviderID: p.ID(),
		}}
	}
	return []Resolution{{
		Capability: CapTypecheck, State: StateSupported,
		Command: localBin("tsc", "--noEmit"), Mode: ModeOneShot,
		Provenance: ProvInference, Confidence: 0.8,
		Reason: "typescript dependency + tsconfig present", ProviderID: p.ID(),
	}}
}

// RegisterNodeProviders adds the built-in Node provider set to a registry.
func RegisterNodeProviders(r *Registry) {
	r.Register(nodeLanguageProvider{})
	r.Register(nodePackageManagerProvider{})
	r.Register(nodeScriptProvider{})
	r.Register(nodeESLintProvider{})
	r.Register(nodeBiomeProvider{})
	r.Register(nodeTscProvider{})
	r.Register(nodeTestRunnerProvider{id: "node.jest", dep: "jest",
		command: localBin("jest", "--ci", "--watchAll=false")})
	r.Register(nodeTestRunnerProvider{id: "node.vitest", dep: "vitest",
		command: localBin("vitest", "run")})
	r.Register(nodeTestRunnerProvider{id: "node.reactscripts", dep: "react-scripts",
		command: localBin("react-scripts", "test", "--watchAll=false", "--passWithNoTests")})
	r.Register(nodeTestRunnerProvider{id: "node.mocha", dep: "mocha",
		command: localBin("mocha")})
}
