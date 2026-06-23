# ADR 0001: Inter-Service Communication Protocol

**Status:** ACCEPTED

## Context

Forge Engine is a two-service system: Backend (Go) and Agent (Python). They must communicate reliably and consistently.

## Decision

Use **REST over HTTP with JSON** for inter-service communication.

- Simpler operational model than gRPC in Phase 0
- Excellent tooling and debugging support
- Request/response models codified in OpenAPI
- Streaming support via Server-Sent Events (SSE) if needed later

## Internal API Contract

All Go ↔ Python endpoints:

1. **Versioned paths:** `/v1/agent/...`, `/v1/backend/...`
2. **Structured errors:** Always return JSON with `error` field
3. **Trace ID propagation:** Every request/response carries `X-Trace-ID` header
4. **Timeouts:** 30s default, configurable per endpoint

Example:
