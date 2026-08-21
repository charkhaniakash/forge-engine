package llmcreds

import (
	"context"
	"net/http"
	"time"
)

const (
	HeaderProvider = "X-Forge-LLM-Provider"
	HeaderModel    = "X-Forge-LLM-Model"
	HeaderKey      = "X-Forge-LLM-Key"
)

type Credential struct {
	ID          string     `json:"id"`
	OrgID       string     `json:"org_id"`
	UserID      string     `json:"user_id"`
	Provider    string     `json:"provider"`
	Model       string     `json:"model"`
	KeyHint     string     `json:"key_hint"`
	ValidatedAt *time.Time `json:"validated_at,omitempty"`
	IsActive    bool       `json:"is_active"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// Runtime is the decrypted payload attached to a request context and
// forwarded to the agent. Never serialize this to logs or JSON responses.
type Runtime struct {
	Provider string
	Model    string
	APIKey   string
}

type ctxKey struct{}

func WithRuntime(ctx context.Context, rt *Runtime) context.Context {
	if rt == nil {
		return ctx
	}
	return context.WithValue(ctx, ctxKey{}, rt)
}

func FromContext(ctx context.Context) *Runtime {
	rt, _ := ctx.Value(ctxKey{}).(*Runtime)
	return rt
}

func ApplyHeaders(req *http.Request, rt *Runtime) {
	if req == nil || rt == nil || rt.Provider == "" {
		return
	}
	req.Header.Set(HeaderProvider, rt.Provider)
	if rt.Model != "" {
		req.Header.Set(HeaderModel, rt.Model)
	}
	if rt.APIKey != "" {
		req.Header.Set(HeaderKey, rt.APIKey)
	}
}

func ApplyHeadersFromContext(ctx context.Context, req *http.Request) {
	ApplyHeaders(req, FromContext(ctx))
}
