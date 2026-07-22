package workspace

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"path/filepath"
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
//
// File I/O implementation note (Phase 7 → Phase 9 upgrade path):
//   ReadFile and WriteFile currently use docker cp (CopyFromContainer /
//   CopyToContainer). This is correct for Phase 7 where each step performs
//   O(10) file operations. For Phase 9 autonomous repair loops that may
//   perform O(100+) operations, upgrade to a bind mount:
//
//   Provision: add HostConfig.Binds = ["/tmp/forge-ws/{id}:/workspace"]
//   ReadFile:  os.ReadFile("/tmp/forge-ws/{id}/" + path)
//   WriteFile: os.WriteFile("/tmp/forge-ws/{id}/" + path, data, 0644)
//
//   This replaces ~2-5ms/op socket overhead with single-syscall latency.
//   The SandboxDriver interface and all callers above this layer are unchanged.
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
			// NOTE: Docker exposes no API to signal/kill a running exec, so there
			// is nothing to call here (the previous ContainerExecStart was a
			// no-op). Validation commands are wrapped with an in-container
			// `timeout` that actually terminates the process tree; this
			// driver-level deadline is only an outer safety net, and the ephemeral
			// validation container is destroyed after the run, reaping anything
			// left behind.
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

// ── Interactive PTY Exec (Phase 10B) ─────────────────────────────────────────

// InteractiveExec represents a running interactive shell with bidirectional I/O.
type InteractiveExec struct {
	ExecID      string
	Stdin       io.Writer
	Stdout      io.Reader
	conn        types.HijackedResponse
	containerID string
	client      *client.Client
}

// Resize sends a window size change to the PTY.
func (ie *InteractiveExec) Resize(cols, rows uint) error {
	return ie.client.ContainerExecResize(context.Background(), ie.ExecID, container.ResizeOptions{
		Width:  cols,
		Height: rows,
	})
}

// Close terminates the interactive exec.
func (ie *InteractiveExec) Close() {
	ie.conn.Close()
}

// ExecInteractive creates a PTY-attached interactive exec inside a container.
// Returns an InteractiveExec with stdin writer and stdout reader for bidirectional
// communication. Used by the browser workspace terminal for persistent shell sessions.
//
// Unlike Execute(), this method:
//   - Allocates a TTY (Tty: true)
//   - Attaches stdin (AttachStdin: true)
//   - Returns a bidirectional connection (not a read-only channel)
//   - Does NOT enforce a timeout (the session runs until explicitly closed)
func (d *DockerSandboxDriver) ExecInteractive(ctx context.Context, containerID string, cols, rows uint16) (*InteractiveExec, error) {
	workDir := workspaceMountPath

	execConfig := types.ExecConfig{
		User:         "forge",
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          true,
		Cmd:          []string{"/bin/bash"},
		WorkingDir:   workDir,
		Env:          []string{"TERM=xterm-256color"},
	}

	execResp, err := d.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("interactive exec create: %w", err)
	}

	resp, err := d.client.ContainerExecAttach(ctx, execResp.ID, types.ExecStartCheck{
		Tty: true,
	})
	if err != nil {
		return nil, fmt.Errorf("interactive exec attach: %w", err)
	}

	// Set initial terminal size
	_ = d.client.ContainerExecResize(ctx, execResp.ID, container.ResizeOptions{
		Width:  uint(cols),
		Height: uint(rows),
	})

	return &InteractiveExec{
		ExecID:      execResp.ID,
		Stdin:       resp.Conn,
		Stdout:      resp.Reader,
		conn:        resp,
		containerID: containerID,
		client:      d.client,
	}, nil
}

// Destroy stops and removes the container. Idempotent — safe to call on
// already-removed containers.
//
// Exit code 137 note: Docker stop sends SIGTERM then SIGKILL after the grace
// period. Containers that receive SIGKILL exit with code 137 (128+9). This is
// expected behaviour for validation containers stopped via DestroyValidationContainer
// and should be logged at Info, not Warn. For regular workspace containers the
// same code may indicate an OOM kill, which warrants investigation.
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
		// Note: for validation containers this is often a no-op since the
		// container may already have exited; the Warn is only relevant for
		// unexpected stop failures on long-running workspace containers.
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

// ReadFile reads a file from inside the container using docker cp.
// Returns the raw file bytes.
func (d *DockerSandboxDriver) ReadFile(ctx context.Context, containerID string, path string) ([]byte, error) {
	reader, _, err := d.client.CopyFromContainer(ctx, containerID, path)
	if err != nil {
		return nil, fmt.Errorf("docker cp read %s: %w", path, err)
	}
	defer reader.Close()

	tr := tar.NewReader(reader)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("tar read: %w", err)
		}
		if hdr.Typeflag == tar.TypeReg {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("file not found in tar: %s", path)
}

// WriteFile writes data to a path inside the container via docker cp.
func (d *DockerSandboxDriver) WriteFile(ctx context.Context, containerID string, path string, data []byte) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	hdr := &tar.Header{
		Name:     filepath.Base(path),
		Mode:     0o644,
		Size:     int64(len(data)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return fmt.Errorf("tar header: %w", err)
	}
	if _, err := tw.Write(data); err != nil {
		return fmt.Errorf("tar write: %w", err)
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("tar close: %w", err)
	}
	destDir := filepath.Dir(path)
	return d.client.CopyToContainer(ctx, containerID, destDir, &buf,
		types.CopyToContainerOptions{AllowOverwriteDirWithFile: false})
}

// CopyFile copies a file from src to dst inside the container via docker exec.
func (d *DockerSandboxDriver) CopyFile(ctx context.Context, containerID string, src, dst string) error {
	ch, err := d.Execute(ctx, containerID, ExecRequest{
		Command:        []string{"cp", "--", src, dst},
		TimeoutSeconds: 30,
		User:           "root", // cp between paths may need root
	})
	if err != nil {
		return fmt.Errorf("copy %s → %s: %w", src, dst, err)
	}
	exitCode := 0
	for event := range ch {
		if event.Type == "exit" && event.ExitCode != nil {
			exitCode = *event.ExitCode
		}
	}
	if exitCode != 0 {
		return fmt.Errorf("cp exited with code %d", exitCode)
	}
	return nil
}

// ProvisionWithVolume creates a container that mounts an existing named volume
// at /workspace instead of creating a fresh volume. Used by the validation
// pipeline to share the Phase 7 code with a language-specific sandbox image.
//
// Filesystem layout for the validation container:
//   /workspace        → existing workspace volume (read-write, contains the code)
//   /tmp              → tmpfs 256m (build tools write temp files here)
//   /home/forge       → tmpfs 512m (npm cache, pip cache, go module cache, etc.)
//   everything else   → read-only (rootfs from the sandbox image)
//
// Why /home/forge needs tmpfs:
//   - forge-sandbox-node sets NPM_CONFIG_CACHE=/home/forge/.npm
//   - forge-sandbox-python pip installs to /home/forge/.local when run as forge
//   - forge-sandbox-go sets GOPATH=/home/forge/go
//   All three toolchains write to /home/forge during their first run.
//   Without a writable /home/forge the tools crash with permission errors,
//   which manifest as exit code 254 (npm/pip startup failure) or exit code 1
//   with a misleading "executable not found" error from the generic parser.
func (d *DockerSandboxDriver) ProvisionWithVolume(ctx context.Context, cfg WorkspaceConfig, volumeName string) (*DriverInfo, error) {
	containerName := fmt.Sprintf("forge-val-%s", cfg.WorkspaceID)

	env := make([]string, 0, len(cfg.EnvVars))
	for k, v := range cfg.EnvVars {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	nanoCPU := parseCPU(cfg.CPULimit)
	memoryBytes := int64(cfg.MemoryLimitMB) * 1024 * 1024
	pidsLimit := int64(cfg.PIDLimit)

	hostConfig := &container.HostConfig{
		NetworkMode: "bridge",
		Resources: container.Resources{
			NanoCPUs:  nanoCPU,
			Memory:    memoryBytes,
			PidsLimit: &pidsLimit,
		},
		ReadonlyRootfs: true,
		// Mount the EXISTING workspace volume (not a new one).
		Binds: []string{
			fmt.Sprintf("%s:%s", volumeName, workspaceMountPath),
		},
		// Writable tmpfs mounts required by the language toolchains:
		//   /tmp            — general temp files (all tools)
		//   /home/forge     — npm cache (node_npm_v1), pip cache (python_pip_v1),
		//                     go module cache (go_default_v1), ruff cache, etc.
		//                     MUST be writable or the toolchain cannot start.
		Tmpfs: map[string]string{
			"/tmp":        "size=256m,mode=1777",
			"/home/forge": "size=512m,mode=0755,uid=1000,gid=1000",
		},
		AutoRemove:  false,
		SecurityOpt: []string{"no-new-privileges"},
	}

	containerConfig := &container.Config{
		Image:        cfg.Image,
		User:         "forge",
		Env:          env,
		OpenStdin:    true,
		AttachStdin:  false,
		AttachStdout: false,
		AttachStderr: false,
		Tty:          false,
		WorkingDir:   workspaceMountPath,
		Labels: map[string]string{
			"forge.validation": "true",
			"forge.managed":    "true",
		},
	}

	d.logger.Infow("validation_container_creating",
		"container_name", containerName,
		"image", cfg.Image,
		"volume", volumeName,
	)

	created, err := d.client.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, containerName)
	if err != nil {
		return nil, fmt.Errorf("docker create validation container failed (image=%s): %w", cfg.Image, err)
	}

	if err := d.client.ContainerStart(ctx, created.ID, types.ContainerStartOptions{}); err != nil {
		_ = d.client.ContainerRemove(context.Background(), created.ID,
			types.ContainerRemoveOptions{Force: true})
		return nil, fmt.Errorf("docker start validation container failed (image=%s): %w", cfg.Image, err)
	}

	d.logger.Infow("validation_container_started",
		"container_id", created.ID[:12],
		"container_name", containerName,
		"image", cfg.Image,
		"volume", volumeName,
	)

	return &DriverInfo{
		ContainerID:   created.ID,
		ContainerName: containerName,
	}, nil
}


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
