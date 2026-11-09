"""Pure-ASGI middleware: request id, access log (no bodies), security headers, body cap."""

from __future__ import annotations

import json
import logging
import secrets
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("writemind.access")

_SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-resource-policy", b"same-site"),
]
# Endpoints that carry user text must never be cached by intermediaries.
_NO_STORE_PREFIXES = ("/v1/check", "/v1/rewrite", "/v1/auth", "/v1/me")


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = _header(scope, b"x-request-id")
        request_id = incoming if incoming and len(incoming) <= 64 else secrets.token_hex(8)
        scope.setdefault("state", {})["request_id"] = request_id
        path: str = scope.get("path", "")
        started = time.perf_counter()
        status_holder = {"status": 500}

        declared = _header(scope, b"content-length")
        if declared and declared.isdigit() and int(declared) > self.max_body_bytes:
            await _send_json(
                send,
                413,
                {
                    "error": {
                        "code": "payload_too_large",
                        "message": "Request body is too large.",
                        "request_id": request_id,
                    }
                },
                request_id,
            )
            self._log(scope, 413, started, request_id)
            return

        received = 0

        async def capped_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    raise _BodyTooLarge
            return message

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode()))
                headers.extend(_SECURITY_HEADERS)
                if path.startswith(_NO_STORE_PREFIXES):
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, capped_receive, send_wrapper)
        except _BodyTooLarge:
            await _send_json(
                send,
                413,
                {
                    "error": {
                        "code": "payload_too_large",
                        "message": "Request body is too large.",
                        "request_id": request_id,
                    }
                },
                request_id,
            )
            status_holder["status"] = 413
        finally:
            self._log(scope, status_holder["status"], started, request_id)

    @staticmethod
    def _log(scope: Scope, status: int, started: float, request_id: str) -> None:
        log.info(
            "request",
            extra={
                "method": scope.get("method"),
                "path": scope.get("path"),
                "status": status,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "request_id": request_id,
            },
        )


class _BodyTooLarge(Exception):
    pass


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key == name:
            return value.decode("latin-1")
    return None


async def _send_json(send: Send, status: int, body: dict, request_id: str) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"x-request-id", request_id.encode()),
                *_SECURITY_HEADERS,
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
