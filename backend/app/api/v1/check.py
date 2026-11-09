"""/v1/check and /v1/rewrite — the text intelligence endpoints.

Text is processed in memory only. It is never logged or written to the database.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Request

from app.api.deps import DbDep, OptionalUser, SettingsDep, rate_limit
from app.core.errors import AppError
from app.schemas.check import CheckRequest, CheckResponse, RewriteRequest, RewriteResponse
from app.services.usage import record_usage_background
from app.services.user_context import context_for_check, merge_request

router = APIRouter(tags=["intelligence"])


@router.post("/check", response_model=CheckResponse, dependencies=[Depends(rate_limit("check"))])
async def check(
    body: CheckRequest,
    request: Request,
    user: OptionalUser,
    db: DbDep,
    settings: SettingsDep,
    background: BackgroundTasks,
) -> CheckResponse:
    if len(body.text) > settings.max_check_chars:
        raise AppError(
            413,
            "text_too_long",
            f"Text exceeds {settings.max_check_chars} characters; check it in smaller parts.",
        )
    base = await request.app.state.user_contexts.get(db, user) if user else None
    ctx = context_for_check(base, body)
    result = await request.app.state.engine.check(body, ctx)
    if user is not None:
        background.add_task(
            record_usage_background,
            request.app.state.db.sessionmaker,
            user.id,
            checks=1,
            characters=len(body.text),
            suggestions_shown=len(result.suggestions),
        )
    return result


@router.post(
    "/rewrite", response_model=RewriteResponse, dependencies=[Depends(rate_limit("rewrite"))]
)
async def rewrite(
    body: RewriteRequest,
    request: Request,
    user: OptionalUser,
    db: DbDep,
    settings: SettingsDep,
    background: BackgroundTasks,
) -> RewriteResponse:
    if len(body.text) > settings.max_rewrite_chars:
        raise AppError(
            413,
            "text_too_long",
            f"Rewrites support up to {settings.max_rewrite_chars} characters; select less text.",
        )
    if not body.text.strip():
        raise AppError(422, "empty_text", "Select some text to rewrite.")
    base = await request.app.state.user_contexts.get(db, user) if user else None
    ctx = merge_request(base, [], [], None, body.ai)
    result = await request.app.state.engine.rewrite(body, ctx)
    if user is not None:
        background.add_task(
            record_usage_background, request.app.state.db.sessionmaker, user.id, rewrites=1
        )
    return result
