-- GitHub installations table (tracks GitHub App installations per org)
CREATE TABLE github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  github_installation_id BIGINT NOT NULL UNIQUE,
  github_account_id BIGINT NOT NULL,
  github_account_login VARCHAR(255) NOT NULL,
  access_token TEXT, -- Installation access token (cached, time-limited)
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_github_installations_org_id ON github_installations(org_id);
CREATE INDEX idx_github_installations_github_id ON github_installations(github_installation_id);

-- GitHub repositories table (tracks repos accessible via installations)
CREATE TABLE github_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  github_repo_id BIGINT NOT NULL,
  repo_name VARCHAR(255) NOT NULL,
  repo_full_name VARCHAR(255) NOT NULL UNIQUE,
  repo_owner VARCHAR(255) NOT NULL,
  default_branch VARCHAR(255) NOT NULL,
  private BOOLEAN NOT NULL DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  last_commit_sha VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_github_repos_installation_id ON github_repos(installation_id);
CREATE INDEX idx_github_repos_github_id ON github_repos(github_repo_id);
