package db

import (
    "context"
    "database/sql"
    "fmt"

    _ "github.com/lib/pq"
)

func NewConnection(databaseURL string) (*sql.DB, error) {
    db, err := sql.Open("postgres", databaseURL)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("failed to ping database: %w", err)
    }

    // Set connection pool limits
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)

    return db, nil
}

// RunMigrations applies SQL migration files (manual for Phase 1)
func RunMigrations(ctx context.Context, db *sql.DB) error {
    // TODO: Phase 1 – run ./migrations/*.up.sql files in order
    // For now, users must run migrations manually:
    // psql -U forge -d forge -f backend/migrations/001_init_schema.up.sql
    return nil
}