package engine

import (
	"context"
	"path"
	"strings"
)

// Python provider set. Python has no universal script block, so v1 is
// inference-driven: install from the detected dependency manager, test via
// pytest when the repo uses it, lint via ruff when configured.

func isPythonUnit(ctx context.Context, fs *RepoFS, unit Unit) bool {
	if !unit.HasLanguage("python") {
		return false
	}
	return hasAnyConfig(ctx, fs, unit.Path, "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg")
}

// pyprojectContains reports whether pyproject.toml contains a substring (used to
// detect [tool.ruff], pytest config, etc. without a full TOML parse).
func pyprojectContains(ctx context.Context, fs *RepoFS, unitPath, needle string) bool {
	raw, err := fs.ReadFile(ctx, path.Join(unitPath, "pyproject.toml"))
	if err != nil {
		return false
	}
	return strings.Contains(string(raw), needle)
}

// ── Language ────────────────────────────────────────────────────────────────

type pythonLanguageProvider struct{}

func (pythonLanguageProvider) ID() string         { return "python.language" }
func (pythonLanguageProvider) Kind() ProviderKind { return KindLanguage }
func (pythonLanguageProvider) Signals() []Signal {
	return []Signal{{Pattern: "pyproject.toml"}, {Pattern: "requirements.txt"}, {Pattern: "setup.py"}}
}
func (pythonLanguageProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	if isPythonUnit(ctx, fs, unit) {
		return Claim{Relevant: true, Confidence: 1.0, Reason: "python project markers present"}
	}
	return Claim{}
}
func (pythonLanguageProvider) Resolve(context.Context, Capability, Unit, *RepoFS) []Resolution {
	return nil
}

// ── Install: dependency-manager aware ─────────────────────────────────────────

type pythonInstallProvider struct{}

func (pythonInstallProvider) ID() string         { return "python.install" }
func (pythonInstallProvider) Kind() ProviderKind { return KindPackageManager }
func (pythonInstallProvider) Signals() []Signal {
	return []Signal{{Pattern: "*.lock"}, {Pattern: "requirements.txt"}, {Pattern: "pyproject.toml"}}
}
func (pythonInstallProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isPythonUnit(ctx, fs, unit)}
}
func (p pythonInstallProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapInstall || !isPythonUnit(ctx, fs, unit) {
		return nil
	}
	exists := func(f string) bool { ok, _ := fs.Exists(ctx, path.Join(unit.Path, f)); return ok }
	var cmd []string
	var reason string
	switch {
	case exists("poetry.lock"):
		cmd, reason = []string{"poetry", "install"}, "poetry.lock present"
	case exists("Pipfile.lock") || exists("Pipfile"):
		cmd, reason = []string{"pipenv", "install", "--dev"}, "pipenv project"
	case exists("uv.lock"):
		cmd, reason = []string{"uv", "sync"}, "uv.lock present"
	case exists("requirements.txt"):
		cmd, reason = []string{"pip", "install", "-r", "requirements.txt"}, "requirements.txt present"
	case exists("pyproject.toml"), exists("setup.py"):
		cmd, reason = []string{"pip", "install", "-e", "."}, "editable install from project metadata"
	default:
		return nil
	}
	return []Resolution{{
		Capability: CapInstall, State: StateSupported, Command: cmd, Mode: ModeOneShot,
		TimeoutSec: 180, Provenance: ProvInference, Confidence: 1.0,
		Reason: reason, ProviderID: p.ID(),
	}}
}

// ── Test: pytest (inference) ──────────────────────────────────────────────────

type pythonPytestProvider struct{}

func (pythonPytestProvider) ID() string         { return "python.pytest" }
func (pythonPytestProvider) Kind() ProviderKind { return KindTool }
func (pythonPytestProvider) Signals() []Signal {
	return []Signal{{Pattern: "pytest.ini"}, {Pattern: "conftest.py"}, {Pattern: "tox.ini"}}
}
func (pythonPytestProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isPythonUnit(ctx, fs, unit)}
}
func (p pythonPytestProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapTest || !isPythonUnit(ctx, fs, unit) {
		return nil
	}
	usesPytest := hasAnyConfig(ctx, fs, unit.Path, "pytest.ini", "conftest.py", "tox.ini") ||
		pyprojectContains(ctx, fs, unit.Path, "pytest")
	if !usesPytest {
		if ok, _ := fs.Exists(ctx, path.Join(unit.Path, "tests")); ok {
			usesPytest = true
		}
	}
	if !usesPytest {
		return nil
	}
	return []Resolution{{
		Capability: CapTest, State: StateSupported,
		Command: []string{"pytest"}, Mode: ModeOneShot,
		TimeoutSec: 300, Provenance: ProvInference, Confidence: 0.8,
		Reason: "pytest configuration or tests directory present", ProviderID: p.ID(),
	}}
}

// ── Lint: ruff (inference) ────────────────────────────────────────────────────

type pythonRuffProvider struct{}

func (pythonRuffProvider) ID() string         { return "python.ruff" }
func (pythonRuffProvider) Kind() ProviderKind { return KindTool }
func (pythonRuffProvider) Signals() []Signal  { return []Signal{{Pattern: "ruff.toml"}, {Pattern: ".ruff.toml"}} }
func (pythonRuffProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	return Claim{Relevant: isPythonUnit(ctx, fs, unit)}
}
func (p pythonRuffProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	if cap != CapLint || !isPythonUnit(ctx, fs, unit) {
		return nil
	}
	if !hasAnyConfig(ctx, fs, unit.Path, "ruff.toml", ".ruff.toml") &&
		!pyprojectContains(ctx, fs, unit.Path, "[tool.ruff") {
		return nil
	}
	return []Resolution{{
		Capability: CapLint, State: StateSupported,
		Command: []string{"ruff", "check", "."}, Mode: ModeOneShot,
		TimeoutSec: 120, Provenance: ProvInference, Confidence: 0.85,
		Reason: "ruff configuration present", ProviderID: p.ID(),
	}}
}

// RegisterPythonProviders adds the built-in Python provider set to a registry.
func RegisterPythonProviders(r *Registry) {
	r.Register(pythonLanguageProvider{})
	r.Register(pythonInstallProvider{})
	r.Register(pythonPytestProvider{})
	r.Register(pythonRuffProvider{})
}
