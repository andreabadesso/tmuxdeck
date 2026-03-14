"""Auth API endpoints for PIN-based and WebAuthn authentication."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

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
    current_pin: str = Field(
        ..., alias="currentPin", min_length=4, max_length=4, pattern=r"^\d{4}$",
    )
    new_pin: str = Field(
        ..., alias="newPin", min_length=4, max_length=4, pattern=r"^\d{4}$",
    )



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
        "webauthnEnabled": auth.has_webauthn_credentials(),
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


# --- WebAuthn helpers ---


def _get_rp_id(request: Request) -> str:
    return request.url.hostname or "localhost"


def _get_origin(request: Request) -> str:
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.netloc)
    return f"{scheme}://{host}"


_RP_NAME = "Claude Box"
_USER_ID = b"claude-box-user"
_USER_NAME = "admin"


# --- WebAuthn Registration ---


class WebAuthnRegisterVerifyBody(BaseModel):
    name: str = Field(default="Security Key", max_length=64)
    credential: dict


@router.post("/webauthn/register/options")
async def webauthn_register_options(request: Request):
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )

    from webauthn.helpers import base64url_to_bytes

    rp_id = _get_rp_id(request)
    existing = auth.get_webauthn_credentials()
    exclude_credentials = [
        PublicKeyCredentialDescriptor(
            id=base64url_to_bytes(c["id"]),
            transports=[AuthenticatorTransport(t) for t in c.get("transports", [])],
        )
        for c in existing
    ]

    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=_RP_NAME,
        user_id=_USER_ID,
        user_name=_USER_NAME,
        user_display_name=_USER_NAME,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.DISCOURAGED,
            user_verification=UserVerificationRequirement.DISCOURAGED,
        ),
        exclude_credentials=exclude_credentials,
    )

    # Store challenge keyed by session token
    token = request.cookies.get(SESSION_COOKIE, "")
    auth.store_challenge(f"reg:{token}", options.challenge)

    return json.loads(options.model_dump_json())


@router.post("/webauthn/register/verify")
async def webauthn_register_verify(request: Request, body: WebAuthnRegisterVerifyBody):
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )

    token = request.cookies.get(SESSION_COOKIE, "")
    challenge = auth.retrieve_challenge(f"reg:{token}")
    if challenge is None:
        return Response(
            content='{"detail":"Challenge expired or missing. Please try again."}',
            status_code=400,
            media_type="application/json",
        )

    rp_id = _get_rp_id(request)
    origin = _get_origin(request)

    try:
        verification = verify_registration_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=False,
        )
    except Exception as e:
        logger.warning("WebAuthn registration verification failed: %s", e)
        return Response(
            content=json.dumps({"detail": f"Verification failed: {e}"}),
            status_code=400,
            media_type="application/json",
        )

    from webauthn.helpers import bytes_to_base64url

    # Extract transports from the credential response
    transports = []
    if isinstance(body.credential, dict):
        transports = body.credential.get("response", {}).get("transports", [])
        if not transports:
            transports = body.credential.get("transports", [])

    cred_record = {
        "id": bytes_to_base64url(verification.credential_id),
        "publicKey": verification.credential_public_key.hex(),
        "signCount": verification.sign_count,
        "transports": transports,
        "name": body.name,
        "createdAt": datetime.now(UTC).isoformat(),
    }
    auth.add_webauthn_credential(cred_record)
    logger.info("WebAuthn credential registered: %s", body.name)
    return {"ok": True, "credential": {"id": cred_record["id"], "name": cred_record["name"]}}


# --- WebAuthn Credential Management ---


@router.get("/webauthn/credentials")
async def webauthn_list_credentials(request: Request):
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )
    creds = auth.get_webauthn_credentials()
    # Return safe subset (no public key material)
    return {
        "credentials": [
            {
                "id": c["id"],
                "name": c.get("name", "Security Key"),
                "createdAt": c.get("createdAt", ""),
                "transports": c.get("transports", []),
            }
            for c in creds
        ]
    }


@router.delete("/webauthn/credentials/{credential_id:path}")
async def webauthn_delete_credential(credential_id: str, request: Request):
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )
    if not auth.remove_webauthn_credential(credential_id):
        return Response(
            content='{"detail":"Credential not found"}',
            status_code=404,
            media_type="application/json",
        )
    logger.info("WebAuthn credential removed: %s", credential_id)
    return {"ok": True}


# --- WebAuthn Authentication ---


@router.post("/webauthn/login/options")
async def webauthn_login_options(request: Request):
    creds = auth.get_webauthn_credentials()
    if not creds:
        return Response(
            content='{"detail":"No security keys registered"}',
            status_code=400,
            media_type="application/json",
        )

    from webauthn.helpers import base64url_to_bytes

    rp_id = _get_rp_id(request)
    allow_credentials = [
        PublicKeyCredentialDescriptor(
            id=base64url_to_bytes(c["id"]),
            transports=[AuthenticatorTransport(t) for t in c.get("transports", [])],
        )
        for c in creds
    ]

    options = generate_authentication_options(
        rp_id=rp_id,
        allow_credentials=allow_credentials,
        user_verification=UserVerificationRequirement.DISCOURAGED,
    )

    # Store challenge keyed by client IP (no session yet)
    ip = _get_client_ip(request)
    auth.store_challenge(f"login:{ip}", options.challenge)

    resp = json.loads(options.model_dump_json())
    return resp


class WebAuthnLoginVerifyBody(BaseModel):
    credential: dict


@router.post("/webauthn/login/verify")
async def webauthn_login_verify(
    body: WebAuthnLoginVerifyBody, request: Request, response: Response,
):
    ip = _get_client_ip(request)
    limiter = get_limiter()

    # Rate limit check (shared with PIN login)
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

    challenge = auth.retrieve_challenge(f"login:{ip}")
    if challenge is None:
        return Response(
            content='{"detail":"Challenge expired or missing. Please try again."}',
            status_code=400,
            media_type="application/json",
        )

    rp_id = _get_rp_id(request)
    origin = _get_origin(request)

    # Find matching credential by ID (base64url-encoded)
    raw_id = body.credential.get("rawId", body.credential.get("id", ""))
    creds = auth.get_webauthn_credentials()
    matched_cred = None
    for c in creds:
        if c["id"] == raw_id:
            matched_cred = c
            break

    if matched_cred is None:
        result = limiter.record_failure(ip)
        failures = limiter._get(ip).failures
        if result["locked"]:
            _fire_security_alert(
                "Login LOCKED",
                f"Login LOCKED after {failures} failed WebAuthn attempts from {ip}.",
            )
        elif failures >= _ALERT_AFTER_FAILURES:
            _fire_security_alert(
                "Failed login attempts",
                f"Failed WebAuthn login from {ip} ({failures} attempts)",
            )
        return Response(
            content='{"detail":"Unknown credential"}',
            status_code=401,
            media_type="application/json",
        )

    try:
        verification = verify_authentication_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=bytes.fromhex(matched_cred["publicKey"]),
            credential_current_sign_count=matched_cred.get("signCount", 0),
            require_user_verification=False,
        )
    except Exception as e:
        logger.warning("WebAuthn authentication failed: %s", e)
        result = limiter.record_failure(ip)
        failures = limiter._get(ip).failures
        if result["locked"]:
            _fire_security_alert(
                "Login LOCKED",
                f"Login LOCKED after {failures} failed WebAuthn attempts from {ip}.",
            )
        elif failures >= _ALERT_AFTER_FAILURES:
            _fire_security_alert(
                "Failed login attempts",
                f"Failed WebAuthn login from {ip} ({failures} attempts)",
            )
        payload: dict = {"detail": "Authentication failed"}
        if result["remaining_attempts"] > 0:
            payload["remainingAttempts"] = result["remaining_attempts"]
        if result["retry_after"] > 0:
            payload["retryAfter"] = round(result["retry_after"], 1)
        if result["locked"]:
            payload["locked"] = True
        status = 423 if result["locked"] else 401
        return Response(
            content=json.dumps(payload),
            status_code=status,
            media_type="application/json",
        )

    # Success
    auth.update_webauthn_sign_count(matched_cred["id"], verification.new_sign_count)
    limiter.record_success(ip)
    token = auth.create_session()
    _set_session_cookie(response, token)
    logger.info("WebAuthn login successful from %s", ip)
    return {"ok": True}
