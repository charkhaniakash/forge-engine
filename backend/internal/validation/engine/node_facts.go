package engine

import (
	"context"
	"encoding/json"
	"path"
)

// nodePackageJSON is the subset of package.json the Node providers care about.
type nodePackageJSON struct {
	Scripts         map[string]string `json:"scripts"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	PackageManager  string            `json:"packageManager"` // e.g. "pnpm@9.1.0"
}

// hasDep reports whether name is a (dev or prod) dependency.
func (p *nodePackageJSON) hasDep(name string) bool {
	if p == nil {
		return false
	}
	if _, ok := p.Dependencies[name]; ok {
		return true
	}
	_, ok := p.DevDependencies[name]
	return ok
}

// script returns the raw script body for name, if defined.
func (p *nodePackageJSON) script(name string) (string, bool) {
	if p == nil || p.Scripts == nil {
		return "", false
	}
	s, ok := p.Scripts[name]
	return s, ok && s != ""
}

// readPackageJSON parses <unit>/package.json (memoized via RepoFS). Returns nil
// if absent or unparseable.
func readPackageJSON(ctx context.Context, fs *RepoFS, unitPath string) *nodePackageJSON {
	raw, err := fs.ReadFile(ctx, path.Join(unitPath, "package.json"))
	if err != nil {
		return nil
	}
	var pj nodePackageJSON
	if err := json.Unmarshal(raw, &pj); err != nil {
		return nil
	}
	return &pj
}

// packageManager describes how to install deps and run scripts for a unit.
type packageManager struct {
	Name       string   // npm | pnpm | yarn | bun
	Install    []string // argv to install dependencies
	RunPrefix  []string // argv prefix to run a package script (append the script name)
}

// detectPackageManager resolves the PM from lockfiles (authoritative), then the
// package.json "packageManager" field, then defaults to npm. Determinism: no
// network, no version guessing — the lockfile that is present decides.
func detectPackageManager(ctx context.Context, fs *RepoFS, unitPath string) packageManager {
	exists := func(f string) bool {
		ok, _ := fs.Exists(ctx, path.Join(unitPath, f))
		return ok
	}
	switch {
	case exists("pnpm-lock.yaml"):
		return packageManager{Name: "pnpm", Install: []string{"pnpm", "install"}, RunPrefix: []string{"pnpm", "run"}}
	case exists("yarn.lock"):
		return packageManager{Name: "yarn", Install: []string{"yarn", "install"}, RunPrefix: []string{"yarn", "run"}}
	case exists("bun.lockb"):
		return packageManager{Name: "bun", Install: []string{"bun", "install"}, RunPrefix: []string{"bun", "run"}}
	default:
		// package-lock.json or nothing → npm.
		return packageManager{
			Name:      "npm",
			Install:   []string{"npm", "install", "--no-audit", "--no-fund"},
			RunPrefix: []string{"npm", "run"},
		}
	}
}

// hasAnyConfig reports whether any of the given config files exists in the unit.
func hasAnyConfig(ctx context.Context, fs *RepoFS, unitPath string, names ...string) bool {
	for _, n := range names {
		if ok, _ := fs.Exists(ctx, path.Join(unitPath, n)); ok {
			return true
		}
	}
	return false
}

// localBin builds an argv that runs a locally-installed tool WITHOUT ever
// downloading it (`npx --no-install`). This is central to determinism: we only
// run tools the repository actually declares/installs.
func localBin(args ...string) []string {
	return append([]string{"npx", "--no-install"}, args...)
}
