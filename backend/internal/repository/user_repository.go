package repository

import (
    "context"
    "database/sql"
    "errors"

    "github.com/charkhaniakash/forge-engine/backend/internal/models"
)

type UserRepository struct {
    db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository {
    return &UserRepository{db: db}
}

// CreateUser inserts a new user
func (r *UserRepository) CreateUser(ctx context.Context, email, passwordHash, name string) (*models.User, error) {
    user := &models.User{
        Email:        email,
        PasswordHash: passwordHash,
        Name:         name,
    }

    err := r.db.QueryRowContext(
        ctx,
        `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, created_at, updated_at`,
        email, passwordHash, name,
    ).Scan(&user.ID, &user.CreatedAt, &user.UpdatedAt)

    if err != nil {
        return nil, err
    }

    return user, nil
}

// GetUserByEmail retrieves a user by email
func (r *UserRepository) GetUserByEmail(ctx context.Context, email string) (*models.User, error) {
    user := &models.User{}
    err := r.db.QueryRowContext(
        ctx,
        `SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE email = $1`,
        email,
    ).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.CreatedAt, &user.UpdatedAt)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, errors.New("user not found")
        }
        return nil, err
    }

    return user, nil
}

// GetUserByID retrieves a user by ID
func (r *UserRepository) GetUserByID(ctx context.Context, id string) (*models.User, error) {
    user := &models.User{}
    err := r.db.QueryRowContext(
        ctx,
        `SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE id = $1`,
        id,
    ).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.CreatedAt, &user.UpdatedAt)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, errors.New("user not found")
        }
        return nil, err
    }

    return user, nil
}