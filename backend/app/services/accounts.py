"""Account lifecycle: registration, login, refresh-token rotation, settings, dictionary."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import security
from app.core.config import Settings
from app.core.errors import AppError
from app.models import (
    DEFAULT_CATEGORIES,
    DictionaryEntry,
    RefreshToken,
    SuggestionFeedback,
    UsageDaily,
    User,
    UserSettings,
)
from app.schemas.account import SettingsOut, SettingsUpdate
from app.schemas.auth import TokenPair, UserOut

DICTIONARY_LIMIT = 5_000


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def create_user(
    session: AsyncSession, email: str, password: str, display_name: str | None
) -> User:
    user = User(
        email=normalize_email(email),
        password_hash=await security.hash_password(password),
        display_name=(display_name or "").strip() or None,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise AppError(409, "email_taken", "An account with this e-mail already exists.") from exc
    session.add(UserSettings(user_id=user.id))
    await session.flush()
    return user


async def authenticate(session: AsyncSession, email: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.email == normalize_email(email)))
    ok = await security.verify_password(user.password_hash if user else None, password)
    if not ok or user is None or not user.is_active:
        raise AppError(401, "invalid_credentials", "E-mail or password is incorrect.")
    if security.password_needs_rehash(user.password_hash):
        user.password_hash = await security.hash_password(password)
    return user


async def issue_tokens(
    session: AsyncSession,
    settings: Settings,
    user: User,
    client: str | None,
    family_id: uuid.UUID | None = None,
) -> tuple[TokenPair, RefreshToken]:
    access, expires_in = security.create_access_token(settings, user.id, user.plan)
    raw_refresh = security.new_refresh_token()
    record = RefreshToken(
        user_id=user.id,
        family_id=family_id or uuid.uuid4(),
        token_hash=security.hash_refresh_token(raw_refresh),
        client=client,
        expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
    )
    session.add(record)
    await session.flush()
    pair = TokenPair(
        access_token=access,
        refresh_token=raw_refresh,
        expires_in=expires_in,
        user=UserOut.model_validate(user),
    )
    return pair, record


async def rotate_refresh_token(
    session: AsyncSession, settings: Settings, raw_token: str
) -> TokenPair:
    """Single-use refresh tokens. Re-use of a rotated token revokes the whole family."""
    token_hash = security.hash_refresh_token(raw_token)
    record = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
    )
    invalid = AppError(401, "invalid_refresh_token", "Session expired. Please sign in again.")
    if record is None:
        raise invalid
    now = datetime.now(UTC)
    if record.revoked_at is not None:
        # Token theft signal: an already-rotated token was presented again.
        await _revoke_family(session, record.family_id, now)
        await session.commit()
        raise invalid
    if record.expires_at <= now:
        raise invalid
    user = await session.get(User, record.user_id)
    if user is None or not user.is_active:
        raise invalid

    pair, new_record = await issue_tokens(
        session, settings, user, record.client, family_id=record.family_id
    )
    record.revoked_at = now
    record.replaced_by = new_record.id
    return pair


async def revoke_refresh_token(session: AsyncSession, raw_token: str) -> None:
    token_hash = security.hash_refresh_token(raw_token)
    record = await session.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    if record is not None:
        await _revoke_family(session, record.family_id, datetime.now(UTC))


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


# --- Settings -----------------------------------------------------------------


def settings_out(record: UserSettings | None) -> SettingsOut:
    if record is None:
        return SettingsOut(
            language="en-US",
            default_style="neutral",
            ai_enabled=True,
            enabled_categories=list(DEFAULT_CATEGORIES),
            disabled_rules=[],
            disabled_sites=[],
            disabled_apps=[],
        )
    return SettingsOut(
        language=record.language,
        default_style=record.default_style,
        ai_enabled=record.ai_enabled,
        enabled_categories=list(record.enabled_categories),
        disabled_rules=list(record.disabled_rules),
        disabled_sites=list(record.disabled_sites),
        disabled_apps=list(record.disabled_apps),
        updated_at=record.updated_at,
    )


async def get_settings_record(session: AsyncSession, user_id: uuid.UUID) -> UserSettings:
    record = await session.get(UserSettings, user_id)
    if record is None:
        record = UserSettings(user_id=user_id)
        session.add(record)
        await session.flush()
        await session.refresh(record)
    return record


async def update_settings(
    session: AsyncSession, user_id: uuid.UUID, patch: SettingsUpdate
) -> SettingsOut:
    record = await get_settings_record(session, user_id)
    for field, value in patch.model_dump(exclude_unset=True, exclude_none=True).items():
        if isinstance(value, list):
            value = [str(v) for v in value]
        elif hasattr(value, "value"):
            value = value.value
        setattr(record, field, value)
    await session.flush()
    await session.refresh(record)
    return settings_out(record)


# --- Dictionary ---------------------------------------------------------------


async def list_words(session: AsyncSession, user_id: uuid.UUID) -> list[str]:
    rows = await session.scalars(
        select(DictionaryEntry.word)
        .where(DictionaryEntry.user_id == user_id)
        .order_by(func.lower(DictionaryEntry.word))
    )
    return list(rows)


async def add_word(session: AsyncSession, user_id: uuid.UUID, word: str) -> bool:
    """Returns True if inserted, False if it already existed."""
    count = await session.scalar(
        select(func.count()).select_from(DictionaryEntry).where(DictionaryEntry.user_id == user_id)
    )
    if (count or 0) >= DICTIONARY_LIMIT:
        raise AppError(409, "dictionary_full", f"Dictionary limit of {DICTIONARY_LIMIT} reached.")
    stmt = (
        pg_insert(DictionaryEntry)
        .values(id=uuid.uuid4(), user_id=user_id, word=word)
        .on_conflict_do_nothing()
        .returning(DictionaryEntry.id)
    )
    inserted = await session.scalar(stmt)
    return inserted is not None


async def remove_word(session: AsyncSession, user_id: uuid.UUID, word: str) -> bool:
    result = await session.execute(
        delete(DictionaryEntry).where(
            DictionaryEntry.user_id == user_id,
            func.lower(DictionaryEntry.word) == word.strip().lower(),
        )
    )
    return (result.rowcount or 0) > 0


# --- Account deletion & export --------------------------------------------------


async def delete_account(session: AsyncSession, user: User) -> None:
    # Feedback rows are already anonymous (rule ids only); detach them explicitly.
    await session.execute(
        update(SuggestionFeedback).where(SuggestionFeedback.user_id == user.id).values(user_id=None)
    )
    await session.delete(user)  # cascades: tokens, settings, dictionary, usage


async def export_account(session: AsyncSession, user: User) -> dict:
    settings_record = await session.get(UserSettings, user.id)
    usage = await session.scalars(
        select(UsageDaily).where(UsageDaily.user_id == user.id).order_by(UsageDaily.day)
    )
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "user": UserOut.model_validate(user).model_dump(mode="json"),
        "settings": settings_out(settings_record).model_dump(mode="json"),
        "dictionary": await list_words(session, user.id),
        "usage_daily": [
            {
                "day": u.day.isoformat(),
                "checks": u.checks,
                "characters": u.characters,
                "suggestions_shown": u.suggestions_shown,
                "accepted": u.accepted,
                "ignored": u.ignored,
                "rewrites": u.rewrites,
            }
            for u in usage
        ],
        "note": "WriteMind AI does not store the text you check, so none is included.",
    }
