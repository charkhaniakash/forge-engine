package engine

import (
	"context"
	"strings"
	"testing"
)

// stageFor returns the assembled stage for a capability in a single-unit plan.
func stageFor(t *testing.T, plan ValidationPlan, cap Capability) StageSpec {
	t.Helper()
	if len(plan.Units) != 1 {
		t.Fatalf("expected 1 unit, got %d", len(plan.Units))
	}
	for _, s := range plan.Units[0].Stages {
		if s.Capability == cap {
			return s
		}
	}
	t.Fatalf("no stage for capability %s", cap)
	return StageSpec{}
}

func planFrom(files map[string]string) ValidationPlan {
	fs := NewRepoFS(&memFS{files: files})
	return Plan(context.Background(), fs, DefaultRegistry())
}

// A CRA-style repo: a `test` script exists → script-first wins over the
// react-scripts inference, and PM is npm.
func TestPlan_ScriptFirstWins(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json": `{
			"scripts": {"test": "react-scripts test", "build": "react-scripts build"},
			"dependencies": {"react-scripts": "5.0.0"}
		}`,
	})
	test := stageFor(t, plan, CapTest)
	if test.State != StateSupported || test.Provenance != ProvScript {
		t.Fatalf("test: state=%s prov=%s cmd=%v", test.State, test.Provenance, test.Command)
	}
	if strings.Join(test.Command, " ") != "npm run test" {
		t.Fatalf("expected 'npm run test', got %v", test.Command)
	}
	build := stageFor(t, plan, CapBuild)
	if build.State != StateSupported || strings.Join(build.Command, " ") != "npm run build" {
		t.Fatalf("build: %s %v", build.State, build.Command)
	}
}

// ESLint is a dependency but there is no config → Misconfigured, NOT a forced
// `npx eslint` and NOT a code failure. This is the exact false-positive we set
// out to eliminate.
func TestPlan_LintMisconfiguredNotForced(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json": `{"devDependencies": {"eslint": "9.0.0"}}`,
	})
	lint := stageFor(t, plan, CapLint)
	if lint.State != StateMisconfigured {
		t.Fatalf("expected misconfigured, got %s (cmd=%v)", lint.State, lint.Command)
	}
	if len(lint.Command) != 0 {
		t.Fatalf("misconfigured lint must carry no command, got %v", lint.Command)
	}
}

// No linter at all and no lint script → Unsupported (silence), never a guessed
// command.
func TestPlan_LintUnsupportedWhenAbsent(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json": `{"dependencies": {"react": "18.0.0"}}`,
	})
	lint := stageFor(t, plan, CapLint)
	if lint.State != StateUnsupported {
		t.Fatalf("expected unsupported, got %s", lint.State)
	}
	if len(lint.Command) != 0 {
		t.Fatalf("unsupported lint must carry no command, got %v", lint.Command)
	}
}

// ESLint dep + flat config → Supported via inference, using the local binary
// (no dynamic download).
func TestPlan_LintInferredWithConfig(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json":     `{"devDependencies": {"eslint": "9.0.0"}}`,
		"eslint.config.js": "export default []",
	})
	lint := stageFor(t, plan, CapLint)
	if lint.State != StateSupported || lint.Provenance != ProvInference {
		t.Fatalf("lint: %s %s", lint.State, lint.Provenance)
	}
	if lint.Command[0] != "npx" || lint.Command[1] != "--no-install" {
		t.Fatalf("expected local-only npx, got %v", lint.Command)
	}
}

// pnpm lockfile → install uses pnpm, not npm.
func TestPlan_PackageManagerAware(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json":   `{"dependencies": {}}`,
		"pnpm-lock.yaml": "lockfileVersion: 9.0",
	})
	install := stageFor(t, plan, CapInstall)
	if install.State != StateSupported || install.Command[0] != "pnpm" {
		t.Fatalf("install: %s %v", install.State, install.Command)
	}
}

// A non-Node repo → no units discovered (nothing to plan yet in v1).
func TestPlan_NoNodeNoUnits(t *testing.T) {
	plan := planFrom(map[string]string{"README.md": "# hi"})
	if len(plan.Units) != 0 {
		t.Fatalf("expected no units, got %d", len(plan.Units))
	}
}

func planForLang(files map[string]string, lang string) ValidationPlan {
	fs := NewRepoFS(&memFS{files: files})
	return PlanForLanguage(context.Background(), fs, DefaultRegistry(), lang)
}

// The Forge manifest is authoritative: it overrides a repo `test` script, and
// `skip: true` forces a capability to Skipped regardless of inference.
func TestPlan_ManifestOverrides(t *testing.T) {
	plan := planFrom(map[string]string{
		"package.json": `{"scripts":{"test":"jest"},"devDependencies":{"jest":"29"}}`,
		".forge/validation.yaml": "" +
			"version: 1\n" +
			"capabilities:\n" +
			"  test:\n" +
			"    command: [\"make\", \"test\"]\n" +
			"  lint:\n" +
			"    skip: true\n",
	})
	test := stageFor(t, plan, CapTest)
	if test.State != StateSupported || test.Provenance != ProvManifest {
		t.Fatalf("test: state=%s prov=%s", test.State, test.Provenance)
	}
	if strings.Join(test.Command, " ") != "make test" {
		t.Fatalf("manifest should override script; got %v", test.Command)
	}
	lint := stageFor(t, plan, CapLint)
	if lint.State != StateSkipped {
		t.Fatalf("manifest skip → Skipped, got %s", lint.State)
	}

	// ProposeManifest renders the inferred plan for human review.
	if ProposeManifest(plan) == "" {
		t.Fatal("expected a non-empty proposed manifest")
	}
}

// Go: standard toolchain commands; lint unsupported without golangci config.
func TestPlan_Go(t *testing.T) {
	plan := planForLang(map[string]string{
		"go.mod":  "module example.com/x\n\ngo 1.22",
		"main.go": "package main\nfunc main(){}",
	}, "go")
	if strings.Join(stageFor(t, plan, CapBuild).Command, " ") != "go build ./..." {
		t.Fatalf("go build: %v", stageFor(t, plan, CapBuild).Command)
	}
	if strings.Join(stageFor(t, plan, CapTest).Command, " ") != "go test ./..." {
		t.Fatalf("go test: %v", stageFor(t, plan, CapTest).Command)
	}
	if stageFor(t, plan, CapLint).State != StateUnsupported {
		t.Fatalf("lint should be unsupported without golangci config")
	}
}

// Go with a golangci config → lint supported.
func TestPlan_GoLintConfigured(t *testing.T) {
	plan := planForLang(map[string]string{
		"go.mod":         "module example.com/x",
		".golangci.yml":  "linters:\n  enable: [gofmt]",
	}, "go")
	lint := stageFor(t, plan, CapLint)
	if lint.State != StateSupported || lint.Command[0] != "golangci-lint" {
		t.Fatalf("go lint: %s %v", lint.State, lint.Command)
	}
}

// Python: requirements.txt → pip install; pytest via tests dir; ruff via config.
func TestPlan_Python(t *testing.T) {
	plan := planForLang(map[string]string{
		"requirements.txt": "requests",
		"tests/test_x.py":  "def test_x(): assert True",
		"ruff.toml":        "line-length = 100",
	}, "python")
	install := stageFor(t, plan, CapInstall)
	if strings.Join(install.Command, " ") != "pip install -r requirements.txt" {
		t.Fatalf("py install: %v", install.Command)
	}
	if stageFor(t, plan, CapTest).Command[0] != "pytest" {
		t.Fatalf("py test: %v", stageFor(t, plan, CapTest).Command)
	}
	if stageFor(t, plan, CapLint).Command[0] != "ruff" {
		t.Fatalf("py lint: %v", stageFor(t, plan, CapLint).Command)
	}
}

// Language scoping: a repo with BOTH package.json and go.mod, planned for go,
// must NOT pick up Node stages (wrong toolchain for the sandbox image).
func TestPlan_LanguageScoping(t *testing.T) {
	files := map[string]string{
		"package.json": `{"scripts":{"test":"jest"},"devDependencies":{"jest":"29"}}`,
		"go.mod":       "module example.com/x",
	}
	goPlan := planForLang(files, "go")
	if strings.Join(stageFor(t, goPlan, CapTest).Command, " ") != "go test ./..." {
		t.Fatalf("expected go test under go scope, got %v", stageFor(t, goPlan, CapTest).Command)
	}
	nodePlan := planForLang(files, "javascript")
	if strings.Join(stageFor(t, nodePlan, CapInstall).Command, " ")[:3] != "npm" {
		t.Fatalf("expected npm install under js scope, got %v", stageFor(t, nodePlan, CapInstall).Command)
	}
}
