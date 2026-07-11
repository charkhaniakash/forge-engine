-- Revert: restore NOT NULL on step_execution_id.
-- WARNING: this will fail if any repair-originated diffs exist (step_execution_id = NULL).
ALTER TABLE code_diffs
    ALTER COLUMN step_execution_id SET NOT NULL;
