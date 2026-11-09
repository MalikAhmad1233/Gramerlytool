"""Password hashing (argon2id), access tokens (JWT) and opaque refresh tokens."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import Settings

_hasher = PasswordHasher()  # argon2id with library defaults (RFC 9106 low-memory profile)
# Used to keep login timing uniform when the e-mail does not exist.
_DUMMY_HASH = _hasher.hash("writemind-timing-equaliser")


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(_hasher.hash, password)


def _verify(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


async def verify_password(stored_hash: str | None, password: str) -> bool:
    if stored_hash is None:
        await asyncio.to_thread(_verify, _DUMMY_HASH, password)
        return False
    return await asyncio.to_thread(_verify, stored_hash, password)


def password_needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


@dataclass(frozen=True, slots=True)
class AccessClaims:
    user_id: uuid.UUID
    plan: str


def create_access_token(settings: Settings, user_id: uuid.UUID, plan: str) -> tuple[str, int]:
    now = datetime.now(UTC)
    ttl = timedelta(minutes=settings.access_token_ttl_minutes)
    payload = {
        "sub": str(user_id),
        "plan": plan,
        "typ": "access",
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, settings.jwt_secret.get_secret_value(), algorithm="HS256")
    return token, int(ttl.total_seconds())


class InvalidTokenError(Exception):
    pass


def decode_access_token(settings: Settings, token: str) -> AccessClaims:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret.get_secret_value(),
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "iat", "sub", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise InvalidTokenError(str(exc)) from exc
    if payload.get("typ") != "access":
        raise InvalidTokenError("wrong token type")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (ValueError, TypeError) as exc:
        raise InvalidTokenError("bad subject") from exc
    return AccessClaims(user_id=user_id, plan=str(payload.get("plan", "free")))


def new_refresh_token() -> str:
    """256-bit opaque token. Only its SHA-256 digest is persisted."""
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
