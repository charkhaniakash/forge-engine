package handlers

import (
	"context"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

type GitHubHandlers struct {
	installationRepo *repository.GitHubInstallationRepository
	repoRepo         *repository.GitHubRepoRepository
	tokenCache       *github.TokenCache
	client           *github.Client
	logger           *zap.SugaredLogger
}

func NewGitHubHandlers(
	installationRepo *repository.GitHubInstallationRepository,
	repoRepo *repository.GitHubRepoRepository,
	tokenCache *github.TokenCache,
	client *github.Client,
	logger *zap.SugaredLogger,
) *GitHubHandlers {
	return &GitHubHandlers{
		installationRepo: installationRepo,
		repoRepo:         repoRepo,
		tokenCache:       tokenCache,
		client:           client,
		logger:           logger,
	}
}

// Webhook handles GitHub webhook events
func (h *GitHubHandlers) Webhook(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)

	// Read raw body
	body := c.Body()
	if len(body) == 0 {
		h.logger.Warnw("webhook_empty_body", "trace_id", traceID)
		return c.Status(400).JSON(fiber.Map{"error": "empty body"})
	}

	// Verify signature
	signature := c.Get("X-Hub-Signature-256")
	if !h.client.VerifyWebhookSignature(body, signature) {
		h.logger.Warnw("webhook_invalid_signature", "trace_id", traceID)
		return c.Status(401).JSON(fiber.Map{"error": "invalid signature"})
	}

	// Get event type
	eventType := c.Get("X-GitHub-Event")
	if eventType == "" {
		h.logger.Warnw("webhook_missing_event_type", "trace_id", traceID)
		return c.Status(400).JSON(fiber.Map{"error": "missing event type"})
	}

	h.logger.Infow("webhook_received", "event_type", eventType, "trace_id", traceID)

	// Parse event
	event, err := github.ParseWebhookEvent(body, eventType)
	if err != nil {
		h.logger.Errorw("webhook_parse_failed", "error", err, "event_type", eventType, "trace_id", traceID)
		return c.Status(400).JSON(fiber.Map{"error": "failed to parse event"})
	}

	// Handle event based on type
	switch eventType {
	case "installation":
		return h.handleInstallationEvent(c, event.(*github.InstallationEvent), traceID)
	case "installation_repositories":
		return h.handleInstallationRepositoriesEvent(c, event.(*github.InstallationEvent), traceID)
	default:
		h.logger.Infow("webhook_unhandled_event", "event_type", eventType, "trace_id", traceID)
		return c.Status(200).JSON(fiber.Map{"message": "event received but not handled"})
	}
}

// handleInstallationEvent handles installation/deinstallation events
func (h *GitHubHandlers) handleInstallationEvent(c *fiber.Ctx, event *github.InstallationEvent, traceID string) error {
	ctx := c.Context()

	switch event.Action {
	case "created":
		// Installation created - we need to link this to an org
		// For now, we'll create a pending installation that needs to be claimed
		// In a real flow, this would happen via the frontend install redirect
		h.logger.Infow("installation_created",
			"github_installation_id", event.Installation.ID,
			"github_account", event.Installation.Account.Login,
			"trace_id", traceID,
		)
		return c.Status(200).JSON(fiber.Map{"message": "installation created"})

	case "deleted":
		// Installation deleted - remove from our system
		installation, err := h.installationRepo.GetByGitHubInstallationID(ctx, event.Installation.ID)
		if err != nil {
			h.logger.Warnw("installation_not_found_on_delete",
				"github_installation_id", event.Installation.ID,
				"error", err,
				"trace_id", traceID,
			)
			return c.Status(200).JSON(fiber.Map{"message": "installation not found, already deleted"})
		}

		// Delete repos first
		if err := h.repoRepo.DeleteByInstallationID(ctx, installation.ID); err != nil {
			h.logger.Errorw("failed_to_delete_repos_on_uninstall",
				"installation_id", installation.ID,
				"error", err,
				"trace_id", traceID,
			)
		}

		// Delete installation
		if err := h.installationRepo.DeleteInstallation(ctx, installation.ID); err != nil {
			h.logger.Errorw("failed_to_delete_installation",
				"installation_id", installation.ID,
				"error", err,
				"trace_id", traceID,
			)
			return c.Status(500).JSON(fiber.Map{"error": "failed to delete installation"})
		}

		// Invalidate token
		if err := h.tokenCache.InvalidateToken(ctx, event.Installation.ID); err != nil {
			h.logger.Warnw("failed_to_invalidate_token", "error", err, "trace_id", traceID)
		}

		h.logger.Infow("installation_deleted",
			"github_installation_id", event.Installation.ID,
			"trace_id", traceID,
		)
		return c.Status(200).JSON(fiber.Map{"message": "installation deleted"})

	default:
		h.logger.Infow("installation_unhandled_action",
			"action", event.Action,
			"trace_id", traceID,
		)
		return c.Status(200).JSON(fiber.Map{"message": "action received but not handled"})
	}
}

// handleInstallationRepositoriesEvent handles repository added/removed events
func (h *GitHubHandlers) handleInstallationRepositoriesEvent(c *fiber.Ctx, event *github.InstallationEvent, traceID string) error {
	ctx := c.Context()

	// For Phase 2, we'll trigger a full sync on repository changes
	// In a more sophisticated implementation, we'd handle incremental changes
	installation, err := h.installationRepo.GetByGitHubInstallationID(ctx, event.Installation.ID)
	if err != nil {
		h.logger.Warnw("installation_not_found_on_repo_change",
			"github_installation_id", event.Installation.ID,
			"error", err,
			"trace_id", traceID,
		)
		return c.Status(200).JSON(fiber.Map{"message": "installation not found"})
	}

	h.logger.Infow("installation_repositories_changed",
		"github_installation_id", event.Installation.ID,
		"action", event.Action,
		"trace_id", traceID,
	)

	// Trigger sync (async in production, sync for Phase 2 simplicity)
	go h.syncReposForInstallation(installation.ID, event.Installation.ID, traceID)

	return c.Status(200).JSON(fiber.Map{"message": "sync triggered"})
}

// LinkInstallation links a GitHub installation to an org (called from frontend)
func (h *GitHubHandlers) LinkInstallation(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	orgID := c.Locals("org_id").(string)

	type LinkRequest struct {
		GitHubInstallationID int64 `json:"github_installation_id"`
	}

	var req LinkRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	if req.GitHubInstallationID == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "github_installation_id required"})
	}

	ctx := c.Context()

	// Check if installation already exists
	existing, err := h.installationRepo.GetByGitHubInstallationID(ctx, req.GitHubInstallationID)
	if err == nil && existing != nil {
		h.logger.Warnw("installation_already_linked",
			"github_installation_id", req.GitHubInstallationID,
			"existing_org_id", existing.OrgID,
			"trace_id", traceID,
		)
		return c.Status(400).JSON(fiber.Map{"error": "installation already linked to another org"})
	}

	// Fetch installation details from GitHub
	// For Phase 2, we'll use a simplified approach - in production we'd fetch from GitHub API
	// For now, we'll create with placeholder account info that will be updated on first sync
	installation, err := h.installationRepo.CreateInstallation(
		ctx,
		orgID,
		req.GitHubInstallationID,
		0, // placeholder account ID
		"", // placeholder account login
	)
	if err != nil {
		h.logger.Errorw("failed_to_create_installation",
			"error", err,
			"org_id", orgID,
			"github_installation_id", req.GitHubInstallationID,
			"trace_id", traceID,
		)
		return c.Status(500).JSON(fiber.Map{"error": "failed to create installation"})
	}

	h.logger.Infow("installation_linked",
		"installation_id", installation.ID,
		"org_id", orgID,
		"github_installation_id", req.GitHubInstallationID,
		"trace_id", traceID,
	)

	return c.Status(201).JSON(installation)
}

// ListRepos lists repositories for the current org
func (h *GitHubHandlers) ListRepos(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	orgID := c.Locals("org_id").(string)

	ctx := c.Context()

	repos, err := h.repoRepo.ListByOrgID(ctx, orgID)
	if err != nil {
		h.logger.Errorw("failed_to_list_repos",
			"error", err,
			"org_id", orgID,
			"trace_id", traceID,
		)
		return c.Status(500).JSON(fiber.Map{"error": "failed to list repos"})
	}

	return c.JSON(repos)
}

// SyncRepos triggers a sync of repositories from GitHub
func (h *GitHubHandlers) SyncRepos(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	orgID := c.Locals("org_id").(string)

	ctx := c.Context()

	// Get installation for org
	installation, err := h.installationRepo.GetByOrgID(ctx, orgID)
	if err != nil {
		h.logger.Warnw("no_installation_for_org",
			"org_id", orgID,
			"error", err,
			"trace_id", traceID,
		)
		return c.Status(404).JSON(fiber.Map{"error": "no GitHub installation found for this org"})
	}

	// Trigger sync
	go h.syncReposForInstallation(installation.ID, installation.GitHubInstallationID, traceID)

	return c.JSON(fiber.Map{"message": "sync started"})
}

// syncReposForInstallation syncs repositories from GitHub for an installation
func (h *GitHubHandlers) syncReposForInstallation(installationID string, githubInstallationID int64, traceID string) {
	ctx := context.Background()

	// Get installation token
	token, err := h.tokenCache.GetInstallationToken(ctx, githubInstallationID)
	if err != nil {
		h.logger.Errorw("failed_to_get_installation_token",
			"error", err,
			"installation_id", installationID,
			"trace_id", traceID,
		)
		return
	}

	// List repos from GitHub
	githubRepos, err := h.client.ListInstallationRepos(token, githubInstallationID)
	if err != nil {
		h.logger.Errorw("failed_to_list_github_repos",
			"error", err,
			"installation_id", installationID,
			"trace_id", traceID,
		)
		return
	}

	// Sync repos to database
	for _, ghRepo := range githubRepos {
		// Check if repo already exists
		existing, err := h.repoRepo.GetByGitHubRepoID(ctx, ghRepo.ID)
		if err != nil {
			// Create new repo
			_, err := h.repoRepo.CreateRepo(
				ctx,
				installationID,
				ghRepo.ID,
				ghRepo.Name,
				ghRepo.FullName,
				ghRepo.Owner.Login,
				ghRepo.DefaultBranch,
				ghRepo.Private,
			)
			if err != nil {
				h.logger.Errorw("failed_to_create_repo",
					"error", err,
					"repo_full_name", ghRepo.FullName,
					"trace_id", traceID,
				)
				continue
			}
			h.logger.Infow("repo_created",
				"repo_full_name", ghRepo.FullName,
				"trace_id", traceID,
			)
		} else {
			// Update existing repo
			err := h.repoRepo.UpdateSyncInfo(ctx, existing.ID, "")
			if err != nil {
				h.logger.Errorw("failed_to_update_repo",
					"error", err,
					"repo_full_name", ghRepo.FullName,
					"trace_id", traceID,
				)
			}
		}
	}

	h.logger.Infow("repo_sync_completed",
		"installation_id", installationID,
		"repo_count", len(githubRepos),
		"trace_id", traceID,
	)
}
