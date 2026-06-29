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

> ### 🔵 ACTIVE PHASE: **Phase 4 — Retrieval & Q&A**
>
> Only work within this phase's scope (see Phase 4 below) until the human moves
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

### ✅ Phase 3 — Repository Ingestion & Indexing
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

**Objective:** Isolated, ephemeral, resource-bounded environment for code
execution — built and proven before any agent acts inside it.

**In scope:** per-task ephemeral container provisioning (Docker to start),
resource limits (CPU/mem/disk/network egress default-deny), filesystem
boundary, command execution API (stdout/stderr/exit code, enforced timeouts),
lifecycle tied to task state, orphan sandbox reaper job.

**Out of scope:** any AI/agent reasoning. This phase is pure infra and must work
fully without any LLM involved.

**Backend (Go):** owns this entire phase — provisioning, lifecycle, quota
enforcement, network policy, the tool-execution API, hard timeouts/kill
switches, full audit logging of every command run.

**Agent (Python):** zero direct execution capability — only ever sends
`ToolCallRequest` and receives `ToolCallResult` per the Section 2 contract.

**Definition of Done:** Backend provisions an isolated sandbox with a real repo
checked out, executes arbitrary commands with enforced limits, captures output,
tears down reliably — fully testable with zero AI involvement.

---

### Phase 7 — Code Modification Execution

**Objective:** Agent executes an approved plan, step by step, inside the
sandbox, with live-visible diffs.

**In scope:** code-editing agent loop (read → reason → write via tool calls),
diff generation/display, step-by-step execution tracking, explicit surfacing of
plan deviations (not silent improvisation).

**Out of scope:** running builds/tests (Phase 8), auto-repair (Phase 9), commits/PRs (Phase 10).

**Backend (Go):** orchestrates execution job, relays tool-call requests to the
Phase 6 sandbox, persists diffs as structured artifacts, streams every event
over WebSocket, advances task state machine.

**Agent (Python):** per-plan-step reasoning loop, issues read/write tool calls,
explains reasoning per step, detects and reports plan deviations explicitly.

**Definition of Done:** Given an approved plan, the agent executes each step in
the sandbox, produces real inspectable diffs, streams progress live, and
surfaces deviations rather than silently going off-script.

---

### Phase 8 — Build & Test Execution

**Objective:** Automatically run the project's real build/test tooling after
code changes and structure the results.

**In scope:** build-tool detection for a known, explicit set of stacks, test/build
execution via the Phase 6 sandbox, structured result parsing (pass/fail, error
locations), baseline-before-changes check to avoid blaming pre-existing flakiness.

**Out of scope:** auto-repair (Phase 9) — this phase only runs and reports, it
does not fix anything.

**Backend (Go):** orchestrates the validation step, stores raw + parsed
results, decides which commands constitute "build"/"test" for a given project
(config-driven).

**Agent (Python):** parses raw stdout/stderr into structured failure data for a
defined initial set of test frameworks, classifies failures as
simple/fixable vs. not (input to Phase 9, decision enforced in Phase 9 by Backend).

**Definition of Done:** After code modification, the platform runs the right
build/test commands for supported stacks, structures pass/fail/error data
accurately, and surfaces it clearly.

---

### Phase 9 — Self-Repair Loop

**Objective:** Bounded automatic fixing of simple validation failures before
escalating to the user.

**In scope:** repair loop with a hard iteration cap and cost/time budget,
failure-category gate (only "safe to auto-fix" categories attempted), re-runs
Phase 7→8 in a tight loop, clean escalation when budget is exhausted.

**Out of scope:** ever modifying test expectations to force a pass — the agent
fixes implementation, not the test, unless explicitly instructed otherwise.

**Backend (Go):** **enforces hard limits server-side** (max attempts, max time,
max cost) — this is not optional and must not depend on the agent's own
self-discipline. Manages state transitions, persists full attempt history.

**Agent (Python):** classifies failures, generates targeted fixes scoped
narrowly to the failing area, can self-terminate early if it judges something
unfixable — but Backend's hard cap is the real safety net regardless.

**Definition of Done:** Given a simple validation failure, the agent attempts
bounded, fully logged repair cycles, succeeds or cleanly exhausts its budget, and
never silently weakens a test to fake a pass.

---

### Phase 10 — Git Operations: Commit & Pull Request

**Objective:** Turn validated agent changes into a real branch, commit(s), and PR on GitHub.

**In scope:** branch creation with collision handling, commit creation with
meaningful messages, PR creation with a generated description (plan summary +
changes + validation + repair history), PR status sync back from GitHub.

**Out of scope:** anything not directly about producing the git artifacts.

**Backend (Go):** all actual GitHub API calls via Phase 2's installation token,
assembles the PR description from already-structured data, handles git-level
conflicts (base branch moved — decide rebase vs. fail-and-ask).

**Agent (Python):** optionally assists in generating human-readable prose for
commit/PR descriptions from known structured facts — summarization only, not
free invention.

**Definition of Done:** A completed task results in a real branch + commit(s) +
PR with an accurate description, visible and linked in the platform.

---

### Phase 11 — Real-Time Execution Streaming (Hardening)

**Objective:** Harden the live-streaming experience built incrementally in
Phases 4–10 into something production-grade.

**In scope:** event log persistence (every WS event durably stored), reconnect
with replay-from-sequence-number, multi-viewer support, backpressure handling
so a slow client never stalls the agent.

**Out of scope:** no new agent intelligence — this is transport hardening only.

**Backend (Go):** event log persistence, connection management hardening,
backpressure/slow-consumer handling, fan-out efficiency.

**Agent (Python):** no change — already emits structured progress from prior phases.

**Definition of Done:** A user can disconnect mid-task and reconnect to a
complete, gap-free history plus live continuation; slow clients don't affect
agent execution speed.

---

### Phase 12 — Human Review & Control Gates

**Objective:** Unify all approval/intervention points: pause, resume, abort,
override, configurable autonomy levels.

**In scope:** unified task control model, configurable autonomy per org/task,
pre-PR diff review step, manual diff override capability.

**Out of scope:** new execution capabilities — this phase only adds control over
existing ones.

**Backend (Go):** enforces control state transitions atomically (abort must
actually stop sandbox execution within seconds, not just flip a DB flag),
autonomy policy evaluation at each gate, persists manual overrides as new source
of truth.

**Agent (Python):** supports being paused/interrupted mid-reasoning with enough
checkpointed state to resume; respects override signals — never silently
re-overwrites a user's manual edit on the next loop iteration.

**Definition of Done:** User can pause/resume/abort/override at any point, with
*tested*, guaranteed cessation of sandbox activity on abort, and autonomy
settings respected consistently by both sides.

---

### Phase 13 — Observability, Audit, and Cost Tracking

**Objective:** Make every decision, tool call, and dollar spent traceable and attributable.

**In scope:** per-task cost ledger (tokens × pricing + compute time), full "show
your work" trace view from existing event/tool-execution data, distributed
tracing across the Go↔Python boundary, anomaly alerting.

**Out of scope:** new agent behaviors — this phase consolidates and surfaces
data other phases already generate.

**Backend (Go):** cost aggregation pipeline, trace correlation (consuming trace
IDs propagated since Phase 0), quota enforcement tied to Phase 1.

**Agent (Python):** reports token usage/latency/model used on every LLM call in
a structured format; emits structured reasoning traces, not just final outputs.

**Definition of Done:** Full cost breakdown and step-by-step trace retrievable
per task; org admins have a real-time usage dashboard; anomalies trigger alerts
before they become billing surprises.

---

### Phase 14 — Multi-Tenant Scale & Concurrency Hardening

**Objective:** Correct, performant behavior under real concurrent multi-tenant load.

**In scope:** fair job-queue scheduling across orgs, horizontal scaling of both
services, sandbox pool management, DB partitioning for high-volume tables, load
testing.

**Out of scope:** new product features — this is a hardening pass across the
whole system, done once real usage patterns are known.

**Backend (Go):** fair queuing/scheduling, WebSocket hub horizontal scaling
(Redis-backed pub/sub), DB partitioning/archival strategy.

**Agent (Python):** horizontal FastAPI scaling, LLM provider rate-limit/backpressure handling.

**Definition of Done:** Platform sustains realistic concurrent multi-tenant load
with fair resource allocation and no tenant able to degrade another's experience.

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
