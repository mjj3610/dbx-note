#!/usr/bin/env node
/**
 * 本地假模型服务（OpenAI 兼容），用于端到端测试流式对话
 *
 * 提供：
 * - POST /v1/chat/completions（stream=true 时按 SSE 分块返回）
 * - GET  /v1/models
 *
 * 运行：node scripts/mock-ai.mjs [--port 5199]
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 5199

/** 逐块吐出的固定回复，便于断言 */
const REPLY = [
  '### 笔记摘要\n\n',
  '这是一段由本地假模型返回的内容，用于验证流式输出与插入。\n\n',
  '- 第一条要点\n',
  '- 第二条要点\n\n',
  '> 引用块用于检查 Markdown 渲染。\n',
]

function readBody(request) {
  return new Promise((resolvePromise) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
  })
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`)

  if (url.pathname.endsWith('/models') && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'mock-note-model' }, { id: 'mock-fast-model' }] }))
    return
  }

  if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
    const raw = await readBody(request)
    const body = JSON.parse(raw || '{}')
    const streaming = body.stream === true

    // 选区 AI（润色 / 精简 / 扩写 / 翻译）：回显「标记 + 原文首行」，
    // 便于端到端断言「替换选区后正文真的变了」
    const lastUser = Array.isArray(body.messages)
      ? [...body.messages].reverse().find((message) => message.role === 'user')
      : null
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const marker = /润色这段文字[：:]/.test(prompt)
      ? '已润色'
      : /精简这段文字[：:]/.test(prompt)
        ? '已精简'
        : /扩写这段文字[：:]/.test(prompt)
          ? '已扩写'
          : /将这段文字[：:]/.test(prompt)
            ? '已翻译'
            : ''
    const reply = marker ? [`${marker}：${(prompt.split('\n')[1] ?? '').trim()}`] : REPLY

    // 多模态消息：带 image_url 时按「图片识别」返回固定文本
    const vision = Array.isArray(body.messages)
      ? body.messages.some(
          (message) =>
            Array.isArray(message?.content) &&
            message.content.some((part) => part?.type === 'image_url'),
        )
      : false

    if (vision) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '识别结果：这是一张测试图片，上面的文字是「DBX 笔记」。',
              },
            },
          ],
          usage: { total_tokens: 32 },
        }),
      )
      return
    }

    if (!streaming) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply.join('') } }],
          usage: { total_tokens: 64 },
        }),
      )
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    let index = 0
    const timer = setInterval(() => {
      if (index >= reply.length) {
        clearInterval(timer)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      const payload = {
        choices: [{ delta: { content: reply[index] }, index: 0 }],
      }
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
      index += 1
    }, 80)

    request.on('close', () => clearInterval(timer))
    return
  }

  // 语音转写：只要收到文件就返回固定文本
  if (url.pathname.endsWith('/audio/transcriptions') && request.method === 'POST') {
    await readBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: '这是一段语音转写测试文本。' }))
    return
  }

  /* ---------------- PicGo 图床模拟 ---------------- */

  // PicGo 的连通性探测走 `/heartbeat`
  if (url.pathname.endsWith('/heartbeat')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true }))
    return
  }

  // PicGo 上传：POST { list: [本地路径] } → { success, result: [url] }
  if (url.pathname.endsWith('/upload') && request.method === 'POST') {
    const raw = await readBody(request)
    let uploaded = 'image'
    try {
      const body = JSON.parse(raw || '{}')
      const first = Array.isArray(body.list) ? String(body.list[0] ?? '') : ''
      if (first) uploaded = first.split(/[\\/]/).pop() || 'image'
    } catch {
      /* 解析失败就用默认名 */
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ success: true, result: [`http://127.0.0.1:${PORT}/files/${uploaded}`] }),
    )
    return
  }

  // 上传后的图片本体：宿主 CSP 拦外链，插件会经 Sidecar 取回，这里给一张 1×1 PNG
  if (url.pathname.startsWith('/files/') && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    return
  }

  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'not found' } }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假模型服务已启动：http://127.0.0.1:${PORT}/v1`)
})
