"""Lightweight live checks that a provider + API key actually work."""
from __future__ import annotations

import os

import httpx

from src.config import settings

_TIMEOUT = 20.0

_OPENAI_COMPAT = {
    "openai": "https://api.openai.com/v1",
    "groq": os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    "openrouter": os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    "tokenrouter": os.getenv("TOKENROUTER_BASE_URL", "https://api.tokenrouter.com/v1"),
    "mistral": os.getenv("MISTRAL_BASE_URL", "https://api.mistral.ai/v1"),
}


async def validate_llm(provider: str, api_key: str, model: str) -> tuple[bool, str]:
    name = (provider or "").strip().lower()
    model = (model or "").strip()
    if not name:
        return False, "Provider is required"
    if not model:
        return False, "Model is required"

    try:
        if name == "ollama":
            return await _validate_ollama(model)
        if name in _OPENAI_COMPAT:
            if not api_key:
                return False, "API key is required"
            return await _validate_openai_compat(_OPENAI_COMPAT[name], api_key, model, name)
        if name == "gemini":
            if not api_key:
                return False, "API key is required"
            return await _validate_gemini(api_key, model)
        if name == "anthropic":
            if not api_key:
                return False, "API key is required"
            return await _validate_anthropic(api_key, model)
        if name == "cohere":
            if not api_key:
                return False, "API key is required"
            return await _validate_cohere(api_key, model)
        return False, f"Unknown provider '{provider}'"
    except httpx.TimeoutException:
        return False, "Provider timed out — check the key, model, and network"
    except httpx.HTTPError as exc:
        return False, f"Could not reach provider: {exc}"
    except Exception as exc:
        return False, str(exc)


async def _validate_openai_compat(base: str, api_key: str, model: str, name: str) -> tuple[bool, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if name == "openrouter":
        headers["HTTP-Referer"] = "https://forge-engine.local"
        headers["X-Title"] = "Forge Engine"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(f"{base.rstrip('/')}/chat/completions", json=payload, headers=headers)
    if resp.status_code >= 400:
        return False, _clip_error(resp)
    return True, "Key is valid"


async def _validate_gemini(api_key: str, model: str) -> tuple[bool, str]:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={api_key}"
    )
    payload = {"contents": [{"parts": [{"text": "ping"}]}], "generationConfig": {"maxOutputTokens": 1}}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(url, json=payload)
    if resp.status_code >= 400:
        return False, _clip_error(resp)
    return True, "Key is valid"


async def _validate_anthropic(api_key: str, model: str) -> tuple[bool, str]:
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers)
    if resp.status_code >= 400:
        return False, _clip_error(resp)
    return True, "Key is valid"


async def _validate_cohere(api_key: str, model: str) -> tuple[bool, str]:
    base = os.getenv("COHERE_BASE_URL", "https://api.cohere.ai/v2")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(f"{base.rstrip('/')}/chat", json=payload, headers=headers)
    if resp.status_code >= 400:
        return False, _clip_error(resp)
    return True, "Key is valid"


async def _validate_ollama(model: str) -> tuple[bool, str]:
    base = os.getenv("OLLAMA_BASE_URL", settings.ollama_base_url or "http://localhost:11434")
    base = base.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(f"{base}/api/tags")
    if resp.status_code >= 400:
        return False, _clip_error(resp)
    names = [m.get("name", "") for m in resp.json().get("models", [])]
    if names and not any(model == n or n.startswith(model + ":") or n.startswith(model) for n in names):
        return False, f"Ollama is reachable but model '{model}' is not pulled"
    return True, "Ollama is reachable"


def _clip_error(resp: httpx.Response) -> str:
    text = resp.text.strip()
    if len(text) > 280:
        text = text[:277] + "..."
    return f"Provider returned HTTP {resp.status_code}: {text or resp.reason_phrase}"
