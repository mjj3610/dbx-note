#!/usr/bin/env node
/**
 * 通过 REST 直接向 t8y2/dbx-store 提候选 PR。
 *
 * 为什么不用 gh-publish 的 pr 子命令：它需要本地有一份带上游历史的 git 分支才能推，
 * 而本机走代理 clone/fetch 持续 502（git smart-http 被拦），改走 contents API 在
 * fork 的 main 上直接落一个提交——历史与上游同源，PR diff 只有一个文件。
 *
 * 用法：node store-submission/open-pr.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const UPSTREAM = 't8y2/dbx-store'
const BASE = 'main'
// 候选文件从仓库内取（由 make-store-candidate.mjs 依 CI 指纹生成），不依赖 .tmp 里的临时副本
const PLUGIN_ID = JSON.parse(readFileSync('manifest.json', 'utf8')).id
const CANDIDATE_PATH = `store-submission/candidates/${PLUGIN_ID}.json`
const BODY_PATH = 'store-submission/PR_BODY.md'

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const match = out.match(/^password=(.+)$/m)
  if (!match) throw new Error('git credential fill 没返回令牌')
  return match[1].trim()
}

const TOKEN = token()

async function api(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dbx-note-store-pr',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data }
}

async function must(method, path, body) {
  const result = await api(method, path, body)
  if (!result.ok) {
    throw new Error(`${method} ${path} → ${result.status}: ${JSON.stringify(result.data).slice(0, 400)}`)
  }
  return result.data
}

const me = await must('GET', '/user')
const login = me.login
console.log(`身份：${login}`)

const candidate = readFileSync(CANDIDATE_PATH, 'utf8')
const parsed = JSON.parse(candidate)
const body = readFileSync(BODY_PATH, 'utf8')

// 1) fork（已存在则复用）
const forkRepo = `${login}/dbx-store`
let fork = await api('GET', `/repos/${forkRepo}`)
if (!fork.ok) {
  console.log(`fork ${UPSTREAM} …`)
  await api('POST', `/repos/${UPSTREAM}/forks`)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 3000))
    fork = await api('GET', `/repos/${forkRepo}`)
    if (fork.ok) break
  }
  if (!fork.ok) throw new Error('fork 后仍读不到仓库')
}
console.log(`fork 就绪：${forkRepo}`)

// 2) 在 fork 的 main 上写候选文件（存在则带上 sha 覆盖）
const target = `candidates/${parsed.id}.json`
const existing = await api('GET', `/repos/${forkRepo}/contents/${target}?ref=${BASE}`)
const putBody = {
  message: `Add ${parsed.id} ${parsed.version} candidate`,
  content: Buffer.from(candidate, 'utf8').toString('base64'),
  branch: BASE,
}
if (existing.ok && existing.data?.sha) {
  putBody.sha = existing.data.sha
  console.log('候选文件已存在，覆盖')
}
await must('PUT', `/repos/${forkRepo}/contents/${target}`, putBody)
console.log(`已写入 ${target}`)

// 3) 开 PR（同分支已有打开的 PR 就复用）
const open = await must('GET', `/repos/${UPSTREAM}/pulls?state=open&head=${login}:${BASE}`)
const found = Array.isArray(open) ? open.find((pr) => pr.title.includes(parsed.id)) : null
if (found) {
  console.log(`\n已有打开的 PR：#${found.number}`)
  console.log(found.html_url)
  process.exit(0)
}

const pr = await must('POST', `/repos/${UPSTREAM}/pulls`, {
  title: `Add ${parsed.id} ${parsed.version} (new plugin)`,
  head: `${login}:${BASE}`,
  base: BASE,
  body,
  maintainer_can_modify: true,
})
console.log(`\n✓ 已提交 PR：#${pr.number}`)
console.log(pr.html_url)
