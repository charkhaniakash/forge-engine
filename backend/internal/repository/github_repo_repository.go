package repository

import (
	"context"
	"database/sql"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
)

type GitHubRepoRepository struct {
	db *sql.DB
}

func NewGitHubRepoRepository(db *sql.DB) *GitHubRepoRepository {
	return &GitHubRepoRepository{db: db}
}

// CreateRepo creates a new GitHub repo record
func (r *GitHubRepoRepository) CreateRepo(
	ctx context.Context,
	installationID string,
	githubRepoID int64,
	repoName string,
	repoFullName string,
	repoOwner string,
	defaultBranch string,
	private bool,
) (*models.GitHubRepo, error) {
	id := uuid.New().String()
	now := time.Now()

	query := `
		INSERT INTO github_repos (id, installation_id, github_repo_id, repo_name, repo_full_name, repo_owner, default_branch, private, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, installation_id, github_repo_id, repo_name, repo_full_name, repo_owner, default_branch, private, last_synced_at, last_commit_sha, created_at, updated_at
	`

	var repo models.GitHubRepo
	err := r.db.QueryRowContext(ctx, query, id, installationID, githubRepoID, repoName, repoFullName, repoOwner, defaultBranch, private, now, now).Scan(
		&repo.ID,
		&repo.InstallationID,
		&repo.GitHubRepoID,
		&repo.RepoName,
		&repo.RepoFullName,
		&repo.RepoOwner,
		&repo.DefaultBranch,
		&repo.Private,
		&repo.LastSyncedAt,
		&repo.LastCommitSHA,
		&repo.CreatedAt,
		&repo.UpdatedAt,
	)

	if err != nil {
		return nil, err
	}

	return &repo, nil
}

// ListByInstallationID lists all repos for an installation
func (r *GitHubRepoRepository) ListByInstallationID(ctx context.Context, installationID string) ([]*models.GitHubRepo, error) {
	query := `
		SELECT id, installation_id, github_repo_id, repo_name, repo_full_name, repo_owner, default_branch, private, last_synced_at, last_commit_sha, created_at, updated_at
		FROM github_repos
		WHERE installation_id = $1
		ORDER BY repo_name
	`

	rows, err := r.db.QueryContext(ctx, query, installationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var repos []*models.GitHubRepo
	for rows.Next() {
		var repo models.GitHubRepo
		err := rows.Scan(
			&repo.ID,
			&repo.InstallationID,
			&repo.GitHubRepoID,
			&repo.RepoName,
			&repo.RepoFullName,
			&repo.RepoOwner,
			&repo.DefaultBranch,
			&repo.Private,
			&repo.LastSyncedAt,
			&repo.LastCommitSHA,
			&repo.CreatedAt,
			&repo.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		repos = append(repos, &repo)
	}

	return repos, nil
}

// ListByOrgID lists all repos for an org (via installation)
func (r *GitHubRepoRepository) ListByOrgID(ctx context.Context, orgID string) ([]*models.GitHubRepo, error) {
	query := `
		SELECT r.id, r.installation_id, r.github_repo_id, r.repo_name, r.repo_full_name, r.repo_owner, r.default_branch, r.private, r.last_synced_at, r.last_commit_sha, r.created_at, r.updated_at
		FROM github_repos r
		INNER JOIN github_installations i ON r.installation_id = i.id
		WHERE i.org_id = $1
		ORDER BY r.repo_name
	`

	rows, err := r.db.QueryContext(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var repos []*models.GitHubRepo
	for rows.Next() {
		var repo models.GitHubRepo
		err := rows.Scan(
			&repo.ID,
			&repo.InstallationID,
			&repo.GitHubRepoID,
			&repo.RepoName,
			&repo.RepoFullName,
			&repo.RepoOwner,
			&repo.DefaultBranch,
			&repo.Private,
			&repo.LastSyncedAt,
			&repo.LastCommitSHA,
			&repo.CreatedAt,
			&repo.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		repos = append(repos, &repo)
	}

	return repos, nil
}

// GetByGitHubRepoID retrieves a repo by GitHub repo ID
func (r *GitHubRepoRepository) GetByGitHubRepoID(ctx context.Context, githubRepoID int64) (*models.GitHubRepo, error) {
	query := `
		SELECT id, installation_id, github_repo_id, repo_name, repo_full_name, repo_owner, default_branch, private, last_synced_at, last_commit_sha, created_at, updated_at
		FROM github_repos
		WHERE github_repo_id = $1
	`

	var repo models.GitHubRepo
	err := r.db.QueryRowContext(ctx, query, githubRepoID).Scan(
		&repo.ID,
		&repo.InstallationID,
		&repo.GitHubRepoID,
		&repo.RepoName,
		&repo.RepoFullName,
		&repo.RepoOwner,
		&repo.DefaultBranch,
		&repo.Private,
		&repo.LastSyncedAt,
		&repo.LastCommitSHA,
		&repo.CreatedAt,
		&repo.UpdatedAt,
	)

	if err != nil {
		return nil, err
	}

	return &repo, nil
}

// UpdateSyncInfo updates the sync metadata for a repo
func (r *GitHubRepoRepository) UpdateSyncInfo(
	ctx context.Context,
	id string,
	lastCommitSHA string,
) error {
	now := time.Now()
	query := `
		UPDATE github_repos
		SET last_synced_at = $2, last_commit_sha = $3, updated_at = $4
		WHERE id = $1
	`

	_, err := r.db.ExecContext(ctx, query, id, now, lastCommitSHA, now)
	return err
}

// DeleteRepo deletes a GitHub repo record
func (r *GitHubRepoRepository) DeleteRepo(ctx context.Context, id string) error {
	query := `DELETE FROM github_repos WHERE id = $1`
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}

// DeleteByInstallationID deletes all repos for an installation
func (r *GitHubRepoRepository) DeleteByInstallationID(ctx context.Context, installationID string) error {
	query := `DELETE FROM github_repos WHERE installation_id = $1`
	_, err := r.db.ExecContext(ctx, query, installationID)
	return err
}

// GetByID retrieves a repo by its internal UUID.
func (r *GitHubRepoRepository) GetByID(ctx context.Context, id string) (*models.GitHubRepo, error) {
	query := `
		SELECT id, installation_id, github_repo_id, repo_name, repo_full_name, repo_owner, default_branch, private, last_synced_at, last_commit_sha, created_at, updated_at
		FROM github_repos
		WHERE id = $1
	`
	var repo models.GitHubRepo
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&repo.ID,
		&repo.InstallationID,
		&repo.GitHubRepoID,
		&repo.RepoName,
		&repo.RepoFullName,
		&repo.RepoOwner,
		&repo.DefaultBranch,
		&repo.Private,
		&repo.LastSyncedAt,
		&repo.LastCommitSHA,
		&repo.CreatedAt,
		&repo.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &repo, nil
}
