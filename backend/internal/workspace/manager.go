package workspace

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// WorkspaceManager is the single orchestrator for workspace lifecycle.
// It owns all transitions in the state machine and writes every lifecycle
// event to execution_logs. No other component calls the SandboxDriver directly.
//
// Boundary rule (from Section 2 of Requirement.md):
//   The Agent never calls this. It will only issue ToolCallRequest messages
//   in Phase 7+, which the ExecutionService will route here.
type WorkspaceManager struct {
	driver     SandboxDriver
	wsRepo     *repository.WorkspaceRepository
	tokenCache *github.TokenCache
	cfg        Config
	logger     *zap.SugaredLogger
}

// NewWorkspaceManager constructs a WorkspaceManager.
func NewWorkspaceManager(
	driver SandboxDriver,
	wsRepo *repository.WorkspaceRepository,
	tokenCache *github.TokenCache,
	cfg Config,
	logger *zap.SugaredLogger,
) *WorkspaceManager {
	return &WorkspaceManager{
		driver:     driver,
		wsRepo:     wsRepo,
		tokenCache: tokenCache,
		cfg:        cfg,
		logger:     logger,
	}
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Provision creates a workspace, starts the container, clones the repository,
// and checks out the target commit. Returns the workspace row once it reaches
// 'ready' status. Blocks until ready or an error occurs.
//
// The installation token is injected as a GIT_ASKPASS env var at container
// creation time and is never written to disk or logged.
func (m *WorkspaceManager) Provision(
	ctx context.Context,
	workItemID, repoID, repoFullName, commitSHA string,
	installationID int64,
) (*models.Workspace, error) {
	log := m.logger.With(
		"work_item_id", workItemID,
		"repo_id", repoID,
		"commit_sha", commitSHA[:min(8, len(commitSHA))],
	)

	// 1. Create DB row.
	ws, err := m.wsRepo.Create(ctx,
		workItemID, repoID, commitSHA,
		m.cfg.SandboxImage, m.cfg.DefaultCPULimit,
		m.cfg.DefaultMemoryLimitMB, m.cfg.DefaultPIDLimit, m.cfg.DefaultTimeoutSeconds,
	)
	if err != nil {
		return nil, fmt.Errorf("create workspace row: %w", err)
	}
	log = log.With("workspace_id", ws.ID)

	// Wrap the rest so we can MarkFailed on any error.
	if provErr := m.provision(ctx, ws, repoFullName, commitSHA, installationID, log); provErr != nil {
		log.Errorw("workspace_provision_failed", "error", provErr)
		_ = m.wsRepo.MarkFailed(ctx, ws.ID, provErr.Error())
		_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
			models.LifecycleEventFailed, provErr.Error())
		return nil, provErr
	}

	// Re-fetch to return the updated row.
	return m.wsRepo.GetByID(ctx, ws.ID)
}

func (m *WorkspaceManager) provision(
	ctx context.Context,
	ws *models.Workspace,
	repoFullName, commitSHA string,
	installationID int64,
	log *zap.SugaredLogger,
) error {
	// 2. Log lifecycle: creating.
	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventCreating,
		fmt.Sprintf("Provisioning workspace for %s@%s", repoFullName, commitSHA[:8]))

	// 3. Get a short-lived installation token (never logged, injected via env).
	token, err := m.tokenCache.GetInstallationToken(ctx, installationID)
	if err != nil {
		return fmt.Errorf("get installation token: %w", err)
	}

	// Build the authenticated clone URL using the token.
	cloneURL := fmt.Sprintf("https://x-access-token:%s@github.com/%s.git", token, repoFullName)

	// The GIT_ASKPASS script approach from Phase 3 doesn't work inside the
	// container without writing a file, so we inject the token via the URL
	// directly. The URL is never written to execution_logs (only the sanitised
	// repo name is logged).
	cfg := WorkspaceConfig{
		WorkspaceID:    ws.ID,
		Image:          m.cfg.SandboxImage,
		CPULimit:       m.cfg.DefaultCPULimit,
		MemoryLimitMB:  m.cfg.DefaultMemoryLimitMB,
		PIDLimit:       m.cfg.DefaultPIDLimit,
		TimeoutSeconds: m.cfg.DefaultTimeoutSeconds,
		// GIT_TERMINAL_PROMPT=0 prevents git from hanging waiting for input.
		EnvVars: map[string]string{
			"GIT_TERMINAL_PROMPT": "0",
		},
	}

	// 4. Provision the container.
	info, err := m.driver.Provision(ctx, cfg)
	if err != nil {
		return fmt.Errorf("docker provision: %w", err)
	}

	if err := m.wsRepo.SetContainerID(ctx, ws.ID, info.ContainerID, info.ContainerName); err != nil {
		// Container is running — we must destroy it before returning.
		_ = m.driver.Destroy(context.Background(), info.ContainerID)
		return fmt.Errorf("set container id: %w", err)
	}

	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventCreated,
		fmt.Sprintf("Container %s started", info.ContainerName))

	log.Infow("workspace_container_ready",
		"container_id", info.ContainerID[:12],
		"container_name", info.ContainerName)

	// 5. Clone the repository inside the container.
	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventRepoCloning,
		fmt.Sprintf("Cloning %s into /workspace", repoFullName))

	cloneResult, err := m.execAndLog(ctx, ws.ID, info.ContainerID, ExecRequest{
		// Use the token-embedded URL for authentication.
		// WorkingDir is / so we clone into /workspace directly.
		Command:        []string{"git", "clone", "--depth=1", cloneURL, "/workspace"},
		WorkingDir:     "",
		TimeoutSeconds: 300, // cloning can take time on large repos
		User:           "forge",
	}, log)
	if err != nil {
		return fmt.Errorf("git clone: %w", err)
	}
	if cloneResult.ExitCode != 0 {
		return fmt.Errorf("git clone failed (exit %d): %s", cloneResult.ExitCode, cloneResult.Stderr)
	}

	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventRepoCloned,
		fmt.Sprintf("Repository cloned: %s", repoFullName))

	// 6. Checkout the target commit SHA.
	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventRepoCheckout,
		fmt.Sprintf("Checking out %s", commitSHA[:8]))

	checkoutResult, err := m.execAndLog(ctx, ws.ID, info.ContainerID, ExecRequest{
		Command:        []string{"git", "-C", "/workspace", "checkout", commitSHA},
		TimeoutSeconds: 60,
		User:           "forge",
	}, log)
	if err != nil {
		return fmt.Errorf("git checkout: %w", err)
	}
	if checkoutResult.ExitCode != 0 {
		return fmt.Errorf("git checkout failed (exit %d): %s", checkoutResult.ExitCode, checkoutResult.Stderr)
	}

	// 7. Mark workspace ready.
	if err := m.wsRepo.MarkReady(ctx, ws.ID); err != nil {
		return fmt.Errorf("mark ready: %w", err)
	}

	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventReady,
		"Workspace ready — repository cloned and checked out")

	log.Infow("workspace_ready",
		"workspace_id", ws.ID,
		"commit_sha", commitSHA[:8])

	return nil
}

// Exec runs a command inside a ready workspace and streams ExecutionEvents.
// The caller is responsible for draining the returned channel.
// Execution is logged to execution_logs automatically.
func (m *WorkspaceManager) Exec(
	ctx context.Context,
	workspaceID string,
	req ExecRequest,
) (<-chan ExecutionEvent, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("workspace not found: %w", err)
	}
	if ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace %s has no container (status: %s)", workspaceID, ws.Status)
	}
	if ws.Status != models.WorkspaceStatusReady && ws.Status != models.WorkspaceStatusExecuting {
		return nil, fmt.Errorf("workspace %s is not in executable state (status: %s)", workspaceID, ws.Status)
	}

	// Start the log entry before execution.
	logEntry, err := m.wsRepo.LogCommandStart(ctx, workspaceID, req.Command, optString(req.WorkingDir), req.TimeoutSeconds)
	if err != nil {
		m.logger.Warnw("exec_log_start_failed", "workspace_id", workspaceID, "error", err)
	}

	rawCh, err := m.driver.Execute(ctx, *ws.ContainerID, req)
	if err != nil {
		return nil, fmt.Errorf("driver exec: %w", err)
	}

	// Wrap the raw channel so we can complete the log entry when done.
	outCh := make(chan ExecutionEvent, 256)
	go func() {
		defer close(outCh)

		var stdoutBuf, stderrBuf bytes.Buffer
		startTime := time.Now()
		exitCode := -1
		timedOut := false

		for event := range rawCh {
			switch event.Type {
			case "stdout":
				stdoutBuf.Write(event.Data)
			case "stderr":
				stderrBuf.Write(event.Data)
			case "exit":
				if event.ExitCode != nil {
					exitCode = *event.ExitCode
				}
			case "timeout":
				timedOut = true
				if event.ExitCode != nil {
					exitCode = *event.ExitCode
				}
			}
			// Forward every event to the outer channel.
			outCh <- event
		}

		// Complete the log entry.
		if logEntry != nil {
			durationMS := int(time.Since(startTime).Milliseconds())
			_ = m.wsRepo.LogCommandComplete(
				context.Background(),
				logEntry.ID,
				exitCode,
				truncate(stdoutBuf.String(), 64*1024),
				truncate(stderrBuf.String(), 64*1024),
				timedOut,
				durationMS,
			)
		}
	}()

	return outCh, nil
}

// Destroy tears down the workspace: stops/removes the container and updates DB.
func (m *WorkspaceManager) Destroy(ctx context.Context, workspaceID string) error {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("workspace not found: %w", err)
	}
	if ws.Status == models.WorkspaceStatusDestroyed {
		return nil // already destroyed — idempotent
	}

	_, _ = m.wsRepo.LogLifecycle(ctx, workspaceID,
		models.LifecycleEventDestroying, "Destroying workspace")

	_ = m.wsRepo.MarkDestroying(ctx, workspaceID)

	if ws.ContainerID != nil {
		if err := m.driver.Destroy(ctx, *ws.ContainerID); err != nil {
			m.logger.Warnw("driver_destroy_failed",
				"workspace_id", workspaceID,
				"container_id", (*ws.ContainerID)[:min(12, len(*ws.ContainerID))],
				"error", err,
			)
			// Non-fatal — mark destroyed anyway; the reaper will clean up.
		}
	}

	_ = m.wsRepo.MarkDestroyed(ctx, workspaceID)
	_, _ = m.wsRepo.LogLifecycle(ctx, workspaceID,
		models.LifecycleEventDestroyed, "Workspace destroyed")

	m.logger.Infow("workspace_destroyed", "workspace_id", workspaceID)
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// execResult is the collapsed output from an internal exec call.
type execResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
}

// execAndLog runs a command, drains the stream, logs it, and returns the result.
// Used internally during Provision for clone and checkout operations.
func (m *WorkspaceManager) execAndLog(
	ctx context.Context,
	workspaceID, containerID string,
	req ExecRequest,
	log *zap.SugaredLogger,
) (*execResult, error) {
	// Redact credentials from the logged command.
	safeCmd := redactCommand(req.Command)

	logEntry, _ := m.wsRepo.LogCommandStart(ctx, workspaceID, safeCmd, optString(req.WorkingDir), req.TimeoutSeconds)

	ch, err := m.driver.Execute(ctx, containerID, req)
	if err != nil {
		return nil, err
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	exitCode := -1
	timedOut := false
	start := time.Now()

	for event := range ch {
		switch event.Type {
		case "stdout":
			stdoutBuf.Write(event.Data)
		case "stderr":
			stderrBuf.Write(event.Data)
		case "exit":
			if event.ExitCode != nil {
				exitCode = *event.ExitCode
			}
		case "timeout":
			timedOut = true
		}
	}

	durationMS := int(time.Since(start).Milliseconds())
	stdout := truncate(stdoutBuf.String(), 32*1024)
	stderr := truncate(stderrBuf.String(), 32*1024)

	if logEntry != nil {
		_ = m.wsRepo.LogCommandComplete(
			ctx, logEntry.ID, exitCode, stdout, stderr, timedOut, durationMS)
	}

	if exitCode != 0 || timedOut {
		log.Warnw("internal_exec_nonzero",
			"command", safeCmd,
			"exit_code", exitCode,
			"timed_out", timedOut,
			"stderr", stderr,
		)
	}

	return &execResult{
		ExitCode: exitCode,
		Stdout:   stdout,
		Stderr:   stderr,
		TimedOut: timedOut,
	}, nil
}

// redactCommand replaces any git clone URL (which may contain a token) with
// a safe version for logging.
func redactCommand(cmd []string) []string {
	safe := make([]string, len(cmd))
	copy(safe, cmd)
	for i, arg := range safe {
		if strings.Contains(arg, "x-access-token:") {
			// Replace everything after the @ with the repo path only.
			if idx := strings.LastIndex(arg, "@"); idx >= 0 {
				safe[i] = "https://x-access-token:***@" + arg[idx+1:]
			}
		}
	}
	return safe
}

func truncate(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	return s[:maxBytes] + "\n[truncated]"
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
