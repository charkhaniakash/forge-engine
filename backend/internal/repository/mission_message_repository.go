package repository

import (
	"context"
	"database/sql"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// MissionMessageRepository handles persistence for mission follow-up chat messages.
type MissionMessageRepository struct {
	db *sql.DB
}

// NewMissionMessageRepository constructs a MissionMessageRepository.
func NewMissionMessageRepository(db *sql.DB) *MissionMessageRepository {
	return &MissionMessageRepository{db: db}
}

// Append inserts a new message into the mission thread.
func (r *MissionMessageRepository) Append(ctx context.Context, workItemID, role, content string, turnNumber int) (*models.MissionMessage, error) {
	var msg models.MissionMessage
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO mission_messages (work_item_id, role, content, turn_number)
		VALUES ($1, $2, $3, $4)
		RETURNING id, work_item_id, role, content, turn_number, created_at
	`, workItemID, role, content, turnNumber).Scan(
		&msg.ID, &msg.WorkItemID, &msg.Role, &msg.Content, &msg.TurnNumber, &msg.CreatedAt,
	)
	return &msg, err
}

// ListByWorkItem returns all messages for a work item, ordered by turn and time.
func (r *MissionMessageRepository) ListByWorkItem(ctx context.Context, workItemID string) ([]*models.MissionMessage, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, work_item_id, role, content, turn_number, created_at
		FROM mission_messages
		WHERE work_item_id = $1
		ORDER BY turn_number, created_at
	`, workItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var msgs []*models.MissionMessage
	for rows.Next() {
		var m models.MissionMessage
		if err := rows.Scan(&m.ID, &m.WorkItemID, &m.Role, &m.Content, &m.TurnNumber, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, &m)
	}
	return msgs, rows.Err()
}

// LatestTurnNumber returns the highest turn_number for a work item (0 if none).
func (r *MissionMessageRepository) LatestTurnNumber(ctx context.Context, workItemID string) (int, error) {
	var turn int
	err := r.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(turn_number), 0) FROM mission_messages WHERE work_item_id = $1
	`, workItemID).Scan(&turn)
	return turn, err
}
