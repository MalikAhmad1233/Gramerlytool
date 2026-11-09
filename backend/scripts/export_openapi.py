"""Writes the OpenAPI document to shared/openapi.json (the cross-client API contract)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import create_app  # noqa: E402

target = Path(__file__).resolve().parents[2] / "shared" / "openapi.json"
target.write_text(json.dumps(create_app().openapi(), indent=2, ensure_ascii=False) + "\n", "utf-8")
print(f"wrote {target}")
