FROM golang:1.24-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o bin/server ./cmd/server

# Final image
FROM alpine:latest
# ca-certificates: for HTTPS calls to GitHub API
# git: for the ingestion cloner (go/internal/ingestion/cloner.go uses os/exec git)
RUN apk --no-cache add ca-certificates git
WORKDIR /root/

COPY --from=builder /app/bin/server .
COPY --from=builder /app/.env.local.example .env.local

EXPOSE 8080
CMD ["./server"]