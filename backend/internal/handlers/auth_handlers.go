package handlers

import (
    "github.com/gofiber/fiber/v2"
    "go.uber.org/zap"

    "github.com/charkhaniakash/forge-engine/backend/internal/auth"
    "github.com/charkhaniakash/forge-engine/backend/internal/models"
    "github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

type AuthHandlers struct {
    userRepo *repository.UserRepository
    orgRepo  *repository.OrgRepository
    logger   *zap.SugaredLogger
}

func NewAuthHandlers(userRepo *repository.UserRepository, orgRepo *repository.OrgRepository, logger *zap.SugaredLogger) *AuthHandlers {
    return &AuthHandlers{
        userRepo: userRepo,
        orgRepo:  orgRepo,
        logger:   logger,
    }
}

// SignupRequest represents a signup request
type SignupRequest struct {
    Email    string `json:"email"`
    Password string `json:"password"`
    Name     string `json:"name"`
}

// LoginRequest represents a login request
type LoginRequest struct {
    Email    string `json:"email"`
    Password string `json:"password"`
    OrgID    string `json:"org_id"` // Which org context to log into
}

// AuthResponse represents an auth response with token
type AuthResponse struct {
    Token string                `json:"token"`
    User  *models.User          `json:"user"`
    Org   *models.Organization  `json:"org"`
    Role  string                `json:"role"`
}

// Signup handles user registration
func (h *AuthHandlers) Signup(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)

    var req SignupRequest
    if err := c.BodyParser(&req); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
    }

    // Validate input
    if req.Email == "" || req.Password == "" {
        return c.Status(400).JSON(fiber.Map{"error": "email and password required"})
    }

    // Hash password
    hash, err := auth.HashPassword(req.Password)
    if err != nil {
        h.logger.Errorw("password_hash_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    // Create user
    user, err := h.userRepo.CreateUser(c.Context(), req.Email, hash, req.Name)
    if err != nil {
        h.logger.Errorw("user_creation_failed", "error", err, "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "email already exists or invalid"})
    }

    // Auto-create a personal org for the user
    defaultOrgName := req.Name + "'s Workspace"
    if defaultOrgName == "'s Workspace" {
        defaultOrgName = user.Email + "'s Workspace"
    }

    org, err := h.orgRepo.CreateOrg(c.Context(), defaultOrgName, user.ID)
    if err != nil {
        h.logger.Errorw("org_creation_failed", "error", err, "trace_id", traceID)
        // Don't fail signup if org creation fails — user can create later
    }

    h.logger.Infow("user_signup_success", "user_id", user.ID, "org_id", org.ID, "trace_id", traceID)

    return c.Status(201).JSON(fiber.Map{
        "message": "signup successful",
        "user_id": user.ID,
        "org_id":  org.ID,
    })
}

// Login handles user login
func (h *AuthHandlers) Login(c *fiber.Ctx) error {
    traceID := c.Locals("trace_id").(string)

    var req LoginRequest
    if err := c.BodyParser(&req); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
    }

    // Get user
    user, err := h.userRepo.GetUserByEmail(c.Context(), req.Email)
    if err != nil || user == nil {
        h.logger.Warnw("login_user_not_found", "email", req.Email, "trace_id", traceID)
        return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
    }

    // Verify password
    if !auth.VerifyPassword(user.PasswordHash, req.Password) {
        h.logger.Warnw("login_password_invalid", "user_id", user.ID, "trace_id", traceID)
        return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
    }

    // Get user's orgs
    orgs, err := h.orgRepo.ListUserOrgs(c.Context(), user.ID)
    if err != nil {
        h.logger.Errorw("org_list_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    if len(orgs) == 0 {
        h.logger.Warnw("login_no_org", "user_id", user.ID, "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "user has no organizations"})
    }

    // If OrgID specified, use that; otherwise use first org
    orgID := req.OrgID
    if orgID == "" {
        orgID = orgs[0].ID
    }

    // Get role in org
    role, err := h.orgRepo.GetUserOrgRole(c.Context(), orgID, user.ID)
    if err != nil {
        h.logger.Warnw("org_role_not_found", "user_id", user.ID, "org_id", orgID, "trace_id", traceID)
        return c.Status(400).JSON(fiber.Map{"error": "user not member of specified org"})
    }

    // Generate token
    token, err := auth.GenerateUserToken(user, orgID, role)
    if err != nil {
        h.logger.Errorw("token_generation_failed", "error", err, "trace_id", traceID)
        return c.Status(500).JSON(fiber.Map{"error": "internal error"})
    }

    org, _ := h.orgRepo.GetOrgByID(c.Context(), orgID)

    h.logger.Infow("login_success", "user_id", user.ID, "org_id", orgID, "trace_id", traceID)

    return c.Status(200).JSON(AuthResponse{
        Token: token,
        User:  user,
        Org:   org,
        Role:  role,
    })
}