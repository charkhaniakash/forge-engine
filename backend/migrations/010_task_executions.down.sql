-- Migration 010 rollback
DROP INDEX IF EXISTS idx_execution_events_tool_call_id;
DROP TABLE IF EXISTS execution_checkpoints;
DROP TABLE IF EXISTS code_diffs;
DROP TABLE IF EXISTS execution_events;
DROP TABLE IF EXISTS step_executions;
DROP TABLE IF EXISTS task_executions;
