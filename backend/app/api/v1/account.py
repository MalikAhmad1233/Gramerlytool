"""Signed-in user resources: profile, settings, dictionary, usage, export, deletion."""

from __future__ import annotations

from fastapi import APIRouter, Query, Response, status
from fastapi.responses import JSONResponse

from app.api.deps import CurrentUser, DbDep, OptionalUser
from app.core import security
from app.core.errors import AppError
from app.schemas.account import (
    DictionaryOut,
    DictionaryWord,
    FeedbackBatch,
    SettingsOut,
    SettingsUpdate,
    UsageSummary,
)
from app.schemas.auth import DeleteAccountRequest, UserOut
from app.services import accounts, usage

router = APIRouter(tags=["account"])


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(body: DeleteAccountRequest, user: CurrentUser, db: DbDep) -> Response:
    if not await security.verify_password(user.password_hash, body.password):
        raise AppError(403, "invalid_password", "Password confirmation failed.")
    await accounts.delete_account(db, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me/export")
async def export_me(user: CurrentUser, db: DbDep) -> JSONResponse:
    data = await accounts.export_account(db, user)
    return JSONResponse(
        data, headers={"Content-Disposition": 'attachment; filename="writemind-export.json"'}
    )


@router.get("/settings", response_model=SettingsOut, tags=["settings"])
async def get_settings(user: CurrentUser, db: DbDep) -> SettingsOut:
    return accounts.settings_out(await accounts.get_settings_record(db, user.id))


@router.put("/settings", response_model=SettingsOut, tags=["settings"])
async def put_settings(body: SettingsUpdate, user: CurrentUser, db: DbDep) -> SettingsOut:
    return await accounts.update_settings(db, user.id, body)


@router.get("/dictionary", response_model=DictionaryOut, tags=["dictionary"])
async def get_dictionary(user: CurrentUser, db: DbDep) -> DictionaryOut:
    words = await accounts.list_words(db, user.id)
    return DictionaryOut(words=words, count=len(words), limit=accounts.DICTIONARY_LIMIT)


@router.post("/dictionary", response_model=DictionaryOut, tags=["dictionary"])
async def add_dictionary_word(
    body: DictionaryWord, user: CurrentUser, db: DbDep, response: Response
) -> DictionaryOut:
    inserted = await accounts.add_word(db, user.id, body.word)
    response.status_code = status.HTTP_201_CREATED if inserted else status.HTTP_200_OK
    words = await accounts.list_words(db, user.id)
    return DictionaryOut(words=words, count=len(words), limit=accounts.DICTIONARY_LIMIT)


@router.delete("/dictionary/{word}", status_code=status.HTTP_204_NO_CONTENT, tags=["dictionary"])
async def remove_dictionary_word(word: str, user: CurrentUser, db: DbDep) -> Response:
    if not await accounts.remove_word(db, user.id, word):
        raise AppError(404, "not_found", "Word is not in your dictionary.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/feedback", status_code=status.HTTP_202_ACCEPTED, tags=["feedback"])
async def feedback(body: FeedbackBatch, user: OptionalUser, db: DbDep) -> dict[str, int]:
    await usage.store_feedback(db, user.id if user else None, body)
    return {"accepted": len(body.events)}


@router.get("/usage/summary", response_model=UsageSummary, tags=["usage"])
async def usage_summary(
    user: CurrentUser, db: DbDep, days: int = Query(default=7, ge=1, le=90)
) -> UsageSummary:
    return await usage.usage_summary(db, user.id, days)
