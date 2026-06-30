package ingestion

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"go.uber.org/zap"
)

// Cloner clones a GitHub repository to a temporary directory using an
// installation access token. It owns the clone directory lifecycle: callers
// must call Cleanup after they are finished with the path.
//
// The Agent is given this path as a read-only input. It must never call git
// directly — that contract is enforced by ADR 0004.
type Cloner struct {
	baseDir string // root temp directory for all clones, e.g. /tmp/forge-clones
	logger  *zap.SugaredLogger
}

// CloneResult holds the local path and metadata for a successful clone.
type CloneResult struct {
	Dir       string // absolute path to the clone root
	CommitSHA string // HEAD commit SHA after clone
}

// NewCloner creates a Cloner that stores clones under baseDir.
// If baseDir is empty, os.TempDir()/forge-clones is used.
func NewCloner(baseDir string, logger *zap.SugaredLogger) *Cloner {
	if baseDir == "" {
		baseDir = filepath.Join(os.TempDir(), "forge-clones")
	}
	return &Cloner{baseDir: baseDir, logger: logger}
}

// Clone checks out the repository at the given commitSHA into a uniquely named
// subdirectory of c.baseDir. It uses the provided installation access token for
// HTTPS authentication via a GIT_ASKPASS helper script injected into the
// subprocess environment — no credentials are written to disk.
//
// The caller owns cleanup: always call Cleanup(dir) when done, even on error.
func (c *Cloner) Clone(ctx context.Context, cloneURL string, commitSHA string, token string) (*CloneResult, error) {
	if err := os.MkdirAll(c.baseDir, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create clone base dir: %w", err)
	}

	// Build a safe directory name.
	// commitSHA may be empty for manual triggers — use "head" as placeholder.
	// Prefix with "clone-" so the path never starts with a hyphen, which git
	// would misinterpret as a flag (causing exit 128 with no useful output).
	shaLabel := "head"
	if len(commitSHA) >= 8 {
		shaLabel = commitSHA[:8]
	} else if commitSHA != "" {
		shaLabel = commitSHA
	}
	dirName := fmt.Sprintf("clone-%s-%d", shaLabel, time.Now().UnixNano())
	dir := filepath.Join(c.baseDir, dirName)

	c.logger.Infow("clone_starting",
		"dir", dir,
		"commit_sha", commitSHA,
		"sha_label", shaLabel,
	)

	// Inject the token via GIT_ASKPASS so it never touches ~/.netrc or git config.
	askPassScript, cleanup, err := writeAskPassScript(token)
	if err != nil {
		return nil, fmt.Errorf("failed to write askpass script: %w", err)
	}
	defer cleanup()

	// Shallow clone — depth=1, only the default branch.
	cloneArgs := []string{
		"clone",
		"--depth=1",
		"--single-branch",
		cloneURL,
		dir,
	}

	c.logger.Infow("git_clone_starting",
		"dir", dir,
		"args", strings.Join(cloneArgs[1:len(cloneArgs)-1], " "), // omit URL (contains token)
	)

	if err := c.runGit(ctx, askPassScript, cloneArgs...); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("git clone failed: %w", err)
	}

	c.logger.Infow("git_clone_succeeded", "dir", dir)

	// Read HEAD from the cloned repo.
	head, err := c.getHEAD(ctx, dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to read HEAD after clone: %w", err)
	}

	c.logger.Infow("git_head_resolved", "dir", dir, "head", head)

	// If a specific commit was requested and it differs from HEAD, fetch and
	// check it out. This handles push-triggered jobs where the SHA is known.
	if commitSHA != "" && !strings.HasPrefix(head, commitSHA) && !strings.HasPrefix(commitSHA, head) {
		c.logger.Infow("git_fetch_specific_commit",
			"dir", dir,
			"commit_sha", commitSHA,
			"current_head", head,
		)

		if err := c.runGit(ctx, askPassScript, "-C", dir, "fetch", "--depth=1", "origin", commitSHA); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("git fetch %s failed: %w", commitSHA, err)
		}

		if err := c.runGit(ctx, askPassScript, "-C", dir, "checkout", commitSHA); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("git checkout %s failed: %w", commitSHA, err)
		}

		// Re-read HEAD after checkout so we return the resolved full SHA.
		head, err = c.getHEAD(ctx, dir)
		if err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("failed to read HEAD after checkout: %w", err)
		}

		c.logger.Infow("git_checkout_succeeded",
			"dir", dir,
			"head", head,
		)
	}

	// If head is still short (e.g. because commitSHA was short), resolve to full.
	if len(head) < 40 {
		if full, err := c.getHEAD(ctx, dir); err == nil {
			head = full
		}
	}

	result := &CloneResult{
		Dir:       dir,
		CommitSHA: strings.TrimSpace(head),
	}

	c.logger.Infow("clone_complete",
		"dir", result.Dir,
		"commit_sha", result.CommitSHA,
	)

	return result, nil
}

// Cleanup removes the clone directory. Safe to call with an empty path or a
// path that no longer exists.
func (c *Cloner) Cleanup(dir string) {
	if dir == "" {
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		c.logger.Warnw("clone_cleanup_failed", "dir", dir, "error", err)
	} else {
		c.logger.Infow("clone_cleanup_done", "dir", dir)
	}
}

// runGit executes a git command with GIT_ASKPASS injected. It captures both
// stdout and stderr and includes them in any error message.
func (c *Cloner) runGit(ctx context.Context, askPassScript string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(),
		"GIT_ASKPASS="+askPassScript,
		"GIT_TERMINAL_PROMPT=0",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		c.logger.Errorw("git_command_failed",
			"args", args,
			"exit_code", cmd.ProcessState.ExitCode(),
			"stdout", strings.TrimSpace(stdout.String()),
			"stderr", strings.TrimSpace(stderr.String()),
		)
		return fmt.Errorf(
			"git %s: %w\nstdout: %s\nstderr: %s",
			args[0], err,
			strings.TrimSpace(stdout.String()),
			strings.TrimSpace(stderr.String()),
		)
	}

	return nil
}

// getHEAD returns the full commit SHA of HEAD in the given repo directory.
// It captures stderr so that failures include the actual git error message
// rather than just "exit status 128".
func (c *Cloner) getHEAD(ctx context.Context, dir string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "HEAD")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		c.logger.Errorw("git_rev_parse_failed",
			"dir", dir,
			"exit_code", cmd.ProcessState.ExitCode(),
			"stderr", strings.TrimSpace(stderr.String()),
		)
		return "", fmt.Errorf(
			"rev-parse HEAD in %s: %w\nstderr: %s",
			dir, err,
			strings.TrimSpace(stderr.String()),
		)
	}

	sha := strings.TrimSpace(stdout.String())
	if sha == "" {
		return "", fmt.Errorf("rev-parse HEAD in %s returned empty output", dir)
	}
	return sha, nil
}

// writeAskPassScript writes a temporary shell script that prints the token
// when git asks for credentials. Returns the script path and a cleanup func.
func writeAskPassScript(token string) (string, func(), error) {
	f, err := os.CreateTemp("", "forge-askpass-*.sh")
	if err != nil {
		return "", nil, err
	}
	script := fmt.Sprintf("#!/bin/sh\necho '%s'\n", strings.ReplaceAll(token, "'", "'\\''"))
	if _, err := f.WriteString(script); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", nil, err
	}
	_ = f.Close()
	if err := os.Chmod(f.Name(), 0o700); err != nil {
		_ = os.Remove(f.Name())
		return "", nil, err
	}
	cleanup := func() { _ = os.Remove(f.Name()) }
	return f.Name(), cleanup, nil
}
