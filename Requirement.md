# CLAUDE.md — Project Context for AI-Assisted Development

This file is read automatically before every session. It defines what this
project is, how it must be architected, the full phase-by-phase build plan, and
— most importantly — what you are allowed to build *right now* versus later.
Treat every rule below as a hard constraint, not a suggestion to override
because it seems more convenient in the moment.

---

## 1. What this product is

An autonomous software engineering agent platform. Users connect a GitHub repo,
ask questions about it, describe an engineering task in plain English (e.g. "Add
JWT Authentication"), and the system plans, implements, tests, repairs, and opens
a pull request for that task — with the user able to watch progress live and
intervene at any point.

This is a two-service system, not one app with an AI feature bolted on. Keep
that distinction in your head for every decision you make.

---

## 2. THE ONE RULE THAT CANNOT BE BROKEN

**The Agent System (Python) never directly touches a user's filesystem, shell, or
git remote. Ever. Under no circumstances.**

- The Backend (Go) owns all execution. It provisions sandboxes, runs commands,
  reads/writes files, and talks to GitHub.
- The Agent (Python) only ever **requests** an action through a defined
  tool-call contract (e.g. `ToolCallRequest { type: shell|read_file|write_file,
  args }`) and receives a structured result back. It reasons. It does not
  execute.
- If you find yourself about to write `subprocess.run()`, `open(path, "w")`, or
  any git command inside the Python service against a real user repo — stop.
  That is the wrong layer. Route it through the Go-owned tool-execution API
  instead, even if direct execution would be faster to write right now.

This rule exists because it is the entire security and audit model of the
platform. Do not "temporarily" violate it to get a demo working faster. There is
no such thing as temporary here — it becomes permanent debt once sandboxing
(Phase 6) is built around the assumption that this boundary holds.

---

## 3. Tech stack (fixed — do not substitute)

| Layer | Stack |
|---|---|
| Frontend | React, TypeScript |
| Backend Platform | Go, Fiber, PostgreSQL, Redis, WebSockets |
| Agent System | Python, FastAPI, (LangGraph — only once explicitly introduced) |
| AI Providers | OpenAI / Anthropic, behind a provider-abstraction layer |
| Infra | Docker, GitHub App integration |

Do not introduce a new framework, ORM, queue system, or language without it
being raised explicitly and recorded as a decision first.

---

## 4. Repo structure (fixed)

```
/backend       Go service (Fiber) — orchestration, auth, GitHub, sandbox mgmt, persistence
/agent         Python service (FastAPI) — reasoning, planning, retrieval, LLM calls
/frontend      React + TypeScript app
/infra         docker-compose, deployment configs, env templates
/docs/adr      Architecture Decision Records — one file per significant decision
```

Do not duplicate logic across `/backend` and `/agent`. If both seem to need
something (e.g. a GitHub client), it belongs in `/backend` only.

---

## 5. ⚠️ BUILD ONE PHASE AT A TIME — THIS IS THE MOST IMPORTANT RULE HERE

The project is broken into 15 phases (Phase 0 → Phase 14), each below with its
own scope and Definition of Done. **You only work on the phase marked ACTIVE.**
Do not, under any framing of "being helpful":

- Scaffold tables, endpoints, or models for a future phase "while you're in there"
- Add auth while building the Phase 0 skeleton
- Wire GitHub while building Phase 1
- Start planning logic while building repo indexing
- Add self-repair while building the basic edit loop
- Build PR creation before validation/testing exists
- Pull in a feature from two phases ahead because it seemed related or easy

If the active phase has a hard dependency on something from a **future** phase
that doesn't exist yet — **stop and say so explicitly.** Do not silently stub
the future phase to unblock yourself. If it depends on something from a **past**
phase that looks incomplete or wrong, flag that too rather than patching around
it quietly.

When you believe the active phase's Definition of Done is met, say so explicitly
and stop. Do not continue into the next phase on momentum. The human updates the
ACTIVE marker below.

---

## 6. ACTIVE PHASE MARKER

> ### 🔵 ACTIVE PHASE: **Phase 7 — Code Modification Execution**
>
> Only work within this phase's scope (see Phase 7 below) until the human moves
> this marker forward.

*(Update this section only when the human says a phase is complete and to move
on. Do not move it yourself.)*

---

## COMPLETED PHASES

### ✅ Phase 0 — Foundations & Platform Skeleton
- Backend + Agent services wired, deployable in one command
- Trace ID propagation across services
- JWT inter-service auth (Backend → Agent)
- CI/CD pipeline (GitHub Actions)

### ✅ Phase 1 — Identity, Org, and Access Foundation
- User signup/login with JWT (24h expiry)
- Org creation, membership, roles (owner/admin/member)
- Invitation flow with token-based acceptance
- RBAC middleware protecting endpoints
- Rate-limit primitives (config-driven, Redis impl pending)

### ✅ Phase 2 — GitHub Integration & Repository Connection
- GitHub App registration (private key, webhook secret, app ID)
- Secure Install + Callback flow with JWT-signed state tokens
  - GET /v1/github/install/url: Generates install URL with signed state
  - GET /v1/github/install/callback: Validates state, reads installation_id from query params, upserts github_installations record immediately
  - pending_installs table for tracking pending installations
  - 10-minute expiry on pending installs
  - One-time use state tokens
- Manual installation linking fallback (POST /v1/github/installations/link)
- Webhook receiver with HMAC-SHA256 signature verification
- Repo listing/sync: repos fetched from GitHub API and cached
- Installation token caching with 5-min early refresh
- Durable storage: github_installations, github_repos, pending_installs tables
- RBAC: org_id enforced on protected endpoints
- Frontend: GitHubInstallButton component and GitHubInstallCallback page
- ADR documentation for install flow (docs/adr/0002-github-install-flow.md)

### ✅ Phase 2 — Hardening
- Webhook idempotency: webhook_deliveries table + ON CONFLICT DO NOTHING deduplication
- Pending install hardening: state_token_hash, callback_seen, used_at columns (migration 004)
- Callback correlation: InstallCallback reads installation_id from GitHub redirect, upserts github_installations immediately via GitHub API — covers both fresh install and DB-loss recovery
- SyncRepos auto-recovery: when no local installation record exists, calls ListAppInstallations to find and recreate the record automatically
- RelinkInstallation endpoint removed: superseded by the two automated recovery paths above
- Frontend: recovery banner shown when sync returns 404
- ADR 0003: defer LangGraph adoption documented

### ✅ Phase 6 — Secure Execution Sandbox
- Database: workspaces table — driver, container_id (opaque), resource limits, full lifecycle status machine
- Database: execution_logs table — unified event log for lifecycle events AND commands, with seq ordering
- Migration 009: workspaces + execution_logs with correct indexes
- Workspace abstraction: Workspace (domain) → Sandbox (runtime) → DockerContainer (impl detail)
- SandboxDriver interface: Provision, Execute, Destroy, Status, ReadFile, WriteFile, CopyFile (last 3 are Phase 7 stubs)
- DockerSandboxDriver: --network none, non-root forge user (uid 1000), read-only rootfs, CPU/mem/PID limits, streaming ExecutionEvent channel
- Clone inside sandbox: git clone via authenticated URL injected as env var (never logged), then git checkout to target commit SHA
- ExecutionEvent stream: "stdout"|"stderr"|"exit"|"timeout"|"error" events — consumers drain channel; Phase 7 fans to WebSocket
- WorkspaceManager: orchestrates full lifecycle, writes every lifecycle event to execution_logs, redacts credentials from logs
- WorkspaceReaper: periodic goroutine — destroys provisioning-timeout, wall-clock-timeout, and dead-container orphans
- WorkspaceRepository: full CRUD + status transitions + LogLifecycle + LogCommandStart/Complete + ListLogs
- WorkspaceHandlers: POST/GET/DELETE /workspace, GET /workspace/logs, POST /internal/workspaces/:id/exec
- RequireInternalAuth middleware: validates Backend-to-Backend JWT (sub="backend") for the internal exec endpoint
- Approval gate: ProvisionWorkspace rejects unless approval_status IN ('approved', 'auto_approved') — server-side hard check
- forge-sandbox Dockerfile: ubuntu:22.04-slim, git only, forge user uid 1000, /workspace owned by forge
- docker-compose: Docker socket mounted into backend (backend is the ONLY Docker-capable component), sandbox image build service
- Frontend: WorkspaceStatus component — provision/destroy/status display, execution log viewer (dark terminal style)
- Frontend: WorkspaceStatus shown in TaskPanel for approved/executing/done/failed tasks
- Agent involvement: zero — Phase 6 is pure infrastructure, no LLM calls, no agent interaction

---
- Database: work_items table — type, intent, status state machine, approval_status enum, approval_policy JSONB
- Database: plans table — immutable append-only versions, schema_version v1, is_active flag, created_by field
- Migration 008: work_items + plans with correct indexes and constraints
- Go: WorkItemRepository — full state machine transitions (StartPlanning, MarkPlanReady, Approve, ResetForReplan, Cancel, GetByIDInternal)
- Go: AgentPlanClient — POST /v1/agent/plan streaming NDJSON client (thinking/plan/error events)
- Go: TaskHandlers — 9 endpoints (create, list, get, list-plans, update-plan, approve, replan, cancel, WS stream)
- Go: Approval gate — hard-enforced server-side; status cannot advance to plan_approved without approval_status = approved
- Go: Plan validation — JSON schema check + dependency cycle detection before any plan is persisted
- Go: Planning goroutine — background dispatch, thinking events fanned to WebSocket in real time
- Agent: Planner Protocol — interface for all planning implementations (plan_type, planner_id, async generate())
- Agent: PlannerRegistry — factory pattern; Phase 5 registers ImplementationPlanner only
- Agent: ImplementationPlanner — JSON-mode LLM call, PlanBody validation, one retry on failure
- Agent: PlanValidator — deterministic: required fields, duplicate IDs, depends_on refs, cycle detection
- Agent: PlanningPipeline — 7-stage async generator: intent→retrieval→impact→arch→constraint(noop)→generate→emit
- Agent: RetrievalProfile — named profiles (qa, planning); planning uses k=120, include_tests=True, budget=8192
- Agent: RetrievalEngine — updated to accept optional RetrievalProfile; backward-compatible (Q&A unchanged)
- Agent: ChatProviders — updated to accept response_format for JSON mode (OpenAI/Gemini/Anthropic)
- Agent: POST /v1/agent/plan — streaming NDJSON router; replaces Phase 5 stub
- Frontend: TaskPanel — task list, intent input, live planning progress, plan viewer with step editing
- Frontend: PlanView — steps with risk badges, affected files, edit/reorder/delete, approve button
- Frontend: App.tsx — ⚡ Tasks button per indexed repo, TaskPanel mount
- Plan Schema v1: schema_version, plan_type, planner_id, intent_summary, risks, assumptions, affected_files, steps
- PlanStep: id, stable_id, order, depends_on[], title, description, type, affected_files, estimated_risk, user_edited, metadata
- Approval policy: JSONB field; Phase 5 always_require_human; extensible for Phase 12 auto-approve rules
- WorkItem composition: parent_id + template_id nullable columns reserved for future sub-tasks / templates

---
- Database: ingestion_jobs table with lifecycle tracking (queued/running/done/failed/superseded)
- Database: code_chunks table with pgvector extension for embeddings
- Go: JobWorker with Redis queue (BLPOP), goroutine pool with configurable concurrency
- Go: Cloner for git clone via os/exec with credential helper
- Go: AgentClient for streaming HTTP calls to Python agent
- Go: IngestionJobRepository for job CRUD and supersede logic
- Go: Push webhook handler enqueues ingestion jobs on push events
- Go: Installation sync auto-enqueues ingestion jobs for all synced repos
- Agent: POST /v1/agent/ingest endpoint with streaming NDJSON progress
- Agent: Tree-sitter parsers for Python and JavaScript, line-based fallback
- Agent: Token-budget-aware chunker with tiktoken (cl100k_base encoding)
- Agent: Embedder with provider abstraction (OpenAI/Anthropic)
- Agent: Vector store writer for direct pgvector writes
- Frontend: Index status API (GET /v1/github/repos/:repoID/index/status)
- Frontend: Manual trigger (POST /v1/github/repos/:repoID/index/trigger)
- Frontend: Job progress panel showing stage, processed/total chunks, progress bar
- ADR 0004: Clone ownership and ingestion contract documented
- Supersede logic: worker checks status before clone and after clone only
- Retrieval gates on job status = 'done' (partial repos never queryable)
- Snapshot model: (repo_id, commit_sha) as immutable snapshot key

---

## 7. Phase-by-Phase Plan

Each phase lists: Objective · In-Scope Deliverables · Explicitly Out-of-Scope ·
Backend (Go) responsibilities · Agent (Python) responsibilities · Definition of
Done.

---

### Phase 0 — Foundations & Platform Skeleton

**Objective:** Empty but real skeleton of both services, wired together, deployable.

**In scope:**
- Go/Fiber service: health/readiness endpoints, config, structured logging
- Python/FastAPI service: same, plus a stub LLM-provider interface (no real calls)
- Docker Compose: both services + Postgres + Redis, one-command local dev
- Internal service-to-service auth between Go and Python (signed tokens or mTLS)
- CI: lint + test + build for both services
- ADR defining the Agent Job Contract shape (job in, events out) — written
  decision only, not working code yet

**Out of scope:** users, orgs, GitHub, repos, indexing, planning, sandboxes,
anything that "does something smart."

**Backend (Go):** service bootstrap, config/env management, defines the
versioned internal API contract Python must implement, health/readiness, trace
ID propagation.

**Agent (Python):** FastAPI bootstrap, config, stub endpoints matching the
agreed contract, LLM provider abstraction skeleton (no calls yet).

**Definition of Done:** A request flows Frontend → Go → Python → back over
HTTP, in CI, with logs correlated by trace ID, deployable locally in one command.

---

### Phase 1 — Identity, Org, and Access Foundation

**Objective:** Users can sign up, belong to an org; everything scopes to (user, org).

**In scope:** signup/login, JWT/session issuance + validation middleware, org
model + membership + roles (owner/admin/member), invitation flow, rate-limit
primitives (built, not yet enforced).

**Out of scope:** GitHub, repos, billing enforcement, anything agent-related.

**Backend (Go):** all auth flows, password hashing, RBAC middleware, org CRUD,
invitations.

**Agent (Python):** nothing user-facing. Only trusts a forwarded, Backend-validated
`org_id`/`user_id` on internal calls — never authenticates end users itself.

**Definition of Done:** A user signs up, creates/joins an org, and every API
call carries a server-verified `org_id` (never trusted from the client).

---

### Phase 2 — GitHub Integration & Repository Connection

**Objective:** Users connect GitHub via a GitHub App; platform has durable,
permissioned repo access and webhooks.

**In scope:** GitHub App registration (contents, PRs, checks, metadata scopes),
install flow, webhook receiver with signature verification, repo listing/sync,
installation token caching/refresh.

**Out of scope:** cloning/indexing repo contents, writing code, opening PRs.

**Backend (Go):** GitHub App auth (JWT → installation token), webhook
verification + idempotent processing, repo metadata sync, encrypted token
storage, permission checks on connect/disconnect.

**Agent (Python):** none directly — only ever receives a scoped, time-limited
credential or proxied path from Backend, never raw GitHub App keys.

**Definition of Done:** User installs the app, sees repos listed, platform can
fetch a fresh installation token for any connected repo on demand; webhooks are
verified and durably recorded.


### Phase 2 — Hardening (added)

Purpose: Operational and safety hardening to make the GitHub App install/callback/webhook flow production-ready before Phase 3 ingestion.

Changes implemented:
- Webhook idempotency: `webhook_deliveries` table + `ON CONFLICT DO NOTHING` deduplication
- Pending install hardening: `state_token_hash`, `callback_seen`, `used_at` columns (migration 004) with single-use enforcement
- Callback/Correlation flow: `GET /v1/github/install/callback` now reads `installation_id` from GitHub's redirect query params and immediately upserts the `github_installations` record via the GitHub API — covers both fresh install and DB-loss recovery without requiring a new webhook
- `SyncRepos` auto-recovery: when no local installation record exists, calls `GET /app/installations` to find and recreate the record automatically
- `RelinkInstallation` endpoint removed: superseded entirely by the two automated recovery paths above
- Frontend: recovery banner shown when sync returns 404
- ADR 0003: defer LangGraph adoption documented

---

### Phase 3 — Repository Ingestion & Indexing

**Objective:** Turn a connected repo into something queryable: cloned, parsed, chunked, embedded.

**Agreed architecture (see ADR 0004):**

- Go clones the repo using the installation token. The Agent never calls git.
- Go passes the read-only clone path to the Agent via `POST /v1/agent/ingest`.
- The Agent streams NDJSON progress events back on the HTTP response.
- Go reads the stream, updates job state in DB, fans out to frontend via WebSocket.
- The frontend only talks to Go. It never knows the Agent exists.
- Retrieval (Phase 4+) only reads chunks where `ingestion_jobs.status = 'done'`.
- Rapid pushes: older jobs are marked `superseded`; worker checks before clone and after clone only (not during embedding).
- Every successful ingestion is treated as an immutable snapshot keyed by `(repo_id, commit_sha)`.

**In scope:**
- `ingestion_jobs` table: `trigger_type`, `status` (queued/running/done/failed/superseded), `progress_stage`, `queued_at`, `started_at`, `finished_at`, `worker_id`, `total_chunks`, `processed_chunks`, `error`
- `code_chunks` table: `repo_id`, `job_id`, `commit_sha`, `file_path`, `language`, `chunk_type`, `name`, `start_line`, `end_line`, `content`, `token_count`, `embedding_model`, `embedding` (vector, nullable), `parser_name`, `parser_version`
- pgvector extension; ivfflat index on embedding column
- Go: `JobWorker` (goroutine pool, Redis BLPOP), `Cloner` (git clone via os/exec), `AgentClient` (streaming HTTP), `IngestionJobRepository`, status endpoints, push webhook → enqueue
- Agent: `POST /v1/agent/ingest` (streaming NDJSON), tree-sitter parsing (Python + JS/TS + line-based fallback), chunker (token-budget aware), embedder (provider abstraction, batched), vector store writer (psycopg2 direct)
- ADR 0004 documenting the clone ownership and ingestion contract
- Job status API: `GET /v1/github/repos/:repoID/index/status`
- Manual trigger: `POST /v1/github/repos/:repoID/index/trigger`
- Frontend: job progress panel showing stage + percentage

**Out of scope:** Q&A, retrieval, planning, code editing, dependency graph, LangGraph, symbol table as first-class entity, generative LLM calls, `repo_index_heads` table.

**Backend (Go):** job lifecycle, queue, clone, agent HTTP client, status persistence, push webhook debounce, WebSocket fan-out, clone cleanup.

**Agent (Python):** parse, chunk, embed, write `code_chunks`, stream NDJSON progress. Never calls git. Never writes to the filesystem.

**Definition of Done:**
1. Connecting a repo triggers an ingestion job automatically
2. A push to a connected repo triggers a re-index job (debounced by SHA; older jobs marked superseded)
3. `code_chunks` rows exist for the repo tied to the indexed commit SHA, with embeddings stored in pgvector
4. A cosine similarity query against `code_chunks` returns relevant chunks
5. Job status (queued → running → done/failed/superseded) is visible via API with stage and progress
6. Real-time progress is visible in the frontend (stage label + processed/total counts)
7. Partially indexed repos are never queryable (retrieval gates on `status = 'done'`)
8. The Agent never calls git, subprocess, or writes outside the database

---

### Phase 3 — Embedding Provider Abstraction (Extended)

**Why this exists:**
The ingestion pipeline must not be coupled to any single embedding vendor. Providers change their APIs, pricing, and availability. Different deployments may require different models (OpenAI for cloud, Ollama for on-premise, Gemini as an alternative). The abstraction makes the pipeline provider-agnostic so adding a new provider never requires changes to ingestion logic.

**Design:**
A Strategy Pattern is used. `EmbeddingProvider` (abstract base class in `agent/src/ingestion/embedding/base.py`) defines the contract:

```python
class EmbeddingProvider(ABC):
    @property
    @abstractmethod
    def model_name(self) -> str: ...   # stored in code_chunks.embedding_model

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]: ...
```

The ingestion pipeline (`job.py`) imports only `embedder.embed_batch()` — a thin shim that delegates to the active provider. No provider-specific code or conditionals exist outside `factory.py`.

**Supported providers:**

| `EMBEDDING_PROVIDER` | Class | Default model | Dimensions |
|---|---|---|---|
| `openai` (default) | `OpenAIEmbeddingProvider` | `text-embedding-3-small` | 1536 |
| `gemini` | `GeminiEmbeddingProvider` | `models/text-embedding-004` | 768 |

**Configuration variables:**

| Variable | Description | Default |
|---|---|---|
| `EMBEDDING_PROVIDER` | Provider name (`openai`, `gemini`) | `openai` |
| `EMBEDDING_MODEL` | Model identifier sent to the provider API | `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | Vector dimension (must match DB column type) | `1536` |
| `EMBEDDING_BATCH_SIZE` | Texts per `embed()` call | `32` |
| `OPENAI_API_KEY` | Required when `EMBEDDING_PROVIDER=openai` | — |
| `GEMINI_API_KEY` | Required when `EMBEDDING_PROVIDER=gemini` | — |

**How to add a new provider (e.g. Voyage AI):**
1. Create `agent/src/ingestion/embedding/voyage_provider.py` implementing `EmbeddingProvider`.
2. Add an entry to `_REGISTRY` in `factory.py`:
   ```python
   "voyage": (lambda: _make_voyage(),),
   ```
3. Add `_make_voyage()` in `factory.py` that reads the API key from `settings`.
4. Set `EMBEDDING_PROVIDER=voyage` in the environment.
5. No other files change.

**Critical constraint — model consistency per repository:**
All `code_chunks` rows for a given repository must be generated by the same embedding model. Changing `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL` after a repository has been indexed produces vectors in an incompatible space — cosine similarity queries will return meaningless results. Switching models requires:
1. Deleting all `code_chunks` rows for the affected repositories (`DELETE FROM code_chunks WHERE repo_id = $1`).
2. Re-triggering an ingestion job (`POST /v1/github/repos/:repoID/index/trigger`).
The `embedding_model` column on every `code_chunks` row records which model produced it, making it possible to identify which repositories need re-indexing after a model change.

**File layout:**
```
agent/src/ingestion/embedding/
  __init__.py          — exports EmbeddingProvider, get_embedding_provider
  base.py              — abstract EmbeddingProvider
  openai_provider.py   — OpenAI implementation
  gemini_provider.py   — Google Gemini implementation
  factory.py           — sole selection point; reads EMBEDDING_PROVIDER
agent/src/ingestion/
  embedder.py          — public shim: embed_batch() delegates to factory
```

---

### Phase 4 — Repository Q&A (Grounded Retrieval)

**Objective:** Users ask natural-language questions about a repo and get
accurate, cited, streamed answers.

**Agreed architecture (see implementation):**

- Sessions are pinned to `commit_sha` at creation time — every question in the session retrieves against the same snapshot. A banner is shown when a newer index is available.
- `qa_sessions.workspace_id` is NULL in Phase 4 and reserved for Phase 5+ workspace grouping.
- Go resolves the latest done `commit_sha` from `ingestion_jobs` and passes it to the Agent — the Agent never queries job tables directly.
- Agent retrieval pipeline: `embed → VectorCandidateGenerator(top_k=50) → MetadataFilter → Reranker(cosine+keyword) → DiversitySelector(max_per_file=3, keep=15) → LinearContextAssembler(budget=4096)`.
- `RetrievalScope` is a runtime-only construct (never stored in DB) — `qa_sessions` keeps plain `repo_id` + `commit_sha` columns.
- `CandidateGenerator` accepts `RetrievalScope` (not bare repo_id) — future multi-repo search passes multiple pairs without changing the interface.
- NDJSON event schema: `{"v":1, "event":"token|done|error", "seq":N, "request_id":"..."}` — versioned from day one.
- `LLMStreamer` emits an opaque `payload: dict` in the done event — Q&A sets `payload={"citations":[...]}`. Future capabilities (planning, code-gen) set their own payload without changing the streamer.
- Reusable core lives in `src/core/` (RetrievalEngine, ContextAssembler, LLMStreamer). Q&A-specific code lives in `src/qa/`.
- `RetrievalResult` carries diagnostics (timing_ms, candidate_count, filtered_count, reranked_count, final_count) logged as a structured `retrieval_trace` event for future observability.
- Snapshot retention: Go owns GC lifecycle. Sessions reference `commit_sha` as a GC anchor — chunks for a snapshot are never deleted while a session references that SHA.
- All retrieval tuning knobs (candidate_k, rerank_k, etc.) are config-driven via `RETRIEVAL__*` env vars; runtime-configurable DB config is Phase 13.

**In scope:**
- `qa_sessions` + `qa_messages` tables (migration 007)
- `QARepository`: session + message CRUD
- `AgentQAClient`: POST `/v1/agent/qa` + NDJSON stream reader
- REST endpoints: create session, list sessions, get session, ask, WebSocket stream
- `RetrievalEngine` composing 4 stages
- `VectorCandidateGenerator`, `MetadataFilter`, `Reranker`, `DiversitySelector`, `LinearContextAssembler`
- `ChatProvider` protocol + OpenAI/Gemini/Anthropic implementations
- `QAPipeline`: embed → retrieve → assemble → prompt → stream
- `QAPanel` frontend: session list, chat UI, citation tags, WebSocket streaming
- Nested config: `EmbeddingConfig`, `ChatConfig`, `RetrievalConfig`

**Out of scope:** hybrid retrieval, symbol graph expansion, WebSocket reconnect/replay (Phase 11), cost tracking (Phase 13), multi-repo sessions, LangGraph.

**Backend (Go):** session/message persistence, auth gate, repo-readiness check, WS hub, answer persistence on done event.

**Agent (Python):** embed, retrieve, assemble, prompt, stream. Stateless — never writes sessions or messages.

**Definition of Done:**
1. A user asks a question on an indexed repo and gets a streamed, cited, grounded answer
2. Sessions persist and resume with full message history
3. Sessions are pinned to the commit SHA they were created against
4. Citations include chunk_id, file_path, start_line, end_line, language, chunk_type, symbol_name
5. Token events stream in real time via WebSocket; answer persists in DB on completion
6. Retrieval pipeline logs a `retrieval_trace` event with full diagnostics per request
7. All retrieval tuning is configurable without code changes

---

### Phase 5 — Task Creation & Implementation Planning

**Objective:** Convert a user's intent into a concrete, editable, human-approved
plan — with zero code changes yet.

**In scope:** task object model, planning agent producing structured
(schema-validated) multi-step plans with files/risks/assumptions, plan editing
UI, explicit approval gate.

**Out of scope:** any actual file modification, sandbox execution, builds/tests.

**Backend (Go):** task state machine (`draft → planning → plan_ready →
plan_approved → ...`), versioned plan persistence, **hard-enforces that no
execution can start without `plan_approved`**.

**Agent (Python):** retrieves context (reuses Phase 4 retrieval), reasons about
affected files/modules, emits structured plan output Backend/Frontend can render
and let users edit.

**Definition of Done:** User submits intent, gets an editable structured plan
grounded in real repo context, approves it, and the system cannot proceed to
execution without that approval.

---

### Phase 6 — Secure Execution Sandbox

**Objective:** Build the secure execution foundation of Forge by introducing an isolated, ephemeral, resource-bounded workspace where engineering tasks can safely execute. This phase transitions Forge from a repository understanding platform into an execution-capable platform, but **does not introduce autonomous AI execution yet**. The sandbox represents the same concept as the cloud workspaces used by modern AI engineering systems such as Devin or Google Jules—an isolated environment where repositories are cloned, commands are executed, outputs are streamed, and the entire workspace is destroyed after completion. The goal of this phase is to prove the execution infrastructure independently of any AI reasoning.

**In scope:** Per-task ephemeral container provisioning (Docker initially), repository cloning and checkout, filesystem isolation, CPU/memory/disk quotas, network egress default-deny, command execution API (stdout/stderr/exit code, enforced timeouts), real-time command output streaming, sandbox lifecycle tied to task state, orphan sandbox reaper job, and complete audit logging of every command executed.

**Out of scope:** Any AI reasoning, code generation, file modification, autonomous decision making, build repair, commit creation, or pull request generation. This phase focuses solely on building the execution platform that future phases will consume.

**Backend (Go):** Owns the entire execution platform. It provisions and destroys sandboxes, clones repositories, checks out commits, executes commands, enforces resource quotas and security boundaries, manages network policies, streams command output, exposes the tool-execution API, enforces hard timeouts and kill switches, performs cleanup, and records complete execution audit logs.

**Agent (Python):** Has **zero direct execution capability**. It never interacts with Docker, shells, filesystems, or Git directly. In future phases it will only issue structured `ToolCallRequest` messages and consume `ToolCallResult` responses through the backend, preserving a strict separation between reasoning and execution.

**Definition of Done:** The backend can provision an isolated sandbox, clone and prepare a repository at a specific commit, execute arbitrary commands with enforced security and resource limits, stream execution output, capture stdout/stderr/exit codes, cleanly destroy the environment after completion, and reliably recover orphaned sandboxes. The entire execution platform must be fully testable without involving any LLM or AI agent.
---

### Phase 7 — Autonomous Code Modification Execution

**Objective:** Execute an approved implementation plan inside the Phase 6 Workspace through structured tool calls, producing deterministic, observable, and fully auditable code modifications with live-visible diffs. The agent behaves like a software engineer operating inside an isolated workspace while remaining strictly bounded by the approved plan.

**In scope:**
- Step-by-step execution of approved implementation plans
- Code-editing agent loop (read → understand → reason → write via tool calls)
- Repository navigation (symbol lookup, dependency exploration, reference search, project structure understanding)
- Structured file operations (read, create, modify, rename, move, delete)
- Context-aware minimal code edits (avoid whole-file rewrites where possible)
- Structured diff generation and visualization
- Live execution timeline showing every reasoning and tool event
- Execution checkpoints after every completed plan step
- Workspace artifact tracking (modified files, created files, deleted files)
- Step-by-step execution tracking with progress indicators
- Explicit surfacing of plan deviations (never silently improvising)
- Structured execution event model for future replay and observability
- Live synchronization of workspace changes to future browser workspace clients

**Out of scope:**
- Running builds or tests (Phase 8)
- Automatic repair loops (Phase 9)
- Git commits and Pull Requests (Phase 10)
- Browser IDE implementation (Phase 10B)
- Streaming hardening and replay (Phase 11)
- Human intervention controls (Phase 12)

**Backend (Go):**
Owns the complete execution orchestration pipeline.
Responsibilities include:
- Execute approved implementation plans sequentially
- Orchestrate Workspace execution lifecycle
- Validate every tool invocation
- Relay tool-call requests to the Phase 6 Workspace
- Persist structured execution events
- Persist structured code diffs
- Persist execution checkpoints
- Persist workspace artifacts
- Stream execution progress over WebSocket
- Synchronize workspace updates with future browser workspace clients
- Detect and surface plan deviations
- Enforce execution permissions, workspace boundaries, cancellation, and timeouts
- Advance the task execution state machine

**Agent (Python):**
Responsible only for reasoning and execution planning.
Responsibilities include:
- Interpret each approved implementation step
- Gather repository context before modifying code
- Issue structured read/write/search tool calls
- Navigate repository structure intelligently
- Generate minimal code modifications
- Explain execution reasoning for every completed step
- Detect repository inconsistencies
- Explicitly report plan deviations instead of silently changing strategy
- Produce structured execution summaries
- Never edit files directly
- Never bypass Backend authorization
- Never communicate directly with the Workspace runtime or Browser UI

**Definition of Done:**
Given an approved implementation plan:
- The agent executes every approved step sequentially inside the Workspace.
- Repository context is gathered before each modification.
- Every modification is performed through structured tool calls.
- Every file change produces an inspectable structured diff.
- Every execution step is streamed live to the frontend.
- Execution checkpoints are persisted after every completed step.
- Workspace artifacts are tracked throughout execution.
- Plan deviations are surfaced explicitly for user visibility.
- The Workspace contains the fully modified repository, ready for Build & Test validation in Phase 8.

---

### Phase 8 — Intelligent Build & Validation Pipeline

**Objective:** Automatically validate the modified repository by executing its real build, test, lint, formatting, and analysis tooling inside the Phase 6 Workspace. Produce structured validation results that become the input for the autonomous repair loop in Phase 9.

This phase never modifies code. It only validates, analyzes, and reports.

---

**In scope:**

### Validation Pipeline
- Automatic project stack detection
- Build tool detection
- Test framework detection
- Package manager detection
- Language runtime detection
- Framework detection
- Validation profile selection

### Repository Baseline
- Optional baseline validation before AI modifications
- Detect pre-existing build failures
- Detect pre-existing test failures
- Detect flaky tests
- Compare before/after validation results
- Prevent attributing existing failures to the AI

### Build Validation
- Execute project build commands
- Support an explicit set of known language stacks
- Support configurable validation profiles
- Capture build artifacts
- Capture compiler diagnostics
- Capture dependency resolution failures

### Test Validation
- Execute unit tests
- Execute integration tests (where configured)
- Detect skipped tests
- Detect flaky tests
- Parse structured test results
- Collect execution statistics

### Static Analysis
- Run project linting tools
- Run formatting validation
- Collect compiler warnings
- Collect static analysis diagnostics
- Capture code quality violations

### Structured Result Parsing
Convert raw command output into structured validation data:
- Build status
- Test status
- Failed test cases
- Compiler errors
- Runtime exceptions
- Stack traces
- File locations
- Line numbers
- Error categories
- Severity levels
- Suggested repair category

### Validation Artifacts
Persist:
- Raw stdout/stderr
- Structured validation results
- Build logs
- Test reports
- Lint reports
- Execution duration
- Validation summary
- Generated artifacts metadata

### Live Validation Timeline
Stream every validation event:
- Build started
- Installing dependencies
- Running build
- Running tests
- Running linter
- Parsing failures
- Validation complete

### Validation Summary
Generate a structured report including:
- Build Success / Failed
- Tests Passed / Failed
- Files with errors
- Diagnostics summary
- Validation duration
- Readiness for Phase 9

---

**Out of scope:**
- Automatic code repair (Phase 9)
- Git commits and Pull Requests (Phase 10)
- Browser IDE implementation (Phase 10B)
- Human intervention controls (Phase 12)

This phase never attempts to modify implementation code. It only validates and reports.

---

**Backend (Go):**

Owns the complete validation orchestration pipeline.

Responsibilities include:
- Detect project technology stack
- Select validation profile
- Determine build, test, lint, and analysis commands
- Execute validation commands through the Phase 6 Workspace
- Orchestrate validation order
- Capture raw execution output
- Persist structured validation artifacts
- Persist validation summaries
- Stream validation progress over WebSocket
- Compare baseline vs post-change validation
- Produce structured inputs for the Phase 9 repair engine
- Enforce validation timeouts and execution policies

---

**Agent (Python):**

Responsible only for validation understanding.

Responsibilities include:
- Parse raw stdout/stderr
- Parse compiler diagnostics
- Parse structured test results
- Parse lint results
- Categorize failures
- Identify affected files
- Identify affected symbols
- Classify failures by severity
- Classify failures as repairable or non-repairable
- Produce structured validation summaries
- Never modify implementation code
- Never execute repair actions

---

**Definition of Done:**

After Phase 7 completes:

- The platform automatically detects the project's technology stack.
- The correct validation pipeline executes inside the Workspace.
- Build, test, lint, and analysis commands execute successfully for supported stacks.
- Baseline validation is compared against post-change validation where applicable.
- Raw execution logs are converted into structured diagnostics.
- Compiler errors, test failures, lint violations, and runtime exceptions are accurately classified.
- Validation progress streams live to the frontend.
- All validation artifacts are persisted.
- The repository is classified as either:
  - Validation Passed
  - Validation Failed (Repairable)
  - Validation Failed (Requires Human Intervention)

The resulting structured validation report becomes the direct input for the autonomous repair loop implemented in Phase 9.

---
### Phase 9 — Autonomous Self-Repair & Recovery Loop

**Objective:** Automatically repair validation failures through a bounded, intelligent repair workflow that iteratively diagnoses, fixes, validates, and verifies implementation changes inside the Phase 6 Workspace before escalating to the user. The repair workflow is implemented internally as a LangGraph-based Repair Graph with explicit backend-enforced safety limits.

**In scope:**
- LangGraph-based autonomous repair workflow
- Intelligent failure diagnosis and classification
- Failure-category gating (only safe-to-auto-fix categories)
- Root-cause analysis before generating fixes
- Context-aware repository investigation
- Targeted implementation repairs scoped to affected files only
- Minimal code modifications (avoid unnecessary rewrites)
- Iterative repair → validation → retry loop
- Automatic strategy switching when an attempted repair fails
- Repair checkpointing between iterations
- Structured repair attempt history
- Repair confidence scoring
- Explicit escalation when repair confidence becomes too low
- Full execution timeline for every repair attempt
- Re-run Phase 7 → Phase 8 after every repair attempt
- Hard iteration, cost, and execution budgets
- Complete audit logging of every repair decision

**Out of scope:**
- Modifying tests to artificially produce passing results
- Disabling validations to hide failures
- Changing build configurations to bypass failures
- Git commits and Pull Requests (Phase 10)
- Browser IDE implementation (Phase 10B)
- Human approval workflows (Phase 12)

The repair engine fixes implementation code only unless the user explicitly instructs otherwise.

---

**Backend (Go):**

Owns the complete repair orchestration pipeline.

Responsibilities include:
- Start autonomous repair sessions
- Enforce maximum repair attempts
- Enforce execution time limits
- Enforce token and cost budgets
- Enforce workspace boundaries
- Execute Phase 7 and Phase 8 between repair iterations
- Persist complete repair history
- Persist every repair attempt
- Persist generated diffs
- Persist validation history
- Stream repair progress over WebSocket
- Decide when repair budgets are exhausted
- Escalate failures requiring human intervention
- Advance task lifecycle state

The Backend is the final authority for repair safety. The Agent can never exceed configured limits.

---

**Agent (Python):**

Responsible only for repair reasoning.

The repair workflow is implemented internally as a **LangGraph-based Repair Graph**. The graph manages repair state, branching decisions, retries, strategy selection, and checkpointing while remaining an internal implementation detail of the Python Agent. The Go Backend continues interacting with the Agent exclusively through the existing ToolCallRequest / ToolCallResult contract.

Responsibilities include:
- Analyze structured validation failures
- Perform root-cause analysis
- Gather additional repository context when necessary
- Classify failures by repairability
- Generate narrowly scoped implementation fixes
- Choose appropriate repair strategies
- Switch strategies when previous repairs fail
- Execute repository investigation before editing
- Generate minimal implementation changes
- Determine when additional repair attempts are worthwhile
- Self-terminate early when confidence becomes too low
- Produce structured repair summaries
- Explain repair reasoning
- Never modify tests unless explicitly instructed
- Never bypass Backend repair limits
- Never bypass Backend authorization
- Never communicate directly with the Workspace runtime or Browser UI

---

**Definition of Done:**

Given a validation failure:

- The repair workflow executes through the LangGraph-based Repair Graph.
- Validation failures are classified before repair begins.
- Root-cause analysis is performed prior to every repair attempt.
- Only approved repair categories are attempted automatically.
- Every repair attempt produces structured diffs.
- Phase 7 and Phase 8 execute after every repair iteration.
- Every repair attempt is fully logged and streamed live.
- Checkpoints are created after every iteration.
- Repair history is persisted for auditing.
- Repair terminates immediately upon successful validation.
- If repair budgets are exhausted or confidence becomes too low, the Backend cleanly escalates to the user.
- The repair engine never weakens or modifies tests to artificially achieve passing validation unless explicitly instructed by the user.


---
### Phase 10 — Git Operations, Review Preparation & Pull Request Automation

**Objective:** Convert a successfully validated implementation into production-ready Git artifacts by creating an isolated branch, meaningful commit history, and a comprehensive Pull Request that accurately represents the work performed throughout the entire execution lifecycle.

This phase is responsible for publishing work to GitHub. It never modifies implementation code.

---

**In scope:**

### Git Workspace Finalization
- Verify workspace is in a clean, valid state
- Detect modified, created, renamed, moved, and deleted files
- Generate repository change summary
- Detect merge conflicts before push

### Branch Management
- Automatic feature branch creation
- Collision-resistant branch naming
- Branch naming strategy based on task metadata
- Existing branch reuse (when appropriate)
- Safe branch cleanup policies

### Commit Generation
- Generate meaningful commit messages
- Support configurable commit message templates
- Support optional multi-commit mode for future execution strategies
- Include execution metadata
- Include validation metadata
- Preserve deterministic commit ordering

### Pull Request Generation
Generate a complete Pull Request including:

- Human-readable implementation summary
- Original user request
- Approved implementation plan
- High-level architectural changes
- Modified files summary
- Validation results
- Repair history (if applicable)
- Risks
- Assumptions
- Follow-up recommendations
- Deployment considerations (future-ready)

### GitHub Synchronization
- Push branch to remote
- Create Pull Request
- Synchronize PR status
- Synchronize review state
- Synchronize mergeability
- Synchronize CI status (future-ready)

### Change Review Artifacts
Persist:
- Branch information
- Commit metadata
- PR metadata
- PR URL
- Changed file list
- Diff summary
- GitHub synchronization history

### Live Progress
Stream:
- Creating branch
- Creating commits
- Pushing branch
- Creating Pull Request
- Synchronizing GitHub
- Pull Request ready

---

**Out of scope:**
- Browser-based code review (Phase 10B)
- Human approval workflow (Phase 12)
- Deployment pipelines
- Automatic merging
- Repository administration

This phase never edits implementation code. It only publishes validated work.

---

**Backend (Go):**

Owns the complete Git publishing pipeline.

Responsibilities include:
- Verify repository readiness
- Manage Git workspace state
- Create feature branches
- Handle branch collisions
- Create commits
- Push branches
- Create Pull Requests through the GitHub App
- Assemble PR descriptions using structured execution data
- Handle Git synchronization failures
- Handle base-branch movement
- Decide rebase vs fail-and-request-user-action
- Persist Git metadata
- Persist PR metadata
- Stream publishing progress
- Synchronize GitHub state back into Forge Engine

All Git operations are performed exclusively through the GitHub App Installation Token.

---

**Agent (Python):**

Responsible only for summarization.

Responsibilities include:
- Generate human-readable commit messages
- Generate Pull Request summaries
- Summarize implementation work
- Summarize validation results
- Summarize repair history
- Summarize architectural impact
- Generate reviewer-friendly explanations

The Agent never invents information. Every summary is derived from structured execution data already stored by previous phases.

The Agent:
- Never performs Git operations
- Never communicates directly with GitHub
- Never pushes commits
- Never creates Pull Requests

---

**Definition of Done:**

Given a successfully validated implementation:

- A production-ready feature branch is created.
- Repository changes are committed with meaningful commit messages.
- The branch is pushed successfully to GitHub.
- A Pull Request is automatically created.
- The Pull Request contains accurate implementation summaries generated from structured execution history.
- Validation results and repair history are attached.
- Branch, commit, and PR metadata are synchronized back into Forge Engine.
- Users can immediately review the generated Pull Request through both GitHub and Forge Engine.

---


### Phase 10B — Cloud Development Workspace (Browser IDE)

**Objective:** Deliver a production-grade browser-based software engineering workspace where users can observe, inspect, collaborate with, interrupt, and guide the autonomous software engineer in real time. The workspace becomes the primary interface for interacting with Forge Engine and serves as a live representation of the execution Workspace rather than the user's local filesystem.

---

**In scope:**

### Browser IDE
- Monaco Editor (VS Code experience)
- Multi-file editing
- File explorer
- Breadcrumb navigation
- Tabs
- Split editor
- Command palette
- Keyboard shortcuts
- Minimap
- Find & Replace
- Go To Definition
- Peek Definition
- Symbol Outline
- Search across repository
- File tree virtualization for large repositories

### Live Workspace Synchronization
- Live synchronization with the Phase 6 Workspace
- Incremental file synchronization
- File create/update/delete events
- Live cursor-safe updates while AI edits files
- Automatic refresh when execution modifies files
- Workspace reconnection after browser refresh
- Automatic workspace recovery after temporary disconnects

### AI Pair Programmer Experience
- Watch AI edit code live
- AI cursor visualization
- Highlight active file being modified
- Highlight active lines being edited
- Show currently executing plan step
- Show AI progress
- Show repository exploration
- Show files currently being read
- Show tools currently being executed
- Show current reasoning stage (high level only)
- Show execution confidence
- Display execution timeline

### Interactive Task Timeline
Timeline includes:
- Planning
- Approval
- Workspace Provisioning
- Repository Analysis
- Code Modification
- Validation
- Repair Attempts
- Git Operations

Each timeline event supports:
- timestamps
- duration
- logs
- affected files
- execution artifacts

### Integrated Terminal
- Interactive terminal
- Live stdout/stderr
- Terminal history
- Multiple terminal sessions (future-ready)
- Command cancellation
- Terminal resize
- ANSI color support

### Validation Workspace
- Build output panel
- Test output panel
- Lint output panel
- Diagnostics panel
- Error navigation
- Warning navigation
- Click-to-file navigation
- Validation history

### Git Experience
- Side-by-side Git diff viewer
- Inline diff viewer
- File change summary
- Added / Modified / Deleted files
- Commit preview
- Pull Request preview

### AI Activity Feed
Live feed showing:
- Reading file
- Searching symbols
- Searching references
- Creating file
- Editing file
- Running command
- Running validation
- Repair attempt
- Waiting for approval
- Finished step

### Human-in-the-Loop Controls
- Pause execution
- Resume execution
- Stop execution
- Approve next step
- Reject current plan
- Request replanning
- Ask AI questions during execution
- Inspect execution reasoning summaries
- Approve repair attempts (future policy driven)

### Repository Intelligence
- Symbol search
- File search
- Global search
- Reference search
- Dependency explorer
- Repository outline
- Recently modified files

### Workspace Sessions
- Session restoration
- Browser reconnect
- Persistent editor state
- Open tab restoration
- Scroll position restoration
- Terminal reconnection

### Observability
- Workspace health
- Sandbox status
- CPU usage
- Memory usage
- Workspace lifetime
- Execution duration
- Streaming latency
- Active task information

---

**Out of scope:**
- Editing the user's local filesystem
- Native VS Code extension
- Multi-user collaborative editing
- Plugin marketplace
- IDE themes and customization
- Mobile IDE
- Local desktop application

---

**Backend (Go):**

Owns the complete Browser Workspace platform.

Responsibilities include:
- Workspace lifecycle management
- Sandbox session management
- Browser workspace provisioning
- Filesystem API
- Terminal API
- File synchronization
- Incremental diff streaming
- WebSocket gateway
- AI event streaming
- Execution timeline streaming
- Diagnostics streaming
- Git diff generation
- Session restoration
- Workspace reconnection
- Browser state synchronization
- Execution permission enforcement
- Human interaction handling
- Workspace cleanup when execution completes

---

**Agent (Python):**

Responsible only for software engineering reasoning.

Responsibilities include:
- Continue autonomous execution
- Produce code modifications
- Produce execution summaries
- Produce structured progress events
- Produce repository exploration events
- Produce validation summaries
- Produce repair summaries

The Agent:
- Never communicates directly with the browser
- Never owns editor state
- Never owns terminal state
- Never owns workspace synchronization
- Never owns WebSocket connections

### Interactive AI Collaboration

The Browser Workspace is not a passive viewer. Users can actively collaborate with the autonomous software engineer while execution is in progress.

Capabilities include:

- Pause execution at any time
- Resume execution from the latest checkpoint
- Cancel execution gracefully
- Send follow-up instructions during execution
- Ask questions about the current implementation
- Request explanations for ongoing code modifications
- Protect specific files or folders from modification
- Mark files as read-only for the current execution
- Request alternative implementation approaches
- Trigger partial replanning for remaining work
- Continue execution without restarting completed work

The execution engine treats user interactions as first-class execution events rather than new tasks, allowing the agent to adapt its remaining work while preserving completed progress.

---

**Definition of Done:**

- Users can open a live browser workspace for any active task.
- The Browser Workspace reflects the live execution Workspace in real time.
- AI code modifications appear immediately inside the editor.
- Repository exploration is visible while the AI works.
- Terminal, build, validation, and repair output stream live.
- Git diffs can be inspected before publishing.
- Users can pause, resume, stop, or guide execution.
- Execution timelines, diagnostics, and AI activity remain synchronized throughout the task.
- Browser sessions automatically reconnect after refresh without losing workspace state.
- The Browser Workspace automatically closes and cleans up when the underlying execution Workspace is destroyed.



--------

### Phase 11 — Production-Grade Real-Time Execution Streaming

**Objective:** Transform the real-time execution streaming introduced throughout Phases 4–10 into a resilient, production-grade event delivery platform capable of supporting long-running autonomous software engineering sessions with guaranteed ordering, replay, reconnection, and multiple concurrent viewers.

The streaming platform becomes the single source of truth for all execution activity occurring inside Forge Engine.

---

**In scope:**

### Durable Event Streaming
- Persist every execution event before broadcasting
- Monotonically increasing sequence numbers
- Ordered event delivery
- Exactly-once replay semantics
- Event integrity guarantees

### Connection Management
- Automatic client reconnection
- Resume streaming from last acknowledged sequence number
- Heartbeat / keep-alive support
- Idle timeout detection
- Graceful connection recovery
- Automatic session restoration

### Multi-Viewer Support
- Multiple browser sessions observing the same execution
- Organization-wide viewers (permission controlled)
- Independent replay state per client
- Efficient event fan-out

### Event Replay
- Replay complete execution history
- Replay from arbitrary sequence number
- Fast-forward to latest state
- Gap detection
- Duplicate event protection

### Streaming Reliability
- Backpressure handling
- Slow-consumer isolation
- Buffered event queues
- Event batching where appropriate
- Non-blocking broadcasting
- Automatic client throttling

### Event Model
Stream structured events including:
- Planning
- Workspace lifecycle
- Repository analysis
- Tool execution
- File modifications
- Validation
- Repair
- Git operations
- Browser workspace updates
- Human interaction events (future-ready)

### Execution Timeline
Provide a complete replayable execution timeline supporting:
- timestamps
- duration
- event metadata
- affected files
- execution summaries
- tool activity
- validation history
- repair history

### Session Recovery
After browser refresh or temporary disconnect:
- Restore workspace state
- Restore timeline
- Restore terminal output
- Restore editor state
- Resume live event streaming

### Streaming Observability
Collect:
- active connections
- reconnect count
- event throughput
- streaming latency
- dropped events
- replay duration
- slow client metrics

---

**Out of scope:**
- New reasoning capabilities
- New agent intelligence
- Execution planning
- Validation logic
- Repair logic
- Browser IDE features
- Human approval policies

This phase focuses exclusively on transport reliability and streaming infrastructure.

---

**Backend (Go):**

Owns the complete execution event platform.

Responsibilities include:
- Persist every execution event before delivery
- Maintain ordered event logs
- Generate sequence numbers
- Manage WebSocket lifecycle
- Handle reconnect and replay
- Manage client acknowledgements
- Detect missing events
- Fan-out events to multiple clients
- Isolate slow consumers
- Apply backpressure strategies
- Batch events when appropriate
- Restore streaming sessions
- Collect streaming metrics
- Guarantee that agent execution is never blocked by client performance

---

**Agent (Python):**

No architectural changes.

Responsibilities include:
- Continue emitting structured execution events
- Continue emitting progress events
- Continue emitting validation events
- Continue emitting repair events
- Continue emitting execution summaries

The Agent remains completely unaware of:
- reconnects
- replay
- WebSockets
- client sessions
- browser state
- event persistence

---

**Definition of Done:**

- Every execution event is durably persisted before being streamed.
- Every event has a globally ordered sequence number within its execution session.
- Users can disconnect and reconnect without losing execution history.
- Replay resumes from the last acknowledged event.
- Multiple users can observe the same execution simultaneously.
- Slow or disconnected clients never reduce agent execution throughput.
- Event delivery remains ordered, reliable, and replayable across the complete execution lifecycle.
- Browser workspaces recover automatically after refresh while maintaining live synchronization with the active execution.

---

### Phase 12 — Human-in-the-Loop Execution Control & Autonomy Policies

**Objective:** Transform Forge Engine from a fully autonomous execution engine into a collaborative software engineering platform where humans can supervise, interrupt, guide, and control the AI at any point during execution through configurable autonomy policies.

This phase introduces the execution control plane for the entire platform.

---

**In scope:**

### Execution Control
- Pause execution
- Resume execution
- Abort execution
- Graceful cancellation
- Force cancellation
- Step-by-step execution mode
- Continue execution after interruption

### Interactive AI Collaboration
- Send follow-up instructions during execution
- Ask questions while the AI is working
- Clarify implementation intent
- Request explanation of current changes
- Redirect implementation strategy
- Trigger partial replanning of remaining work
- Continue execution without restarting completed work

### Checkpoint & Resume
- Automatic execution checkpoints
- Resume from latest checkpoint
- Rollback to previous checkpoint (future-ready)
- Preserve completed execution state
- Restore execution context after interruption

### Manual Code Overrides
- Manual editing inside Browser Workspace
- Protect manually edited regions
- Protect files from further modification
- Protect folders from modification
- Merge AI changes with manual edits
- Prevent AI from overwriting approved user changes

### Review Gates
- Review before execution
- Review after execution
- Review after validation
- Review after repair
- Review before Git commit
- Review before Pull Request creation

### Autonomy Policies
Configurable per:
- Organization
- Repository
- Task
- Execution session

Example policies:
- Fully Manual
- Approval Per Step
- Approval Per Phase
- Approval Before PR
- Fully Autonomous

### Intervention Events
Execution supports live events including:
- Pause
- Resume
- Abort
- Continue
- Replan
- Protect File
- Protect Folder
- Retry Step
- Skip Step
- Inject Instruction
- Request Explanation
- Approve
- Reject

### Execution History
Persist:
- Every interruption
- Every approval
- Every rejection
- Every override
- Every user instruction
- Every policy decision
- Complete audit history

---

**Out of scope:**
- New reasoning capabilities
- New validation capabilities
- New repair capabilities
- New Git functionality

This phase controls existing capabilities rather than introducing new execution features.

---

**Backend (Go):**

Owns the complete execution control plane.

Responsibilities include:
- Evaluate autonomy policies
- Enforce approval gates
- Manage execution state machine
- Pause running execution
- Resume execution
- Abort execution within guaranteed time limits
- Persist execution checkpoints
- Restore execution state
- Persist user overrides
- Persist policy decisions
- Coordinate execution interruptions
- Broadcast execution state changes
- Prevent further tool execution after abort
- Guarantee workspace shutdown after cancellation
- Synchronize Browser Workspace with execution state

The Backend remains the final authority over execution control.

---

**Agent (Python):**

Responsible only for adapting execution.

Responsibilities include:
- Pause reasoning immediately upon interruption
- Persist sufficient reasoning state for later continuation
- Resume reasoning from checkpoints
- Incorporate follow-up user instructions
- Re-evaluate remaining implementation after new guidance
- Respect protected files and protected regions
- Respect manual code modifications
- Never overwrite approved user edits
- Explain execution decisions when requested
- Produce updated execution summaries
- Continue execution from checkpoints instead of restarting

The Agent:
- Never ignores Backend control signals
- Never continues after an Abort event
- Never bypasses autonomy policies
- Never overwrites protected user changes

---

**Definition of Done:**

- Users can pause, resume, abort, and guide execution at any point.
- Follow-up instructions modify only the remaining execution plan.
- Previously completed work is preserved through execution checkpoints.
- Execution resumes from the latest checkpoint without restarting.
- Manual code edits are respected and never silently overwritten.
- Autonomy policies are enforced consistently for every execution session.
- Every interruption, approval, rejection, override, and policy decision is fully audited.
- Abort requests reliably terminate sandbox activity within the configured time limit.
- The Browser Workspace, Backend, Workspace, and Agent remain fully synchronized throughout the execution lifecycle.


---

### Phase 13 — Enterprise Observability, Audit, Cost Intelligence & Analytics

**Objective:** Transform Forge Engine into a fully observable enterprise platform where every execution, reasoning decision, tool invocation, infrastructure action, approval, and dollar spent is completely traceable, auditable, replayable, and attributable.

This phase establishes the operational intelligence layer of Forge Engine.

---

**In scope:**

### Execution Timeline
Provide a complete replayable timeline including:
- Planning
- Repository analysis
- Workspace lifecycle
- Tool execution
- File modifications
- Validation
- Repair
- Git operations
- Pull Request creation
- Human interactions
- Policy evaluations

Every execution becomes replayable from start to finish.

---

### Cost Intelligence

Track cost per:

- Organization
- Repository
- User
- Task
- Workspace
- Execution
- Model
- Planner
- Tool
- Pull Request

Cost breakdown includes:

- Prompt tokens
- Completion tokens
- Embedding tokens
- LLM pricing
- Embedding pricing
- Compute time
- Workspace lifetime
- Build duration
- Test duration
- Storage consumption
- Network usage (future)
- Infrastructure overhead

Provide estimated and actual execution cost.

---

### Complete Audit Trail

Persist every:

- User action
- AI decision
- Tool invocation
- Workspace event
- Approval
- Rejection
- Manual override
- Pause
- Resume
- Abort
- Policy evaluation
- Git operation
- Pull Request creation

Every event is timestamped, correlated, and attributable.

---

### Distributed Tracing

End-to-end trace propagation across:

Frontend

↓

Go Backend

↓

Background Workers

↓

Workspace

↓

Python Agent

↓

LLM Provider

↓

Embedding Provider

↓

GitHub

Every request shares the same Trace ID.

Support:

- Parent spans
- Child spans
- Cross-service latency
- Bottleneck analysis

---

### AI Reasoning Observability

Capture structured reasoning metadata including:

- Planner selected
- Retrieved context size
- Retrieved files
- Model used
- Tool selection
- Execution duration
- Confidence signals
- Retry count
- Repair attempts
- Validation outcomes

Never expose hidden chain-of-thought.

Only structured execution metadata is persisted.

---

### Usage Analytics

Organization dashboards showing:

- Tasks executed
- Success rate
- Failure rate
- Average execution time
- Average repair attempts
- Workspace utilization
- Token consumption
- Cost trends
- Repository activity
- Most active users
- AI productivity metrics

---

### Workspace Analytics

Track:

- Workspace lifetime
- Command count
- Files modified
- Files created
- Files deleted
- Validation executions
- Repair loops
- CPU usage
- Memory usage
- Peak resource utilization

---

### AI Performance Analytics

Track:

- Model latency
- Planner latency
- Retrieval latency
- Tool latency
- Build duration
- Test duration
- Repair success rate
- PR success rate

Compare different models over time.

---

### Replay & Debugging

Support:

- Replay any historical execution
- Replay reasoning events
- Replay workspace lifecycle
- Replay terminal output
- Replay Browser Workspace activity
- Replay AI execution timeline

Enable deterministic debugging of previous executions.

---

### Alerts & Anomaly Detection

Generate alerts for:

- Cost spikes
- Excessive repair loops
- Long-running executions
- Workspace leaks
- Tool failures
- LLM failures
- GitHub failures
- Build failures
- Test failures
- Policy violations
- Quota exhaustion

---

### Quotas & Budget Management

Support configurable limits for:

- Daily token budget
- Monthly spending
- Workspace hours
- Concurrent executions
- LLM usage
- Repository executions
- Organization budgets

Automatic actions:

- Warn
- Pause execution
- Require approval
- Reject execution

---

### Enterprise Reporting

Generate reports including:

- Cost reports
- Usage reports
- Engineering productivity
- AI efficiency
- Repository health
- Execution statistics
- Compliance reports
- Audit exports

---

**Out of scope:**

- New planning capabilities
- New execution capabilities
- New repair capabilities
- New Browser Workspace functionality

This phase exposes, correlates, analyzes, and visualizes data generated by previous phases.

---

**Backend (Go):**

Owns the complete observability platform.

Responsibilities include:

- Cost aggregation
- Trace correlation
- Event aggregation
- Audit persistence
- Metrics collection
- Dashboard APIs
- Usage analytics
- Budget enforcement
- Alert generation
- Report generation
- Replay APIs
- Quota enforcement
- Organization analytics
- Workspace analytics
- Distributed trace management

The Backend becomes the operational control center of Forge Engine.

---

**Agent (Python):**

Responsible only for emitting structured telemetry.

Responsibilities include:

- Report token usage
- Report model usage
- Report execution latency
- Report retrieval statistics
- Report planner metadata
- Report repair metadata
- Report tool usage
- Report reasoning metadata
- Propagate Trace IDs
- Emit structured execution events

The Agent never computes costs or quotas.
It only reports structured telemetry.

---

**Definition of Done:**

- Every execution is fully traceable from frontend to completion.
- Every AI decision, tool invocation, and user action is correlated by Trace ID.
- Every task has a complete cost breakdown.
- Organizations have real-time usage and cost dashboards.
- Historical executions can be replayed for debugging and audits.
- Budgets and quotas are enforced automatically.
- Anomalies trigger proactive alerts before becoming operational or billing issues.
- Enterprise administrators have complete visibility into AI activity, infrastructure utilization, and organizational usage.

---

### Phase 14 — Enterprise Scale, Multi-Tenant Infrastructure & Platform Hardening

**Objective:** Transform Forge Engine from a feature-complete AI engineering platform into a globally scalable, highly available, enterprise-grade SaaS capable of serving thousands of organizations and millions of autonomous engineering tasks simultaneously while guaranteeing fairness, isolation, reliability, and operational stability.

This phase focuses exclusively on platform scalability, resilience, and operational excellence.

---

## In scope

### Multi-Tenant Isolation

Every organization becomes an isolated tenant.

Isolation includes:

- Workspace isolation
- Repository isolation
- Storage isolation
- Event isolation
- Cost isolation
- Queue isolation
- Cache isolation
- Rate limits
- Quotas
- Security boundaries

No tenant can impact another tenant.

---

### Intelligent Job Scheduling

Instead of FIFO scheduling:

Implement priority-aware scheduling.

Support:

- Organization quotas
- Priority queues
- Fair scheduling
- Premium tiers
- Starvation prevention
- Execution preemption (future-ready)

Example:

Enterprise customers never wait behind thousands of free-tier jobs.

---

### Horizontal Scaling

Support independent scaling of:

Frontend

Go Backend

Python Agent

Workspace Executors

Background Workers

WebSocket Gateway

Redis

PostgreSQL

Vector Database

Each service scales independently.

---

### Workspace Pooling

Instead of always creating:

Workspace

↓

Run

↓

Destroy

Support:

- Warm workspace pools
- Image pre-pulling
- Container reuse (policy-controlled)
- Fast provisioning
- Parallel workspace allocation

Cold-start latency drops significantly.

---

### Distributed Event Infrastructure

Scale WebSockets using:

Redis Pub/Sub

↓

Multiple Backend Nodes

↓

Thousands of Browser Clients

Support:

- Sticky sessions
- Distributed event broadcasting
- Event routing
- Load-balanced streaming

---

### Database Scaling

Support:

- Read replicas
- Connection pooling
- Partitioning
- Archiving
- Online migrations
- Query optimization
- Automatic vacuum tuning
- Large execution history management

Partition large tables such as:

- execution_logs
- qa_messages
- code_chunks
- audit_events
- cost_events

---

### Distributed Caching

Introduce:

Redis Cluster

for:

- Sessions
- Rate limiting
- Repository metadata
- Workspace metadata
- Planner cache
- Retrieval cache
- GitHub metadata

---

### AI Provider Resilience

Support:

- Multiple LLM providers
- Automatic failover
- Load balancing
- Rate-limit handling
- Provider health monitoring
- Regional routing
- Cost-aware model routing

Example:

OpenAI rate limited

↓

Automatically switch

↓

Gemini

↓

Continue execution

---

### Workspace Infrastructure

Support:

- Multiple workspace hosts
- Distributed workspace scheduling
- Workspace health monitoring
- Automatic cleanup
- Failed workspace recovery
- Resource balancing

Future-ready for:

Docker

↓

Firecracker

↓

Kubernetes

↓

Cloud VMs

without changing higher layers.

---

### High Availability

Support:

- Backend failover
- Agent failover
- Redis failover
- Database failover
- Workspace recovery

Long-running executions survive infrastructure failures whenever possible.

---

### Load Testing

Validate:

- Thousands of concurrent workspaces
- Thousands of active WebSockets
- Thousands of GitHub API requests
- Thousands of LLM requests
- Large repository indexing
- Long-running executions

Measure:

- Latency
- Throughput
- Recovery time
- Failure rates

---

### Operations Dashboard

Provide infrastructure visibility for operators:

- Active workspaces
- Queue depth
- Agent utilization
- CPU
- Memory
- Token throughput
- Active organizations
- Build success rate
- Test success rate
- Event throughput
- Cost per hour

---

## Out of scope

- New planning capabilities
- New coding capabilities
- New Browser Workspace functionality
- New Git features

This phase focuses exclusively on platform scalability, reliability, and operational maturity.

---

## Backend (Go)

Owns platform orchestration.

Responsibilities include:

- Fair job scheduling
- Workspace scheduling
- Tenant isolation
- Distributed event routing
- Horizontal scaling
- Queue management
- Distributed locking
- Cache coordination
- Database optimization
- Infrastructure monitoring
- Rate limiting
- Quota enforcement
- High availability

---

## Agent (Python)

Responsible for scalable reasoning infrastructure.

Responsibilities include:

- Horizontal scaling
- Worker auto-registration
- Distributed task execution
- Provider failover
- Model routing
- Rate-limit handling
- Retry policies
- Health reporting

The Agent remains stateless and horizontally scalable.

---

## Definition of Done

- Thousands of organizations can execute tasks simultaneously.
- Resource allocation remains fair across tenants.
- Infrastructure components scale independently.
- Long-running executions remain reliable during node failures.
- Workspace provisioning remains fast under heavy load.
- WebSocket streaming supports thousands of concurrent clients.
- Database performance remains stable for very large execution histories.
- AI provider outages are handled gracefully through automatic failover.
- No single tenant can degrade another tenant's performance.
- Forge Engine operates as a production-grade, enterprise SaaS platform.
---

## 8. Conventions

- **Inter-service communication:** `[DECIDE: REST or gRPC between Go and
  Python — pick one in Phase 0, record in /docs/adr, don't mix both]`
- **API versioning:** all internal Go↔Python endpoints versioned from day one
  (e.g. `/v1/agent/...`).
- **Error handling:** `[DECIDE: e.g. Go returns wrapped errors with context;
  Python uses typed exceptions mapped to structured JSON at the FastAPI
  boundary. Every cross-service error must be structured JSON, never a bare
  string.]`
- **Logging:** structured JSON logs in both services, every line carries a
  trace ID propagated across the Go↔Python call.
- **Database migrations:** `[DECIDE: e.g. golang-migrate, forward-only, no
  manual schema edits.]`
- **Naming:** `[DECIDE: e.g. snake_case for DB columns/JSON payloads, consistent
  across both services so no translation layer is needed.]`

Fill in the bracketed items during Phase 0 — they should not still say
`[DECIDE]` once Phase 0 is marked done.

---

## 9. How to behave when given a task in this repo

1. Check the ACTIVE PHASE marker (Section 6) before writing any code.
2. If the requested task matches the active phase's scope — proceed.
3. If it belongs to a different phase, say so explicitly and ask for
   confirmation before proceeding — don't assume the human meant to skip ahead.
4. Build the smallest correct slice of the active phase's deliverables first,
   not all of them in one giant pass.
5. Never violate Section 2 (the execution boundary) for convenience, speed, or
   because it would make the current task easier.
6. When you believe the active phase's Definition of Done is met, say so
   explicitly and stop — don't continue into the next phase on momentum.
