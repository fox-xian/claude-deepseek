/**
 * DeepSeek 转发网关
 *
 * 轻量级代理：接收 Claude Code 发来的 Anthropic 格式请求，
 * 重写模型名称为 deepseek-v4-pro 后转发到 DeepSeek 的
 * Anthropic 兼容端点。
 *
 * 用法：
 *   GATEWAY_PORT=8082 DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic \
 *     bun run src/deepseek-gateway/server.ts
 *
 * Claude Code 配置 (~/.claude/settings.json):
 *   { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8082" } }
 */

const PORT = parseInt(process.env.GATEWAY_PORT || '8082', 10)
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
const MODEL_NAME = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'

function rewriteModel(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText)
    if (body.model) {
      body.model = MODEL_NAME
    }
    return JSON.stringify(body)
  } catch {
    return bodyText
  }
}

function buildTargetUrl(pathname: string, search: string): string {
  return `${DEEPSEEK_BASE}${pathname}${search}`
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const startTime = Date.now()

  // 健康检查
  if (url.pathname === '/health' && req.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', upstream: DEEPSEEK_BASE, model: MODEL_NAME }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const targetUrl = buildTargetUrl(url.pathname, url.search)

  let body: string | null = null
  const headers: Record<string, string> = {}

  // 转发大部分请求头，跳过 host
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    // 让 fetch 根据 body 自动设置 content-length
    if (lower === 'content-length') continue
    headers[key] = value
  }

  // 对 /v1/messages 请求重写模型名称
  if (req.body && url.pathname.includes('/messages')) {
    body = await req.text()
    body = rewriteModel(body)
  }

  const logPrefix = `${req.method} ${url.pathname}`
  console.log(`[gateway] ${logPrefix} -> ${targetUrl}`)

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    })

    const elapsed = Date.now() - startTime
    console.log(`[gateway] ${logPrefix} <- ${resp.status} (${elapsed}ms)`)

    // 流式返回响应
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    })
  } catch (err) {
    const elapsed = Date.now() - startTime
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[gateway] ${logPrefix} ERROR: ${message} (${elapsed}ms)`)

    return new Response(JSON.stringify({
      error: 'gateway_error',
      message: `Failed to reach upstream: ${message}`,
    }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: handleRequest,
})

console.log(`[gateway] listening on http://127.0.0.1:${PORT}`)
console.log(`[gateway] forwarding to ${DEEPSEEK_BASE}`)
console.log(`[gateway] model rewrite: -> ${MODEL_NAME}`)
