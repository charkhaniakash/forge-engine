-- Migration 013: Make code_diffs.step_execution_id nullable.
--
-- Repair-originated writes (Phase 9) call the same /tool endpoint as execution
-- (Phase 7) but have no step_execution context. The NOT NULL constraint on
-- step_execution_id caused every repair write_file call to fail with a DB error.
-- Making it nullable allows repair diffs to be persisted without a step reference.

ALTER TABLE code_diffs
    ALTER COLUMN step_execution_id DROP NOT NULL;
