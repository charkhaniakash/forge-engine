-- Migration: Add pending_installs table for GitHub App install flow
-- This table tracks pending GitHub App installations before they are confirmed via webhook

CREATE TABLE IF NOT EXISTS pending_installs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    state_token VARCHAR(512) UNIQUE NOT NULL,
    csrf_token VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_pending_installs_org_id FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Index for fast lookup by state_token
CREATE INDEX idx_pending_installs_state_token ON pending_installs(state_token);

-- Index for fast lookup by org_id
CREATE INDEX idx_pending_installs_org_id ON pending_installs(org_id);

-- Index for cleanup of expired records
CREATE INDEX idx_pending_installs_expires_at ON pending_installs(expires_at);
