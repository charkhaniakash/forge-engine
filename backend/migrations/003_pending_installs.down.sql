-- Rollback: Remove pending_installs table

DROP INDEX IF EXISTS idx_pending_installs_expires_at;
DROP INDEX IF EXISTS idx_pending_installs_org_id;
DROP INDEX IF EXISTS idx_pending_installs_state_token;
DROP TABLE IF EXISTS pending_installs;
