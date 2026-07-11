"""
Chunker: token-budget-aware post-processor for ParsedChunks.

Responsibilities:
  1. Count tokens for every chunk (stored for Phase 4 context budgeting).
  2. Split any chunk that exceeds the configured token limit into smaller
     line-based sub-chunks, preserving all metadata.
  3. Drop empty chunks.

The chunker does NOT call any external APIs. It only uses tiktoken for
local token counting.
"""
from __future__ import annotations

import tiktoken

from src.ingestion.parser.base import ParsedChunk
from src.config import settings

# Use the cl100k_base encoding — compatible with all OpenAI embedding models.
_ENCODING = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """Return the number of tokens in text using cl100k_base encoding."""
    return len(_ENCODING.encode(text, disallowed_special=()))


def process_chunks(chunks: list[ParsedChunk]) -> list[ParsedChunk]:
    """
    Count tokens for each chunk, split oversized ones, drop empty ones.
    Returns the final list ready for embedding.
    """
    result: list[ParsedChunk] = []
    limit = settings.chunk_token_limit

    for chunk in chunks:
        if not chunk.content.strip():
            continue

        token_count = count_tokens(chunk.content)

        if token_count <= limit:
            chunk.token_count = token_count
            result.append(chunk)
        else:
            # Split into sub-chunks at line boundaries.
            result.extend(_split_chunk(chunk, limit))

    return result


def _split_chunk(chunk: ParsedChunk, limit: int) -> list[ParsedChunk]:
    """
    Split a single oversized chunk into multiple smaller ones by walking
    lines until the token budget is reached, then starting a new sub-chunk.

    If a single line exceeds the limit (e.g. minified JS), it is truncated
    to fit within the budget. This prevents the embedding API from rejecting
    the input with a 400 error.
    """
    lines = chunk.content.splitlines()
    sub_chunks: list[ParsedChunk] = []

    current_lines: list[str] = []
    current_start_line = chunk.start_line

    for i, line in enumerate(lines):
        # Handle single lines that exceed the limit (e.g. minified files).
        line_tokens = count_tokens(line)
        if line_tokens > limit:
            # Flush any buffered lines first.
            if current_lines:
                content = "\n".join(current_lines)
                sub_chunks.append(ParsedChunk(
                    file_path=chunk.file_path,
                    language=chunk.language,
                    chunk_type="block",
                    name=chunk.name if len(sub_chunks) == 0 else None,
                    start_line=current_start_line,
                    end_line=current_start_line + len(current_lines) - 1,
                    content=content,
                    parser_name=chunk.parser_name,
                    parser_version=chunk.parser_version,
                    token_count=count_tokens(content),
                ))
                current_lines = []
                current_start_line = chunk.start_line + i

            # Truncate the oversized line to fit within the token limit.
            truncated = _truncate_to_token_limit(line, limit)
            sub_chunks.append(ParsedChunk(
                file_path=chunk.file_path,
                language=chunk.language,
                chunk_type="block",
                name=chunk.name if len(sub_chunks) == 0 else None,
                start_line=chunk.start_line + i,
                end_line=chunk.start_line + i,
                content=truncated,
                parser_name=chunk.parser_name,
                parser_version=chunk.parser_version,
                token_count=count_tokens(truncated),
            ))
            current_start_line = chunk.start_line + i + 1
            continue

        candidate = current_lines + [line]
        if count_tokens("\n".join(candidate)) > limit and current_lines:
            # Flush the current buffer as a sub-chunk.
            content = "\n".join(current_lines)
            sub_chunks.append(ParsedChunk(
                file_path=chunk.file_path,
                language=chunk.language,
                chunk_type="block",           # sub-chunks are always blocks
                name=chunk.name if len(sub_chunks) == 0 else None,
                start_line=current_start_line,
                end_line=current_start_line + len(current_lines) - 1,
                content=content,
                parser_name=chunk.parser_name,
                parser_version=chunk.parser_version,
                token_count=count_tokens(content),
            ))
            current_start_line = chunk.start_line + i
            current_lines = [line]
        else:
            current_lines.append(line)

    # Flush remainder.
    if current_lines:
        content = "\n".join(current_lines)
        sub_chunks.append(ParsedChunk(
            file_path=chunk.file_path,
            language=chunk.language,
            chunk_type="block",
            name=chunk.name if len(sub_chunks) == 0 else None,
            start_line=current_start_line,
            end_line=current_start_line + len(current_lines) - 1,
            content=content,
            parser_name=chunk.parser_name,
            parser_version=chunk.parser_version,
            token_count=count_tokens(content),
        ))

    return sub_chunks


def _truncate_to_token_limit(text: str, limit: int) -> str:
    """
    Truncate text to fit within the token limit by encoding, slicing tokens,
    and decoding back. Leaves a small margin (16 tokens) for safety.
    """
    tokens = _ENCODING.encode(text, disallowed_special=())
    if len(tokens) <= limit:
        return text
    # Keep a small margin under the limit.
    safe_limit = limit - 16
    truncated_tokens = tokens[:safe_limit]
    return _ENCODING.decode(truncated_tokens)
