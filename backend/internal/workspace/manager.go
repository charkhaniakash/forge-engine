package workspace

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"strconv"
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
//
//	The Agent never calls this. It will only issue ToolCallRequest messages
//	in Phase 7+, which the ExecutionService will route here.
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
		Network:        m.cfg.Network,
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
	//
	// IMPORTANT: git clone --depth=1 only fetches the default branch's latest
	// commit. If commitSHA is an older commit (recorded by an earlier ingestion
	// job), the shallow clone won't have it. We must fetch the specific commit
	// before checking it out.
	_, _ = m.wsRepo.LogLifecycle(ctx, ws.ID,
		models.LifecycleEventRepoCheckout,
		fmt.Sprintf("Fetching and checking out %s", commitSHA[:8]))

	// First, fetch the target commit specifically into the shallow clone.
	fetchResult, err := m.execAndLog(ctx, ws.ID, info.ContainerID, ExecRequest{
		Command:        []string{"git", "-C", "/workspace", "fetch", "--depth=1", "origin", commitSHA},
		TimeoutSeconds: 60,
		User:           "forge",
	}, log)
	if err != nil {
		return fmt.Errorf("git fetch commit: %w", err)
	}
	if fetchResult.ExitCode != 0 {
		return fmt.Errorf("git fetch commit failed (exit %d): %s", fetchResult.ExitCode, fetchResult.Stderr)
	}

	// Now checkout the commit.
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

// ── Structured types for workspace file APIs ──────────────────────────────────

// SearchResult is one match returned by SearchSymbol.
// Callers receive structured data — no string parsing required.
// The underlying search implementation (grep, ripgrep, LSP, AST) is an
// internal detail that can be swapped without changing this type.
type SearchResult struct {
	FilePath string `json:"file_path"` // relative to /workspace
	Line     int    `json:"line"`
	Column   int    `json:"column"`  // 0 if not provided by implementation
	Preview  string `json:"preview"` // the matching line content
}

// DirEntry is one entry returned by ListDir.
// Includes enough metadata for the browser IDE without a follow-up Stat call.
type DirEntry struct {
	Name    string `json:"name"`
	Type    string `json:"type"`     // "file" | "dir" | "symlink"
	Size    int64  `json:"size"`     // bytes; 0 for dirs
	ModTime string `json:"mod_time"` // RFC3339
}

// StatResult is returned by Stat.
type StatResult struct {
	Path    string `json:"path"`
	Exists  bool   `json:"exists"`
	Type    string `json:"type"` // "file" | "dir" | "symlink" | ""
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

// ── Search ────────────────────────────────────────────────────────────────────

// SearchSymbol searches for a pattern across the workspace and returns
// structured results. The semantic contract is "find this symbol / pattern";
// the current implementation uses grep. Future phases can swap to ripgrep,
// tree-sitter, or a language server without changing callers.
func (m *WorkspaceManager) SearchSymbol(
	ctx context.Context,
	workspaceID, dir, pattern string,
) ([]SearchResult, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace not ready: %w", err)
	}
	absDir := workspaceMountPath
	if dir != "" && dir != "." {
		absDir = containerPath(dir)
	}

	// grep -n: include line numbers. -r: recursive. -H: always print filename.
	// Exit code 1 = no matches (not an error); 2+ = real error.
	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command: []string{
			"grep", "-r", "-n", "-H",
			"--include=*.go", "--include=*.py", "--include=*.ts",
			"--include=*.js", "--include=*.tsx", "--include=*.jsx",
			"--", pattern, absDir,
		},
		TimeoutSeconds: 30,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return nil, err
	}
	if result.ExitCode > 1 {
		return nil, fmt.Errorf("search failed (exit %d): %s", result.ExitCode, result.Stderr)
	}

	var results []SearchResult
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		if line == "" {
			continue
		}
		// grep -n output format: "path/to/file.go:42:preview content"
		line = strings.TrimPrefix(line, workspaceMountPath+"/")
		parts := strings.SplitN(line, ":", 3)
		if len(parts) < 3 {
			continue
		}
		lineNum := 0
		fmt.Sscanf(parts[1], "%d", &lineNum)
		results = append(results, SearchResult{
			FilePath: parts[0],
			Line:     lineNum,
			Column:   0,
			Preview:  strings.TrimSpace(parts[2]),
		})
	}
	return results, nil
}

// ── File operations (Phase 7) ─────────────────────────────────────────────────

// ReadFile reads a file from the workspace at the given relative path.
// containerPath resolves a caller-supplied path to its absolute location inside
// the workspace container. Callers SHOULD pass repo-relative paths, but tools
// and LLMs sometimes hand us an already-absolute "/workspace/..." path. This
// strips the mount prefix when (and only when) it's genuinely the container
// root, so we never double it into "/workspace/workspace/...". A relative
// subdirectory literally named "workspace/foo" (no leading slash) is preserved.
func containerPath(p string) string {
	p = strings.TrimSpace(p)
	if p == workspaceMountPath {
		p = ""
	} else if strings.HasPrefix(p, workspaceMountPath+"/") {
		p = strings.TrimPrefix(p, workspaceMountPath+"/")
	}
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return workspaceMountPath
	}
	return workspaceMountPath + "/" + p
}

func (m *WorkspaceManager) ReadFile(ctx context.Context, workspaceID, path string) ([]byte, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)
	return m.driver.ReadFile(ctx, *ws.ContainerID, absPath)
}

// WriteFile overwrites a file at the given path with new content.
// The parent directory must already exist — use CreateFile to auto-create parents.
// Phase 9 will add ApplyPatch / ReplaceRange for surgical edits without full rewrites.
func (m *WorkspaceManager) WriteFile(ctx context.Context, workspaceID, path string, data []byte) error {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)
	return m.driver.WriteFile(ctx, *ws.ContainerID, absPath, data)
}

// CreateFile creates a new file, auto-creating any missing parent directories.
func (m *WorkspaceManager) CreateFile(ctx context.Context, workspaceID, path string, data []byte) error {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)
	parentDir := filepath.Dir(absPath)
	mkdirResult, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"mkdir", "-p", parentDir},
		TimeoutSeconds: 10,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil || mkdirResult.ExitCode != 0 {
		return fmt.Errorf("mkdir -p %s: %v", parentDir, err)
	}
	return m.driver.WriteFile(ctx, *ws.ContainerID, absPath, data)
}

// DeleteFile removes a file from the workspace.
func (m *WorkspaceManager) DeleteFile(ctx context.Context, workspaceID, path string) error {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)
	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"rm", "-f", "--", absPath},
		TimeoutSeconds: 10,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("rm %s failed (exit %d): %s", path, result.ExitCode, result.Stderr)
	}
	return nil
}

// RenameFile moves/renames a file, auto-creating the destination parent directory.
func (m *WorkspaceManager) RenameFile(ctx context.Context, workspaceID, oldPath, newPath string) error {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return fmt.Errorf("workspace not ready: %w", err)
	}
	absOld := containerPath(oldPath)
	absNew := containerPath(newPath)

	// Ensure destination parent exists.
	destParent := filepath.Dir(absNew)
	mkdirResult, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"mkdir", "-p", destParent},
		TimeoutSeconds: 10,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil || mkdirResult.ExitCode != 0 {
		return fmt.Errorf("mkdir -p %s: %v", destParent, err)
	}

	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"mv", "--", absOld, absNew},
		TimeoutSeconds: 10,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("mv %s → %s failed (exit %d): %s", oldPath, newPath, result.ExitCode, result.Stderr)
	}
	return nil
}

// ListDir returns structured metadata for entries in a directory.
// Returns DirEntry with name, type (file/dir/symlink), size, and mod_time.
// This avoids a follow-up Stat call per entry in the browser IDE.
func (m *WorkspaceManager) ListDir(ctx context.Context, workspaceID, path string) ([]DirEntry, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace not ready: %w", err)
	}
	if path == "" {
		path = "."
	}
	absPath := containerPath(path)

	// stat -c "%F|%s|%Y|%n" each entry: type|size|epoch|name
	// Using find to get consistent output across different ls versions.
	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"find", absPath, "-maxdepth", "1", "-mindepth", "1", "-printf", "%y|%s|%T@|%f\n"},
		TimeoutSeconds: 10,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("list %s failed (exit %d): %s", path, result.ExitCode, result.Stderr)
	}

	var entries []DirEntry
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		if line == "" {
			continue
		}
		// format: type|size|epoch|name
		// find %y: f=file, d=dir, l=symlink, etc.
		parts := strings.SplitN(line, "|", 4)
		if len(parts) != 4 {
			continue
		}
		typeCh := parts[0]
		var size int64
		fmt.Sscanf(parts[1], "%d", &size)
		var epoch float64
		fmt.Sscanf(parts[2], "%f", &epoch)
		name := parts[3]

		entType := "file"
		switch typeCh {
		case "d":
			entType = "dir"
		case "l":
			entType = "symlink"
		}

		entries = append(entries, DirEntry{
			Name:    name,
			Type:    entType,
			Size:    size,
			ModTime: epochToRFC3339(int64(epoch)),
		})
	}
	return entries, nil
}

// Exists reports whether a path exists inside the workspace.
// Use this instead of catching ReadFile errors to detect missing files.
func (m *WorkspaceManager) Exists(ctx context.Context, workspaceID, path string) (bool, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return false, fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)
	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"test", "-e", absPath},
		TimeoutSeconds: 5,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return false, err
	}
	return result.ExitCode == 0, nil
}

// Stat returns metadata for a path inside the workspace.
// Returns StatResult.Exists=false if the path does not exist (not an error).
func (m *WorkspaceManager) Stat(ctx context.Context, workspaceID, path string) (*StatResult, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace not ready: %w", err)
	}
	absPath := containerPath(path)

	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		// stat -c: %F=type %s=size %Y=epoch  — portable across Linux
		Command:        []string{"stat", "-c", "%F|%s|%Y", "--", absPath},
		TimeoutSeconds: 5,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		// File does not exist — not an error, just report Exists=false.
		return &StatResult{
			Path:   path,
			Exists: false,
		}, nil
	}

	parts := strings.SplitN(strings.TrimSpace(result.Stdout), "|", 3)
	if len(parts) != 3 {
		return &StatResult{Path: path, Exists: false}, nil
	}

	typeName := parts[0] // "regular file", "directory", "symbolic link"
	var size int64
	fmt.Sscanf(parts[1], "%d", &size)
	var epoch int64
	fmt.Sscanf(parts[2], "%d", &epoch)

	entType := "file"
	if strings.Contains(typeName, "directory") {
		entType = "dir"
	} else if strings.Contains(typeName, "symbolic") {
		entType = "symlink"
	}

	return &StatResult{
		Path:    path,
		Exists:  true,
		Type:    entType,
		Size:    size,
		ModTime: epochToRFC3339(epoch),
	}, nil
}

// HasChanges reports whether the workspace working tree has any uncommitted
// changes relative to HEAD — modified, staged, or untracked files.
//
// This is the authoritative "did the execution actually change anything?"
// signal. It cannot be fooled by no-op writes (identical content) or by an
// agent that reports success without touching a file: `git status --porcelain`
// reflects the real working tree. The publishing orchestrator uses the same
// check before committing, so both stages agree on what "no changes" means.
//
// Returns (false, err) only when the check could not run (workspace gone, exec
// error). Callers should treat an error as "unknown" and NOT block on it — the
// advisory pipeline must never fail a task on infrastructure trouble.
func (m *WorkspaceManager) HasChanges(ctx context.Context, workspaceID string) (bool, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return false, fmt.Errorf("workspace not ready: %w", err)
	}
	result, err := m.execAndLog(ctx, workspaceID, *ws.ContainerID, ExecRequest{
		Command:        []string{"git", "status", "--porcelain"},
		TimeoutSeconds: 15,
	}, m.logger.With("workspace_id", workspaceID))
	if err != nil {
		return false, err
	}
	if result.ExitCode != 0 {
		return false, fmt.Errorf("git status failed (exit %d): %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return strings.TrimSpace(result.Stdout) != "", nil
}

// ── Validation container helpers (Phase 8) ────────────────────────────────────

// ProvisionValidationContainer creates an ephemeral language-specific container
// for Phase 8 validation. The container mounts the same named volume as the
// Phase 7 workspace so it sees the post-execution code state.
//
// The container is NOT tracked in the workspaces table — it is ephemeral and
// managed entirely by the ValidationOrchestrator. The caller must call
// DestroyValidationContainer when the validation run completes.
func (m *WorkspaceManager) ProvisionValidationContainer(
	ctx context.Context,
	workspaceID string,
	sandboxImage string,
) (string, error) {
	// The Phase 7 workspace volume name follows the convention set in DockerSandboxDriver.Provision.
	volumeName := fmt.Sprintf("forge-workspace-%s", workspaceID)

	cfg := WorkspaceConfig{
		// Use a unique ID derived from the workspace ID + timestamp so container
		// names never collide if multiple validation runs are in flight.
		WorkspaceID:    fmt.Sprintf("%s-val-%d", workspaceID[:8], time.Now().UnixNano()/1e6),
		Image:          sandboxImage,
		Network:        m.cfg.Network,
		CPULimit:       m.cfg.DefaultCPULimit,
		MemoryLimitMB:  m.cfg.DefaultMemoryLimitMB,
		PIDLimit:       m.cfg.DefaultPIDLimit,
		TimeoutSeconds: m.cfg.DefaultTimeoutSeconds,
		EnvVars: map[string]string{
			"GIT_TERMINAL_PROMPT": "0",
		},
	}

	// Override the volume binding so the validation container uses the existing
	// workspace volume (not a fresh empty one).
	info, err := m.driver.ProvisionWithVolume(ctx, cfg, volumeName)
	if err != nil {
		return "", fmt.Errorf("provision validation container (image=%s, volume=%s): %w", sandboxImage, volumeName, err)
	}
	return info.ContainerID, nil
}

// ExecInValidationContainer runs a command inside an ephemeral validation container
// by its Docker container ID. This bypasses the workspaces table entirely.
// validationExecGraceSeconds is the extra time the OUTER (driver-level) deadline
// gets over the in-container `timeout`, so the container kills the process first
// and we observe its real exit code (124/137) instead of a driver-side deadline.
const validationExecGraceSeconds = 15

// nonInteractiveExecEnv are baseline env vars applied to every validation
// command so tools run in one-shot CI mode and never wait on a TTY/prompt.
// This is the source-level fix for watch-mode runners (react-scripts, jest,
// vitest, …) hanging until timeout, independent of the command being run.
func nonInteractiveExecEnv() map[string]string {
	return map[string]string{
		"CI":                  "true", // jest/vitest/react-scripts → single run, no watch
		"FORCE_COLOR":         "0",    // clean, parseable output
		"NODE_ENV":            "test",
		"npm_config_yes":      "true", // npx never prompts to install
		"GIT_TERMINAL_PROMPT": "0",    // git never blocks on credentials
		"DEBIAN_FRONTEND":     "noninteractive",
	}
}

// ExecInValidationContainer runs a validation command with correct, non-interactive
// process semantics:
//   - injects a CI/non-interactive environment (callers may override any key),
//   - enforces the timeout IN-CONTAINER via coreutils `timeout` (Docker has no
//     "kill exec" API, so a hung/watch process is otherwise unkillable), and
//   - keeps the driver-level deadline as an outer safety net (grace beyond the
//     in-container timeout) so the container terminates the process first.
func (m *WorkspaceManager) ExecInValidationContainer(
	ctx context.Context,
	containerID string,
	req ExecRequest,
) (<-chan ExecutionEvent, error) {
	// Layer the non-interactive baseline under any caller-provided env.
	env := nonInteractiveExecEnv()
	for k, v := range req.Env {
		env[k] = v
	}
	req.Env = env

	// Wrap the command so the container hard-kills it on timeout:
	//   timeout -k 5 <N> <cmd...>
	// coreutils exits 124 when it sends TERM (timeout) and 137 (128+9) if the
	// KILL grace elapses — runStage treats both as a timeout. The sandbox images
	// are ubuntu-based, so GNU `timeout` is always present.
	if n := req.TimeoutSeconds; n > 0 && len(req.Command) > 0 && req.Command[0] != "timeout" {
		req.Command = append([]string{"timeout", "-k", "5", strconv.Itoa(n)}, req.Command...)
		req.TimeoutSeconds = n + validationExecGraceSeconds
	}

	return m.driver.Execute(ctx, containerID, req)
}

// DestroyValidationContainer removes an ephemeral validation container by ID.
func (m *WorkspaceManager) DestroyValidationContainer(ctx context.Context, containerID string) error {
	err := m.driver.Destroy(ctx, containerID)
	// Exit code 137 is expected: Docker stop sends SIGKILL after the grace period,
	// which terminates the container with 128+9=137. This is normal cleanup, not an error.
	m.logger.Infow("validation_container_destroyed",
		"container_id", containerID[:min(12, len(containerID))],
		"note", "exit_137_is_expected_sigkill_from_docker_stop",
	)
	return err
}

// ExecInteractive creates a persistent interactive shell in the workspace container.
// Returns an InteractiveExec with stdin/stdout for bidirectional I/O.
// Used by the browser workspace terminal for persistent PTY sessions.
func (m *WorkspaceManager) ExecInteractive(ctx context.Context, workspaceID string, cols, rows uint16) (*InteractiveExec, error) {
	ws, err := m.wsRepo.GetByID(ctx, workspaceID)
	if err != nil || ws.ContainerID == nil {
		return nil, fmt.Errorf("workspace not ready: %w", err)
	}
	return m.driver.ExecInteractive(ctx, *ws.ContainerID, cols, rows)
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

// epochToRFC3339 converts a Unix epoch (seconds) to an RFC3339 timestamp string.
func epochToRFC3339(epoch int64) string {
	if epoch == 0 {
		return ""
	}
	return time.Unix(epoch, 0).UTC().Format(time.RFC3339)
}
