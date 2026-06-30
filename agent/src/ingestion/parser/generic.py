"""
Generic line-based fallback parser.

Used for any file type that has no tree-sitter grammar. Splits the file
into fixed-size line blocks so every file in a repo gets indexed, even
if we can't do AST-level symbol extraction.
"""
from __future__ import annotations

import importlib.metadata

from src.ingestion.parser.base import ParsedChunk, Parser

_BLOCK_SIZE = 50  # lines per fallback block


class GenericParser(Parser):
    """Splits any text file into fixed-size line blocks."""

    @property
    def name(self) -> str:
        return "line-based"

    @property
    def version(self) -> str:
        # No external library — use the agent package version.
        try:
            return importlib.metadata.version("forge-agent")
        except Exception:
            return "0.1.0"

    @property
    def supported_extensions(self) -> list[str]:
        # Catch-all: no specific extension list.
        return []

    def parse(self, file_path: str, source: str) -> list[ParsedChunk]:
        if not source.strip():
            return []

        lines = source.splitlines()
        chunks: list[ParsedChunk] = []

        for block_start in range(0, len(lines), _BLOCK_SIZE):
            block_lines = lines[block_start : block_start + _BLOCK_SIZE]
            start_line = block_start + 1           # 1-indexed
            end_line = block_start + len(block_lines)
            content = "\n".join(block_lines)

            chunks.append(
                ParsedChunk(
                    file_path=file_path,
                    language="unknown",
                    chunk_type="block",
                    name=None,
                    start_line=start_line,
                    end_line=end_line,
                    content=content,
                    parser_name=self.name,
                    parser_version=self.version,
                )
            )

        return chunks
