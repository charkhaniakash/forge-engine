# ADR 0001: Inter-Service Communication Protocol

**Status:** ACCEPTED

## Context

Forge Engine is a two-service system: Backend (Go) and Agent (Python). They must communicate reliably, securely, and consistently.

## Decision

Use **REST over HTTP with JSON** for inter-service communication, protected by **JWT (HS256)** authentication.

### Protocol Details

1. **Transport:** HTTP/1.1 with JSON payloads
2. **Auth:** JWT (HS256) signed by Backend, verified by Agent
3. **Versioning:** All paths prefixed with `/v1/...`
4. **Trace ID:** Every request/response carries `X-Trace-ID` header for correlation
5. **Errors:** Always JSON with `error` field and appropriate HTTP status code

### JWT Token Flow

1. Backend (Go) receives a user request
2. Backend generates a signed JWT token (5-min expiry) containing:
   - `sub: "backend"` (always Backend as issuer)
   - `trace_id: "..."` (from X-Trace-ID header)
   - `iat`, `exp` (issued-at, expiration)
3. Backend sends token to Agent in `Authorization: Bearer <token>` header
4. Agent verifies token signature using shared `JWT_SECRET`
5. Agent rejects if token is expired or signature invalid (401 Unauthorized)

### Example: Backend → Agent Request
