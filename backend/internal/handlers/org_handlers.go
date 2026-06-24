package handlers

import (
    "time"

    "github.com/gofiber/fiber/v2"
    "github.com/google/uuid"
    "go.uber.org/zap"

    "github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

type OrgHandlers struct {
    orgRepo        *repository.OrgRepository
    invitationRepo *repository.InvitationRepository
    userRepo       *repository.UserRepository
    logger         *zap.SugaredLogger
}

func NewOrgHandlers(orgRepo *repository.OrgRepository, invitationRepo *repository.InvitationRepository, userRepo *repository.UserRepository, logger *zap.SugaredLogger) *OrgHandlers {
    return &OrgHandlers{
        orgRepo:        orgRepo,
        invitationRepo: invitationRepo,
        userRepo:       userRepo,
        logger:         logger,
    }
}

type CreateOrgRequest struct {
    Name string `json:"name"`
}

type InviteRequest struct {
    Email string `json:"email"`
    Role  string `json:"role"`
}

// CreateOrg creates a new organization
func (h *OrgHandlers) CreateOrg(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    userID := c.Locals("user_id").(string)

    var req CreateOrgRequest
    if err := c.BodyParser(&req); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
    }

    if req.Name == "" {
        return c.Status(400).JSON(fiber.Map{"error": "name required"})
    }

    org, err := h.orgRepo.CreateOrg(c.Context(), req.Name, userID)
    if err != nil {
        h.logger.Errorw("org_creation_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    h.logger.Infow("org_created", "org_id", org.ID, "user_id", userID, "trace_id", traceID)

    return c.Status(201).JSON(org)
}

// ListOrgs lists user's organizations
func (h *OrgHandlers) ListOrgs(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    userID := c.Locals("user_id").(string)

    orgs, err := h.orgRepo.ListUserOrgs(c.Context(), userID)
    if err != nil {
        h.logger.Errorw("org_list_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    return c.JSON(orgs)
}

// GetOrg retrieves a specific org (with access control)
func (h *OrgHandlers) GetOrg(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    userID := c.Locals("user_id").(string)

    orgID := c.Params("orgID")

    // Verify user is member of org
    _, err := h.orgRepo.GetUserOrgRole(c.Context(), orgID, userID)
    if err != nil {
        h.logger.Warnw("org_access_denied", "org_id", orgID, "user_id", userID, "trace_id", traceID)
        return c.Status(403).JSON(fiber.Map{"error": "access denied"})
    }

    org, err := h.orgRepo.GetOrgByID(c.Context(), orgID)
    if err != nil {
        return c.Status(404).JSON(fiber.Map{"error": "org not found"})
    }

    return c.JSON(org)
}

// ListMembers lists members of an org
func (h *OrgHandlers) ListMembers(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    userID := c.Locals("user_id").(string)

    orgID := c.Params("orgID")

    // Verify user is member
    _, err := h.orgRepo.GetUserOrgRole(c.Context(), orgID, userID)
    if err != nil {
        h.logger.Warnw("members_access_denied", "org_id", orgID, "user_id", userID, "trace_id", traceID)
        return c.Status(403).JSON(fiber.Map{"error": "access denied"})
    }

    members, err := h.orgRepo.ListOrgMembers(c.Context(), orgID)
    if err != nil {
        h.logger.Errorw("members_list_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    return c.JSON(members)
}

// InviteMember invites a user to an org
func (h *OrgHandlers) InviteMember(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)
    userID := c.Locals("user_id").(string)
    orgID := c.Params("orgID")

    // Check permissions: only admin or owner can invite
    role, err := h.orgRepo.GetUserOrgRole(c.Context(), orgID, userID)
    if err != nil {
        h.logger.Warnw("invite_access_denied", "org_id", orgID, "user_id", userID, "trace_id", traceID)
        return c.Status(403).JSON(fiber.Map{"error": "access denied"})
    }

    if role != "owner" && role != "admin" {
        h.logger.Warnw("invite_permission_denied", "org_id", orgID, "user_id", userID, "role", role, "trace_id", traceID)
        return c.Status(403).JSON(fiber.Map{"error": "insufficient permissions"})
    }

    var req InviteRequest
    if err := c.BodyParser(&req); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
    }

    if req.Email == "" {
        return c.Status(400).JSON(fiber.Map{"error": "email required"})
    }

    if req.Role == "" {
        req.Role = "member"
    }

    // Generate invitation token
    token := uuid.New().String()

    inv, err := h.invitationRepo.CreateInvitation(
        c.Context(),
        orgID,
        req.Email,
        token,
        req.Role,
        time.Now().Add(7*24*time.Hour), // 7-day expiry
    )

    if err != nil {
        h.logger.Errorw("invitation_creation_failed", "error", err, "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "invitation already sent or other error"})
    }

    h.logger.Infow("invitation_created", "org_id", orgID, "email", req.Email, "trace_id", traceID)

    return c.Status(201).JSON(fiber.Map{
        "invitation_id": inv.ID,
        "token":         token,
        "expires_at":    inv.ExpiresAt,
    })
}