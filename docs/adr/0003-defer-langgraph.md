# ADR 0003 — Defer LangGraph adoption for Phase 3

Status: Accepted
Date: 2026-06-26
Authors: Team

## Context
Phase 3 focuses on repository ingestion & indexing (clone → parse → chunk → embed). The repository rules require any new framework choice to be recorded via an ADR before adoption.

LangGraph (and similar frameworks) provide higher-level LLM/agent orchestration primitives useful for multi-step workflows, planning, and long-running agent pipelines. Introducing LangGraph now would add a new framework dependency and design surface prior to completing Phase 2 hardening and basic Phase 3 infrastructure.

## Decision
Defer adoption of LangGraph (or similar orchestration libraries) until after Phase 3’s core ingestion work is proven and there is a clear, recorded need in Phase 4/5.

Implement Phase 3 using the existing, agreed stack:
- Backend: Go + Fiber — job orchestration, cloning, read-only checkout management
- Agent: Python + FastAPI — parsing and embedding work only; communicates via the Backend’s tool contract (no direct filesystem/git)
- Queue: Redis + simple worker model (no new queue framework)
- Vector store: PGVector (Postgres extension) by default
- Embedding/LLM adapters: provider-abstraction layer (OpenAI/Anthropic)

## Rationale
- Minimizes early coupling to a heavy orchestration framework and keeps the stack simple.
- Phase 3 requirements (cloning, parsing, embeddings, vector storage, job lifecycle) are achievable with the current stack and small adapters.
- Adding LangGraph later (Phase 4/5) is lower risk: by then the job contract, sandbox/clone ownership decision, and integration patterns will be stable, easing migration.

## Consequences
- Short-term: faster, lower-risk Phase 3 implementation using existing components and fewer external dependencies.
- Long-term: if/when complex agent orchestration is needed (planning, multi-tool flows, advanced retries), we will revisit and create an ADR proposing LangGraph (or an alternative), including migration steps and cost/benefit analysis.
- Operational: ensure the provider-abstraction for LLMs/embeddings is sufficient to integrate with LangGraph later if chosen.

## Next steps
1. Proceed with Phase 3 scaffolding using the chosen defaults (PGVector, Redis, Go worker).
2. If agent orchestration needs arise during Phase 3, create a follow-up ADR proposing LangGraph with concrete use-cases and a migration plan.
3. Record any changes to this decision by adding a new ADR and linking back to this file.

Suggested commit message:
- `docs(adr): add ADR 0003 deferring LangGraph adoption (Phase 3)`