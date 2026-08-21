"""Backend-facing LLM credential validation."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from src.auth import extract_token_from_header, verify_token
from src.llm.validate import validate_llm

router = APIRouter()


def _verify_token(authorization: str = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization")
    token = extract_token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization format")
    return verify_token(token)


class ValidateRequest(BaseModel):
    provider: str
    model: str
    api_key: str = ""


class ValidateResponse(BaseModel):
    ok: bool
    message: str


@router.post("/v1/agent/llm/validate", response_model=ValidateResponse)
async def validate(body: ValidateRequest, _token: dict = Depends(_verify_token)) -> ValidateResponse:
    ok, message = await validate_llm(body.provider, body.api_key, body.model)
    return ValidateResponse(ok=ok, message=message)
