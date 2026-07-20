-- Auto-run (a.k.a. "Plan off"): when true, the pipeline auto-approves + provisions
-- + executes as soon as the plan is ready, instead of waiting for a human review.
ALTER TABLE work_items ADD COLUMN auto_run BOOLEAN NOT NULL DEFAULT false;
