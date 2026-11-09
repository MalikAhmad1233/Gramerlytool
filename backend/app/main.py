"""WriteMind AI API — application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import health
from app.api.v1 import account, auth, check, meta
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.core.rate_limit import RateLimiter
from app.db.session import Database
from app.engine.ai.provider import AIProvider, build_provider
from app.engine.languagetool import LanguageToolClient
from app.engine.pipeline import Engine
from app.services.user_context import UserContextCache


def create_app(
    settings: Settings | None = None,
    *,
    ai_provider: AIProvider | None = None,
    languagetool: LanguageToolClient | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.db = Database(settings)
        app.state.rate_limiter = RateLimiter()
        app.state.user_contexts = UserContextCache()
        app.state.languagetool = languagetool or LanguageToolClient(
            settings.languagetool_url,
            timeout=settings.languagetool_timeout_seconds,
            max_concurrency=settings.languagetool_max_concurrency,
        )
        app.state.ai_provider = ai_provider or build_provider(settings)
        app.state.engine = Engine(settings, app.state.languagetool, app.state.ai_provider)
        try:
            yield
        finally:
            await app.state.languagetool.close()
            await app.state.ai_provider.aclose()
            await app.state.db.dispose()

    app = FastAPI(
        title="WriteMind AI API",
        version=settings.api_version,
        summary="Detect Instantly. Suggest Intelligently. Let Users Decide.",
        lifespan=lifespan,
        docs_url="/docs" if settings.environment != "production" else None,
        redoc_url=None,
    )
    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-WriteMind-Client"],
        expose_headers=["X-Request-ID", "Retry-After"],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware, max_body_bytes=settings.max_body_bytes)

    app.include_router(health.router)
    for module in (auth, account, check, meta):
        app.include_router(module.router, prefix="/v1")
    return app


app = create_app()
