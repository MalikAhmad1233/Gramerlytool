"""Application configuration, loaded from environment variables (prefix ``WRITEMIND_``)."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-me-0123456789"  # noqa: S105


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="WRITEMIND_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "production"] = "development"
    app_name: str = "WriteMind AI"
    api_version: str = "1.0.0"
    log_level: str = "INFO"

    # --- Database -------------------------------------------------------------
    database_url: str = "postgresql+asyncpg://writemind:writemind@localhost:5432/writemind"
    database_pool_size: int = 10
    database_echo: bool = False

    # --- Auth -----------------------------------------------------------------
    jwt_secret: SecretStr = SecretStr(_DEV_JWT_SECRET)
    jwt_issuer: str = "writemind-ai"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 30

    # --- Grammar engine -------------------------------------------------------
    languagetool_url: str = "http://localhost:8081"
    languagetool_timeout_seconds: float = 6.0
    languagetool_max_concurrency: int = 8

    # --- AI provider ----------------------------------------------------------
    ai_provider: Literal["anthropic", "none"] = "anthropic"
    anthropic_api_key: SecretStr | None = None
    ai_model: str = "claude-opus-5-5"
    ai_effort: Literal["low", "medium", "high"] = "low"
    ai_timeout_seconds: float = 8.0
    ai_max_paragraph_chars: int = 2_000
    ai_refusal_fallbacks: bool = True

    # --- Engine limits & caching ---------------------------------------------
    max_check_chars: int = 20_000
    max_rewrite_chars: int = 2_000
    cache_ttl_seconds: int = 600
    cache_max_entries: int = 5_000

    # --- Rate limits (requests per minute) ------------------------------------
    rate_limit_enabled: bool = True
    rate_check_guest: int = 120
    rate_check_user: int = 600
    rate_rewrite_guest: int = 10
    rate_rewrite_user: int = 60
    rate_auth: int = 20
    rate_feedback_guest: int = 60
    rate_feedback_user: int = 240
    rate_account_guest: int = 30
    rate_account_user: int = 240

    # --- HTTP -----------------------------------------------------------------
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    # Chrome extension IDs are 32 chars a–p. Pin to your published ID in production.
    cors_origin_regex: str = r"^chrome-extension://[a-p]{32}$"
    trust_proxy_headers: bool = False
    max_body_bytes: int = 256_000

    @model_validator(mode="after")
    def _validate_production(self) -> Settings:
        if self.environment == "production":
            secret = self.jwt_secret.get_secret_value()
            if secret == _DEV_JWT_SECRET or len(secret) < 32:
                raise ValueError(
                    "WRITEMIND_JWT_SECRET must be set to a random value of 32+ characters "
                    "in production"
                )
        return self

    def resolved_anthropic_key(self) -> str | None:
        """Explicitly configured key only; never silently borrow ambient credentials."""
        if self.anthropic_api_key is not None:
            value = self.anthropic_api_key.get_secret_value().strip()
            return value or None
        value = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        return value or None

    @property
    def ai_configured(self) -> bool:
        return self.ai_provider == "anthropic" and self.resolved_anthropic_key() is not None


@lru_cache
def get_settings() -> Settings:
    return Settings()
