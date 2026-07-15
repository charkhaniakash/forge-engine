// Package workspace owns the secure execution sandbox infrastructure.
// It is the only Go package that interacts with Docker (or any future
// container runtime). All other packages interact with workspaces through
// WorkspaceManager, never through the driver directly.
package workspace

import (
	"context"
	"fmt"
	"time"
)

// ── Types ─────────────────────────────────────────────────────────────────────

// WorkspaceConfig carries all parameters needed to provision a workspace.
type WorkspaceConfig struct {
	WorkspaceID    string // DB UUID — used to name the container
	Image          string
	CPULimit       string // e.g. "1.0" (cores)
	MemoryLimitMB  int
	PIDLimit       int
	TimeoutSeconds int
	// EnvVars are injected at container creation time.
	// NEVER stored in execution_logs — they may contain credentials.
	EnvVars map[string]string
}

// DriverInfo is returned by Provision and holds the opaque driver-level handle.
type DriverInfo struct {
	ContainerID   string
	ContainerName string
}

// ContainerStatus is the low-level state reported by the driver.
type ContainerStatus struct {
	Running    bool
	ExitCode   *int
	Error      string
	FinishedAt *time.Time
}

// ExecRequest describes a command to run inside a workspace.
// Command is always an argv array — shell strings are never accepted.
type ExecRequest struct {
	Command        []string
	WorkingDir     string            // relative to /workspace; empty = /workspace
	Env            map[string]string // additional env vars for this exec only
	TimeoutSeconds int               // 0 = use default (60s)
	User           string            // empty = default container user (forge)
}

// ExecutionEvent is one item in the stream returned by Execute().
// Consumers drain the channel; when it closes, the command has finished.
type ExecutionEvent struct {
	Type      string    // "stdout" | "stderr" | "exit" | "timeout" | "error"
	Data      []byte    // raw bytes of stdout/stderr chunk
	ExitCode  *int      // set on "exit" events only
	Error     string    // set on "error" events only
	Timestamp time.Time
	Seq       int       // monotonically incrementing within this exec stream
}

// ── SandboxDriver interface ───────────────────────────────────────────────────

// SandboxDriver is the single abstraction point for all container runtimes.
// Phase 6 ships DockerSandboxDriver. Future drivers (Firecracker, Fargate, etc.)
// implement this interface and are wired in WorkspaceConfig without touching
// any code above this layer.
//
// Phase 6 implements: Provision, Execute, Destroy, Status.
// Phase 7 implements: ReadFile, WriteFile, CopyFile.
type SandboxDriver interface {
	// Provision creates and starts a new container. The container runs an idle
	// process (sleep infinity) and is ready to accept docker exec calls.
	// Returns the opaque container handle.
	Provision(ctx context.Context, cfg WorkspaceConfig) (*DriverInfo, error)

	// Execute runs a command inside the container and returns a channel of
	// ExecutionEvents. The channel is closed when the command exits or times out.
	// Stdout and stderr are streamed incrementally — consumers MUST drain the
	// channel even if they only want the exit code.
	Execute(ctx context.Context, containerID string, req ExecRequest) (<-chan ExecutionEvent, error)

	// Destroy stops and removes the container. Safe to call on already-removed
	// containers (idempotent).
	Destroy(ctx context.Context, containerID string) error

	// Status returns the current low-level container state.
	Status(ctx context.Context, containerID string) (ContainerStatus, error)

	// ReadFile reads a file from inside the container.
	// Phase 6: returns ErrNotImplemented. Phase 7: real implementation.
	ReadFile(ctx context.Context, containerID string, path string) ([]byte, error)

	// WriteFile writes data to a path inside the container.
	// Phase 6: returns ErrNotImplemented. Phase 7: real implementation.
	WriteFile(ctx context.Context, containerID string, path string, data []byte) error

	// CopyFile copies a file from src to dst inside the container.
	// Phase 6: returns ErrNotImplemented. Phase 7: real implementation.
	CopyFile(ctx context.Context, containerID string, src, dst string) error

	// ProvisionWithVolume creates a container like Provision but mounts an
	// existing named volume instead of creating a new one.
	// Used by the ValidationOrchestrator to share the Phase 7 code volume
	// with an ephemeral language-specific validation container.
	ProvisionWithVolume(ctx context.Context, cfg WorkspaceConfig, volumeName string) (*DriverInfo, error)

	// ExecInteractive creates a PTY-attached interactive shell inside the container.
	// Returns an InteractiveExec with bidirectional stdin/stdout for persistent
	// terminal sessions. Used by Phase 10B Browser Workspace terminal.
	ExecInteractive(ctx context.Context, containerID string, cols, rows uint16) (*InteractiveExec, error)
}

// ErrNotImplemented is returned by Phase 6 stubs for Phase 7+ methods.
var ErrNotImplemented = fmt.Errorf("not implemented in Phase 6")
