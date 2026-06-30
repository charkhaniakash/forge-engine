"""
Q&A-specific request/response models.
"""
from __future__ import annotations

from pydantic import BaseModel


class HistoryMessage(BaseModel):
    role: str     # "user" | "assistant"
    content: str


class QARequest(BaseModel):
    session_id: str
    repo_id: str
    commit_sha: str
    question: str
    request_id: str
    history: list[HistoryMessage] = []
