"""
ContextAssembler: Protocol + LinearContextAssembler.

Takes the diversity-selected chunk set and builds the final context window:
  1. Estimates token usage per chunk (uses token_count if available, otherwise
     estimates at ~4 chars per token).
  2. Applies physical adjacency expansion: if a chunk's immediate neighbour
     (same file, consecutive lines) is present in the selected set, they are
     merged into one block to preserve code flow.
  3. Trims to the token budget.
  4. Derives the Citation list from the selected chunks.

Protocol is kept minimal (one method) so future assemblers (e.g.
GraphContextAssembler for symbol-graph expansion in Phase 5+) are drop-in
replacements without touching the pipeline.
"""
from __future__ import annotations

import math
from typing import Protocol, runtime_checkable

import structlog
import tiktoken

from src.core.models import AssembledContext, Citation, RetrievedChunk

logger = structlog.get_logger()

# Tokeniser used for budget tracking — same as Phase 3 chunker.
_ENC = tiktoken.get_encoding("cl100k_base")

# Gap tolerance for physical adjacency expansion: if the next chunk starts
# within this many lines of the current chunk's end_line, treat as adjacent.
_ADJACENCY_GAP = 2


@runtime_checkable
class ContextAssembler(Protocol):
    def assemble(
        self,
        chunks: list[RetrievedChunk],
        budget: int,
    ) -> AssembledContext:
        """Select and pack chunks into the context window.

        budget is the maximum number of tokens available for code context
        (excludes prompt template and conversation history).
        Returns the assembled context and its citations.
        """
        ...


def _token_count(text: str) -> int:
    """Count tokens using tiktoken. Falls back to len(text)//4 on error."""
    try:
        return len(_ENC.encode(text))
    except Exception:
        return max(1, len(text) // 4)


def _chunk_tokens(chunk: RetrievedChunk) -> int:
    if chunk.token_count and chunk.token_count > 0:
        return chunk.token_count
    return _token_count(chunk.content)


class LinearContextAssembler:
    """Greedy linear assembler with physical adjacency expansion.

    Selection order: chunks are taken in their current order (highest score
    first from DiversitySelector). Adjacent chunks from the same file are
    merged into a single block before counting tokens, which preserves
    code context without inflating the slot count.
    """

    def assemble(
        self,
        chunks: list[RetrievedChunk],
        budget: int,
    ) -> AssembledContext:
        merged = self._merge_adjacent(chunks)
        selected: list[RetrievedChunk] = []
        total_tokens = 0

        for chunk in merged:
            tokens = _chunk_tokens(chunk)
            if total_tokens + tokens > budget:
                continue  # skip (don't break — a smaller later chunk might fit)
            selected.append(chunk)
            total_tokens += tokens

        citations = [
            Citation(
                chunk_id=c.id,
                commit_sha=c.commit_sha,
                file_path=c.file_path,
                start_line=c.start_line,
                end_line=c.end_line,
                language=c.language,
                chunk_type=c.chunk_type,
                symbol_name=c.symbol_name,
            )
            for c in selected
        ]

        logger.info(
            "context_assembler",
            input_chunks=len(chunks),
            merged_chunks=len(merged),
            selected_chunks=len(selected),
            total_tokens=total_tokens,
            budget=budget,
        )

        return AssembledContext(
            chunks=selected,
            citations=citations,
            total_tokens=total_tokens,
        )

    def _merge_adjacent(
        self,
        chunks: list[RetrievedChunk],
    ) -> list[RetrievedChunk]:
        """Merge physically adjacent chunks from the same file.

        Two chunks are adjacent if they share the same file_path and the
        second chunk's start_line <= first chunk's end_line + ADJACENCY_GAP.
        Merged chunks inherit the score of the higher-scored original.
        """
        if not chunks:
            return []

        # Group by file for adjacency checking.
        by_file: dict[str, list[RetrievedChunk]] = {}
        for chunk in chunks:
            by_file.setdefault(chunk.file_path, []).append(chunk)

        # Sort each file's chunks by start_line.
        for lst in by_file.values():
            lst.sort(key=lambda c: c.start_line)

        # Preserve the original selection order (score order) but replace
        # adjacently-mergeable pairs with their merged form.
        merged_map: dict[str, RetrievedChunk] = {}  # chunk.id → merged chunk
        for file_chunks in by_file.values():
            self._merge_file_chunks(file_chunks, merged_map)

        # Re-emit in original order, skipping IDs that were absorbed.
        seen_merged_ids: set[str] = set()
        result: list[RetrievedChunk] = []
        for chunk in chunks:
            merged = merged_map.get(chunk.id, chunk)
            if id(merged) not in seen_merged_ids:
                seen_merged_ids.add(id(merged))
                result.append(merged)
        return result

    def _merge_file_chunks(
        self,
        file_chunks: list[RetrievedChunk],   # sorted by start_line
        merged_map: dict[str, RetrievedChunk],
    ) -> None:
        """Merge adjacent chunks within a single file in-place in merged_map."""
        import dataclasses

        i = 0
        while i < len(file_chunks):
            current = file_chunks[i]
            j = i + 1
            while j < len(file_chunks):
                nxt = file_chunks[j]
                if nxt.start_line <= current.end_line + _ADJACENCY_GAP:
                    # Merge: extend current to cover nxt's range.
                    merged_content = current.content + "\n" + nxt.content
                    current = dataclasses.replace(
                        current,
                        end_line=max(current.end_line, nxt.end_line),
                        content=merged_content,
                        token_count=None,  # will be re-counted
                        score=max(current.score, nxt.score),
                    )
                    # Map the absorbed chunk's ID to the merged chunk.
                    merged_map[nxt.id] = current
                    j += 1
                else:
                    break
            merged_map[file_chunks[i].id] = current
            i = j
