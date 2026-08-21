package validation

// ValidationProfile is the central abstraction for Phase 8.
// Everything — sandbox image, commands, timeouts, stage ordering —
// comes from the profile. Nothing outside this package hardcodes
// stack-specific behavior.
type ValidationProfile struct {
	ID             string
	Stack          string // "go" | "node" | "python"
	Language       string
	Framework      string
	PackageManager string
	SandboxImage   string
	Stages         []StageConfig
	BaselineEnabled bool // default false; Phase 9 sets true
}

// StageConfig describes one validation stage within a profile.
type StageConfig struct {
	Name           string     // install | build | test | lint | format
	SequenceNumber int
	Commands       [][]string // argv arrays — no shell strings ever
	TimeoutSeconds int
	// RunOnBuildFail: if true, this stage runs even if the build stage failed.
	// Lint is typically true; test is false.
	RunOnBuildFail bool
	// RunOnInstallFail: if true, this stage runs even if the install stage failed.
	// Most stages should be false (install failure is a hard dependency).
	RunOnInstallFail bool
	// Optional: if the tool is not found (exit 127), skip rather than fail.
	Optional bool
}

// ── Built-in profiles ─────────────────────────────────────────────────────────

var profiles = map[string]*ValidationProfile{
	"go_default_v1": {
		ID:             "go_default_v1",
		Stack:          "go",
		Language:       "go",
		Framework:      "standard",
		PackageManager: "gomod",
		SandboxImage:   "forge-sandbox-go:latest",
		Stages: []StageConfig{
			{
				Name:           "install",
				SequenceNumber: 1,
				Commands:       [][]string{{"go", "mod", "download"}},
				TimeoutSeconds: 120,
			},
			{
				Name:           "build",
				SequenceNumber: 2,
				Commands:       [][]string{{"go", "build", "./..."}},
				TimeoutSeconds: 120,
			},
			{
				Name:           "test",
				SequenceNumber: 3,
				Commands:       [][]string{{"go", "test", "-json", "-timeout", "120s", "./..."}},
				TimeoutSeconds: 180,
				RunOnBuildFail: false,
				RunOnInstallFail: false,
			},
			{
				Name:           "lint",
				SequenceNumber: 4,
				Commands:       [][]string{{"golangci-lint", "run", "--out-format", "json"}},
				TimeoutSeconds: 120,
				RunOnBuildFail: true,
				RunOnInstallFail: false,
				Optional:       true,
			},
		},
	},

	"node_npm_v1": {
		ID:             "node_npm_v1",
		Stack:          "node",
		Language:       "javascript",
		Framework:      "standard",
		PackageManager: "npm",
		SandboxImage:   "forge-sandbox-node:latest",
		Stages: []StageConfig{
			{
				Name:           "install",
				SequenceNumber: 1,
				Commands:       [][]string{{"npm", "install", "--prefer-offline"}},
				TimeoutSeconds: 180,
			},
			{
				Name:           "build",
				SequenceNumber: 2,
				// npm run build is optional — not all Node projects have a build step.
				Commands:       [][]string{{"npm", "run", "build", "--if-present"}},
				TimeoutSeconds: 120,
				Optional:       true,
			},
			{
				Name:           "test",
				SequenceNumber: 3,
				// --passWithNoTests: exits 0 when no test files exist instead of 1,
				// preventing the "no tests found" exit-1 from being misclassified as
				// a repairable failure and triggering an infinite repair→validation loop.
				// --watchAll=false: single run, no interactive watch mode (CI_=true also
				// handles this but the flag is explicit insurance).
				// --forceExit: prevents jest from hanging if async tasks remain open.
				Commands:       [][]string{{"npm", "test", "--", "--watchAll=false", "--passWithNoTests", "--forceExit"}},
				TimeoutSeconds: 180,
				RunOnBuildFail: false,
				RunOnInstallFail: false,
			},
			{
				Name:           "lint",
				SequenceNumber: 4,
				// Ignore build artifacts and vendored code. Without these, a
				// SUCCESSFUL build creates build/ (minified JS) which eslint then
				// lints and chokes on — making lint fail *because* the build
				// passed, so repair could never reach a clean "passed".
				Commands: [][]string{{
					"npx", "eslint", ".", "--format", "json",
					"--ignore-pattern", "build/",
					"--ignore-pattern", "dist/",
					"--ignore-pattern", "coverage/",
				}},
				TimeoutSeconds:   60,
				RunOnBuildFail:   true,
				RunOnInstallFail: false,
				Optional:         true,
			},
		},
	},

	"python_pip_v1": {
		ID:             "python_pip_v1",
		Stack:          "python",
		Language:       "python",
		Framework:      "standard",
		PackageManager: "pip",
		SandboxImage:   "forge-sandbox-python:latest",
		Stages: []StageConfig{
			{
				Name:           "install",
				SequenceNumber: 1,
				Commands:       [][]string{{"pip", "install", "-r", "requirements.txt", "--quiet"}},
				TimeoutSeconds: 180,
			},
			{
				Name:           "test",
				SequenceNumber: 2,
				Commands:       [][]string{{"pytest", "--json-report", "--json-report-file=.pytest-report.json", "-v"}},
				TimeoutSeconds: 180,
				RunOnInstallFail: false,
			},
			{
				Name:           "lint",
				SequenceNumber: 3,
				Commands:       [][]string{{"ruff", "check", ".", "--output-format", "json"}},
				TimeoutSeconds: 60,
				RunOnInstallFail: false,
				Optional:       true,
			},
		},
	},

	"python_pyproject_v1": {
		ID:             "python_pyproject_v1",
		Stack:          "python",
		Language:       "python",
		Framework:      "standard",
		PackageManager: "uv",
		SandboxImage:   "forge-sandbox-python:latest",
		Stages: []StageConfig{
			{
				Name:           "install",
				SequenceNumber: 1,
				Commands:       [][]string{{"pip", "install", "-e", ".", "--quiet"}},
				TimeoutSeconds: 180,
			},
			{
				Name:           "test",
				SequenceNumber: 2,
				Commands:       [][]string{{"pytest", "--json-report", "--json-report-file=.pytest-report.json", "-v"}},
				TimeoutSeconds: 180,
				RunOnInstallFail: false,
			},
			{
				Name:           "lint",
				SequenceNumber: 3,
				Commands:       [][]string{{"ruff", "check", ".", "--output-format", "json"}},
				TimeoutSeconds: 60,
				RunOnInstallFail: false,
				Optional:       true,
			},
		},
	},
}

// GetProfile returns a built-in profile by ID, or nil if not found.
func GetProfile(id string) *ValidationProfile {
	p, ok := profiles[id]
	if !ok {
		return nil
	}
	return p
}

// AllProfiles returns all built-in profiles (for diagnostics).
func AllProfiles() []*ValidationProfile {
	out := make([]*ValidationProfile, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, p)
	}
	return out
}
