package llmcreds

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"
)

type Handlers struct {
	svc    *Service
	repo   *Repository
	logger *zap.SugaredLogger
}

func NewHandlers(svc *Service, repo *Repository, logger *zap.SugaredLogger) *Handlers {
	return &Handlers{svc: svc, repo: repo, logger: logger}
}

func (h *Handlers) ListProviders(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"providers": Catalog})
}

func (h *Handlers) GetConfig(c *fiber.Ctx) error {
	orgID, _ := c.Locals("org_id").(string)
	creds, err := h.repo.ListByOrg(c.Context(), orgID)
	if err != nil {
		h.logger.Errorw("llm_list_failed", "error", err)
		return c.Status(500).JSON(fiber.Map{"error": "failed to load llm settings"})
	}
	if creds == nil {
		creds = []*Credential{}
	}
	var active *Credential
	for _, cr := range creds {
		if cr.IsActive {
			active = cr
			break
		}
	}
	return c.JSON(fiber.Map{
		"configured": active != nil,
		"active":     active,
		"saved":      creds,
	})
}

type saveRequest struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	APIKey   string `json:"api_key"`
	Activate *bool  `json:"activate"`
}

func (h *Handlers) ValidateAndSave(c *fiber.Ctx) error {
	orgID, _ := c.Locals("org_id").(string)
	userID, _ := c.Locals("user_id").(string)
	traceID, _ := c.Locals("trace_id").(string)

	var req saveRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	def, ok := Lookup(req.Provider)
	if !ok {
		return c.Status(400).JSON(fiber.Map{"error": "unknown provider"})
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = def.DefaultModel
	}
	apiKey := strings.TrimSpace(req.APIKey)
	if def.RequiresKey && apiKey == "" {
		existing, err := h.repo.GetByProvider(c.Context(), orgID, def.ID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to load existing key"})
		}
		if existing == nil {
			return c.Status(400).JSON(fiber.Map{"error": "api_key is required"})
		}
		dec, err := Decrypt(existing.Encrypted)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "failed to read stored key"})
		}
		apiKey = dec
	}

	okVal, message, err := h.svc.Validate(c.Context(), def.ID, model, apiKey)
	if err != nil {
		h.logger.Warnw("llm_validate_error", "error", err, "provider", def.ID, "trace_id", traceID)
		return c.Status(502).JSON(fiber.Map{"error": err.Error()})
	}
	if !okVal {
		return c.Status(400).JSON(fiber.Map{"ok": false, "error": message})
	}

	activate := true
	if req.Activate != nil {
		activate = *req.Activate
	}
	saved, err := h.svc.Save(c.Context(), orgID, userID, def.ID, model, apiKey, activate)
	if err != nil {
		h.logger.Errorw("llm_save_failed", "error", err, "trace_id", traceID)
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"ok": true, "message": message, "credential": saved})
}

func (h *Handlers) Activate(c *fiber.Ctx) error {
	orgID, _ := c.Locals("org_id").(string)
	provider := strings.ToLower(c.Params("provider"))
	if _, ok := Lookup(provider); !ok {
		return c.Status(400).JSON(fiber.Map{"error": "unknown provider"})
	}
	if err := h.repo.Activate(c.Context(), orgID, provider); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handlers) Delete(c *fiber.Ctx) error {
	orgID, _ := c.Locals("org_id").(string)
	provider := strings.ToLower(c.Params("provider"))
	if err := h.repo.Delete(c.Context(), orgID, provider); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
