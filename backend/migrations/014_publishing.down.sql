-- Rollback Phase 10: Publishing tables
DROP TABLE IF EXISTS publishing_audit_log;
DROP TABLE IF EXISTS github_sync_history;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS git_commits;
DROP TABLE IF EXISTS git_branches;
DROP TABLE IF EXISTS publishing_sessions;
