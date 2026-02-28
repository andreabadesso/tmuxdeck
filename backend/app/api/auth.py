"""Auth API endpoints for PIN-based authentication."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import auth
from ..rate_limit import get_limiter

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
logger = logging.getLogger(__name__)

SESSION_COOKIE = "session"
COOKIE_MAX_AGE = auth.SESSION_MAX_AGE

# Alert thresholds
_ALERT_AFTER_FAILURES = 3


class PinBody(BaseModel):
    pin: str = Field(..., min_length=4, max_length=4, pattern=r"^\d{4}$")


class ChangePinBody(BaseModel):
    current_pin: str = Field(..., alias="currentPin", min_length=4, max_length=4, pattern=r"^\d{4}$")
    new_pin: str = Field(..., alias="newPin", min_length=4, max_length=4, pattern=r"^\d{4}$")



def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=COOKIE_MAX_AGE,
        path="/",
    )


def _is_authenticated(request: Request) -> bool:
    token = request.cookies.get(SESSION_COOKIE)
    return token is not None and auth.validate_session(token)


def _get_client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _fire_security_alert(title: str, message: str) -> None:
    """Send a security alert to Telegram (fire-and-forget)."""
    try:
        from ..services.telegram_bot import send_security_alert
        asyncio.create_task(send_security_alert(title, message))
    except Exception:
        logger.debug("Could not send security alert (Telegram bot not available)")


@router.get("/status")
async def auth_status(request: Request):
    limiter = get_limiter()
    return {
        "authenticated": _is_authenticated(request),
        "pinSet": auth.is_pin_set(),
        "locked": limiter.is_any_locked(),
    }


@router.post("/setup")
async def auth_setup(body: PinBody, response: Response):
    if auth.is_pin_set():
        return Response(
            content='{"detail":"PIN already configured"}',
            status_code=400,
            media_type="application/json",
        )
    pin_hash = auth.hash_pin(body.pin)
    auth.set_pin_hash(pin_hash)
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/login")
async def auth_login(body: PinBody, request: Request, response: Response):
    stored = auth.get_pin_hash()
    if stored is None:
        return Response(
            content='{"detail":"No PIN configured"}',
            status_code=400,
            media_type="application/json",
        )

    ip = _get_client_ip(request)
    limiter = get_limiter()

    # Check rate limit before PIN verification
    check = limiter.check(ip)
    if not check.allowed:
        if check.locked:
            return Response(
                content=json.dumps({
                    "detail": "Account locked due to too many failed attempts",
                    "locked": True,
                }),
                status_code=423,
                media_type="application/json",
            )
        return Response(
            content=json.dumps({
                "detail": "Too many login attempts",
                "retryAfter": round(check.retry_after, 1),
            }),
            status_code=429,
            media_type="application/json",
        )

    if not auth.verify_pin(body.pin, stored):
        result = limiter.record_failure(ip)

        # Build response payload
        payload: dict = {
            "detail": "Invalid PIN",
            "remainingAttempts": result["remaining_attempts"],
        }
        if result["retry_after"] > 0:
            payload["retryAfter"] = round(result["retry_after"], 1)
        if result["locked"]:
            payload["locked"] = True

        # Send Telegram alerts
        failures = limiter._get(ip).failures
        if result["locked"]:
            _fire_security_alert(
                "Login LOCKED",
                f"Login LOCKED after {failures} failed attempts from {ip}. "
                "Use /unlock to restore access.",
            )
        elif failures >= _ALERT_AFTER_FAILURES:
            _fire_security_alert(
                "Failed login attempts",
                f"Failed login attempt from {ip} ({failures} attempts)",
            )

        status = 423 if result["locked"] else 401
        return Response(
            content=json.dumps(payload),
            status_code=status,
            media_type="application/json",
        )

    # Success — reset rate limiter
    limiter.record_success(ip)
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        auth.destroy_session(token)
    response.delete_cookie(key=SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/change-pin")
async def auth_change_pin(request: Request, body: ChangePinBody, response: Response):
    # Must be authenticated
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )
    stored = auth.get_pin_hash()
    if stored is None or not auth.verify_pin(body.current_pin, stored):
        return Response(
            content='{"detail":"Current PIN is incorrect"}',
            status_code=401,
            media_type="application/json",
        )
    new_hash = auth.hash_pin(body.new_pin)
    auth.set_pin_hash(new_hash)
    # Issue a fresh session
    old_token = request.cookies.get(SESSION_COOKIE)
    if old_token:
        auth.destroy_session(old_token)
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/unlock")
async def auth_unlock(request: Request):
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )
    limiter = get_limiter()
    limiter.unlock_all()
    _fire_security_alert("Login unlocked", "Login unlocked via web API")
    return {"ok": True}
