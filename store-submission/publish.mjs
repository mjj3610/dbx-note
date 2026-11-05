#!/usr/bin/env node
/**
 * 一键提交到 DBX 商店。
 *
 * 为什么需要它：提交要跨越 5 个必须带凭据的外向操作（建仓库 → 推源码与 tag →
 * 建 Release 传包 → fork 商店仓库 → 提候选 PR），本机没有 gh CLI，WorkBuddy 的
 * GitHub 连接器是只读 App（建仓库/fork 均 403）。这个脚本把这些步骤收敛成一条命令，
 * token 只从环境变量读，不写入 .git/config、不落盘。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node store-submission/publish.mjs
 *   node store-submission/publish.mjs --dry-run          # 只做本地校验，不联网写
 *   GITHUB_TOKEN=xxx node store-submission/publish.mjs --skip-pr
 *
 * 前置：本地已有 release/<id>-<version>-<target>.dbxp 与 .artifact.json，
 *       且候选元数据 store-submission/candidates/<id>.json 已写好。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const STORE_REPO = 't8y2/dbx-store'
const STORE_BASE = 'main'

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const SKIP_PR = argv.includes('--skip-pr')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

const api = 'https://api.github.com'

function log(step, message) {
  console.log(`\n[${step}] ${message}`)
}
function warn(message) {
  console.log(`  ! ${message}`)
}
function ok(message) {
  console.log(`  ✓ ${message}`)
}

function die(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

// ── 本地材料校验（不需要 token） ───────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const candidatePath = join(ROOT, 'store-submission', 'candidates', `${manifest.id}.json`)
if (!existsSync(candidatePath)) die(`缺少候选元数据：${candidatePath}`)
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))

log('1/6', '校验本地材料')

// 商店签名时会比对包内 manifest 与候选元数据的三项身份，这里先自查一遍
if (candidate.id !== manifest.id) die(`id 不一致：候选 ${candidate.id} vs manifest ${manifest.id}`)
if (candidate.publisher !== manifest.publisher) die(`publisher 不一致：候选 ${candidate.publisher} vs manifest ${manifest.publisher}`)
if (candidate.version !== manifest.version) die(`version 不一致：候选 ${candidate.version} vs manifest ${manifest.version}`)
ok(`身份一致：${manifest.id} ${manifest.version} ${manifest.publisher}`)

// 逐个校验候选里钉住的每个平台产物：文件存在、sha256 与 size 完全匹配
const assets = []
for (const target of candidate.targets) {
  const fileName = basename(new URL(target.url).pathname)
  const filePath = join(ROOT, 'release', fileName)
  if (!existsSync(filePath)) die(`缺少产物：release/${fileName}（请先 node scripts/package.mjs）`)

  const bytes = readFileSync(filePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== target.sha256) {
    die(`${fileName} 的 sha256 与候选不一致\n    本地 ${sha256}\n    候选 ${target.sha256}`)
  }
  if (bytes.length !== target.size) {
    die(`${fileName} 的 size 与候选不一致：本地 ${bytes.length} vs 候选 ${target.size}`)
  }
  ok(`${target.target}  ${fileName}  ${sha256.slice(0, 16)}…  ${bytes.length} B`)
  assets.push({ target: target.target, fileName, filePath, bytes, sha256, size: bytes.length })
}

// Release 里要一并上传的汇总清单
const summaryPath = join(ROOT, 'release', 'release-candidates.json')
if (!existsSync(summaryPath)) {
  warn('缺少 release/release-candidates.json，请先运行 node scripts/make-release-candidates.mjs')
} else {
  ok('release-candidates.json 已就绪')
}

const prBodyPath = join(ROOT, 'store-submission', 'PR_BODY.md')
if (!existsSync(prBodyPath)) die('缺少 PR 正文：store-submission/PR_BODY.md')
const prBody = readFileSync(prBodyPath, 'utf8')

// 从候选 URL 反推 tag，保证 Release 与候选钉住的地址完全同源
const firstUrl = new URL(candidate.targets[0].url)
const tagFromUrl = firstUrl.pathname.split('/').filter(Boolean).slice(-2, -1)[0]
if (!tagFromUrl) die(`无法从候选 URL 解析 tag：${firstUrl.href}`)
ok(`发布 tag：${tagFromUrl}`)

if (DRY_RUN) {
  console.log('\n--dry-run：本地材料校验通过，未发起任何网络写操作。')
  process.exit(0)
}

if (!TOKEN) {
  die(
    '缺少凭据。请设置环境变量后重跑：\n' +
      '  GITHUB_TOKEN=你的token node store-submission/publish.mjs\n' +
      'token 需要 dbx-note 与 dbx-store fork 的 Contents: Read and write，' +
      '以及 Workflows: Read and write（要推 .github/workflows）。',
  )
}

// ── GitHub API 封装 ────────────────────────────────────────────────────────────

async function call(method, path, body, extraHeaders = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dbx-note-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data }
}

async function callOk(method, path, body, extraHeaders) {
  const result = await call(method, path, body, extraHeaders)
  if (!result.ok) {
    die(`${method} ${path} 失败（${result.status}）：${JSON.stringify(result.data).slice(0, 400)}`)
  }
  return result.data
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (allowFail) return null
    die(`git ${args.join(' ')} 失败：${error.stderr || error.message}`)
  }
}

// ── 2. 确认身份与仓库 ──────────────────────────────────────────────────────────

log('2/6', '确认 GitHub 身份与源码仓库')
const me = await callOk('GET', '/user')
const owner = me.login
if (owner !== candidate.publisher) {
  die(`token 属于 ${owner}，但候选的 publisher 是 ${candidate.publisher}；两者必须一致`)
}
ok(`已认证：${owner}`)

const repoName = 'dbx-note'
let repo = await call('GET', `/repos/${owner}/${repoName}`)
if (repo.status === 404) {
  repo = await call('POST', '/user/repos', {
    name: repoName,
    description: 'Local-first Markdown note workbench for DBX',
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  })
  if (!repo.ok) {
    die(
      `建仓库失败（${repo.status}）：${JSON.stringify(repo.data).slice(0, 300)}\n` +
        'token 需要 Administration: write，或你先在网页上建好空仓库再重跑本脚本。',
    )
  }
  ok(`已创建 ${owner}/${repoName}`)
} else if (repo.ok) {
  ok(`仓库已存在：${owner}/${repoName}`)
} else {
  die(`查询仓库失败（${repo.status}）`)
}

if (candidate.homepage !== `https://github.com/${owner}/${repoName}`) {
  warn(`候选 homepage 是 ${candidate.homepage}，与本仓库不一致，请自行确认`)
}

// ── 3. 推源码与 tag ───────────────────────────────────────────────────────────

log('3/6', '推送源码与 tag')
const remoteUrl = `https://x-access-token:${TOKEN}@github.com/${owner}/${repoName}.git`
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
git(['push', '--quiet', remoteUrl, `${branch}:${branch}`])
ok(`已推送分支 ${branch}`)

// 已存在的 tag 不能重复推（商店要求 URL 不可变）
const existingTag = git(['tag', '-l', tagFromUrl])
if (existingTag) {
  warn(`本地已有 tag ${tagFromUrl}，按原样推送`)
} else {
  // 署名身份从 GitHub 账户推出来，不依赖本机 git 全局配置（换机器也能跑）
  git([
    '-c',
    `user.name=${owner}`,
    '-c',
    `user.email=${owner}@users.noreply.github.com`,
    'tag',
    '-a',
    tagFromUrl,
    '-m',
    `${manifest.name} ${manifest.version}`,
  ])
  ok(`已创建 tag ${tagFromUrl}`)
}
git(['push', '--quiet', remoteUrl, tagFromUrl])
ok('已推送 tag')

// ── 4. 建 Release 并上传产物 ──────────────────────────────────────────────────

log('4/6', `发布 Release ${tagFromUrl}`)
let release = (await call('GET', `/repos/${owner}/${repoName}/releases/tags/${tagFromUrl}`)).data
if (release && release.id) {
  ok(`Release 已存在（id=${release.id}），复用`)
} else {
  release = await callOk('POST', `/repos/${owner}/${repoName}/releases`, {
    tag_name: tagFromUrl,
    name: tagFromUrl,
    body: `Unsigned DBX plugin candidate for ${candidate.id} ${candidate.version}.`,
    draft: false,
    prerelease: false,
  })
  ok(`已创建 Release（id=${release.id}）`)
}

const uploadList = [
  ...assets.map((asset) => ({ name: asset.fileName, bytes: asset.bytes })),
  ...(existsSync(summaryPath) ? [{ name: 'release-candidates.json', bytes: readFileSync(summaryPath) }] : []),
  ...assets.map((asset) => ({
    name: basename(asset.fileName.replace(/\.dbxp$/, '.artifact.json')),
    bytes: readFileSync(join(ROOT, 'release', basename(asset.fileName.replace(/\.dbxp$/, '.artifact.json')))),
  })),
]

for (const item of uploadList) {
  const already = (release.assets || []).find((entry) => entry.name === item.name)
  if (already) {
    ok(`${item.name} 已存在，跳过`)
    continue
  }
  const response = await fetch(
    `https://uploads.github.com/repos/${owner}/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(item.name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(item.bytes.length),
        'User-Agent': 'dbx-note-publisher',
      },
      body: item.bytes,
    },
  )
  if (!response.ok) {
    die(`上传 ${item.name} 失败（${response.status}）：${(await response.text()).slice(0, 300)}`)
  }
  ok(`已上传 ${item.name}（${item.bytes.length} B）`)
}

// 商店 CI 会真的下载这个地址校验字节，先自己确认可下载
for (const target of candidate.targets) {
  const head = await fetch(target.url, { method: 'HEAD', redirect: 'follow' })
  if (!head.ok) die(`候选地址不可下载（${head.status}）：${target.url}`)
  ok(`候选地址可下载：${head.status}`)
}

if (SKIP_PR) {
  console.log('\n--skip-pr：仓库与 Release 已完成，未提 PR。')
  process.exit(0)
}

// ── 5. fork 商店仓库并写入候选文件 ─────────────────────────────────────────────

log('5/6', `fork ${STORE_REPO} 并写入候选元数据`)
let forkState = await call('GET', `/repos/${owner}/dbx-store`)
if (!forkState.ok) {
  await call('POST', `/repos/${STORE_REPO}/forks`)
  // fork 是异步的，轮询到可读为止
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 3000))
    forkState = await call('GET', `/repos/${owner}/dbx-store`)
    if (forkState.ok) break
  }
  if (!forkState.ok) die('fork 后仍读不到仓库，请稍后重跑 --skip 之前的步骤会自动跳过')
}
ok(`fork 就绪：${owner}/dbx-store`)

const candidateRepoPath = `candidates/${manifest.id}.json`
const existing = await call('GET', `/repos/${owner}/dbx-store/contents/${candidateRepoPath}?ref=${STORE_BASE}`)
const putBody = {
  message: `Add ${manifest.id} ${candidate.version} candidate`,
  content: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8').toString('base64'),
  branch: STORE_BASE,
}
if (existing.ok && existing.data && existing.data.sha) {
  putBody.sha = existing.data.sha
  warn('候选文件已存在，将按当前内容覆盖')
}
const put = await call('PUT', `/repos/${owner}/dbx-store/contents/${candidateRepoPath}`, putBody)
if (!put.ok) die(`写入候选文件失败（${put.status}）：${JSON.stringify(put.data).slice(0, 300)}`)
ok(`已写入 ${candidateRepoPath}`)

// ── 6. 提 PR ─────────────────────────────────────────────────────────────────

log('6/6', '提交候选 PR')
const prs = await call('GET', `/repos/${STORE_REPO}/pulls?state=open&head=${owner}:${STORE_BASE}`)
const existingPr = Array.isArray(prs.data) ? prs.data.find((pr) => pr.title?.includes(manifest.id)) : null
if (existingPr) {
  ok(`已存在打开的 PR：#${existingPr.number} ${existingPr.html_url}`)
  console.log(`\n完成。PR 地址：${existingPr.html_url}`)
  process.exit(0)
}

const pr = await call('POST', `/repos/${STORE_REPO}/pulls`, {
  title: `Add ${manifest.id} ${candidate.version} (new plugin)`,
  head: `${owner}:${STORE_BASE}`,
  base: STORE_BASE,
  body: prBody,
  maintainer_can_modify: true,
})
if (!pr.ok) die(`提 PR 失败（${pr.status}）：${JSON.stringify(pr.data).slice(0, 400)}`)

console.log(`\n✓ 提交完成：${pr.data.html_url}`)
console.log('  CI 会红并提示 open candidate(s) awaiting DBX Store signing —— 这是设计如此。')
console.log('  等维护者在该 PR 下评论 /sign 完成签名后合并，插件即上架。')
