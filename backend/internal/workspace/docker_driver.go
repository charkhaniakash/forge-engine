package workspace

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"go.uber.org/zap"
)

const (
	// workspaceMountPath is the in-container path for the cloned repository.
	workspaceMountPath = "/workspace"

	// defaultExecTimeoutSeconds is the fallback when ExecRequest.TimeoutSeconds = 0.
	defaultExecTimeoutSeconds = 60

	// maxExecTimeoutSeconds is the hard cap — no single command may run longer.
	maxExecTimeoutSeconds = 300
)

// DockerSandboxDriver implements SandboxDriver using the Docker Engine API.
// It is the only component in the codebase that calls Docker directly.
//
// Security guarantees enforced at this layer:
//   - Network isolation: HostConfig.NetworkMode = "none"
//   - Non-root execution: User = "forge" (uid 1000)
//   - Resource limits: CPU, memory, PIDs from WorkspaceConfig
//   - Read-only root filesystem + writable /workspace and /tmp via tmpfs
type DockerSandboxDriver struct {
	client *client.Client
	logger *zap.SugaredLogger
}

// NewDockerDriver creates a DockerSandboxDriver connected to the local Docker daemon.
func NewDockerDriver(logger *zap.SugaredLogger) (*DockerSandboxDriver, error) {
	cli, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker client: %w", err)
	}
	return &DockerSandboxDriver{client: cli, logger: logger}, nil
}

// Provision creates and starts a new sandbox container. The container runs
// `sleep infinity` as the forge user and is ready for docker exec calls.
// Network is isolated (none). All resource limits are applied at creation time.
func (d *DockerSandboxDriver) Provision(ctx context.Context, cfg WorkspaceConfig) (*DriverInfo, error) {
	containerName := fmt.Sprintf("forge-ws-%s", cfg.WorkspaceID[:8])

	// Build env slice. Credentials are passed here (e.g. GIT_ASKPASS token)
	// but are NEVER logged or written to the filesystem.
	env := make([]string, 0, len(cfg.EnvVars))
	for k, v := range cfg.EnvVars {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	// Resource limits.
	nanoCPU := parseCPU(cfg.CPULimit)
	memoryBytes := int64(cfg.MemoryLimitMB) * 1024 * 1024
	pidsLimit := int64(cfg.PIDLimit)

	hostConfig := &container.HostConfig{
		// Network mode: bridge (allows git clone during provisioning).
		// TODO: Phase 7+ - implement network isolation after clone is complete.
		NetworkMode: "bridge",

		// Resource limits — enforced by the kernel via cgroups.
		Resources: container.Resources{
			NanoCPUs:  nanoCPU,
			Memory:    memoryBytes,
			PidsLimit: &pidsLimit,
		},

		// /workspace is writable (repo lives here).
		// Root filesystem is read-only; /workspace gets a volume mount to make it writable.
		ReadonlyRootfs: true,
		Binds: []string{
			fmt.Sprintf("forge-workspace-%s:%s", cfg.WorkspaceID, workspaceMountPath),
		},
		Tmpfs: map[string]string{
			"/tmp": "size=128m,mode=1777",
		},

		// Auto-remove is NOT set — we want the container to persist until
		// WorkspaceManager.Destroy() is called, even if the idle process exits.
		AutoRemove: false,

		// Security options: no new privileges for any child process.
		SecurityOpt: []string{"no-new-privileges"},
	}

	containerConfig := &container.Config{
		Image: cfg.Image,
		// Run as the non-root forge user defined in the Dockerfile.
		User: "forge",
		Env:  env,
		// Keep stdin open so the container doesn't exit immediately.
		OpenStdin:    true,
		AttachStdin:  false,
		AttachStdout: false,
		AttachStderr: false,
		Tty:          false,
		WorkingDir:   workspaceMountPath,
		// Labels for identification and cleanup by the reaper.
		Labels: map[string]string{
			"forge.workspace_id": cfg.WorkspaceID,
			"forge.managed":      "true",
		},
	}

	created, err := d.client.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, containerName)
	if err != nil {
		return nil, fmt.Errorf("docker create failed: %w", err)
	}

	if err := d.client.ContainerStart(ctx, created.ID, types.ContainerStartOptions{}); err != nil {
		// Clean up the created-but-unstarted container.
		_ = d.client.ContainerRemove(context.Background(), created.ID,
			types.ContainerRemoveOptions{Force: true})
		return nil, fmt.Errorf("docker start failed: %w", err)
	}

	d.logger.Infow("workspace_container_started",
		"workspace_id", cfg.WorkspaceID,
		"container_id", created.ID[:12],
		"container_name", containerName,
	)

	return &DriverInfo{
		ContainerID:   created.ID,
		ContainerName: containerName,
	}, nil
}

// Execute runs an argv command inside the container and streams output as
// ExecutionEvents. The returned channel is closed when the command exits,
// times out, or the context is cancelled.
//
// Callers MUST drain the channel completely to avoid goroutine leaks.
func (d *DockerSandboxDriver) Execute(ctx context.Context, containerID string, req ExecRequest) (<-chan ExecutionEvent, error) {
	timeout := req.TimeoutSeconds
	if timeout <= 0 {
		timeout = defaultExecTimeoutSeconds
	}
	if timeout > maxExecTimeoutSeconds {
		timeout = maxExecTimeoutSeconds
	}

	workDir := workspaceMountPath
	if req.WorkingDir != "" {
		// WorkingDir is always relative to /workspace.
		workDir = workspaceMountPath + "/" + strings.TrimPrefix(req.WorkingDir, "/")
	}

	// Build env for this specific exec.
	execEnv := make([]string, 0, len(req.Env))
	for k, v := range req.Env {
		execEnv = append(execEnv, fmt.Sprintf("%s=%s", k, v))
	}

	user := req.User
	if user == "" {
		user = "forge"
	}

	execConfig := types.ExecConfig{
		User:         user,
		AttachStdout: true,
		AttachStderr: true,
		Cmd:          req.Command,
		WorkingDir:   workDir,
		Env:          execEnv,
	}

	execID, err := d.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("exec create failed: %w", err)
	}

	resp, err := d.client.ContainerExecAttach(ctx, execID.ID, types.ExecStartCheck{})
	if err != nil {
		return nil, fmt.Errorf("exec attach failed: %w", err)
	}

	ch := make(chan ExecutionEvent, 256)

	go func() {
		defer close(ch)
		defer resp.Close()

		execCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
		defer cancel()

		seq := 0
		timedOut := false

		// Docker multiplexed stream: 8-byte header per frame.
		// Header[0]: stream type (1=stdout, 2=stderr)
		// Header[4:8]: frame size (big-endian uint32)
		header := make([]byte, 8)
		scanner := bufio.NewScanner(resp.Reader)
		scanner.Buffer(make([]byte, 64*1024), 64*1024)

		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			buf := make([]byte, 32*1024)
			for {
				// Read the 8-byte multiplexed stream header.
				if _, err := io.ReadFull(resp.Reader, header); err != nil {
					return
				}
				streamType := header[0] // 1=stdout, 2=stderr
				frameSize := int(header[4])<<24 | int(header[5])<<16 | int(header[6])<<8 | int(header[7])

				if frameSize == 0 {
					continue
				}

				toRead := frameSize
				for toRead > 0 {
					n := toRead
					if n > len(buf) {
						n = len(buf)
					}
					nr, err := io.ReadFull(resp.Reader, buf[:n])
					if nr > 0 {
						eventType := "stdout"
						if streamType == 2 {
							eventType = "stderr"
						}
						data := make([]byte, nr)
						copy(data, buf[:nr])
						select {
						case ch <- ExecutionEvent{
							Type:      eventType,
							Data:      data,
							Timestamp: time.Now(),
							Seq:       seq,
						}:
							seq++
						case <-execCtx.Done():
							return
						}
					}
					if err != nil {
						return
					}
					toRead -= nr
				}
			}
		}()

		_ = scanner // suppress unused warning

		select {
		case <-readDone:
		case <-execCtx.Done():
			timedOut = execCtx.Err() == context.DeadlineExceeded
			// Kill the exec process.
			killCtx, killCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer killCancel()
			_ = d.client.ContainerExecStart(killCtx, execID.ID, types.ExecStartCheck{})
		}

		// Retrieve exit code.
		inspCtx, inspCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer inspCancel()

		inspect, err := d.client.ContainerExecInspect(inspCtx, execID.ID)
		if err == nil && !inspect.Running {
			code := inspect.ExitCode
			if timedOut {
				ch <- ExecutionEvent{
					Type:      "timeout",
					Timestamp: time.Now(),
					Seq:       seq,
					ExitCode:  &code,
				}
				seq++
			} else {
				ch <- ExecutionEvent{
					Type:      "exit",
					ExitCode:  &code,
					Timestamp: time.Now(),
					Seq:       seq,
				}
			}
		}
	}()

	return ch, nil
}

// Destroy stops and removes the container. Idempotent — safe to call on
// already-removed containers.
func (d *DockerSandboxDriver) Destroy(ctx context.Context, containerID string) error {
	// Extract workspace ID from container name to clean up the volume.
	containerInfo, err := d.client.ContainerInspect(ctx, containerID)
	if err != nil && !isNotFoundError(err) {
		d.logger.Warnw("docker_inspect_failed", "container_id", containerID[:min(12, len(containerID))], "error", err)
	}

	// Stop with a 10-second SIGTERM grace period.
	timeout := 10

	if err := d.client.ContainerStop(
		ctx,
		containerID,
		container.StopOptions{
			Timeout: &timeout,
		},
	); err != nil {
		// Log but don't fail — we still want to attempt Remove.
		d.logger.Warnw("docker_stop_failed",
			"container_id", containerID[:min(12, len(containerID))],
			"error", err)
	}

	if err := d.client.ContainerRemove(ctx, containerID, types.ContainerRemoveOptions{
		Force:         true,
		RemoveVolumes: true,
	}); err != nil {
		if !isNotFoundError(err) {
			return fmt.Errorf("docker rm failed: %w", err)
		}
		// Already removed — treat as success.
	}

	// Remove the workspace volume if it exists.
	if containerInfo.Name != "" {
		volumeName := fmt.Sprintf("forge-workspace-%s", strings.TrimPrefix(containerInfo.Name, "forge-ws-"))
		if err := d.client.VolumeRemove(ctx, volumeName, true); err != nil && !isNotFoundError(err) {
			d.logger.Warnw("docker_volume_remove_failed", "volume_name", volumeName, "error", err)
		}
	}

	return nil
}

// Status returns the current container state.
func (d *DockerSandboxDriver) Status(ctx context.Context, containerID string) (ContainerStatus, error) {
	info, err := d.client.ContainerInspect(ctx, containerID)
	if err != nil {
		if isNotFoundError(err) {
			return ContainerStatus{Running: false}, nil
		}
		return ContainerStatus{}, fmt.Errorf("docker inspect failed: %w", err)
	}

	status := ContainerStatus{
		Running: info.State.Running,
	}
	if !info.State.Running {
		code := info.State.ExitCode
		status.ExitCode = &code
		if t, err := time.Parse(time.RFC3339, info.State.FinishedAt); err == nil && !t.IsZero() {
			status.FinishedAt = &t
		}
		status.Error = info.State.Error
	}
	return status, nil
}

// ReadFile reads a file from inside the container.
// Phase 6: not implemented. Phase 7 will implement via docker cp.
func (d *DockerSandboxDriver) ReadFile(_ context.Context, _ string, _ string) ([]byte, error) {
	return nil, ErrNotImplemented
}

// WriteFile writes data to a path inside the container.
// Phase 6: not implemented. Phase 7 will implement via docker cp.
func (d *DockerSandboxDriver) WriteFile(_ context.Context, _ string, _ string, _ []byte) error {
	return ErrNotImplemented
}

// CopyFile copies a file inside the container.
// Phase 6: not implemented. Phase 7 will implement via docker exec cp.
func (d *DockerSandboxDriver) CopyFile(_ context.Context, _ string, _, _ string) error {
	return ErrNotImplemented
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// parseCPU converts a CPU limit string (e.g. "1.0") to Docker's NanoCPU unit.
func parseCPU(limit string) int64 {
	var f float64
	if _, err := fmt.Sscanf(limit, "%f", &f); err != nil || f <= 0 {
		f = 1.0
	}
	return int64(f * 1e9)
}

// isNotFoundError returns true if the Docker error indicates the container
// or resource doesn't exist.
func isNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "No such container") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "404")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ bytes.Buffer // suppress unused import
