"""
JavaScript / TypeScript AST parser using tree-sitter.

Extracts function declarations, arrow functions assigned to variables,
class declarations, and method definitions. Falls back to a single
file-level chunk on parse failure.
"""
from __future__ import annotations

from typing import Optional

import tree_sitter_javascript as tsjs
from tree_sitter import Language, Parser as TSParser, Node

from src.ingestion.parser.base import ParsedChunk, Parser

JS_LANGUAGE = Language(tsjs.language())

# Node types we treat as extractable symbols
_FUNCTION_TYPES = {
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
}
_CLASS_TYPES = {"class_declaration"}
_ARROW_PARENTS = {"variable_declarator"}  # const foo = () => {}


def _text(node: Node, source_bytes: bytes) -> str:
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _get_name(node: Node, source_bytes: bytes) -> Optional[str]:
    for child in node.children:
        if child.type == "identifier":
            return _text(child, source_bytes)
    return None


class JavaScriptParser(Parser):
    """tree-sitter based JavaScript/TypeScript parser."""

    def __init__(self) -> None:
        self._parser = TSParser(JS_LANGUAGE)

    @property
    def name(self) -> str:
        return "tree-sitter-javascript"

    @property
    def version(self) -> str:
        try:
            import importlib.metadata
            return importlib.metadata.version("tree-sitter-javascript")
        except Exception:
            return "0.21.4"

    @property
    def supported_extensions(self) -> list[str]:
        return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]

    def parse(self, file_path: str, source: str) -> list[ParsedChunk]:
        if not source.strip():
            return []

        source_bytes = source.encode("utf-8", errors="replace")
        source_lines = source.splitlines()

        try:
            tree = self._parser.parse(source_bytes)
        except Exception:
            return [ParsedChunk(
                file_path=file_path,
                language="javascript",
                chunk_type="file",
                name=None,
                start_line=1,
                end_line=len(source_lines),
                content=source,
                parser_name=self.name,
                parser_version=self.version,
            )]

        chunks: list[ParsedChunk] = []
        self._walk(tree.root_node, source_bytes, source_lines, file_path, chunks, depth=0)

        if not chunks:
            chunks.append(ParsedChunk(
                file_path=file_path,
                language="javascript",
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
        if depth > 2:
            return

        if node.type in _FUNCTION_TYPES and depth <= 1:
            name = _get_name(node, source_bytes)
            self._emit(node, source_lines, file_path, "function", name, chunks)
            # Still walk into class bodies for methods
            for child in node.children:
                self._walk(child, source_bytes, source_lines, file_path, chunks, depth + 1)
            return

        if node.type in _CLASS_TYPES and depth <= 1:
            name = _get_name(node, source_bytes)
            self._emit(node, source_lines, file_path, "class", name, chunks)
            for child in node.children:
                self._walk(child, source_bytes, source_lines, file_path, chunks, depth + 1)
            return

        # const foo = () => {} or const foo = function() {}
        if node.type == "lexical_declaration" and depth == 0:
            for declarator in node.children:
                if declarator.type == "variable_declarator":
                    var_name: Optional[str] = None
                    has_func = False
                    for child in declarator.children:
                        if child.type == "identifier":
                            var_name = _text(child, source_bytes)
                        if child.type in (
                            "arrow_function",
                            "function",
                            "generator_function",
                        ):
                            has_func = True
                    if has_func:
                        self._emit(node, source_lines, file_path, "function", var_name, chunks)
            return

        for child in node.children:
            self._walk(child, source_bytes, source_lines, file_path, chunks, depth)

    def _emit(
        self,
        node: Node,
        source_lines: list[str],
        file_path: str,
        chunk_type: str,
        name: Optional[str],
        chunks: list[ParsedChunk],
    ) -> None:
        start_line = node.start_point[0]
        end_line = node.end_point[0]
        content = "\n".join(source_lines[start_line : end_line + 1])
        chunks.append(ParsedChunk(
            file_path=file_path,
            language="javascript",
            chunk_type=chunk_type,
            name=name,
            start_line=start_line + 1,
            end_line=end_line + 1,
            content=content,
            parser_name=self.name,
            parser_version=self.version,
        ))
