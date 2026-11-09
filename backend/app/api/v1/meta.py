from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.deps import SettingsDep
from app.schemas.common import SUPPORTED_LANGUAGES, Category, RewriteStyle, Style

router = APIRouter(tags=["meta"])


@router.get("/meta")
async def meta(request: Request, settings: SettingsDep) -> dict:
    provider = getattr(request.app.state, "ai_provider", None)
    return {
        "name": settings.app_name,
        "tagline": "Detect Instantly. Suggest Intelligently. Let Users Decide.",
        "version": settings.api_version,
        "languages": [{"code": k, "name": v} for k, v in SUPPORTED_LANGUAGES.items()],
        "styles": [s.value for s in Style],
        "rewrite_styles": [s.value for s in RewriteStyle],
        "categories": [c.value for c in Category],
        "limits": {
            "max_check_chars": settings.max_check_chars,
            "max_rewrite_chars": settings.max_rewrite_chars,
        },
        "ai_available": bool(provider is not None and provider.available),
        "offsets": "utf-16",
    }
