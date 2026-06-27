package ingestion

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Cloner clones a GitHub repository to a temporary directory using an
// installation access token. It owns the clone directory lifecycle: callers
// must call Cleanup after they are finished with the path.
//
// The Agent is given this path as a read-only input. It must never call git
// directly — that contract is enforced by ADR 0004.
type Cloner struct {
	baseDir string // root temp directory for all clones, e.g. /tmp/forge-clones
}

// CloneResult holds the local path and metadata for a successful clone.
type CloneResult struct {
	Dir       string // absolute path to the clone root
	CommitSHA string // HEAD commit SHA after clone
}

// NewCloner creates a Cloner that stores clones under baseDir.
// If baseDir is empty, os.TempDir()/forge-clones is used.
func NewCloner(baseDir string) *Cloner {
	if baseDir == "" {
		baseDir = filepath.Join(os.TempDir(), "forge-clones")
	}
	return &Cloner{baseDir: baseDir}
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

	// Unique directory per job: <baseDir>/<sha>-<timestamp>
	shortSHA := commitSHA
	if len(shortSHA) > 8 {
		shortSHA = shortSHA[:8]
	}
	dirName := fmt.Sprintf("%s-%d", shortSHA, time.Now().UnixNano())
	dir := filepath.Join(c.baseDir, dirName)

	// Inject the token via GIT_ASKPASS so it never touches ~/.netrc or git config.
	// The helper script prints the token when git asks for a password.
	askPassScript, cleanup, err := writeAskPassScript(token)
	if err != nil {
		return nil, fmt.Errorf("failed to write askpass script: %w", err)
	}
	defer cleanup()

	// Shallow clone at depth 1 to keep disk usage minimal.
	// We fetch only the specific commit SHA after the shallow clone.
	cloneArgs := []string{
		"clone",
		"--depth=1",
		"--single-branch",
		cloneURL,
		dir,
	}

	if err := runGit(ctx, askPassScript, cloneArgs...); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("git clone failed: %w", err)
	}

	// If the requested commitSHA is not HEAD (e.g. a push event for a specific
	// commit), fetch and checkout that exact commit.
	head, err := getHEAD(ctx, dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to read HEAD after clone: %w", err)
	}

	if commitSHA != "" && !strings.HasPrefix(head, commitSHA) && !strings.HasPrefix(commitSHA, head) {
		// Fetch the specific commit (shallow clones don't have it by default).
		if err := runGit(ctx, askPassScript, "-C", dir, "fetch", "--depth=1", "origin", commitSHA); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("git fetch %s failed: %w", commitSHA, err)
		}
		if err := runGit(ctx, askPassScript, "-C", dir, "checkout", commitSHA); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("git checkout %s failed: %w", commitSHA, err)
		}
		head = commitSHA
	}

	// Resolve full SHA if we only have a short one.
	if len(head) < 40 {
		full, err := getHEAD(ctx, dir)
		if err == nil {
			head = full
		}
	}

	return &CloneResult{Dir: dir, CommitSHA: strings.TrimSpace(head)}, nil
}

// Cleanup removes the clone directory. Safe to call with an empty path or a
// path that no longer exists.
func (c *Cloner) Cleanup(dir string) {
	if dir == "" {
		return
	}
	_ = os.RemoveAll(dir)
}

// runGit runs a git command with the GIT_ASKPASS env set.
func runGit(ctx context.Context, askPassScript string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(),
		"GIT_ASKPASS="+askPassScript,
		"GIT_TERMINAL_PROMPT=0", // never block waiting for interactive input
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w\noutput: %s", err, string(out))
	}
	return nil
}

// getHEAD returns the full commit SHA of HEAD in the given repo directory.
func getHEAD(ctx context.Context, dir string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("rev-parse HEAD: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// writeAskPassScript writes a temporary shell script that prints the token
// when git asks for credentials. Returns the script path and a cleanup func.
func writeAskPassScript(token string) (string, func(), error) {
	f, err := os.CreateTemp("", "forge-askpass-*.sh")
	if err != nil {
		return "", nil, err
	}
	// The script ignores its argument (the prompt) and just echoes the token.
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
