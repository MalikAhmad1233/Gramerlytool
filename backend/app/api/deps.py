"""FastAPI dependencies: settings, DB session, auth, rate limiting."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.core.config import Settings
from app.core.errors import AppError
from app.models import User


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.sessionmaker() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


SettingsDep = Annotated[Settings, Depends(get_app_settings)]
DbDep = Annotated[AsyncSession, Depends(get_db)]

_UNAUTHORIZED = {"WWW-Authenticate": "Bearer"}


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization")
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AppError(
            401, "invalid_token", "Malformed Authorization header.", headers=_UNAUTHORIZED
        )
    return token.strip()


async def get_optional_user(request: Request, settings: SettingsDep, db: DbDep) -> User | None:
    """Guests are allowed; a *present but invalid* token is still rejected so clients refresh."""
    token = _bearer(request)
    if token is None:
        request.state.identity = None
        return None
    try:
        claims = security.decode_access_token(settings, token)
    except security.InvalidTokenError as exc:
        raise AppError(
            401, "invalid_token", "Access token is invalid or expired.", headers=_UNAUTHORIZED
        ) from exc
    user = await db.get(User, claims.user_id)
    if user is None or not user.is_active:
        raise AppError(401, "invalid_token", "Account is not active.", headers=_UNAUTHORIZED)
    request.state.identity = f"user:{user.id}"
    return user


async def get_current_user(user: Annotated[User | None, Depends(get_optional_user)]) -> User:
    if user is None:
        raise AppError(401, "unauthorized", "Sign in required.", headers=_UNAUTHORIZED)
    return user


OptionalUser = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def client_ip(request: Request, settings: Settings) -> str:
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(route_class: str) -> Callable:
    """Token bucket per identity (user id when signed in, otherwise client IP)."""

    async def dependency(request: Request, settings: SettingsDep, user: OptionalUser) -> None:
        if not settings.rate_limit_enabled:
            return
        if route_class == "auth":
            per_minute = settings.rate_auth
            identity = f"ip:{client_ip(request, settings)}"
        else:
            guest_limit = getattr(settings, f"rate_{route_class}_guest")
            user_limit = getattr(settings, f"rate_{route_class}_user")
            per_minute = user_limit if user is not None else guest_limit
            identity = f"user:{user.id}" if user else f"ip:{client_ip(request, settings)}"
        decision = request.app.state.rate_limiter.hit(f"{route_class}:{identity}", per_minute)
        if not decision.allowed:
            raise AppError(
                429,
                "rate_limited",
                "Too many requests. Please slow down.",
                headers={"Retry-After": str(decision.retry_after)},
            )

    return dependency
