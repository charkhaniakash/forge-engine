-- Migration 012 Rollback: Phase 9 — Autonomous Self-Repair & Recovery Loop

DROP TABLE IF EXISTS repair_checkpoints;
DROP TABLE IF EXISTS repair_attempts;
DROP TABLE IF EXISTS repair_sessions;
