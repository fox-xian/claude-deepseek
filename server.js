/**
 * DeepSeek 转发网关 (Node.js)
 *
 * 轻量级代理：接收 Claude Code 发来的 Anthropic 格式请求，
 * 重写模型名称后转发到 DeepSeek API。
 *
 * 用法：
 *   node server.js
 */

const http = require("http");
const https = require("https");

// ---- 配置 ------------------------------------------------------------
const PORT = parseInt(process.env.GATEWAY_PORT || "8082", 10);
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic";
const MODEL_NAME = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

const SKIP_REQ_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

// ---- 工具函数 ---------------------------------------------------------
function rewriteModel(bodyBuf) {
  try {
    const body = JSON.parse(bodyBuf.toString("utf-8"));
    if (body.model) {
      body.model = MODEL_NAME;
    }
    return Buffer.from(JSON.stringify(body), "utf-8");
  } catch {
    return bodyBuf;
  }
}

function buildTargetUrl(pathname, search) {
  const base = DEEPSEEK_BASE.replace(/\/+$/, "");
  let target = base + pathname;
  if (search) target += search;
  return target;
}

function log(level, msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[gateway] [${level}] ${msg}\n`);
}

// ---- 请求处理 ---------------------------------------------------------
const server = http.createServer((req, res) => {
  const startTime = Date.now();
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;
  const search = parsed.search; // 含 ? 的查询字符串
  const logPrefix = `${req.method} ${pathname}`;

  // ---------- 健康检查 ----------
  if (pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    log("info", `${logPrefix} -> 200 (local)`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "HEAD" ? "" : JSON.stringify({ status: "ok", upstream: DEEPSEEK_BASE, model: MODEL_NAME }));
    return;
  }

  // ---------- 根路径 ----------
  if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    log("info", `${logPrefix} -> 200 (local)`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(req.method === "HEAD" ? "" : "ok");
    return;
  }

  // ---------- 模型列表 ----------
  if (pathname === "/v1/models" && (req.method === "GET" || req.method === "HEAD")) {
    log("info", `${logPrefix} -> 200 (local)`);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(
        JSON.stringify({
          data: [{ id: MODEL_NAME, object: "model", created: 0, owned_by: "deepseek" }],
        })
      );
    }
    return;
  }

  // ---------- 代理转发 ----------
  const targetUrl = buildTargetUrl(pathname, search);
  log("info", `${logPrefix} -> ${targetUrl}`);

  // 收集请求体数据块
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);

    // 对消息请求重写模型名称
    if (body.length > 0 && pathname.includes("/messages")) {
      body = rewriteModel(body);
    }

    // 构建上游请求头
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !SKIP_REQ_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }

    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === "https:" ? https : http;

    const proxyReq = transport.request(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: headers,
        rejectUnauthorized: false, // 开发环境允许自签名证书
      },
      (proxyRes) => {
        const elapsed = Date.now() - startTime;
        log("info", `${logPrefix} <- ${proxyRes.statusCode} (${elapsed}ms)`);

        // 复制响应头（跳过逐跳头）
        const resHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value !== undefined) resHeaders[key] = value;
        }
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (e) => {
      const elapsed = Date.now() - startTime;
      log("error", `${logPrefix} ERROR: ${e.message} (${elapsed}ms)`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "gateway_error",
            message: `Failed to reach upstream: ${e.message}`,
          })
        );
      }
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

// ---- 启动服务 ---------------------------------------------------------
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gateway] listening on http://127.0.0.1:${PORT}`);
  console.log(`[gateway] forwarding to ${DEEPSEEK_BASE}`);
  console.log(`[gateway] model rewrite: -> ${MODEL_NAME}`);
});
