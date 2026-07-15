package browserworkspace

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// ── File Models ──────────────────────────────────────────────────────────────

// FileNode represents a file or directory in the workspace tree.
type FileNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Type     string     `json:"type"` // "file" | "directory"
	Size     int64      `json:"size,omitempty"`
	Children []FileNode `json:"children,omitempty"`
}

// FileContent holds file content for delivery to the browser.
type FileContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Size     int64  `json:"size"`
	Language string `json:"language,omitempty"`
}

// ── Filesystem Service ───────────────────────────────────────────────────────

// FilesystemService provides file operations for the browser workspace.
type FilesystemService struct {
	driver  *workspace.WorkspaceManager
	gateway *Gateway
	logger  *zap.SugaredLogger
}

// NewFilesystemService creates a filesystem service.
func NewFilesystemService(driver *workspace.WorkspaceManager, gateway *Gateway, logger *zap.SugaredLogger) *FilesystemService {
	return &FilesystemService{
		driver:  driver,
		gateway: gateway,
		logger:  logger,
	}
}

// GetFileTree returns the full recursive directory structure of the workspace.
func (fs *FilesystemService) GetFileTree(ctx context.Context, workspaceID string) (*FileNode, error) {
	root := &FileNode{
		Name:     "/",
		Path:     ".",
		Type:     "directory",
		Children: []FileNode{},
	}

	if err := fs.buildTreeRecursive(ctx, workspaceID, ".", root); err != nil {
		return nil, err
	}
	return root, nil
}

// buildTreeRecursive populates a FileNode's children by listing the directory
// and recursing into subdirectories. Skips .git and node_modules for performance.
func (fs *FilesystemService) buildTreeRecursive(ctx context.Context, workspaceID, path string, parent *FileNode) error {
	entries, err := fs.driver.ListDir(ctx, workspaceID, path)
	if err != nil {
		return err
	}

	for _, e := range entries {
		// Skip large/irrelevant directories
		if e.Type == "dir" && (e.Name == ".git" || e.Name == "node_modules" || e.Name == "__pycache__" || e.Name == ".venv" || e.Name == "vendor") {
			continue
		}

		childPath := path + "/" + e.Name
		if path == "." {
			childPath = e.Name
		}

		node := FileNode{
			Name: e.Name,
			Path: childPath,
			Size: e.Size,
		}

		if e.Type == "dir" {
			node.Type = "directory"
			node.Children = []FileNode{}
			// Recurse into subdirectory
			if err := fs.buildTreeRecursive(ctx, workspaceID, childPath, &node); err != nil {
				// Non-fatal: skip directories that fail to read
				fs.logger.Warnw("list_dir_failed", "path", childPath, "error", err)
			}
		} else {
			node.Type = "file"
		}

		parent.Children = append(parent.Children, node)
	}
	return nil
}

// ReadFile reads a file from the workspace.
func (fs *FilesystemService) ReadFile(ctx context.Context, workspaceID, path string) (*FileContent, error) {
	data, err := fs.driver.ReadFile(ctx, workspaceID, path)
	if err != nil {
		return nil, err
	}

	return &FileContent{
		Path:     path,
		Content:  string(data),
		Size:     int64(len(data)),
		Language: detectLanguage(path),
	}, nil
}

// WriteFile writes a file to the workspace (human edit).
func (fs *FilesystemService) WriteFile(ctx context.Context, workspaceID, path string, content []byte) error {
	if err := fs.driver.WriteFile(ctx, workspaceID, path, content); err != nil {
		return err
	}

	// Notify subscribers about the change
	fs.gateway.Publish(workspaceID, ChFilesystem, "file_modified", map[string]interface{}{
		"path":    path,
		"content": string(content),
		"size":    len(content),
		"source":  "human",
	})
	return nil
}

// StartWatcher starts file watching for a workspace using inotifywait.
// Detects file changes in real-time and publishes them to the browser.
func (fs *FilesystemService) StartWatcher(ctx context.Context, workspaceID string) {
	go func() {
		fs.logger.Infow("file_watcher_starting", "workspace_id", workspaceID)

		// Spawn inotifywait inside the container to watch /workspace recursively
		events, err := fs.driver.Exec(ctx, workspaceID, workspace.ExecRequest{
			Command: []string{
				"inotifywait", "-m", "-r",
				"--format", "%e %w%f",
				"--exclude", `(\.git/objects|node_modules/\.cache|__pycache__|\.npm)`,
				"/workspace",
			},
			WorkingDir:     "",
			TimeoutSeconds: 0, // no timeout — runs until context cancelled
		})
		if err != nil {
			fs.logger.Warnw("file_watcher_start_failed", "workspace_id", workspaceID, "error", err)
			// Fall back to polling heartbeat
			fs.startPollingFallback(ctx, workspaceID)
			return
		}

		var lastPath string
		var lastTime time.Time

		for ev := range events {
			if ctx.Err() != nil {
				return
			}

			if ev.Type != "stdout" {
				continue
			}

			line := strings.TrimSpace(string(ev.Data))
			if line == "" {
				continue
			}

			// Parse: "EVENT_TYPE /workspace/path/to/file"
			parts := strings.SplitN(line, " ", 2)
			if len(parts) < 2 {
				continue
			}

			eventType := parts[0]
			fullPath := parts[1]

			// Convert to relative path
			relPath := strings.TrimPrefix(fullPath, "/workspace/")
			if relPath == fullPath {
				continue // not under /workspace
			}

			// Debounce: skip if same path within 100ms
			now := time.Now()
			if relPath == lastPath && now.Sub(lastTime) < 100*time.Millisecond {
				continue
			}
			lastPath = relPath
			lastTime = now

			// Map inotify events to our event types
			var fsEvent string
			switch {
			case strings.Contains(eventType, "CREATE"):
				fsEvent = "file_created"
			case strings.Contains(eventType, "CLOSE_WRITE"), strings.Contains(eventType, "MODIFY"):
				fsEvent = "file_modified"
			case strings.Contains(eventType, "DELETE"):
				fsEvent = "file_deleted"
			case strings.Contains(eventType, "MOVED_FROM"):
				fsEvent = "file_deleted"
			case strings.Contains(eventType, "MOVED_TO"):
				fsEvent = "file_created"
			default:
				continue
			}

			// For modified/created, read the new content
			payload := map[string]interface{}{
				"path":  relPath,
				"event": fsEvent,
			}

			if fsEvent != "file_deleted" {
				data, readErr := fs.driver.ReadFile(ctx, workspaceID, relPath)
				if readErr == nil {
					// Only send content for files < 100KB
					if len(data) < 100*1024 {
						payload["content"] = string(data)
					}
					payload["size"] = len(data)
					payload["language"] = detectLanguage(relPath)
				}
			}

			fs.gateway.Publish(workspaceID, ChFilesystem, fsEvent, payload)
		}

		// If we get here, inotifywait exited — restart after delay
		if ctx.Err() == nil {
			fs.logger.Warnw("file_watcher_exited_restarting", "workspace_id", workspaceID)
			time.Sleep(1 * time.Second)
			// Re-check context after sleep — may have been cancelled during the delay
			if ctx.Err() == nil {
				fs.StartWatcher(ctx, workspaceID)
			}
		}
	}()
}

// startPollingFallback runs when inotifywait is not available.
func (fs *FilesystemService) startPollingFallback(ctx context.Context, workspaceID string) {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				fs.gateway.Publish(workspaceID, ChFilesystem, "watcher_heartbeat", map[string]interface{}{
					"active": true,
					"mode":   "polling",
				})
			}
		}
	}()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func detectLanguage(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".css":
		return "css"
	case ".html":
		return "html"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".md":
		return "markdown"
	case ".sql":
		return "sql"
	case ".sh", ".bash":
		return "shell"
	case ".toml":
		return "toml"
	default:
		return ""
	}
}
