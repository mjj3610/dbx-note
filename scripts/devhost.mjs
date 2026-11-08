#!/usr/bin/env node
/**
 * 本地开发宿主（无 DBX 客户端时的替代品）
 *
 * 作用：把 ui/ 静态产物跑起来，并按 DBX 宿主的方式注入 `window.dbxPlugin`，
 * 让 `invoke()` 通过 HTTP 转发到 Rust Sidecar。用于界面联调与自动化截图。
 *
 * 运行：node scripts/devhost.mjs [--port 5195] [--data .tmp/data] [--workspace <path>]
 * 说明：仅用于开发，正式运行请安装 .dbxp 到 DBX。
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const PORT = Number(argValue('port', '5195'))
const DATA_DIR = resolve(ROOT, argValue('data', '.tmp/dev-data'))
const WORKSPACE = argValue('workspace', '')
const UI_DIR = join(ROOT, 'ui')
// 默认用 release 产物；本地快速回归可用 DBX_NOTE_BACKEND 指向 debug 二进制
const BIN = process.env.DBX_NOTE_BACKEND
  ? resolve(process.env.DBX_NOTE_BACKEND)
  : join(ROOT, 'backend', 'target', 'release', process.platform === 'win32' ? 'backend.exe' : 'backend')

if (!existsSync(UI_DIR)) {
  console.error('缺少 ui/ 产物，请先运行 npm run build')
  process.exit(1)
}
if (!existsSync(BIN)) {
  console.error(`缺少后端可执行文件：${BIN}，请先运行 npm run backend`)
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })

const backend = spawn(BIN, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: DATA_DIR },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const pending = new Map()
let buffer = ''
backend.stdout.setEncoding('utf8')
backend.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      const waiter = pending.get(String(message.id))
      if (waiter) {
        pending.delete(String(message.id))
        waiter(message)
      }
    } catch (error) {
      console.error('[devhost] 无法解析后端消息', error)
    }
  }
})
backend.stderr.setEncoding('utf8')
backend.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`))

/** 转发一次 RPC 调用 */
function callBackend(method, params, timeoutMs = 20000) {
  const id = randomUUID()
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`后端响应超时：${method}`))
    }, timeoutMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) rejectPromise(new Error(message.error.message))
      else resolvePromise(message.result)
    })
    backend.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** 宿主注入脚本：模拟 dbxPlugin 桥接 */
const shim = `
window.dbxPlugin = {
  ready: Promise.resolve({ host: { platform: 'dev' } }),
  context: { locale: 'zh-CN' },
  locale: new URLSearchParams(location.search).get('locale') || 'zh-CN',
  theme: { appearance: new URLSearchParams(location.search).get('theme') || 'light' },
  async request() { return {} },
  async copy(text) {
    try { await navigator.clipboard.writeText(text); return true } catch { return false }
  },
  async invoke(method, params, options) {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params, timeoutMs: options && options.timeoutMs }),
    })
    const payload = await response.json()
    if (payload.error) throw new Error(payload.error.message)
    return payload.result
  },
}
`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const server = createServer(async (request, response) => {
  if (request.url === '/rpc' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const result = await callBackend(body.method, body.params ?? {}, body.timeoutMs ?? 20000)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: -32000, message: error.message } }))
    }
    return
  }

  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const relative = url.pathname === '/' ? '/index.html' : url.pathname
  const filePath = join(UI_DIR, normalize(relative).replace(/^([.][.][/\\])+/, ''))
  if (!filePath.startsWith(UI_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404)
    response.end('Not found')
    return
  }

  if (filePath.endsWith('index.html')) {
    let html = readFileSync(filePath, 'utf8')
    html = html.replace('<head>', `<head>\n<script>${shim}</script>`)
    response.writeHead(200, { 'content-type': MIME['.html'] })
    response.end(html)
    return
  }

  response.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(response)
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`DBX Note 开发宿主：http://127.0.0.1:${PORT}/`)
  console.log(`数据目录：${DATA_DIR}`)
  try {
    await callBackend('plugin/initialize', { host: { protocolVersions: [1] } }, 5000)
    if (WORKSPACE) {
      await callBackend('workspace/set', { path: resolve(WORKSPACE) }, 10000)
      console.log(`工作区：${resolve(WORKSPACE)}`)
    }
  } catch (error) {
    console.error('初始化后端失败：', error.message)
  }
})

const shutdown = () => {
  backend.kill()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
