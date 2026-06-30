"""
Python AST parser using tree-sitter.

Extracts top-level and class-level functions and classes. Falls back to
a single file-level chunk if parsing fails.
"""
from __future__ import annotations

from typing import Optional

import tree_sitter_python as tspython
from tree_sitter import Language, Parser as TSParser, Node

from src.ingestion.parser.base import ParsedChunk, Parser

PY_LANGUAGE = Language(tspython.language())

_SYMBOL_TYPES = {"function_definition", "class_definition", "decorated_definition"}


def _get_name(node: Node, source_bytes: bytes) -> Optional[str]:
    """Extract the identifier name from a function or class node."""
    for child in node.children:
        if child.type == "identifier":
            return source_bytes[child.start_byte : child.end_byte].decode("utf-8", errors="replace")
        # decorated_definition wraps the actual def/class
        if child.type in ("function_definition", "class_definition"):
            return _get_name(child, source_bytes)
    return None


def _node_to_chunk(
    node: Node,
    source_bytes: bytes,
    source_lines: list[str],
    file_path: str,
    parser_name: str,
    parser_version: str,
) -> ParsedChunk:
    actual_node = node
    # Unwrap decorated_definition to get the real type
    if node.type == "decorated_definition":
        for child in node.children:
            if child.type in ("function_definition", "class_definition"):
                actual_node = child
                break

    chunk_type = "function" if actual_node.type == "function_definition" else "class"
    name = _get_name(node, source_bytes)

    start_line = node.start_point[0]  # 0-indexed
    end_line = node.end_point[0]      # 0-indexed
    content = "\n".join(source_lines[start_line : end_line + 1])

    return ParsedChunk(
        file_path=file_path,
        language="python",
        chunk_type=chunk_type,
        name=name,
        start_line=start_line + 1,   # 1-indexed
        end_line=end_line + 1,
        content=content,
        parser_name=parser_name,
        parser_version=parser_version,
    )


class PythonParser(Parser):
    """tree-sitter based Python parser."""

    def __init__(self) -> None:
        self._parser = TSParser(PY_LANGUAGE)

    @property
    def name(self) -> str:
        return "tree-sitter-python"

    @property
    def version(self) -> str:
        try:
            import importlib.metadata
            return importlib.metadata.version("tree-sitter-python")
        except Exception:
            return "0.21.0"

    @property
    def supported_extensions(self) -> list[str]:
        return [".py"]

    def parse(self, file_path: str, source: str) -> list[ParsedChunk]:
        if not source.strip():
            return []

        source_bytes = source.encode("utf-8", errors="replace")
        source_lines = source.splitlines()

        try:
            tree = self._parser.parse(source_bytes)
        except Exception:
            # Unparseable — fall back to a single file-level chunk.
            return [ParsedChunk(
                file_path=file_path,
                language="python",
                chunk_type="file",
                name=None,
                start_line=1,
                end_line=len(source_lines),
                content=source,
                parser_name=self.name,
                parser_version=self.version,
            )]

        chunks: list[ParsedChunk] = []
        self._walk(
            tree.root_node,
            source_bytes,
            source_lines,
            file_path,
            chunks,
            depth=0,
        )

        if not chunks:
            # File has no top-level symbols (e.g. pure script) — index the whole file.
            chunks.append(ParsedChunk(
                file_path=file_path,
                language="python",
                chunk_type="file",
                name=None,
                start_line=1,
                end_line=len(source_lines),
                content=source,
                parser_name=self.name,
                parser_version=self.version,
            ))

        return chunks

    def _walk(
        self,
        node: Node,
        source_bytes: bytes,
        source_lines: list[str],
        file_path: str,
        chunks: list[ParsedChunk],
        depth: int,
    ) -> None:
        # Only extract top-level and class-body symbols (depth 0 and 1).
        # Nested functions inside functions are included in their parent's content.
        if node.type in _SYMBOL_TYPES and depth <= 1:
            chunks.append(_node_to_chunk(
                node, source_bytes, source_lines, file_path,
                self.name, self.version,
            ))
            # Recurse into class bodies to get methods (depth 1 → 2 is capped above)
            if node.type in ("class_definition", "decorated_definition"):
                for child in node.children:
                    self._walk(child, source_bytes, source_lines, file_path, chunks, depth + 1)
            return

        for child in node.children:
            self._walk(child, source_bytes, source_lines, file_path, chunks, depth)
