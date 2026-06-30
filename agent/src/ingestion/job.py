"""
Ingestion job orchestrator.

Receives a clone path from the Go backend and drives:
  parse → chunk → embed → persist

Yields NDJSON progress events that the Go worker reads from the
streaming HTTP response. The Go worker is solely responsible for
all ingestion_jobs status transitions — this module only reports
progress via yielded events.

ADR 0004 boundary:
  - Never calls git or any shell command.
  - Never writes to the filesystem.
  - Only reads files from the Go-provided clone_path.
  - Only writes to the database (via vector_store).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Generator, Iterator

from src.config import settings
from src.ingestion import chunker, embedder, vector_store
from src.ingestion.parser.base import ParsedChunk, Parser
from src.ingestion.parser.generic import GenericParser
from src.ingestion.parser.javascript_parser import JavaScriptParser
from src.ingestion.parser.python_parser import PythonParser

import json
import structlog

logger = structlog.get_logger()

# Files and directories to skip entirely.
_SKIP_DIRS = {
    ".git", ".hg", ".svn",
    "node_modules", "__pycache__", ".venv", "venv", "env",
    ".tox", "dist", "build", "target", ".cache",
    ".idea", ".vscode",
}
_SKIP_EXTENSIONS = {
    # Binaries
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".a", ".o",
    ".pyc", ".pyo", ".class",
    # Lock files and generated code
    ".lock", ".sum",
    # Large data
    ".csv", ".parquet", ".avro",
}
_MAX_FILE_BYTES = 512 * 1024  # 512 KB — skip unusually large files


def _build_parser_registry() -> dict[str, Parser]:
    """Map file extension → parser instance."""
    registry: dict[str, Parser] = {}
    for p in [PythonParser(), JavaScriptParser()]:
        for ext in p.supported_extensions:
            registry[ext] = p
    return registry


_PARSERS = _build_parser_registry()
_FALLBACK_PARSER = GenericParser()


def _collect_files(clone_path: str) -> list[str]:
    """
    Walk the clone directory and return relative paths of all files
    that should be indexed. Skips binary files, lock files, and
    directories that are never useful to index.
    """
    root = Path(clone_path)
    files: list[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune skip directories in-place so os.walk won't descend into them.
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]

        for filename in filenames:
            ext = Path(filename).suffix.lower()
            if ext in _SKIP_EXTENSIONS:
                continue
            abs_path = Path(dirpath) / filename
            if abs_path.stat().st_size > _MAX_FILE_BYTES:
                continue
            rel_path = str(abs_path.relative_to(root))
            files.append(rel_path)

    return sorted(files)


def _parse_file(abs_path: str, rel_path: str) -> list[ParsedChunk]:
    """Read and parse a single file. Never raises."""
    try:
        source = Path(abs_path).read_text(encoding="utf-8", errors="replace")
        # Remove NUL characters which cause PostgreSQL errors
        source = source.replace("\x00", "")
    except Exception:
        return []

    ext = Path(rel_path).suffix.lower()
    parser = _PARSERS.get(ext, _FALLBACK_PARSER)

    try:
        return parser.parse(rel_path, source)
    except Exception:
        # If the parser raises unexpectedly, fall back to generic.
        return _FALLBACK_PARSER.parse(rel_path, source)


def run_ingestion(
    job_id: str,
    repo_id: str,
    commit_sha: str,
    clone_path: str,
) -> Generator[str, None, None]:
    """
    Run the full ingestion pipeline for one job.

    Yields newline-terminated NDJSON strings (progress events) that the
    Go worker reads from the streaming HTTP response body.

    Event schema:
      {"event": "progress", "stage": "<stage>", "processed": N, "total": N}
      {"event": "done", "total_chunks": N}
      {"event": "error", "message": "<msg>"}

    This generator never raises — all errors are caught and yielded as
    error events, then the generator returns.
    """
    log = logger.bind(job_id=job_id, repo_id=repo_id, commit_sha=commit_sha)

    def emit(obj: dict) -> str:
        return json.dumps(obj) + "\n"

    try:
        # ── 1. Collect files ──────────────────────────────────────────────────
        yield emit({"event": "progress", "stage": "parsing", "processed": 0, "total": 0})

        files = _collect_files(clone_path)
        total_files = len(files)
        log.info("ingestion_files_collected", count=total_files)

        # ── 2. Parse + chunk ──────────────────────────────────────────────────
        all_chunks: list[ParsedChunk] = []

        for i, rel_path in enumerate(files):
            abs_path = os.path.join(clone_path, rel_path)
            raw_chunks = _parse_file(abs_path, rel_path)
            processed = chunker.process_chunks(raw_chunks)
            all_chunks.extend(processed)

            if (i + 1) % 20 == 0 or (i + 1) == total_files:
                yield emit({
                    "event": "progress",
                    "stage": "parsing",
                    "processed": i + 1,
                    "total": total_files,
                })

        total_chunks = len(all_chunks)
        log.info("ingestion_chunks_parsed", count=total_chunks)
        yield emit({
            "event": "progress",
            "stage": "chunking",
            "processed": total_chunks,
            "total": total_chunks,
        })

        if total_chunks == 0:
            yield emit({"event": "done", "total_chunks": 0})
            return

        # ── 3. Embed + persist in batches ─────────────────────────────────────
        batch_size = settings.embedding_batch_size
        persisted = 0

        log.info(
            "embedding_stage_start",
            total_chunks=total_chunks,
            batch_size=batch_size,
            total_batches=(total_chunks + batch_size - 1) // batch_size,
            provider=settings.embedding_provider,
            model=settings.embedding_model,
        )

        for batch_start in range(0, total_chunks, batch_size):
            batch = all_chunks[batch_start : batch_start + batch_size]
            texts = [c.content for c in batch]
            batch_num = batch_start // batch_size + 1

            log.info(
                "embedding_batch_start",
                batch_num=batch_num,
                batch_size=len(batch),
                batch_start=batch_start,
            )

            try:
                vectors = embedder.embed_batch(texts)
                log.info(
                    "embedding_batch_success",
                    batch_num=batch_num,
                    vectors_returned=len(vectors),
                    dims=len(vectors[0]) if vectors else 0,
                )
            except Exception as exc:
                # Log the full error so it's visible in agent logs, then
                # fail the job immediately — writing 1137 NULL embeddings
                # is worse than failing fast and retrying.
                log.error(
                    "embedding_batch_failed",
                    batch_num=batch_num,
                    batch_start=batch_start,
                    error=str(exc),
                    error_type=type(exc).__name__,
                )
                yield emit({
                    "event": "error",
                    "message": (
                        f"Embedding failed at batch {batch_num} "
                        f"(chunks {batch_start}–{batch_start + len(batch)}): "
                        f"{type(exc).__name__}: {exc}"
                    ),
                })
                return

            # Persist this batch immediately (incremental writes per ADR 0004).
            try:
                written = vector_store.write_chunks(
                    batch, vectors, repo_id, job_id, commit_sha
                )
                persisted += written
            except Exception as exc:
                log.error(
                    "persist_batch_failed",
                    batch_num=batch_num,
                    error=str(exc),
                    error_type=type(exc).__name__,
                )
                yield emit({"event": "error", "message": f"persist failed at batch {batch_num}: {exc}"})
                return

            yield emit({
                "event": "progress",
                "stage": "embedding",
                "processed": min(batch_start + batch_size, total_chunks),
                "total": total_chunks,
            })

        log.info("ingestion_complete", total_chunks=persisted)
        yield emit({"event": "done", "total_chunks": persisted})

    except Exception as exc:
        log.error("ingestion_unexpected_error", error=str(exc))
        yield emit({"event": "error", "message": str(exc)})
