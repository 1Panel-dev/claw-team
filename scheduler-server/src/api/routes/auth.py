from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.core.config import settings
from src.models.app_user import AppUser
from src.services.auth import clear_auth_cookie, ensure_default_user, get_current_user_from_request, set_auth_cookie, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=255)


class AuthUserRead(BaseModel):
    id: str
    username: str
    display_name: str
    using_default_password: bool


class ProfileUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    current_password: str | None = Field(default=None, min_length=1, max_length=255)
    new_password: str | None = Field(default=None, min_length=8, max_length=255)


def _using_default_password(user: AppUser) -> bool:
    return user.username == settings.default_login_username and verify_password(settings.default_login_password, user.password_hash)


@router.post("/login", response_model=AuthUserRead)
def login(payload: LoginRequest, response: Response, db: Session = Depends(db_session)) -> AuthUserRead:
    ensure_default_user(db)
    user = db.scalar(select(AppUser).where(AppUser.username == payload.username.strip()))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    set_auth_cookie(response, user)
    return AuthUserRead(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        using_default_password=_using_default_password(user),
    )


@router.post("/logout")
def logout(response: Response) -> dict[str, bool]:
    clear_auth_cookie(response)
    return {"ok": True}


@router.get("/me", response_model=AuthUserRead)
def me(request: Request, db: Session = Depends(db_session)) -> AuthUserRead:
    user = get_current_user_from_request(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return AuthUserRead(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        using_default_password=_using_default_password(user),
    )


@router.put("/profile", response_model=AuthUserRead)
def update_profile(
    payload: ProfileUpdateRequest,
    request: Request,
    response: Response,
    db: Session = Depends(db_session),
) -> AuthUserRead:
    from src.services.auth import hash_password

    user = get_current_user_from_request(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name is required")

    if payload.new_password is not None:
        if not payload.current_password or not verify_password(payload.current_password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        if not payload.new_password.strip():
            raise HTTPException(status_code=400, detail="New password cannot be empty")

    user.display_name = display_name
    if payload.new_password:
        user.password_hash = hash_password(payload.new_password)
    db.commit()
    db.refresh(user)
    set_auth_cookie(response, user)
    return AuthUserRead(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        using_default_password=_using_default_password(user),
    )
