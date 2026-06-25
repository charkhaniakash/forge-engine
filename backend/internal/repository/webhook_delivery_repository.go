package repository

import (
    "context"
    "database/sql"
)

type WebhookDeliveryRepository struct {
    db *sql.DB
}

func NewWebhookDeliveryRepository(db *sql.DB) *WebhookDeliveryRepository {
    return &WebhookDeliveryRepository{db: db}
}

func (r *WebhookDeliveryRepository) IsDeliveryProcessed(ctx context.Context, deliveryID string) (bool, error) {
    var id string
    err := r.db.QueryRowContext(ctx, `SELECT id FROM webhook_deliveries WHERE delivery_id = $1`, deliveryID).Scan(&id)
    if err == sql.ErrNoRows {
        return false, nil
    }
    if err != nil {
        return false, err
    }
    return true, nil
}

func (r *WebhookDeliveryRepository) RecordDelivery(ctx context.Context, deliveryID, eventType string) error {
    _, err := r.db.ExecContext(ctx, `INSERT INTO webhook_deliveries (delivery_id, event_type) VALUES ($1, $2)`, deliveryID, eventType)
    return err
}