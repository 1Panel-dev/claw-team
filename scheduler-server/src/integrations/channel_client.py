"""
这个模块负责从 scheduler-server 调用 channel。
第一阶段所有到 channel 的出站调用都应集中在这里。
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import httpx

from src.core.config import settings
from src.core.security import build_channel_canonical_string, hmac_sha256_hex, new_nonce, now_ms, sha256_hex
from src.models.openclaw_instance import OpenClawInstance


class ChannelClient:
    async def _signed_request(
        self,
        *,
        instance: OpenClawInstance,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        normalized_method = method.upper()
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
        timestamp_ms = now_ms()
        nonce = new_nonce()
        canonical = build_channel_canonical_string(
            timestamp_ms=timestamp_ms,
            nonce=nonce,
            method=normalized_method,
            path=path,
            body_sha256_hex=sha256_hex(body),
        )
        signature = hmac_sha256_hex(instance.channel_signing_secret, canonical)
        headers = {
            "content-type": "application/json; charset=utf-8",
            "x-oc-accountid": instance.channel_account_id,
            "x-oc-timestamp": str(timestamp_ms),
            "x-oc-nonce": nonce,
            "x-oc-signature": signature,
        }
        url = instance.channel_base_url.rstrip("/") + path
        async with httpx.AsyncClient(
            timeout=timeout,
            verify=not settings.channel_allow_insecure_tls,
        ) as client:
            response = await client.request(
                normalized_method,
                url,
                content=body if payload is not None else None,
                headers=headers,
            )
        response.raise_for_status()
        return response.json()

    async def send_inbound(self, *, instance: OpenClawInstance, payload: dict[str, Any]) -> dict[str, Any]:
        """
        把调度中心的一条消息转发给对应 OpenClaw 实例上的 channel。

        注意：
        1. 这里的签名规则要和 channel 插件侧完全一致。
        2. 当前远程 OpenClaw 使用的是自签证书 HTTPS，所以 verify 是否开启由配置决定。
        """
        path = "/clawswarm/v1/inbound"
        return await self._signed_request(instance=instance, method="POST", path=path, payload=payload)

    async def create_agent(self, *, instance: OpenClawInstance, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._signed_request(
            instance=instance,
            method="POST",
            path="/clawswarm/v1/admin/agents",
            payload=payload,
            timeout=60.0,
        )

    async def get_agent_profile(self, *, instance: OpenClawInstance, agent_key: str) -> dict[str, Any]:
        encoded_agent_key = quote(agent_key, safe="")
        return await self._signed_request(
            instance=instance,
            method="GET",
            path=f"/clawswarm/v1/admin/agents/{encoded_agent_key}/profile",
            payload=None,
            timeout=30.0,
        )

    async def update_agent(self, *, instance: OpenClawInstance, agent_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        encoded_agent_key = quote(agent_key, safe="")
        return await self._signed_request(
            instance=instance,
            method="PUT",
            path=f"/clawswarm/v1/admin/agents/{encoded_agent_key}/profile",
            payload=payload,
            timeout=60.0,
        )


channel_client = ChannelClient()
