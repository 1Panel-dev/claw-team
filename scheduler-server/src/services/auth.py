from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.core.config import settings
from src.models.app_user import AppUser


AUTH_COOKIE_NAME = "claw_team_session"
AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10
PASSWORD_SCHEME = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 600_000


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    username: str
    display_name: str


def hash_password(password: str, *, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PASSWORD_ITERATIONS,
    )
    return f"{PASSWORD_SCHEME}${PASSWORD_ITERATIONS}${salt}${base64.urlsafe_b64encode(digest).decode('utf-8')}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        scheme, raw_iterations, salt, expected = password_hash.split("$", 3)
    except ValueError:
        return False
    if scheme != PASSWORD_SCHEME:
        return False
    iterations = int(raw_iterations)
    actual = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations,
    )
    actual_encoded = base64.urlsafe_b64encode(actual).decode("utf-8")
    return hmac.compare_digest(actual_encoded, expected)


def ensure_default_user(db: Session) -> AppUser:
    user = db.scalar(select(AppUser).limit(1))
    if user is not None:
        return user
    user = AppUser(
        username=settings.default_login_username,
        display_name=settings.default_login_username,
        password_hash=hash_password(settings.default_login_password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _build_session_signature(user: AppUser) -> str:
    payload = f"{user.id}:{user.password_hash}"
    return hmac.new(
        settings.auth_secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_session_cookie_value(user: AppUser) -> str:
    return f"{user.id}.{_build_session_signature(user)}"


def set_auth_cookie(response: Response, user: AppUser) -> None:
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=build_session_cookie_value(user),
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=AUTH_COOKIE_MAX_AGE,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")


def get_current_user_from_request(request: Request, db: Session) -> AppUser | None:
    raw = request.cookies.get(AUTH_COOKIE_NAME, "").strip()
    if not raw or "." not in raw:
        return None
    user_id, signature = raw.split(".", 1)
    user = db.get(AppUser, user_id)
    if user is None:
        return None
    expected = _build_session_signature(user)
    if not hmac.compare_digest(signature, expected):
        return None
    return user
