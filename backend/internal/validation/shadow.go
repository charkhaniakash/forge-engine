package validation

import (
	"context"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// wsFileSource adapts the workspace manager to engine.FileSource. It lives in
// this package (not engine) so the engine stays free of a workspace dependency.
// All reads go through the workspace container, exactly like the legacy detector.
type wsFileSource struct {
	wsManager   *workspace.WorkspaceManager
	workspaceID string
}

func (s *wsFileSource) ReadFile(ctx context.Context, path string) ([]byte, error) {
	return s.wsManager.ReadFile(ctx, s.workspaceID, path)
}

func (s *wsFileSource) Exists(ctx context.Context, path string) (bool, error) {
	return s.wsManager.Exists(ctx, s.workspaceID, path)
}

func (s *wsFileSource) List(ctx context.Context, dir string) ([]engine.DirEntry, error) {
	entries, err := s.wsManager.ListDir(ctx, s.workspaceID, dir)
	if err != nil {
		return nil, err
	}
	out := make([]engine.DirEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, engine.DirEntry{Name: e.Name, IsDir: e.Type == "dir"})
	}
	return out, nil
}

// runShadowPlan builds the next-gen ValidationPlan for the workspace and logs it
// alongside the profile the legacy engine chose, WITHOUT executing anything.
// This is Phase 3 shadow mode: it lets us prove the planner against real repos
// before Phase 4 cuts execution over. It is fully defensive — any failure is
// logged and ignored; it never affects the live validation run.
func runShadowPlan(wsManager *workspace.WorkspaceManager, workspaceID, language, legacyProfileID string, logger *zap.SugaredLogger) {
	defer func() {
		if r := recover(); r != nil {
			logger.Warnw("shadow_plan_panic", "recover", r)
		}
	}()

	// Detached context with a tight budget so shadow mode never delays or
	// couples to the real run.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	fs := engine.NewRepoFS(&wsFileSource{wsManager: wsManager, workspaceID: workspaceID})
	plan := engine.PlanForLanguage(ctx, fs, engine.DefaultRegistry(), language)

	logger.Infow("shadow_plan_generated",
		"workspace_id", workspaceID,
		"legacy_profile", legacyProfileID,
		"plan", plan.Summary(),
		"proposed_manifest", engine.ProposeManifest(plan),
	)
}
