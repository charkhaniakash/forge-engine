package handlers

import (
	"context"
	// "crypto/hmac"
	// "crypto/sha256"
	// "encoding/hex"
	// "database/sql"
	"fmt"
	// "os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

type GitHubHandlers struct {
    installationRepo    *repository.GitHubInstallationRepository
    repoRepo            *repository.GitHubRepoRepository
    pendingInstallRepo  *repository.PendingInstallRepository
    webhookDeliveryRepo *repository.WebhookDeliveryRepository
    tokenCache          *github.TokenCache
    client              *github.Client
    appAuth             *github.AppAuth
    logger              *zap.SugaredLogger
    githubAppName       string
    stateSecret         string
}

func NewGitHubHandlers(
    installationRepo *repository.GitHubInstallationRepository,
    repoRepo *repository.GitHubRepoRepository,
    pendingInstallRepo *repository.PendingInstallRepository,
    tokenCache *github.TokenCache,
    client *github.Client,
    logger *zap.SugaredLogger,
    githubAppName string,
    stateSecret string,
    webhookDeliveryRepo *repository.WebhookDeliveryRepository,
    appAuth *github.AppAuth,
) *GitHubHandlers {
    return &GitHubHandlers{
        installationRepo:    installationRepo,
        repoRepo:            repoRepo,
        pendingInstallRepo:  pendingInstallRepo,
        webhookDeliveryRepo: webhookDeliveryRepo,
        tokenCache:          tokenCache,
        client:              client,
        appAuth:             appAuth,
        logger:              logger,
        githubAppName:       githubAppName,
        stateSecret:         stateSecret,
    }
}

// Webhook handles GitHub webhook events
func (h *GitHubHandlers) Webhook(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)

    body := c.Body()
    if len(body) == 0 {
        h.logger.Warnw("webhook_empty_body", "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "empty body"})
    }

    signature := c.Get("X-Hub-Signature-256")
    if !h.client.VerifyWebhookSignature(body, signature) {
        h.logger.Warnw("webhook_invalid_signature", "trace_id", traceID)
        return c.Status(401).JSON(fiber.Map{"error": "invalid signature"})
    }

    eventType := c.Get("X-GitHub-Event")
    if eventType == "" {
        h.logger.Warnw("webhook_missing_event_type", "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "missing event type"})
    }

    deliveryID := c.Get("X-GitHub-Delivery")
    if deliveryID != "" {
        processed, err := h.webhookDeliveryRepo.IsDeliveryProcessed(c.Context(), deliveryID)
        if err != nil {
            h.logger.Errorw("failed_to_check_delivery", "delivery_id", deliveryID, "error", err, "trace_id", traceID)
            return c.Status(500).JSON(fiber.Map{"error": "failed to process webhook"})
        }
        if processed {
            h.logger.Infow("webhook_duplicate_delivery_ignored", "delivery_id", deliveryID, "trace_id", traceID)
            return c.Status(200).JSON(fiber.Map{"message": "duplicate webhook ignored"})
        }
    }

    h.logger.Infow("webhook_received", "event_type", eventType, "delivery_id", deliveryID, "trace_id", traceID)

    event, err := github.ParseWebhookEvent(body, eventType)
    if err != nil {
        h.logger.Errorw("webhook_parse_failed", "error", err, "event_type", eventType, "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "failed to parse event"})
    }

    if deliveryID != "" {
        if err := h.webhookDeliveryRepo.RecordDelivery(c.Context(), deliveryID, eventType); err != nil {
            h.logger.Errorw("failed_to_record_delivery", "delivery_id", deliveryID, "error", err, "trace_id", traceID)
            return c.Status(500).JSON(fiber.Map{"error": "failed to record webhook delivery"})
        }
    }

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
		h.logger.Infow("installation_created",
			"github_installation_id", event.Installation.ID,
			"github_account", event.Installation.Account.Login,
			"trace_id", traceID,
		)

		// The callback handler may have already created the record when it
		// received installation_id from GitHub's redirect URL. Check first
		// so we never create duplicates.
		existing, err := h.installationRepo.GetByGitHubInstallationID(ctx, event.Installation.ID)
		if err == nil && existing != nil {
			h.logger.Infow("installation_created_already_exists_from_callback",
				"installation_id", existing.ID,
				"github_installation_id", event.Installation.ID,
				"trace_id", traceID,
			)
			// Trigger a repo sync in case it hasn't happened yet.
			go h.syncReposForInstallation(existing.ID, existing.GitHubInstallationID, traceID)
			return c.Status(200).JSON(fiber.Map{"message": "installation already linked via callback"})
		}

		// No record yet — use the pending install to correlate the org.
		pendingInstall, err := h.pendingInstallRepo.GetByCallbackSeen(ctx)
		if err != nil {
			h.logger.Errorw("failed_to_lookup_pending_install_for_webhook",
				"error", err,
				"trace_id", traceID,
			)
			return c.Status(500).JSON(fiber.Map{"error": "failed to correlate installation"})
		}

		if pendingInstall == nil {
			h.logger.Infow("installation_created_no_matching_pending_install",
				"github_installation_id", event.Installation.ID,
				"trace_id", traceID,
			)
			return c.Status(200).JSON(fiber.Map{"message": "installation created but no pending install matched"})
		}

		installation, err := h.installationRepo.CreateInstallation(
			ctx,
			pendingInstall.OrgID,
			event.Installation.ID,
			event.Installation.Account.ID,
			event.Installation.Account.Login,
		)
		if err != nil {
			// Race: callback handler won the race and inserted just now.
			existing, err2 := h.installationRepo.GetByGitHubInstallationID(ctx, event.Installation.ID)
			if err2 == nil && existing != nil {
				h.logger.Infow("installation_created_race_resolved",
					"installation_id", existing.ID,
					"trace_id", traceID,
				)
				go h.syncReposForInstallation(existing.ID, existing.GitHubInstallationID, traceID)
				return c.Status(200).JSON(fiber.Map{"message": "installation already linked"})
			}
			h.logger.Errorw("failed_to_create_installation_from_webhook",
				"error", err,
				"org_id", pendingInstall.OrgID,
				"github_installation_id", event.Installation.ID,
				"trace_id", traceID,
			)
			return c.Status(500).JSON(fiber.Map{"error": "failed to create installation"})
		}

		if err := h.pendingInstallRepo.MarkUsed(ctx, pendingInstall.ID); err != nil {
			h.logger.Warnw("failed_to_mark_pending_install_used",
				"error", err,
				"pending_install_id", pendingInstall.ID,
				"trace_id", traceID,
			)
		}

		h.logger.Infow("installation_created_linked",
			"installation_id", installation.ID,
			"org_id", pendingInstall.OrgID,
			"github_installation_id", event.Installation.ID,
			"trace_id", traceID,
		)

		go h.syncReposForInstallation(installation.ID, event.Installation.ID, traceID)
		return c.Status(201).JSON(fiber.Map{"message": "installation linked"})

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

// SyncRepos triggers a sync of repositories from GitHub.
// If no local installation record exists for the org but the GitHub App is
// still installed, it recovers automatically by querying the GitHub API for
// the matching installation and recreating the local record.
func (h *GitHubHandlers) SyncRepos(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	orgID := c.Locals("org_id").(string)

	ctx := c.Context()

	installation, err := h.installationRepo.GetByOrgID(ctx, orgID)
	if err != nil {
		// No local record. Attempt automatic recovery via the GitHub API
		// before giving up — this is the DB-truncation scenario.
		h.logger.Warnw("no_installation_for_org_attempting_recovery",
			"org_id", orgID,
			"error", err,
			"trace_id", traceID,
		)

		installation, err = h.recoverInstallationForOrg(ctx, orgID, traceID)
		if err != nil {
			h.logger.Errorw("installation_recovery_failed",
				"org_id", orgID,
				"error", err,
				"trace_id", traceID,
			)
			return c.Status(404).JSON(fiber.Map{
				"error": "no GitHub installation found for this org — click 'Install GitHub App' to reconnect",
			})
		}
	}

	go h.syncReposForInstallation(installation.ID, installation.GitHubInstallationID, traceID)

	return c.JSON(fiber.Map{"message": "sync started"})
}

// recoverInstallationForOrg queries the GitHub API for all app installations and
// tries to find one that was previously linked to this org. Because the DB was
// truncated we no longer know which GitHub installation ID belongs to this org,
// so we list all active installations for the app and recreate the record for
// whichever one we can successfully obtain a token for. This is safe for
// single-installation setups (one GitHub account per org), which covers the
// described recovery scenario.
//
// For multi-installation orgs this will match the first installation found; a
// future improvement would be to store the GitHub account login in the org
// record so we can match precisely.
func (h *GitHubHandlers) recoverInstallationForOrg(ctx context.Context, orgID string, traceID string) (*models.GitHubInstallation, error) {
	if h.appAuth == nil || h.client == nil {
		return nil, fmt.Errorf("github app not initialised")
	}

	appJWT, err := h.appAuth.GenerateAppJWT()
	if err != nil {
		return nil, fmt.Errorf("failed to generate app JWT: %w", err)
	}

	installations, err := h.client.ListAppInstallations(appJWT)
	if err != nil {
		return nil, fmt.Errorf("failed to list app installations from GitHub: %w", err)
	}

	if len(installations) == 0 {
		return nil, fmt.Errorf("no active installations found on GitHub for this app")
	}

	// Use the first (and typically only) installation. If there are multiple,
	// we take the first one and log a warning so the operator knows.
	if len(installations) > 1 {
		h.logger.Warnw("multiple_installations_found_during_recovery",
			"count", len(installations),
			"org_id", orgID,
			"using_installation_id", installations[0].ID,
			"trace_id", traceID,
		)
	}

	chosen := installations[0]

	// Double-check: if another org already has this installation, bail out
	// rather than silently stealing it.
	existing, err := h.installationRepo.GetByGitHubInstallationID(ctx, chosen.ID)
	if err == nil && existing != nil {
		if existing.OrgID != orgID {
			return nil, fmt.Errorf(
				"installation %d is already linked to org %s — cannot relink to org %s",
				chosen.ID, existing.OrgID, orgID,
			)
		}
		// Already exists for this org — nothing to recreate.
		h.logger.Infow("recovery_found_existing_installation",
			"installation_id", existing.ID,
			"org_id", orgID,
			"trace_id", traceID,
		)
		return existing, nil
	}

	installation, err := h.installationRepo.CreateInstallation(
		ctx,
		orgID,
		chosen.ID,
		chosen.Account.ID,
		chosen.Account.Login,
	)
	if err != nil {
		// Race — some concurrent request created it.
		existing, err2 := h.installationRepo.GetByGitHubInstallationID(ctx, chosen.ID)
		if err2 == nil && existing != nil {
			return existing, nil
		}
		return nil, fmt.Errorf("failed to recreate installation record: %w", err)
	}

	h.logger.Infow("installation_auto_recovered",
		"installation_id", installation.ID,
		"org_id", orgID,
		"github_installation_id", chosen.ID,
		"github_account", chosen.Account.Login,
		"trace_id", traceID,
	)

	return installation, nil
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

// GetInstallURL generates a GitHub App installation URL with a signed state token
func (h *GitHubHandlers) GetInstallURL(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    orgID := c.Locals("org_id").(string)

    ctx := c.Context()

    pendingInstall, rawStateToken, err := h.pendingInstallRepo.CreatePendingInstall(ctx, orgID, 10*time.Minute)
    if err != nil {
        h.logger.Errorw("failed_to_create_pending_install",
            "error", err,
            "org_id", orgID,
            "trace_id", traceID,
        )
        return c.Status(500).JSON(fiber.Map{"error": "failed to create pending install"})
    }

    claims := jwt.MapClaims{
        "org_id":      orgID,
        "state_token": rawStateToken,
        "exp":         pendingInstall.ExpiresAt.Unix(),
        "iat":         time.Now().Unix(),
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    signedState, err := token.SignedString([]byte(h.stateSecret))
    if err != nil {
        h.logger.Errorw("failed_to_sign_state_token",
            "error", err,
            "trace_id", traceID,
        )
        return c.Status(500).JSON(fiber.Map{"error": "failed to sign state token"})
    }

    installURL := fmt.Sprintf("https://github.com/apps/%s/installations/new?state=%s", h.githubAppName, signedState)

    h.logger.Infow("install_url_generated",
        "org_id", orgID,
        "pending_install_id", pendingInstall.ID,
        "trace_id", traceID,
    )

    return c.JSON(fiber.Map{
        "install_url": installURL,
        "expires_at":  pendingInstall.ExpiresAt,
    })
}

// InstallCallback handles the GitHub App installation callback.
//
// GitHub redirects here with ?installation_id=<id>&setup_action=install&state=<jwt>
// after a successful install — or just &setup_action=update when reconfiguring an
// existing install without creating a new one.
//
// The authoritative source of truth for the local github_installations record is the
// installation_id param that GitHub provides here. We upsert it immediately so that:
//   - Normal first-install: record created before the webhook even arrives.
//   - DB-loss recovery: record recreated without any manual intervention; no
//     new webhook will fire because the app is already installed on GitHub.
func (h *GitHubHandlers) InstallCallback(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	state := c.Query("state")

	if state == "" {
		h.logger.Warnw("callback_missing_state", "trace_id", traceID)
		return h.renderCallbackPage(c, false, "Missing state parameter")
	}

	ctx := c.Context()

	token, err := jwt.Parse(state, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(h.stateSecret), nil
	})
	if err != nil || !token.Valid {
		h.logger.Warnw("callback_invalid_jwt", "error", err, "trace_id", traceID)
		return h.renderCallbackPage(c, false, "Invalid or expired state token")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		h.logger.Warnw("callback_invalid_claims", "trace_id", traceID)
		return h.renderCallbackPage(c, false, "Invalid state token claims")
	}

	orgID, ok := claims["org_id"].(string)
	if !ok {
		h.logger.Warnw("callback_missing_org_id", "trace_id", traceID)
		return h.renderCallbackPage(c, false, "Missing org_id in state token")
	}

	stateToken, ok := claims["state_token"].(string)
	if !ok {
		h.logger.Warnw("callback_missing_state_token", "trace_id", traceID)
		return h.renderCallbackPage(c, false, "Missing state_token in state token")
	}

	pendingInstall, err := h.pendingInstallRepo.ValidatePendingInstallByStateToken(ctx, stateToken)
	if err != nil {
		h.logger.Warnw("callback_invalid_pending_install",
			"error", err,
			"org_id", orgID,
			"trace_id", traceID,
		)
		return h.renderCallbackPage(c, false, "Invalid or expired installation request")
	}

	if pendingInstall.OrgID != orgID {
		h.logger.Warnw("callback_org_id_mismatch",
			"pending_org_id", pendingInstall.OrgID,
			"state_org_id", orgID,
			"trace_id", traceID,
		)
		return h.renderCallbackPage(c, false, "Organization ID mismatch")
	}

	// Mark callback seen regardless of what follows — this is idempotent.
	if err := h.pendingInstallRepo.MarkCallbackSeen(ctx, pendingInstall.ID); err != nil {
		h.logger.Warnw("mark_callback_seen_failed", "error", err, "trace_id", traceID)
	}

	// GitHub passes installation_id in the callback URL. Use it to immediately
	// upsert the local installation record. This is the only reliable way to
	// recover from DB loss because GitHub will NOT re-fire installation.created
	// for an already-installed app — the callback is the only signal we get.
	installationIDStr := c.Query("installation_id")
	if installationIDStr != "" {
		if err := h.upsertInstallationFromCallback(ctx, orgID, installationIDStr, pendingInstall.ID, traceID); err != nil {
			// Non-fatal: log it but still show success to the user. The
			// webhook handler will attempt the same upsert when/if the event
			// arrives. Worst case the user clicks "Sync Repos" once.
			h.logger.Errorw("callback_upsert_installation_failed",
				"error", err,
				"org_id", orgID,
				"installation_id_str", installationIDStr,
				"trace_id", traceID,
			)
		}
	} else {
		h.logger.Infow("callback_no_installation_id",
			"org_id", orgID,
			"setup_action", c.Query("setup_action"),
			"trace_id", traceID,
		)
	}

	h.logger.Infow("callback_verified",
		"org_id", orgID,
		"pending_install_id", pendingInstall.ID,
		"trace_id", traceID,
	)

	return h.renderCallbackPage(c, true, "")
}

// upsertInstallationFromCallback creates or no-ops a github_installations record
// using the installation_id GitHub provided in the callback query params.
// It fetches live metadata from the GitHub API so account details are always accurate.
func (h *GitHubHandlers) upsertInstallationFromCallback(
	ctx context.Context,
	orgID string,
	installationIDStr string,
	pendingInstallID string,
	traceID string,
) error {
	var githubInstallationID int64
	if _, err := fmt.Sscanf(installationIDStr, "%d", &githubInstallationID); err != nil || githubInstallationID == 0 {
		return fmt.Errorf("invalid installation_id %q: %w", installationIDStr, err)
	}

	// If a record already exists for this GitHub installation (e.g. duplicate
	// callback delivery), there is nothing to do.
	existing, err := h.installationRepo.GetByGitHubInstallationID(ctx, githubInstallationID)
	if err == nil && existing != nil {
		h.logger.Infow("callback_installation_already_exists",
			"installation_id", existing.ID,
			"org_id", orgID,
			"github_installation_id", githubInstallationID,
			"trace_id", traceID,
		)
		// Still trigger a repo sync to make sure repos are up to date.
		go h.syncReposForInstallation(existing.ID, existing.GitHubInstallationID, traceID)
		return nil
	}

	if h.appAuth == nil || h.client == nil {
		return fmt.Errorf("github app not initialised — cannot fetch installation details")
	}

	appJWT, err := h.appAuth.GenerateAppJWT()
	if err != nil {
		return fmt.Errorf("failed to generate app JWT: %w", err)
	}

	installationDetails, err := h.client.GetInstallationByID(appJWT, githubInstallationID)
	if err != nil {
		return fmt.Errorf("failed to fetch installation from GitHub: %w", err)
	}

	installation, err := h.installationRepo.CreateInstallation(
		ctx,
		orgID,
		installationDetails.ID,
		installationDetails.Account.ID,
		installationDetails.Account.Login,
	)
	if err != nil {
		// Race condition: another request already inserted it. Return the
		// existing record without treating this as an error.
		existing, err2 := h.installationRepo.GetByGitHubInstallationID(ctx, githubInstallationID)
		if err2 == nil && existing != nil {
			h.logger.Infow("callback_installation_race_resolved",
				"installation_id", existing.ID,
				"trace_id", traceID,
			)
			go h.syncReposForInstallation(existing.ID, existing.GitHubInstallationID, traceID)
			return nil
		}
		return fmt.Errorf("failed to create installation record: %w", err)
	}

	// Mark the pending install consumed so the webhook handler (if it ever
	// arrives) skips re-creating the record.
	if err := h.pendingInstallRepo.MarkUsed(ctx, pendingInstallID); err != nil {
		h.logger.Warnw("failed_to_mark_pending_install_used",
			"error", err,
			"pending_install_id", pendingInstallID,
			"trace_id", traceID,
		)
	}

	h.logger.Infow("callback_installation_upserted",
		"installation_id", installation.ID,
		"org_id", orgID,
		"github_installation_id", githubInstallationID,
		"github_account", installationDetails.Account.Login,
		"trace_id", traceID,
	)

	go h.syncReposForInstallation(installation.ID, installation.GitHubInstallationID, traceID)
	return nil
}
// renderCallbackPage renders an HTML response for the callback
func (h *GitHubHandlers) renderCallbackPage(c *fiber.Ctx, success bool, errorMessage string) error {
	if success {
		c.Set("Content-Type", "text/html")
		return c.SendString(`<!DOCTYPE html>
<html>
<head>
    <title>GitHub App Installation Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f6f8fa; }
        .container { text-align: center; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
        h1 { color: #1a7f37; margin-bottom: 1rem; }
        p { color: #24292f; line-height: 1.5; }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>Installation Received</h1>
        <p>Your GitHub App installation has been received. The platform will finish linking your repositories shortly.</p>
        <p>You can close this window and return to the application.</p>
    </div>
</body>
</html>`)
	}

	c.Set("Content-Type", "text/html")
	return c.SendString(`<!DOCTYPE html>
<html>
<head>
    <title>GitHub App Installation Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f6f8fa; }
        .container { text-align: center; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
        h1 { color: #cf222e; margin-bottom: 1rem; }
        p { color: #24292f; line-height: 1.5; }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>Installation Failed</h1>
        <p>` + errorMessage + `</p>
        <p>Please try again or contact support.</p>
    </div>
</body>
</html>`)
}
