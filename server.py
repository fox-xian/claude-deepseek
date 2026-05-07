"""
DeepSeek 转发网关 (Python)

轻量级代理：接收 Claude Code 发来的 Anthropic 格式请求，
重写模型名称后转发到 DeepSeek API。

用法：
  pip install starlette httpx uvicorn
  python src/deepseek-gateway/server.py
"""

import json
import os
import time

from starlette.applications import Starlette
from starlette.requests import Request as SRequest
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route
import httpx
import uvicorn

PORT = int(os.environ.get("GATEWAY_PORT", "8082"))
DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic")
MODEL_NAME = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro")

SKIP_REQ_HEADERS = {"host", "content-length"}


def rewrite_model(body_bytes: bytes) -> bytes:
    try:
        body = json.loads(body_bytes)
        if "model" in body:
            body["model"] = MODEL_NAME
        return json.dumps(body).encode()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body_bytes


def build_target_url(path: str, query: str) -> str:
    base = DEEPSEEK_BASE.rstrip("/")
    url = f"{base}{path}"
    if query:
        url += f"?{query}"
    return url


async def health(request):
    return Response(
        json.dumps({"status": "ok", "upstream": DEEPSEEK_BASE, "model": MODEL_NAME}),
        status_code=200,
        media_type="application/json",
    )


async def proxy(request):
    start_time = time.time()
    path = request.url.path
    method = request.method
    target_url = build_target_url(path, request.url.query)

    # Build headers to forward
    headers = {}
    for key, value in request.headers.items():
        if key.lower() not in SKIP_REQ_HEADERS:
            headers[key] = value

    # Read and possibly rewrite body
    body = await request.body()
    if body and "/messages" in path:
        body = rewrite_model(body)

    log_prefix = f"{method} {path}"
    print(f"[gateway] {log_prefix} -> {target_url}")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(None)) as client:
            upstream_resp = await client.request(
                method=method,
                url=target_url,
                headers=headers,
                content=body,
            )

        elapsed = (time.time() - start_time) * 1000
        print(f"[gateway] {log_prefix} <- {upstream_resp.status_code} ({elapsed:.0f}ms)")

        # Stream the response back
        return StreamingResponse(
            upstream_resp.aiter_bytes(),
            status_code=upstream_resp.status_code,
            headers=dict(upstream_resp.headers),
        )

    except httpx.RequestError as e:
        elapsed = (time.time() - start_time) * 1000
        print(f"[gateway] {log_prefix} ERROR: {e} ({elapsed:.0f}ms)")
        return Response(
            json.dumps({"error": "gateway_error", "message": f"Failed to reach upstream: {e}"}),
            status_code=502,
            media_type="application/json",
        )


async def list_models(request):
    """模拟 /v1/models 响应，因为 DeepSeek 的 Anthropic 端点可能不支持该接口。"""
    return Response(
        json.dumps({
            "data": [
                {"id": MODEL_NAME, "object": "model", "created": 0, "owned_by": "deepseek"}
            ]
        }),
        status_code=200,
        media_type="application/json",
    )


class ProxyEndpoint:
    """接受所有 HTTP 方法的 ASGI 端点。"""

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        request = SRequest(scope, receive, send)
        response = await proxy(request)
        await response(scope, receive, send)


async def root(request):
    return Response("ok", status_code=200)


routes = [
    Route("/", root),
    Route("/health", health, methods=["GET"]),
    Route("/v1/models", list_models, methods=["GET"]),
    Route("/{path:path}", ProxyEndpoint()),
]

app = Starlette(routes=routes)

if __name__ == "__main__":
    print(f"[gateway] listening on http://127.0.0.1:{PORT}")
    print(f"[gateway] forwarding to {DEEPSEEK_BASE}")
    print(f"[gateway] model rewrite: -> {MODEL_NAME}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
