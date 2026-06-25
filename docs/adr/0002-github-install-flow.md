# ADR 0002: GitHub App Install + Callback Flow

## Status
Accepted

## Context
Phase 2 requires GitHub App integration for repository access. The initial implementation used a manual flow where users had to copy-paste installation IDs, which is not production-grade. We need a secure, automated install flow that ties GitHub App installations to organizations without manual intervention.

## Decision
Implement an Install → Callback flow using GitHub's state parameter and webhook confirmation:

### Flow Overview
1. User clicks "Install GitHub App" button in frontend
2. Frontend calls `GET /v1/github/install/url` (authenticated)
3. Backend creates a pending install record with:
   - Random state token (64 hex chars)
   - CSRF token (32 hex chars)
   - org_id from authenticated user
   - 10-minute expiry
4. Backend signs the state using JWT with claims: `{org_id, state_token, exp, iat}`
5. Backend returns GitHub App install URL: `https://github.com/apps/{APP_NAME}/installations/new?state={signed_jwt}`
6. User is redirected to GitHub's install page
7. After installation, GitHub redirects to `GET /v1/github/install/callback?state={signed_jwt}`
8. Backend validates JWT signature and expiry
9. Backend verifies pending install exists and is not expired
10. Backend deletes pending install (one-time use)
11. Backend shows success HTML page
12. GitHub sends `installation` webhook event
13. Backend correlates installation with org (future enhancement - currently uses manual linking as fallback)

### Security Considerations
- **State Token**: JWT signed with `GITHUB_INSTALL_STATE_SECRET` (or `JWT_SECRET` fallback)
- **Expiry**: Pending installs expire after 10 minutes
- **One-time Use**: Pending install deleted after successful callback
- **CSRF Protection**: CSRF token generated and stored (can be enhanced for stricter validation)
- **Webhook Authority**: Webhook is authoritative for installation confirmation
- **No Manual IDs**: Production flow does not accept manual installation ID pasting

### Endpoints
- `GET /v1/github/install/url` (protected): Returns install URL with signed state
- `GET /v1/github/install/callback` (public): Validates state and shows HTML response
- `POST /v1/github/webhook` ( public): Handles GitHub webhook events

### Database Schema
```sql
CREATE TABLE pending_installs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    state_token VARCHAR(512) UNIQUE NOT NULL,
    csrf_token VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
```

### Environment Variables
- `GITHUB_APP_NAME`: GitHub App name (default: "forge-engine")
- `GITHUB_INSTALL_STATE_SECRET`: Secret for signing state tokens (falls back to `JWT_SECRET`)

## Consequences
### Positive
- Secure, production-grade install flow
- No manual installation ID pasting required
- State parameter prevents CSRF attacks
- Automatic correlation between installations and organizations
- Webhook remains authoritative source of truth

### Negative
- Requires ngrok or public URL for local development testing
- Slightly more complex than manual flow
- Webhook correlation not fully implemented (uses manual linking as fallback)

### Alternatives Considered
1. **Manual Installation ID Pasting**: Rejected - not production-grade, error-prone
2. **OAuth Flow**: Rejected - GitHub Apps use install flow, not OAuth
3. **Direct API Linking**: Rejected - requires user to have GitHub PAT, less secure

## Testing
Test with ngrok for local development:
```bash
ngrok http 8080
# Configure GitHub App webhook URL to https://<ngrok>/v1/github/webhook
# Configure GitHub App callback to https://<ngrok>/v1/github/install/callback
```

## References
- [GitHub Apps Installation Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/installing-github-apps)
- [GitHub Webhooks](https://docs.github.com/en/webhooks)
