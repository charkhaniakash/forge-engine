package browserworkspace

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// ── Preview channel ──────────────────────────────────────────────────────────

const ChPreview = "preview"

// PreviewStatus represents the current state of the dev server.
type PreviewStatus string

const (
	PreviewStatusIdle        PreviewStatus = "idle"
	PreviewStatusStarting    PreviewStatus = "starting"
	PreviewStatusCompiling   PreviewStatus = "compiling"
	PreviewStatusReady       PreviewStatus = "ready"
	PreviewStatusError       PreviewStatus = "error"
	PreviewStatusStopped     PreviewStatus = "stopped"
)

// PreviewSession tracks a running dev server process inside the workspace container.
type PreviewSession struct {
	ID           string        `json:"id"`
	WorkspaceID  string        `json:"workspace_id"`
	Port         int           `json:"port"`
	Command      []string      `json:"command"`
	Status       PreviewStatus `json:"status"`
	URL          string        `json:"url"` // proxy URL exposed to frontend
	// Base is the Vite `--base` the dev server was launched with (equals the
	// proxy prefix). When set, the proxy forwards the FULL original path to the
	// container so Vite can resolve assets under its base. Empty = the dev
	// server serves from root and the proxy strips the prefix as usual.
	Base         string        `json:"base,omitempty"`
	StartedAt    time.Time     `json:"started_at"`
	ErrorMessage string        `json:"error_message,omitempty"`
	crashCount   int
	lastCrashAt  time.Time
	cancel       context.CancelFunc
}

// ── Preview Service ──────────────────────────────────────────────────────────

// PreviewService manages dev server sessions inside workspace containers
// and provides HTTP/WS proxying from the browser to the in-container port.
type PreviewService struct {
	wsManager *workspace.WorkspaceManager
	wsRepo    *repository.WorkspaceRepository
	gateway   *Gateway
	sessions  map[string]*PreviewSession // workspaceID → session
	mu        sync.RWMutex
	logger    *zap.SugaredLogger
}

// NewPreviewService creates the preview service.
func NewPreviewService(
	wsManager *workspace.WorkspaceManager,
	wsRepo *repository.WorkspaceRepository,
	gateway *Gateway,
	logger *zap.SugaredLogger,
) *PreviewService {
	return &PreviewService{
		wsManager: wsManager,
		wsRepo:    wsRepo,
		gateway:   gateway,
		sessions:  make(map[string]*PreviewSession),
		logger:    logger,
	}
}

// StartDevServer launches a dev server inside the workspace container and
// streams its stdout/stderr to the preview channel, parsing compile/HMR events.
// Idempotent: if a session is already running or starting for this workspace,
// returns it immediately without spawning a new process.
func (ps *PreviewService) StartDevServer(
	ctx context.Context,
	workspaceID string,
	command []string,
	port int,
) (*PreviewSession, error) {
	ps.mu.Lock()

	carryCrashCount := 0

	// Idempotency guard: return existing session if one is active.
	// This prevents duplicate dev server processes when StartPreview is called
	// multiple times (e.g. rapid user clicks, React re-renders, or polling retries).
	if existing, ok := ps.sessions[workspaceID]; ok {
		switch existing.Status {
		case PreviewStatusReady, PreviewStatusStarting, PreviewStatusCompiling:
			ps.mu.Unlock()
			ps.logger.Infow("preview_dev_server_already_running",
				"workspace_id", workspaceID, "status", existing.Status)
			return existing, nil
		default:
			// Error or stopped — only restart after a cooldown to prevent a
			// crash→restart→crash loop that floods logs and spawns dozens of
			// processes. Cooldown increases with each consecutive crash.
			cooldown := time.Duration(existing.crashCount*5) * time.Second
			if cooldown < 5*time.Second {
				cooldown = 5 * time.Second
			}
			if cooldown > 60*time.Second {
				cooldown = 60 * time.Second
			}
			if !existing.lastCrashAt.IsZero() && time.Since(existing.lastCrashAt) < cooldown {
				ps.mu.Unlock()
				ps.logger.Infow("preview_restart_cooldown",
					"workspace_id", workspaceID,
					"crash_count", existing.crashCount,
					"cooldown_sec", cooldown.Seconds(),
					"retry_after", existing.lastCrashAt.Add(cooldown),
				)
				return existing, nil
			}
			// Carry the crash count forward so repeated genuine failures back off
			// progressively instead of resetting to a 5s cooldown every time.
			carryCrashCount = existing.crashCount
			existing.cancel()
			delete(ps.sessions, workspaceID)
		}
	}

	// If the command carries a Vite `--base` (injected by StartPreview for
	// Vite-family stacks), record it on the session. The proxy then forwards the
	// full prefixed path to the container so Vite's base middleware can resolve
	// asset/module requests. Empty base = server serves from root.
	base := ""
	for i, a := range command {
		if a == "--base" && i+1 < len(command) {
			base = strings.TrimSuffix(command[i+1], "/") + "/"
			break
		}
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &PreviewSession{
		ID:          fmt.Sprintf("prev-%s-%d", workspaceID[:8], time.Now().UnixMilli()),
		WorkspaceID: workspaceID,
		Port:        port,
		Command:     command,
		Status:      PreviewStatusStarting,
		URL:         fmt.Sprintf("/v1/workspace/%s/preview/proxy/", workspaceID),
		Base:        base,
		StartedAt:   time.Now(),
		crashCount:  carryCrashCount,
		cancel:      cancel,
	}
	ps.sessions[workspaceID] = session
	ps.mu.Unlock()

	// Emit starting event
	ps.publish(workspaceID, "preview_starting", map[string]interface{}{
		"command": command,
		"port":    port,
		"url":     session.URL,
	})

	// Launch dev server in background goroutine
	go ps.runDevServer(sessionCtx, session, workspaceID)

	return session, nil
}

// StopDevServer stops the dev server for a workspace.
func (ps *PreviewService) StopDevServer(workspaceID string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if session, ok := ps.sessions[workspaceID]; ok {
		session.cancel()
		session.Status = PreviewStatusStopped
		delete(ps.sessions, workspaceID)
	}
	ps.publish(workspaceID, "preview_stopped", map[string]interface{}{})
}

// GetSession returns the preview session for a workspace.
func (ps *PreviewService) GetSession(workspaceID string) *PreviewSession {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return ps.sessions[workspaceID]
}

// runDevServer starts the command in the container and tails its output.
func (ps *PreviewService) runDevServer(ctx context.Context, session *PreviewSession, workspaceID string) {
	log := ps.logger.With("workspace_id", workspaceID, "port", session.Port)

	// Ensure dependencies are installed before starting the dev server. A fresh
	// workspace is a shallow git clone with NO node_modules, so `npm run dev`
	// (vite / react-scripts / next) would exit immediately with a missing-binary
	// error. This mirrors what v0/Bolt do: install once, then serve.
	if err := ps.ensureDependencies(ctx, session, workspaceID, log); err != nil {
		if ctx.Err() != nil {
			return // cancelled during install — not a crash
		}
		log.Warnw("preview_dependency_install_failed", "error", err)
		ps.recordCrash(workspaceID, "dependency install failed: "+err.Error())
		ps.publish(workspaceID, "preview_error", map[string]interface{}{
			"error": "dependency install failed: " + err.Error(),
		})
		return
	}

	log.Infow("preview_dev_server_starting", "command", session.Command)

	events, err := ps.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        session.Command,
		WorkingDir:     ".",
		TimeoutSeconds: 0, // no timeout — runs until cancelled
		Env: map[string]string{
			// Root fs is read-only; override HOME for any tools that write to
			// $HOME directly. NPM_CONFIG_CACHE is already set to /home/forge/.npm
			// by the forge-sandbox-node Dockerfile and the volume mount makes it
			// persistent — no need to override it here.
			"HOME": "/workspace",
		},
	})
	if err != nil {
		log.Warnw("preview_dev_server_start_failed", "error", err)
		ps.updateStatus(workspaceID, PreviewStatusError)
		ps.publish(workspaceID, "preview_error", map[string]interface{}{
			"error": err.Error(),
		})
		return
	}

	var outputBuf strings.Builder
	ready := false

	for ev := range events {
		if ctx.Err() != nil {
			return
		}

		switch ev.Type {
		case "stdout", "stderr":
			chunk := string(ev.Data)
			outputBuf.WriteString(chunk)

			// Stream raw output to terminal channel so it appears in the terminal
			ps.gateway.Publish(workspaceID, ChTerminal, "output", map[string]interface{}{
				"terminal_id": "preview",
				"data":        chunk,
			})

			// Parse dev server lifecycle events from the output
			lower := strings.ToLower(chunk)
			switch {
			case !ready && (
				strings.Contains(lower, "local:") ||
				strings.Contains(lower, "localhost:") ||
				strings.Contains(lower, "ready in") ||
				strings.Contains(lower, "server running") ||
				strings.Contains(lower, "started server") ||
				strings.Contains(lower, "listening on") ||
				strings.Contains(lower, "compiled successfully") ||
				strings.Contains(lower, "webpack compiled") ||
				strings.Contains(lower, "vite") && strings.Contains(lower, "ready") ||
				strings.Contains(lower, "next.js") && strings.Contains(lower, "ready")):
				ready = true
				ps.updateStatus(workspaceID, PreviewStatusReady)
				ps.publish(workspaceID, "preview_ready", map[string]interface{}{
					"port":    session.Port,
					"url":     session.URL,
					"message": strings.TrimSpace(chunk),
				})
				log.Infow("preview_dev_server_ready")

			case strings.Contains(lower, "compiling") ||
				strings.Contains(lower, "building") ||
				strings.Contains(lower, "bundling") ||
				strings.Contains(lower, "processing"):
				if ready {
					// Already ready — this is a recompile (file change triggered HMR)
					ps.updateStatus(workspaceID, PreviewStatusCompiling)
					ps.publish(workspaceID, "preview_compiling", map[string]interface{}{
						"message": strings.TrimSpace(chunk),
					})
				}

			case ready && (
				strings.Contains(lower, "compiled successfully") ||
				strings.Contains(lower, "[hmr]") ||
				strings.Contains(lower, "hot module") ||
				strings.Contains(lower, "page reload") ||
				strings.Contains(lower, "updated") ||
				strings.Contains(lower, "rebuilt")):
				ps.updateStatus(workspaceID, PreviewStatusReady)
				ps.publish(workspaceID, "preview_hmr", map[string]interface{}{
					"message": strings.TrimSpace(chunk),
					"type":    detectHMRType(lower),
				})

			case strings.Contains(lower, "error") && !strings.Contains(lower, "warning"):
				if !strings.Contains(lower, "eslint") {
					// Real build/runtime error
					ps.publish(workspaceID, "preview_build_error", map[string]interface{}{
						"message": strings.TrimSpace(chunk),
					})
				}
			}

		case "exit":
			code := 0
			if ev.ExitCode != nil {
				code = *ev.ExitCode
			}
			if code != 0 {
				ps.recordCrash(workspaceID, outputBuf.String())
				ps.publish(workspaceID, "preview_error", map[string]interface{}{
					"exit_code": code,
					"output":    outputBuf.String(),
				})
			} else {
				ps.updateStatus(workspaceID, PreviewStatusStopped)
				ps.publish(workspaceID, "preview_stopped", map[string]interface{}{})
			}
		}
	}
}

// updateStatus updates the session status safely.
func (ps *PreviewService) updateStatus(workspaceID string, status PreviewStatus) {
	ps.mu.Lock()
	if session, ok := ps.sessions[workspaceID]; ok {
		session.Status = status
	}
	ps.mu.Unlock()
}

// recordCrash marks the session as errored and records crash metadata for
// cooldown logic that prevents restart loops.
func (ps *PreviewService) recordCrash(workspaceID string, output string) {
	ps.mu.Lock()
	if session, ok := ps.sessions[workspaceID]; ok {
		session.Status = PreviewStatusError
		session.crashCount++
		session.lastCrashAt = time.Now()
		// Capture first ~500 chars of output for the error message.
		errMsg := strings.TrimSpace(output)
		if len(errMsg) > 500 {
			errMsg = errMsg[:500] + "…"
		}
		session.ErrorMessage = errMsg
		ps.logger.Warnw("preview_dev_server_crashed",
			"workspace_id", workspaceID,
			"crash_count", session.crashCount,
			"cooldown_next_sec", session.crashCount*5,
		)
	}
	ps.mu.Unlock()
}

// ensureDependencies installs node_modules if they are missing. A fresh
// workspace clone has no dependencies, so the dev server cannot start until
// they are installed. Runs the install to completion (streaming to the
// terminal channel) before returning. Idempotent: if node_modules already
// exists, returns immediately.
func (ps *PreviewService) ensureDependencies(
	ctx context.Context,
	session *PreviewSession,
	workspaceID string,
	log *zap.SugaredLogger,
) error {
	// Skip if node_modules already present.
	if exists, err := ps.wsManager.Exists(ctx, workspaceID, "node_modules"); err == nil && exists {
		log.Infow("preview_dependencies_present_skipping_install")
		return nil
	}

	installCmd := ps.installCommandFor(ctx, workspaceID, session)
	log.Infow("preview_installing_dependencies", "command", installCmd)
	ps.publish(workspaceID, "preview_installing", map[string]interface{}{
		"command": installCmd,
		"message": "Installing dependencies…",
	})
	// Surface install in the terminal so the user sees progress.
	ps.gateway.Publish(workspaceID, ChTerminal, "output", map[string]interface{}{
		"terminal_id": "preview",
		"data":        fmt.Sprintf("$ %s\n", strings.Join(installCmd, " ")),
	})

	// Install can be slow on large dependency trees; give it a generous ceiling.
	// The container root is read-only (only /workspace and /tmp are writable), and
	// the node image bakes NPM_CONFIG_CACHE=/home/forge/.npm which is NOT writable.
	// Redirect npm/yarn/pnpm caches onto the writable /workspace volume so install
	// doesn't fail with EROFS. These dirs are never committed (publish stages only
	// specific changed files).
	events, err := ps.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        installCmd,
		WorkingDir:     ".",
		TimeoutSeconds: 600,
		Env: map[string]string{
			// NPM_CONFIG_CACHE is already /home/forge/.npm via the Dockerfile ENV
			// and the shared volume makes it persistent. Override HOME so that
			// any tool that writes $HOME/... ends up in /workspace (writable).
			"YARN_CACHE_FOLDER": "/home/forge/.yarn-cache",
			"HOME":              "/workspace",
		},
	})
	if err != nil {
		return fmt.Errorf("could not start install: %w", err)
	}

	var tail strings.Builder
	exitCode := 0
	for ev := range events {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch ev.Type {
		case "stdout", "stderr":
			chunk := string(ev.Data)
			ps.gateway.Publish(workspaceID, ChTerminal, "output", map[string]interface{}{
				"terminal_id": "preview",
				"data":        chunk,
			})
			// Keep a bounded tail for the error message on failure.
			tail.WriteString(chunk)
			if tail.Len() > 4000 {
				s := tail.String()
				tail.Reset()
				tail.WriteString(s[len(s)-2000:])
			}
		case "exit":
			if ev.ExitCode != nil {
				exitCode = *ev.ExitCode
			}
		}
	}

	if exitCode != 0 {
		msg := strings.TrimSpace(tail.String())
		if len(msg) > 400 {
			msg = "…" + msg[len(msg)-400:]
		}
		return fmt.Errorf("install exited %d: %s", exitCode, msg)
	}

	log.Infow("preview_dependencies_installed")
	ps.publish(workspaceID, "preview_installed", map[string]interface{}{
		"message": "Dependencies installed",
	})
	return nil
}

// installCommandFor derives the dependency-install command from the package
// manager the dev command uses (session.Command[0]). Falls back to npm when the
// detected manager binary isn't available in the workspace container.
func (ps *PreviewService) installCommandFor(
	ctx context.Context,
	workspaceID string,
	session *PreviewSession,
) []string {
	pm := "npm"
	if len(session.Command) > 0 {
		pm = session.Command[0]
	}

	// If the detected PM binary isn't in the container, fall back to npm.
	if pm != "npm" {
		if exists, err := ps.binaryExists(ctx, workspaceID, pm); err == nil && !exists {
			ps.logger.Warnw("preview_pm_missing_falling_back_to_npm",
				"workspace_id", workspaceID, "missing_pm", pm)
			pm = "npm"
		}
	}

	switch pm {
	case "yarn":
		return []string{"yarn", "install"}
	case "pnpm":
		return []string{"pnpm", "install"}
	case "bun":
		return []string{"bun", "install"}
	default:
		return []string{"npm", "install", "--no-audit", "--no-fund"}
	}
}

// binaryExists reports whether a command is on PATH inside the workspace container.
func (ps *PreviewService) binaryExists(ctx context.Context, workspaceID, bin string) (bool, error) {
	return binaryInContainer(ctx, ps.wsManager, workspaceID, bin), nil
}

// binaryInContainer reports whether a command is on PATH inside the workspace
// container. Returns false on any error (missing binary is the safe assumption
// so callers fall back to npm). Package-level so DetectDevServer can use it
// without a PreviewService receiver.
func binaryInContainer(ctx context.Context, wsManager *workspace.WorkspaceManager, workspaceID, bin string) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	events, err := wsManager.Exec(checkCtx, workspaceID, workspace.ExecRequest{
		Command:        []string{"which", bin},
		TimeoutSeconds: 5,
	})
	if err != nil {
		return false
	}
	exitCode := -1
	for ev := range events {
		if ev.Type == "exit" && ev.ExitCode != nil {
			exitCode = *ev.ExitCode
		}
	}
	return exitCode == 0
}

func (ps *PreviewService) publish(workspaceID, event string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	payload["ts"] = time.Now().UnixMilli()
	ps.gateway.Publish(workspaceID, ChPreview, event, payload)
}

// detectHMRType infers whether an HMR update is a full reload or a hot patch.
func detectHMRType(lower string) string {
	if strings.Contains(lower, "page reload") || strings.Contains(lower, "full reload") {
		return "full_reload"
	}
	if strings.Contains(lower, "[hmr]") || strings.Contains(lower, "hot module") {
		return "hot_update"
	}
	return "update"
}

// ── HTTP Proxy ────────────────────────────────────────────────────────────────
//
// The preview proxy serves the running dev server to the browser iframe.
// Since `curl` is not guaranteed in the forge sandbox image, we use `wget`
// (which is available in ubuntu:22.04) with `-O -` to stream the response.
//
// For full-fidelity proxying (headers, WebSocket HMR), the sandbox image would
// need either curl or socat installed. For now we serve an HTML page that
// redirects to the container IP:port, which works when the container is on
// the same Docker bridge network as the backend (bridge mode, not host).
//
// Proxy priority:
//   1. If wget is available → use it (returns raw HTML body, no headers)
//   2. Fallback → serve a meta-refresh page pointing to the actual URL
//
// For local Docker Compose deployments the container IP is reachable from
// the host browser via the Docker bridge IP, so the redirect approach works.
func (ps *PreviewService) ProxyHandler(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	reqPath := c.Params("*")
	if reqPath == "" {
		reqPath = "/"
	}
	if !strings.HasPrefix(reqPath, "/") {
		reqPath = "/" + reqPath
	}
	if qs := string(c.Request().URI().QueryString()); qs != "" {
		reqPath = reqPath + "?" + qs
	}

	ps.mu.RLock()
	session, ok := ps.sessions[workspaceID]
	ps.mu.RUnlock()

	if !ok || session.Status == PreviewStatusStopped || session.Status == PreviewStatusError {
		status := "not_started"
		if ok {
			status = string(session.Status)
		}
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error":  "dev server not running",
			"status": status,
		})
	}

	if session.Status == PreviewStatusStarting {
		c.Set("Content-Type", "text/html")
		return c.SendString(buildLoadingPage(PreviewStatusStarting))
	}

	// ── Path mode ────────────────────────────────────────────────────────
	// When the dev server was launched with a Vite `--base` equal to the proxy
	// prefix, Vite serves EVERY asset (HTML, /@vite/client, /src/*,
	// /node_modules/.vite/*) from under that base. We must forward the FULL
	// original request path to the container and let Vite strip its own base.
	// For root-serving stacks (CRA, Next, etc.) we strip the proxy prefix here
	// as before, and rewrite absolute-root asset URLs in responses instead.
	if session.Base != "" {
		reqPath = string(c.Request().URI().Path())
		if reqPath == "" {
		reqPath = "/"
		}
		if qs := string(c.Request().URI().QueryString()); qs != "" {
			reqPath += "?" + qs
		}
	}

	// Resolve the container IP from the workspace container name/ID so we can
	// build an address the Go backend (inside Docker bridge) can reach.
	containerIP, err := ps.resolveContainerIP(c.Context(), workspaceID)
	if err != nil || containerIP == "" {
		// Cannot resolve IP — serve a loading/error page
		c.Set("Content-Type", "text/html")
		return c.SendString(buildLoadingPage(session.Status))
	}

	targetURL := fmt.Sprintf("http://%s:%d%s", containerIP, session.Port, reqPath)
	ps.logger.Infow("preview_proxy_request",
		"workspace_id", workspaceID,
		"method", string(c.Method()),
		"path", reqPath,
		"target", targetURL,
		"base", session.Base,
	)

	// Attempt to proxy via the Go HTTP client (no curl/wget needed)
	proxyCtx, proxyCancel := context.WithTimeout(c.Context(), 10*time.Second)
	defer proxyCancel()

	req, err := http.NewRequestWithContext(proxyCtx, string(c.Method()), targetURL, c.Request().BodyStream())
	if err != nil {
		c.Set("Content-Type", "text/html")
		return c.SendString(buildErrorPage(fmt.Sprintf("proxy error: %v", err)))
	}

	// Forward safe request headers
	c.Request().Header.VisitAll(func(k, v []byte) {
		key := string(k)
		if !isHopByHopHeader(key) && !strings.EqualFold(key, "Host") {
			req.Header.Set(key, string(v))
		}
	})
	req.Header.Set("X-Forwarded-For", c.IP())
	req.Header.Set("X-Forwarded-Host", c.Hostname())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Dev server may not be listening yet — show loading page
		ps.logger.Warnw("preview_proxy_upstream_error",
			"workspace_id", workspaceID,
			"target", targetURL,
			"error", err.Error(),
		)
		c.Set("Content-Type", "text/html")
		return c.SendString(buildLoadingPage(PreviewStatusStarting))
	}
	defer resp.Body.Close()

	// Forward response headers. Content-Length is deliberately skipped: the
	// body may be rewritten below (changing its length), and Fiber recomputes
	// the correct value on Send.
	for key, vals := range resp.Header {
		if !isHopByHopHeader(key) &&
			!strings.EqualFold(key, "Transfer-Encoding") &&
			!strings.EqualFold(key, "Content-Length") {
			for _, v := range vals {
				c.Set(key, v)
			}
		}
	}
	c.Status(resp.StatusCode)

	body, _ := io.ReadAll(resp.Body)
	ps.logger.Infow("preview_proxy_response",
		"workspace_id", workspaceID,
		"path", reqPath,
		"status", resp.StatusCode,
		"content_type", resp.Header.Get("Content-Type"),
		"bytes", len(body),
		"rewritten", session.Base == "" && resp.Header.Get("Content-Encoding") == "",
	)

	// Root-serving fallback: rewrite absolute-root asset URLs in HTML/JS/CSS
	// so they carry the proxy prefix instead of escaping to the page origin
	// (where they 404 → blank iframe). Skipped when the server already runs
	// under a Vite --base (URLs are already prefixed) or the body is compressed.
	if session.Base == "" && resp.Header.Get("Content-Encoding") == "" {
		prefix := fmt.Sprintf("/v1/workspace/%s/preview/proxy/", workspaceID)
		body = rewriteSubpath(body, resp.Header.Get("Content-Type"), prefix)
	}

	return c.Send(body)
}

// resolveContainerIP returns the Docker bridge IP of the workspace container.
// This allows the Go backend (also on the bridge network) to reach the dev server
// directly via HTTP without needing port publishing.
func (ps *PreviewService) resolveContainerIP(ctx context.Context, workspaceID string) (string, error) {
	// Use `hostname -i` inside the container to get its bridge IP
	events, err := ps.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        []string{"hostname", "-i"},
		TimeoutSeconds: 5,
	})
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for ev := range events {
		if ev.Type == "stdout" {
			out.Write(ev.Data)
		}
	}
	ip := strings.TrimSpace(out.String())
	// hostname -i may return multiple IPs separated by spaces; take the first
	if parts := strings.Fields(ip); len(parts) > 0 {
		return parts[0], nil
	}
	return ip, nil
}

// ── Sub-path URL rewriting (fallback for root-serving dev servers) ───────────
//
// CRA (react-scripts), Next and other stacks serve their dev app from the root
// and cannot be told to serve under a sub-path the way Vite accepts `--base`.
// When proxying such a server under /v1/workspace/<id>/preview/proxy/, absolute
// URLs like `/@vite/client`, `/src/main.jsx`, `/_next/static/...` would be
// requested from the page-origin root and 404. We rewrite those references in
// HTML attributes, JS module specifiers and CSS url()/@import so every asset
// request goes back through the proxy prefix.
var (
	reHTMLRef = regexp.MustCompile(`(?i)\b((?:src|href|poster|data-src)\s*=\s*)("|')(/[^"']*)("|')`)
	reJSSpec  = regexp.MustCompile(`(from\s+|import\s*\(|import\s+)("|')(/[^"']+)("|')`)
	reCSSURL  = regexp.MustCompile(`(url\s*\(\s*)("|')?(/[^)"']+)("|'\)|\s*\))`)
	reCSSImp  = regexp.MustCompile(`(@import\s+)("|')(/[^"']+)("|')`)
)

// rewriteSubpath prefixes root-relative (/...) asset URLs with `prefix` inside
// HTML, JavaScript or CSS bodies, depending on the declared content type.
// Already-prefixed and scheme-absolute (https://...) URLs are left untouched.
func rewriteSubpath(body []byte, contentType, prefix string) []byte {
	if prefix == "" || len(body) == 0 {
		return body
	}
	ct := strings.ToLower(contentType)
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}

	pre := func(url string) string {
		if strings.HasPrefix(url, prefix) {
			return url // already prefixed
		}
		return prefix + strings.TrimPrefix(url, "/")
	}

	switch ct {
	case "text/html", "application/xhtml+xml":
		// <script src="/@vite/client"> → src="<prefix>@vite/client"
		return []byte(reHTMLRef.ReplaceAllStringFunc(string(body), func(m string) string {
			p := reHTMLRef.FindStringSubmatch(m)
			if len(p) < 5 || len(p[3]) == 0 || p[3][0] != '/' {
				return m
			}
			return p[1] + p[2] + pre(p[3]) + p[4]
		}))
	case "application/javascript", "text/javascript", "application/x-javascript", "module", "text/jsx":
		// import X from "/src/foo"; import("/src/foo"); import "/x"
		return []byte(reJSSpec.ReplaceAllStringFunc(string(body), func(m string) string {
			p := reJSSpec.FindStringSubmatch(m)
			if len(p) < 5 || len(p[3]) == 0 || p[3][0] != '/' {
				return m
			}
			return p[1] + p[2] + pre(p[3]) + p[4]
		}))
	case "text/css":
		// url("/img/x.png") and @import "/x.css"
		out := reCSSURL.ReplaceAllStringFunc(string(body), func(m string) string {
			p := reCSSURL.FindStringSubmatch(m)
			if len(p) < 5 || len(p[3]) == 0 || p[3][0] != '/' {
				return m
			}
			return p[1] + p[2] + pre(p[3]) + p[4]
		})
		return []byte(reCSSImp.ReplaceAllStringFunc(out, func(m string) string {
			p := reCSSImp.FindStringSubmatch(m)
			if len(p) < 5 || len(p[3]) == 0 || p[3][0] != '/' {
				return m
			}
			return p[1] + p[2] + pre(p[3]) + p[4]
		}))
	default:
		return body
	}
}

// devServerUsesVite reports whether the workspace's dev script runs Vite
// (which accepts `--base`). Used when the caller supplies a custom command so
// we still inject the proxy prefix as the Vite base.
func devServerUsesVite(ctx context.Context, wsManager *workspace.WorkspaceManager, workspaceID string) bool {
	data, err := wsManager.ReadFile(ctx, workspaceID, "package.json")
	if err != nil {
		return false
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return false
	}
	for _, s := range []string{"dev", "start", "serve", "preview"} {
		if script, ok := pkg.Scripts[s]; ok {
			return strings.Contains(strings.ToLower(script), "vite")
		}
	}
	return false
}

// isHopByHopHeader returns true for headers that should not be forwarded.
func isHopByHopHeader(h string) bool {
	lower := strings.ToLower(h)
	hopByHop := []string{
		"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailers", "transfer-encoding", "upgrade",
	}
	for _, hbh := range hopByHop {
		if lower == hbh {
			return true
		}
	}
	return false
}

// buildLoadingPage returns an HTML page shown while the dev server is starting.
func buildLoadingPage(status PreviewStatus) string {
	msg := "Starting Development Server…"
	if status == PreviewStatusCompiling {
		msg = "Compiling…"
	}
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="2">
  <title>%s</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{display:flex;align-items:center;justify-content:center;height:100vh;
         background:#0a0a0b;color:#71717a;font-family:monospace;flex-direction:column;gap:16px}
    .spinner{width:32px;height:32px;border:2px solid #1f2937;
             border-top:2px solid #00ff66;border-radius:50%%;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{font-size:13px;color:#9ca3af}
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>%s</p>
</body>
</html>`, msg, msg)
}

// buildErrorPage returns a simple error HTML page.
func buildErrorPage(message string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Preview Error</title>
<style>*{margin:0;padding:0}body{display:flex;align-items:center;justify-content:center;
height:100vh;background:#0a0a0b;color:#ef4444;font-family:monospace;flex-direction:column;gap:12px}
p{font-size:12px;color:#9ca3af;max-width:400px;text-align:center}</style></head>
<body><span style="font-size:32px">⚠</span><p>%s</p></body>
</html>`, message)
}

// ── DevServer AutoDetect ──────────────────────────────────────────────────────

// DevServerConfig holds the detected dev server configuration for a workspace.
type DevServerConfig struct {
	Command []string `json:"command"`
	Port    int      `json:"port"`
	Manager string   `json:"manager"` // npm|yarn|pnpm|bun
	Vite    bool     `json:"vite"`    // true when the dev script runs Vite (supports --base)
}

// DetectDevServer inspects the workspace to determine how to start its dev server.
// Reads package.json and checks for common start scripts.
func DetectDevServer(ctx context.Context, wsManager *workspace.WorkspaceManager, workspaceID string) (*DevServerConfig, error) {
	data, err := wsManager.ReadFile(ctx, workspaceID, "package.json")
	if err != nil {
		return nil, fmt.Errorf("no package.json found")
	}

	var pkg struct {
		Scripts map[string]string `json:"scripts"`
		Engines map[string]string `json:"engines"`
	}
	if jsonErr := json.Unmarshal(data, &pkg); jsonErr != nil {
		return nil, fmt.Errorf("invalid package.json: %w", jsonErr)
	}

	// Detect package manager (in priority order).
	// wsManager.Exists returns (bool, error); we must check the bool, not just err.
	pm := "npm"
	if exists, err := wsManager.Exists(ctx, workspaceID, "bun.lockb"); err == nil && exists {
		pm = "bun"
	} else if exists, err := wsManager.Exists(ctx, workspaceID, "pnpm-lock.yaml"); err == nil && exists {
		pm = "pnpm"
	} else if exists, err := wsManager.Exists(ctx, workspaceID, "yarn.lock"); err == nil && exists {
		pm = "yarn"
	}

	// The workspace container ships node + npm, but NOT bun/yarn/pnpm. If the
	// lockfile points at a manager whose binary isn't installed, `<pm> run dev`
	// would fail with "executable file not found". Fall back to npm, which
	// resolves from package.json regardless of which lockfile exists. This
	// mirrors the same fallback the validation engine does.
	if pm != "npm" && !binaryInContainer(ctx, wsManager, workspaceID, pm) {
		pm = "npm"
	}

	// Find the right start script in priority order
	scriptPriority := []string{"dev", "start", "serve", "preview"}
	var scriptName string
	for _, s := range scriptPriority {
		if _, ok := pkg.Scripts[s]; ok {
			scriptName = s
			break
		}
	}
	if scriptName == "" {
		return nil, fmt.Errorf("no dev/start script found in package.json")
	}

	// Determine port + host-binding args from script content. The dev server
	// MUST bind to 0.0.0.0 (not the default 127.0.0.1) so the backend can reach
	// it over the Docker bridge to proxy the preview iframe. Each framework takes
	// a different flag; CRA (react-scripts) uses the HOST env var instead, which
	// runDevServer sets, so it needs no extra args.
	port := 3000
	var hostArgs []string
	scriptContent := strings.ToLower(pkg.Scripts[scriptName])
	switch {
	case strings.Contains(scriptContent, "vite"):
		port = 5173
		hostArgs = []string{"--host", "0.0.0.0"}
	case strings.Contains(scriptContent, "next"):
		port = 3000
		hostArgs = []string{"-H", "0.0.0.0"}
	case strings.Contains(scriptContent, "react-scripts"):
		port = 3000 // binds via HOST=0.0.0.0 env (set in runDevServer)
	case strings.Contains(scriptContent, "vue"):
		port = 5173
		hostArgs = []string{"--host", "0.0.0.0"}
	case strings.Contains(scriptContent, "nuxt"):
		port = 3000
		hostArgs = []string{"--host", "0.0.0.0"}
	case strings.Contains(scriptContent, "svelte"):
		port = 5173
		hostArgs = []string{"--host", "0.0.0.0"}
	case strings.Contains(scriptContent, "astro"):
		port = 4321
		hostArgs = []string{"--host", "0.0.0.0"}
	case strings.Contains(scriptContent, "remix"):
		port = 3000
		hostArgs = []string{"--host", "0.0.0.0"}
	}

	var cmd []string
	switch pm {
	case "yarn":
		cmd = []string{"yarn", scriptName}
	case "pnpm":
		cmd = []string{"pnpm", scriptName}
	case "bun":
		cmd = []string{"bun", "run", scriptName}
	default:
		cmd = []string{"npm", "run", scriptName}
	}
	// Pass host args through to the underlying script. The `--` separator is
	// required by npm/pnpm and tolerated by yarn/bun.
	if len(hostArgs) > 0 {
		cmd = append(cmd, "--")
		cmd = append(cmd, hostArgs...)
	}

	return &DevServerConfig{
		Command: cmd,
		Port:    port,
		Manager: pm,
		// vite/vue/svelte scripts contain "vite" (their dev servers run the Vite
		// CLI and accept `--base`); astro/nuxt/next/react-scripts do not.
		Vite: strings.Contains(scriptContent, "vite"),
	}, nil
}

// ── REST Handlers ─────────────────────────────────────────────────────────────

// StartPreview auto-detects and starts the dev server.
// POST /v1/workspace/:workspaceID/preview/start
func (h *Handlers) StartPreview(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	h.logger.Infow("preview_start_requested",
		"workspace_id", workspaceID,
		"remote_ip", c.IP(),
		"user_agent", c.Get("User-Agent"),
		"referer", c.Get("Referer"),
	)

	if h.previewService == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "preview service not configured",
		})
	}

	// If a session is already running or starting, return it instead of restarting.
	// This prevents repeated calls (from file-change events or rapid clicks)
	// from spawning multiple dev server processes.
	if existing := h.previewService.GetSession(workspaceID); existing != nil {
		if existing.Status == PreviewStatusReady ||
			existing.Status == PreviewStatusStarting ||
			existing.Status == PreviewStatusCompiling {
			return c.JSON(existing)
		}
	}

	// Accept optional override from body
	var body struct {
		Command []string `json:"command"`
		Port    int      `json:"port"`
	}
	_ = c.BodyParser(&body)

	// Auto-detect if not provided
	var usesVite bool
	if len(body.Command) == 0 {
		cfg, err := DetectDevServer(ctx, h.wsManager, workspaceID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": fmt.Sprintf("could not detect dev server: %v", err),
			})
		}
		body.Command = cfg.Command
		if body.Port == 0 {
			body.Port = cfg.Port
		}
		usesVite = cfg.Vite
	} else {
		usesVite = devServerUsesVite(ctx, h.wsManager, workspaceID)
	}
	if body.Port == 0 {
		body.Port = 3000
	}

	// Vite-family dev servers natively support `--base`. Point it at the proxy
	// prefix so every asset/module URL the browser requests (e.g. /@vite/client,
	// /src/main.jsx, /node_modules/.vite/...) carries the
	// /v1/workspace/<id>/preview/proxy/ prefix instead of escaping to the page
	// origin root where it 404s → blank iframe.
	if usesVite {
		base := fmt.Sprintf("/v1/workspace/%s/preview/proxy/", workspaceID)
		body.Command = append(body.Command, "--base", base)
	}

	session, err := h.previewService.StartDevServer(ctx, workspaceID, body.Command, body.Port)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	return c.Status(fiber.StatusCreated).JSON(session)
}

// StopPreview stops the dev server.
// DELETE /v1/workspace/:workspaceID/preview
func (h *Handlers) StopPreview(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	if h.previewService == nil {
		return c.Status(fiber.StatusNoContent).Send(nil)
	}
	h.previewService.StopDevServer(workspaceID)
	return c.JSON(fiber.Map{"stopped": true})
}

// GetPreviewStatus returns the current preview session.
// GET /v1/workspace/:workspaceID/preview
func (h *Handlers) GetPreviewStatus(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	if h.previewService == nil {
		return c.JSON(fiber.Map{"status": "idle"})
	}
	session := h.previewService.GetSession(workspaceID)
	if session == nil {
		return c.JSON(fiber.Map{"status": "idle"})
	}
	return c.JSON(session)
}

// ProxyPreview proxies HTTP requests to the running dev server.
// GET/POST/etc /v1/workspace/:workspaceID/preview/proxy/*
func (h *Handlers) ProxyPreview(c *fiber.Ctx) error {
	if h.previewService == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "preview service not configured",
		})
	}
	return h.previewService.ProxyHandler(c)
}

// ── Helper: build a simple reverse proxy via socat for WebSocket HMR ─────────
// This is future work — for now the iframe uses the curl proxy which handles
// HTTP/1.1. WebSocket HMR (vite) requires upgrading the connection, which
// needs a different transport. The preview panel uses the `postMessage` API
// to request a hard-reload from the iframe on `preview_hmr` events instead.

// buildReverseProxy creates a net/http reverse proxy that targets a URL.
// Not used directly in Fiber but available for integration tests.
func buildReverseProxy(target string) (*httputil.ReverseProxy, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	return httputil.NewSingleHostReverseProxy(u), nil
}

// drainReader reads and discards all bytes from a reader (prevents goroutine leaks).
func drainReader(r io.Reader) {
	_, _ = io.Copy(io.Discard, r)
}

// Keep imports used.
var (
	_ = http.StatusOK
	_ = drainReader
	_ = buildReverseProxy
)
