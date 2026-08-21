-- Migration 019: per-org BYOK LLM credentials
-- The platform does not provide an LLM. Each org stores one credential
-- row per provider; is_active marks the one used for agent calls.
-- API keys are stored AES-GCM encrypted (see backend/internal/llmcreds).

CREATE TABLE llm_credentials (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         VARCHAR(32) NOT NULL,
    model            VARCHAR(128) NOT NULL,
    api_key_encrypted TEXT NOT NULL DEFAULT '',
    key_hint         VARCHAR(16) NOT NULL DEFAULT '',
    validated_at     TIMESTAMPTZ NULL,
    is_active        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (org_id, provider)
);

CREATE INDEX idx_llm_credentials_org ON llm_credentials (org_id);
CREATE UNIQUE INDEX idx_llm_credentials_org_active
    ON llm_credentials (org_id)
    WHERE is_active = TRUE;
