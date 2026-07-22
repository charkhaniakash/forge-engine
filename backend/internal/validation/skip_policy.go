package validation

import (
	"path/filepath"
	"strings"

	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
)

// SkipPolicy determines which validation stages can be skipped during
// post-repair validation based on which files the repair modified.
//
// The core insight: if the repair only touched application code (src/**/*.js),
// there's no reason to re-run `npm install` — the dependencies haven't changed.
// But if package.json was modified, install must re-run because the dependency
// tree may have changed.
//
// Rule: find the "earliest affected stage" from the modified files, then execute
// that stage and everything after it. Stages before it are skipped (their
// previous results are still valid).
type SkipPolicy struct{}

// NewSkipPolicy creates a skip policy evaluator.
func NewSkipPolicy() *SkipPolicy {
	return &SkipPolicy{}
}

// stageAffectedBy maps file patterns to the earliest validation stage they
// invalidate. Lower order = earlier in the pipeline = must re-run more.
var stageAffectedBy = []struct {
	patterns []string
	stage    engine.Capability
}{
	// Dependency files → install must re-run (everything after it too)
	{
		patterns: []string{
			"package.json", "package-lock.json", "pnpm-lock.yaml",
			"yarn.lock", "bun.lockb", "go.mod", "go.sum",
			"requirements.txt", "pyproject.toml", "poetry.lock",
			"Pipfile", "Pipfile.lock", "uv.lock",
		},
		stage: engine.CapInstall,
	},
	// Build config files → build must re-run
	{
		patterns: []string{
			"tsconfig.json", "tsconfig*.json", "webpack.config.*",
			"vite.config.*", "rollup.config.*", "esbuild.*",
			"Makefile", "CMakeLists.txt", "build.gradle",
		},
		stage: engine.CapBuild,
	},
	// Typecheck config → typecheck must re-run
	{
		patterns: []string{
			"tsconfig.json", "tsconfig*.json",
		},
		stage: engine.CapTypecheck,
	},
	// Lint config → lint must re-run
	{
		patterns: []string{
			".eslintrc", ".eslintrc.*", "eslint.config.*",
			"biome.json", "biome.jsonc",
			".golangci.yml", ".golangci.yaml",
			"ruff.toml", "pyproject.toml",
		},
		stage: engine.CapLint,
	},
	// Test config → test must re-run
	{
		patterns: []string{
			"jest.config.*", "vitest.config.*", "pytest.ini",
			"setup.cfg", "conftest.py",
		},
		stage: engine.CapTest,
	},
}

// capabilityOrder defines the pipeline order for comparison.
var skipCapabilityOrder = map[engine.Capability]int{
	engine.CapInstall:   0,
	engine.CapBuild:     1,
	engine.CapTypecheck: 2,
	engine.CapLint:      3,
	engine.CapTest:      4,
}

// EarliestAffectedStage returns the earliest validation stage that must re-run
// given a set of modified files. If no config/dependency files were touched,
// returns CapBuild (application code changes need at least build + test).
//
// Returns the stage and a reason string for logging.
func (p *SkipPolicy) EarliestAffectedStage(modifiedFiles []string) (engine.Capability, string) {
	if len(modifiedFiles) == 0 {
		// No files reported — conservative: run everything
		return engine.CapInstall, "no modified files reported"
	}

	earliest := engine.CapBuild // default: app code only → build is earliest needed
	reason := "application code modified"

	for _, f := range modifiedFiles {
		base := filepath.Base(f)
		for _, rule := range stageAffectedBy {
			for _, pattern := range rule.patterns {
				if matchFile(base, pattern) {
					if skipCapabilityOrder[rule.stage] < skipCapabilityOrder[earliest] {
						earliest = rule.stage
						reason = "modified " + f + " affects " + string(rule.stage)
					}
				}
			}
		}
	}

	return earliest, reason
}

// ShouldSkip returns true if the given capability can be skipped because it
// precedes the earliest affected stage.
func (p *SkipPolicy) ShouldSkip(cap engine.Capability, earliest engine.Capability) bool {
	return skipCapabilityOrder[cap] < skipCapabilityOrder[earliest]
}

// matchFile does simple filename matching — exact match or glob-like pattern
// with a single trailing wildcard.
func matchFile(filename, pattern string) bool {
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(filename, prefix)
	}
	matched, _ := filepath.Match(pattern, filename)
	return matched
}
