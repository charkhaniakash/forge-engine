-- Add webhook deliveries table and hardening columns for pending_installs

ALTER TABLE pending_installs
  ADD COLUMN state_token_hash VARCHAR(128),
  ADD COLUMN callback_seen BOOLEAN DEFAULT FALSE,
  ADD COLUMN used_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_pending_installs_state_token_hash ON pending_installs(state_token_hash);
CREATE INDEX IF NOT EXISTS idx_pending_installs_callback_seen ON pending_installs(callback_seen);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery_id ON webhook_deliveries(delivery_id);