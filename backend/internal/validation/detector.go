package validation

import (
	"context"
	"fmt"

	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// DetectionResult captures what the StackDetector found.
type DetectionResult struct {
	Language       string // "go" | "javascript" | "python" | "unknown"
	Framework      string // "react" | "nextjs" | "fastapi" | "standard" | ""
	PackageManager string // "gomod" | "npm" | "yarn" | "pnpm" | "pip" | "uv"
	ProfileID      string // selected profile ID
}

// StackDetector inspects the workspace to detect language, framework,
// package manager, and select the right ValidationProfile.
// Detection is deterministic — no LLM involved.
type StackDetector struct {
	wsManager *workspace.WorkspaceManager
}

// NewStackDetector constructs a StackDetector.
func NewStackDetector(wsManager *workspace.WorkspaceManager) *StackDetector {
	return &StackDetector{wsManager: wsManager}
}

// Detect inspects the workspace and returns a DetectionResult.
func (d *StackDetector) Detect(ctx context.Context, workspaceID string) (*DetectionResult, error) {
	result := &DetectionResult{
		Language:       "unknown",
		Framework:      "",
		PackageManager: "",
		ProfileID:      "",
	}

	// ── Go ────────────────────────────────────────────────────────────────────
	if ok, _ := d.wsManager.Exists(ctx, workspaceID, "go.mod"); ok {
		result.Language = "go"
		result.PackageManager = "gomod"
		result.Framework = "standard"
		result.ProfileID = "go_default_v1"
		return result, nil
	}

	// ── Node.js ───────────────────────────────────────────────────────────────
	if ok, _ := d.wsManager.Exists(ctx, workspaceID, "package.json"); ok {
		result.Language = "javascript"

		// Detect package manager.
		if ok, _ := d.wsManager.Exists(ctx, workspaceID, "pnpm-lock.yaml"); ok {
			result.PackageManager = "pnpm"
		} else if ok, _ := d.wsManager.Exists(ctx, workspaceID, "yarn.lock"); ok {
			result.PackageManager = "yarn"
		} else {
			result.PackageManager = "npm"
		}

		// Detect framework by reading package.json dependencies.
		pkgJSON, err := d.wsManager.ReadFile(ctx, workspaceID, "package.json")
		if err == nil {
			content := string(pkgJSON)
			if containsStr(content, `"next"`) {
				result.Framework = "nextjs"
			} else if containsStr(content, `"react"`) {
				result.Framework = "react"
			} else {
				result.Framework = "standard"
			}
		} else {
			result.Framework = "standard"
		}

		result.ProfileID = "node_npm_v1"
		return result, nil
	}

	// ── Python ────────────────────────────────────────────────────────────────
	if ok, _ := d.wsManager.Exists(ctx, workspaceID, "pyproject.toml"); ok {
		result.Language = "python"
		result.PackageManager = "uv"
		result.Framework = "standard"
		result.ProfileID = "python_pyproject_v1"
		return result, nil
	}

	if ok, _ := d.wsManager.Exists(ctx, workspaceID, "requirements.txt"); ok {
		result.Language = "python"
		result.PackageManager = "pip"
		result.Framework = "standard"
		result.ProfileID = "python_pip_v1"
		return result, nil
	}

	// Unknown stack — Phase 8 cannot validate it.
	return result, fmt.Errorf("unsupported or undetectable stack — no go.mod, package.json, or requirements.txt found")
}

// containsStr is a simple substring check used for package.json inspection.
func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && findStr(s, sub)
}

func findStr(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
