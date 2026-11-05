#!/usr/bin/env node
/**
 * 假的 MCP 服务（stdio / JSON-RPC 2.0），只用于本地测试
 *
 * 实现 initialize、tools/list、tools/call 三个方法，
 * 暴露一个 echo 工具，方便验证 Sidecar 的 mcp/* 通道。
 *
 * 运行：node scripts/mock-mcp.mjs
 */
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: '原样返回传入的文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'now',
    description: '返回当前时间',
    inputSchema: { type: 'object', properties: {} },
  },
]

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return
  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    return
  }
  // 通知没有 id，不用回
  if (request.id === undefined) return
  const { id, method, params = {} } = request

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.0' },
      },
    })
    return
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }

  if (method === 'tools/call') {
    const name = params.name
    if (name === 'echo') {
      const text = String(params.arguments?.text ?? '')
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `echo: ${text}` }], isError: false },
      })
      return
    }
    if (name === 'now') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: new Date().toISOString() }], isError: false },
      })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具：${name}` } })
    return
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法：${method}` } })
})
