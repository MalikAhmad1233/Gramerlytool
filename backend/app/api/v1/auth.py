from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status

from app.api.deps import DbDep, SettingsDep, rate_limit
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenPair
from app.services import accounts

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(rate_limit("auth"))])


@router.post("/register", response_model=TokenPair, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, db: DbDep, settings: SettingsDep) -> TokenPair:
    user = await accounts.create_user(db, body.email, body.password, body.display_name)
    pair, _ = await accounts.issue_tokens(db, settings, user, body.client.value)
    return pair


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, db: DbDep, settings: SettingsDep) -> TokenPair:
    user = await accounts.authenticate(db, body.email, body.password)
    pair, _ = await accounts.issue_tokens(db, settings, user, body.client.value)
    return pair


@router.post("/refresh", response_model=TokenPair)
async def refresh(body: RefreshRequest, db: DbDep, settings: SettingsDep) -> TokenPair:
    return await accounts.rotate_refresh_token(db, settings, body.refresh_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshRequest, db: DbDep) -> Response:
    await accounts.revoke_refresh_token(db, body.refresh_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
