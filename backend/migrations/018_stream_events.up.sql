-- Phase 11: Execution Event Platform — Durable stream events table.
--
-- This table is the single durable event log for the Streaming Gateway.
-- All execution activity (planning, execution, validation, repair, publishing,
-- workspace lifecycle, collaboration state) is persisted here BEFORE being
-- broadcast to connected browsers.
--
-- Relationship to execution_events (Phase 7):
--   execution_events remains the authoritative audit log of agent tool calls.
--   stream_events contains rendered browser-consumable projections of those
--   events PLUS events from every other lifecycle phase. It is a read-optimized
--   superset designed for replay, not a replacement.

CREATE TABLE stream_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Monotonically increasing per workspace. Assigned by the Event Store.
    -- This is the global ordering key for replay and gap detection.
    seq             BIGINT      NOT NULL,

    -- Channel routing (matches gateway channel constants).
    -- system | filesystem | terminal | execution | validation | repair |
    -- publishing | git | diagnostics | timeline | ai_activity | collaboration
    channel         VARCHAR(32) NOT NULL,

    -- Event type within the channel (e.g. "phase_started", "tool_call", "state_changed").
    event           VARCHAR(64) NOT NULL,

    -- Structured payload — the rendered browser-consumable data.
    payload         JSONB       NOT NULL DEFAULT '{}',

    -- Source lifecycle phase for filtering and timeline building.
    -- planning | executing | validation | repair | publishing | workspace | system
    phase           VARCHAR(16) NULL,

    -- Optional FK back to the originating domain record for traceability.
    -- Points to execution_events.id, validation_stages.id, repair_attempts.id, etc.
    source_id       UUID        NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One seq per workspace — the fundamental ordering guarantee.
    UNIQUE (workspace_id, seq)
);

-- Primary replay query: "give me everything after seq N for workspace W"
-- This is the hot path on every reconnect and fresh page load.
CREATE INDEX idx_stream_events_replay
    ON stream_events(workspace_id, seq);

-- Channel-filtered replay: "give me only 'collaboration' events after seq N"
-- Used when a client subscribes to a subset of channels.
CREATE INDEX idx_stream_events_channel
    ON stream_events(workspace_id, channel, seq);

-- TTL cleanup: enables efficient deletion of events older than retention period.
CREATE INDEX idx_stream_events_ttl
    ON stream_events(created_at);

-- Phase-filtered queries for timeline builder: "summarize all validation events"
CREATE INDEX idx_stream_events_phase
    ON stream_events(workspace_id, phase, seq)
    WHERE phase IS NOT NULL;
