# ADR 0004: Clone Ownership and Phase 3 Ingestion Contract

**Status:** ACCEPTED  
**Date:** 2026-06-27

---

## Context

Phase 3 requires cloning connected repositories, parsing their contents, generating
embeddings, and storing a queryable index. Two services are involved: the Backend
(Go) and the Agent (Python). A clear, binding boundary must be established between
them before implementation begins, consistent with the Section 2 rule in
`Requirement.md`: the Agent never directly touches a user's filesystem, shell, or
git remote.

---

## Decisions

### 1. Go owns the clone. The Agent never calls git.

The Backend (Go) is solely responsible for:
- Authenticating with GitHub via an installation token
- Invoking `git clone` via `os/exec` with a credential helper
- Managing the ephemeral clone directory lifecycle (create, pass, clean up)
- Retry logic and timeout enforcement around the clone step
- Deleting the clone directory after the Agent responds, whether success or failure

The Agent (Python) is solely responsible for:
- Reading files from the path Go provides (read-only; no writes)
- AST parsing, chunking, embedding generation
- Writing parsed chunks and embeddings into `code_chunks` via pgvector
- Reporting incremental progress back to Go

The Agent must never call `git`, `subprocess.run()`, `os.system()`, or any shell
command. It must never write to the filesystem outside of the database. This
boundary is permanent and is not a Phase 3 constraint — it is the security model
for all future phases.

### 2. Progress flows Agent → Go only. Go owns frontend updates.

The Agent's `POST /v1/agent/ingest` endpoint returns a **streaming chunked HTTP
response** using newline-delimited JSON (NDJSON). Each line is a progress event:

```json
{"event": "progress", "stage": "parsing", "processed": 12, "total": 80}
{"event": "progress", "stage": "embedding", "processed": 40, "total": 80}
{"event": "done", "total_chunks": 80}
{"event": "error", "message": "..."}
```

Go reads this stream line-by-line in the worker goroutine, updates
`ingestion_jobs.processed_chunks`, `ingestion_jobs.total_chunks`, and
`ingestion_jobs.progress_stage` in the database as events arrive, and fans that
state out to any WebSocket subscribers via the existing job status endpoint.

The frontend never communicates with or even knows the Agent exists. All
progress and status is served from the Backend.

### 3. Supersede logic: worker checks status before clone and after clone only.

When a new push arrives for a repo while a job is already queued or running, Go
marks all older `queued` or `running` jobs for that `repo_id` as `superseded`
and enqueues a new job for the latest commit SHA.

The worker checks `job.status` at exactly two points:
1. **Before cloning** — if `superseded`, log and discard immediately.
2. **After cloning, before calling the Agent** — if `superseded`, clean up the
   clone directory and discard.

The worker does **not** interrupt a job that has entered the embedding stage.
Stopping mid-embedding leaves partial state that is harder to reason about.
An older completed index is harmless — retrieval always gates on the latest
`done` job.

### 4. Retrieval gates on job status.

Chunks are written incrementally to `code_chunks` as the Agent progresses.
However, no retrieval query (Phase 4+) may read from `code_chunks` for a job
unless `ingestion_jobs.status = 'done'`. This prevents partially indexed
repositories from ever becoming queryable.

### 5. Worker/Agent boundary rule.

The **worker (Go)** owns:
- Redis queue lifecycle (BLPOP, ACK, retry)
- Timeout enforcement on the full ingest call
- Clone directory creation and cleanup
- All `ingestion_jobs` status transitions
- WebSocket/SSE fan-out to the frontend

The **Agent (Python)** owns:
- Parsing file content using tree-sitter (or line-based fallback)
- Chunking parsed symbols to fit within the token budget
- Calling the embedding API via the provider abstraction
- Writing `code_chunks` rows to the database
- Emitting NDJSON progress events on its HTTP response

Neither side crosses these boundaries.

### 6. Snapshot model: (repo_id, commit_sha) as the logical snapshot key.

Every successful ingestion is treated conceptually as an immutable snapshot of
the repository. The `(repo_id, commit_sha)` pair in both `ingestion_jobs` and
`code_chunks` is the snapshot key.

A `repository_snapshots` table is deliberately deferred. If Phase 4 retrieval
performance requires it, a lightweight `repo_index_heads` table (one row per
repo pointing at the current live `commit_sha`) will be introduced as a targeted
optimisation. The data model does not need to change to support this.

The schema deliberately avoids introducing `symbol` as a first-class entity in
Phase 3. Future phases may introduce a `symbols` table sitting between `repo`
and `chunks` in the hierarchy. The current schema does not block this — a
`symbol_id` foreign key column can be added to `code_chunks` in a later
migration without touching Phase 3 data.

### 7. Embedding model stored per chunk.

The embedding column is `vector(1536)`, matching `text-embedding-3-small`.
The `embedding_model` column stores the model name used for each chunk. If a
future model uses a different dimension, a re-index migration will be required
regardless (pgvector column type must match). The `embedding_model` column
makes it possible to identify which chunks need re-embedding when models change.

Embeddings are nullable at insert time — a chunk can be written before its
embedding is generated. This means a partial outage during the embedding step
does not lose parsed content. Re-embedding is a query of `WHERE embedding IS NULL`.

---

## Consequences

- The Agent is a pure compute service for Phase 3: it receives a path, reads
  files, writes to the database, streams progress. No filesystem side effects.
- All operational concerns (retry, timeout, cleanup, queue) stay in Go.
- The streaming NDJSON contract between Go and the Agent is the only new
  internal API surface introduced in Phase 3.
- The schema is forward-compatible with a `symbols` table and a
  `repo_index_heads` table without requiring data migrations.

---

## References

- `Requirement.md` Section 2 — the execution boundary rule
- ADR 0001 — inter-service communication (REST + JWT)
- ADR 0003 — defer LangGraph (PGVector and Redis worker confirmed for Phase 3)
