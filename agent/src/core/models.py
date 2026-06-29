"""
Shared domain models for Phase 4 retrieval and Q&A.

These dataclasses are the boundary types between the pipeline stages.
Nothing outside src/core/ should define its own chunk or citation types.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RetrievedChunk:
    """A single chunk returned by the retrieval layer.

    source_type is "chunk" in Phase 4. Future phases that introduce
    first-class symbols or modules set source_type = "symbol" or "module"
    without changing any other field.
    """
    id: str
    repo_id: str
    commit_sha: str
    file_path: str
    start_line: int
    end_line: int
    content: str
    language: str | None = None
    chunk_type: str | None = None
    symbol_name: str | None = None     # 'name' column in code_chunks
    token_count: int | None = None
    source_type: str = "chunk"         # extension point for symbols/modules
    score: float = 0.0                 # final score after re-ranking


@dataclass
class RetrievalScope:
    """Defines the set of indexed snapshots to search.

    Phase 4: always a single repository snapshot (repo_ids has one element,
    commit_shas has one entry). Future multi-repo search passes multiple
    entries without changing the CandidateGenerator interface.

    Note: this is a runtime-only construct — it is never stored in the DB.
    The qa_sessions table stores plain repo_id + commit_sha columns.
    """
    org_id: str
    repo_ids: list[str]
    commit_shas: dict[str, str]        # repo_id → commit_sha

    @classmethod
    def single(cls, org_id: str, repo_id: str, commit_sha: str) -> "RetrievalScope":
        """Convenience constructor for the common Phase 4 single-repo case."""
        return cls(org_id=org_id, repo_ids=[repo_id], commit_shas={repo_id: commit_sha})


@dataclass
class RetrievalResult:
    """Rich result from RetrievalEngine.retrieve().

    Carries the chunks plus diagnostics used for observability logging.
    All fields after 'chunks' are metadata — the pipeline only uses 'chunks'.
    """
    chunks: list[RetrievedChunk]
    strategy: str                      # "vector" | "hybrid" | "symbol_graph"
    timing_ms: int                     # wall time for the full retrieval call
    candidate_count: int               # chunks after vector search, before filter
    filtered_count: int                # chunks after metadata filter
    reranked_count: int                # chunks after diversity selection
    final_count: int                   # chunks sent to context assembler


@dataclass
class Citation:
    """A source reference included in an assistant answer.

    Designed to be self-contained: the frontend can construct a GitHub blob URL
    from these fields without any additional API calls.
    """
    chunk_id: str
    commit_sha: str
    file_path: str
    start_line: int
    end_line: int
    language: str | None = None
    chunk_type: str | None = None
    symbol_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "commit_sha": self.commit_sha,
            "file_path": self.file_path,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "language": self.language,
            "chunk_type": self.chunk_type,
            "symbol_name": self.symbol_name,
        }


@dataclass
class AssembledContext:
    """Output of ContextAssembler.assemble().

    chunks is the ordered final set sent to the prompt.
    citations is derived from chunks and ready for inclusion in the done event.
    total_tokens is the sum of chunk token_counts (estimated if token_count is None).
    """
    chunks: list[RetrievedChunk]
    citations: list[Citation]
    total_tokens: int


@dataclass
class StreamDonePayload:
    """Capability-specific payload in the 'done' NDJSON event.

    Keeping payload as an opaque dict in LLMStreamer means the streamer is
    reusable for planning, code-gen, and other capabilities without changes.
    Q&A sets payload = {"citations": [...]}.
    """
    citations: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"citations": self.citations}
