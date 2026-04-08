from __future__ import annotations

import httpx
from fastapi import HTTPException

HEALTH_CHECK_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
CHANNEL_FETCH_TIMEOUT = 60.0

"""针对 OpenClaw 实例的底层 HTTP 探测函数。"""


def fetch_channel_agents(base_url: str) -> list[dict]:
    """确认插件健康后，再拉取远端 agent 列表。"""
    try:
        with httpx.Client(timeout=CHANNEL_FETCH_TIMEOUT, verify=False) as client:
            health = client.get(f"{base_url}/clawswarm/v1/health")
            health.raise_for_status()
            agents_response = client.get(f"{base_url}/clawswarm/v1/agents")
            agents_response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
    except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
        raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=502,
                detail="clawswarm plugin is unavailable on the OpenClaw instance",
            ) from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc

    try:
        agents_payload = agents_response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc
    if not isinstance(agents_payload, list):
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response")
    return [item for item in agents_payload if isinstance(item, dict)]


def probe_channel_health(base_url: str) -> bool:
    """返回远端健康检查接口是否正常响应。"""
    try:
        with httpx.Client(timeout=HEALTH_CHECK_TIMEOUT, verify=False) as client:
            response = client.get(f"{base_url.rstrip('/')}/clawswarm/v1/health")
            response.raise_for_status()
            return True
    except httpx.HTTPError:
        return False
