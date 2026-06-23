"""JWT verification for inter-service communication."""

import os
from typing import Optional, Dict, Any
import jwt
from fastapi import HTTPException, status


def get_jwt_secret() -> str:
    """Get the JWT secret from environment."""
    secret = os.getenv("JWT_SECRET", "phase-0-insecure-default")
    return secret


def verify_token(token: str) -> Dict[str, Any]:
    """Verify and decode a JWT token from Backend."""
    try:
        secret = get_jwt_secret()
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
        )
    except jwt.InvalidTokenError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}",
        )


def extract_token_from_header(auth_header: Optional[str]) -> Optional[str]:
    """Extract bearer token from Authorization header."""
    if not auth_header:
        return None
    
    parts = auth_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    
    return parts[1]