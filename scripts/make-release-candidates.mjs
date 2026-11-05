#!/usr/bin/env node
/**
 * 汇总 release/*.artifact.json → release/release-candidates.json
 *
 * 为什么需要它：DBX 商店要求每个版本的 GitHub Release 里附带一份
 * `release-candidates.json`，把所有平台产物的 sha256 / size 汇总在一起，
 * 供维护者签名时校验。手工抄容易抄错，所以从 package.mjs 产出的
 * artifact.json 直接合并。
 *
 * artifact.json 里的 url 只是文件名（同目录），这里要补成 Release 的绝对地址。
 *
 * 前置：node scripts/package.mjs（每个平台跑一次）
 * 运行：node scripts/make-release-candidates.mjs [--repo owner/name] [--tag v0.4.0]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const releaseDir = join(ROOT, 'release')

const args = process.argv.slice(2)
const pick = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const version = manifest.version
const repo = pick('--repo') ?? 'mjj3610/dbx-note'
const tag = pick('--tag') ?? `v${version}`

if (!existsSync(releaseDir)) {
  console.error('缺少 release/，请先运行 node scripts/package.mjs')
  process.exit(1)
}

// 只取当前版本、且形如 <id>-<version>-<target>.artifact.json 的文件
const prefix = `${manifest.id}-${version}-`
const artifacts = readdirSync(releaseDir)
  .filter((name) => name.startsWith(prefix) && name.endsWith('.artifact.json'))
  .sort()

if (artifacts.length === 0) {
  console.error(`release/ 下没有 ${prefix}*.artifact.json，请先打包`)
  process.exit(1)
}

const targets = []
for (const name of artifacts) {
  const artifact = JSON.parse(readFileSync(join(releaseDir, name), 'utf8'))
  if (!artifact.target || !artifact.sha256 || !artifact.size) {
    console.error(`artifact 缺字段：${name}`)
    process.exit(1)
  }
  targets.push({
    target: artifact.target,
    // url 形如 com.mjj3610.note-0.4.0-windows-x64.dbxp
    url: `https://github.com/${repo}/releases/download/${tag}/${artifact.url}`,
    sha256: artifact.sha256,
    size: artifact.size,
  })
}

// 同一 target 只允许一条，重复说明打包了两次不同包名，属于人为错误
const seen = new Set()
for (const entry of targets) {
  if (seen.has(entry.target)) {
    console.error(`target 重复：${entry.target}`)
    process.exit(1)
  }
  seen.add(entry.target)
}

const output = {
  schemaVersion: 1,
  id: manifest.id,
  publisher: manifest.publisher,
  version,
  targets,
}

const outputPath = join(releaseDir, 'release-candidates.json')
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`已生成 release/release-candidates.json（${targets.length} 个平台）`)
for (const entry of targets) {
  console.log(`  ${entry.target}  ${entry.sha256.slice(0, 16)}…  ${entry.size} B`)
}
