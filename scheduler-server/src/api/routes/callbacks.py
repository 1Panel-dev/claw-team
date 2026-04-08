"""ClawSwarm 回调路由。

这一层只保留请求入口职责：
- 根据回调 token 找到实例
- 校验可选的回调签名
- 把通过校验的请求委托给专门的 service
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.core.security import verify_callback_signature
from src.models.openclaw_instance import OpenClawInstance
from src.services.callback_event_service import handle_callback_event
from src.services.send_text_service import handle_send_text
from src.services.webchat_mirror_service import mirror_webchat_message as handle_webchat_mirror_message

router = APIRouter(prefix="/api/v1/clawswarm", tags=["callbacks"])


class WebchatMirrorCreate(BaseModel):
    """镜像 OpenClaw Web UI 消息所需的最小载荷。"""

    channelId: str = Field(min_length=1)
    sessionKey: str = Field(min_length=1)
    messageId: str = Field(min_length=1)
    senderType: str = Field(min_length=1)
    content: str = Field(min_length=1)
    timestamp: int | None = Field(default=None, ge=0)


class SendTextCreate(BaseModel):
    kind: str = Field(min_length=1)
    sourceCsId: str = Field(min_length=1)
    targetCsId: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    message: str = Field(min_length=1)
    windowSeconds: int = Field(default=300, ge=60, le=3600)
    softMessageLimit: int = Field(default=12, ge=2, le=100)
    hardMessageLimit: int = Field(default=20, ge=3, le=200)


@router.post("/events")
async def receive_callback(request: Request, db: Session = Depends(db_session)) -> dict[str, bool]:
    body = await request.body()
    auth_header = request.headers.get("authorization", "")
    timestamp = request.headers.get("x-clawswarm-timestamp", "")
    signature = request.headers.get("x-clawswarm-signature", "")

    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

    # 如果 channel 附带了 HMAC 签名，先校验通过再信任这次回调。
    if timestamp and signature and not verify_callback_signature(token=token, timestamp=timestamp, body=body, signature=signature):
        raise HTTPException(status_code=401, detail="bad callback signature")

    return await handle_callback_event(db=db, instance=instance, event=json.loads(body.decode("utf-8")))


@router.post("/webchat-mirror")
async def mirror_webchat_message(
    payload: WebchatMirrorCreate,
    request: Request,
    db: Session = Depends(db_session),
) -> dict[str, Any]:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

    return await handle_webchat_mirror_message(db=db, instance=instance, payload=payload)


@router.post("/send-text")
async def receive_send_text(
    payload: SendTextCreate,
    request: Request,
    db: Session = Depends(db_session),
) -> dict[str, Any]:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

    return await handle_send_text(db=db, instance=instance, payload=payload)
