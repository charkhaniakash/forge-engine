"""
Base types for the Phase 3 parser layer.

A Parser reads a source file and returns a list of ParsedChunk objects.
Each chunk represents a logical unit of code — a function, class, or
fallback block — with enough metadata to produce a useful embedding and
to reconstruct its location in the source tree.

ADR 0004: the Agent reads files from a Go-provided read-only clone path.
It never calls git or writes to the filesystem.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class ParsedChunk:
    """A single logical unit extracted from a source file."""

    file_path: str          # relative path within the repo
    language: str           # e.g. "python", "javascript", "unknown"
    chunk_type: str         # "function" | "class" | "block" | "file"
    name: Optional[str]     # symbol name for function/class chunks; None for block/file
    start_line: int         # 1-indexed, inclusive
    end_line: int           # 1-indexed, inclusive
    content: str            # raw source text of this chunk

    # Parser provenance — enables selective re-indexing when parsers change
    parser_name: str = ""
    parser_version: str = ""

    # Populated by chunker after splitting oversized symbols
    token_count: Optional[int] = None


class Parser(ABC):
    """Abstract base class for language-specific parsers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Stable identifier for this parser, e.g. 'tree-sitter-python'."""

    @property
    @abstractmethod
    def version(self) -> str:
        """Version string of the underlying parser library."""

    @property
    @abstractmethod
    def supported_extensions(self) -> list[str]:
        """File extensions this parser handles, e.g. ['.py']."""

    @abstractmethod
    def parse(self, file_path: str, source: str) -> list[ParsedChunk]:
        """
        Parse source text and return a list of chunks.

        Args:
            file_path: relative path within the repo (for metadata only —
                       the parser must not open any files itself).
            source:    full file content as a string.

        Returns:
            List of ParsedChunk objects. Never raises — malformed files
            should fall back to a single file-level chunk.
        """
