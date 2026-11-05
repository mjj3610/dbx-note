#!/usr/bin/env node
/**
 * 打包 .dbxp（替代 CLI 的 package 子命令）
 *
 * 为什么需要它：`dbx-plugin package` 会强制用 msvc 工具链重新编译 Rust Sidecar，
 * 本机未安装 MSVC Build Tools 时无法完成。本脚本直接使用已构建的 Sidecar，
 * 按 DBX 包规范打平目录、生成 checksums.json 与 artifact.json。
 *
 * 前置：npm run build && npm run backend
 * 运行：node scripts/package.mjs [--target windows-x64]
 */
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
// 优先级：命令行 --target > 官方发布工作流注入的 DBX_PLUGIN_TARGET > 本机默认值。
// CI 的每个 runner 都会带 DBX_PLUGIN_TARGET，这样同一个命令能在矩阵里复用。
const targetIndex = args.indexOf('--target')
const TARGET = targetIndex >= 0 ? args[targetIndex + 1] : process.env.DBX_PLUGIN_TARGET || 'windows-x64'

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const stageDir = join(ROOT, '.tmp', 'stage')
const releaseDir = join(ROOT, 'release')
const binarySource = join(ROOT, 'backend', 'target', 'release', process.platform === 'win32' ? 'backend.exe' : 'backend')
const uiDir = join(ROOT, 'ui')

if (!existsSync(uiDir)) {
  console.error('缺少 ui/，请先运行 npm run build')
  process.exit(1)
}
if (!existsSync(binarySource)) {
  console.error(`缺少 Sidecar 产物：${binarySource}，请先运行 npm run backend`)
  process.exit(1)
}

// 1. 组装暂存目录
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(join(stageDir, 'bin', TARGET), { recursive: true })
cpSync(uiDir, join(stageDir, 'ui'), { recursive: true })
cpSync(join(ROOT, 'assets'), join(stageDir, 'assets'), { recursive: true })
cpSync(join(ROOT, 'licenses'), join(stageDir, 'licenses'), { recursive: true })
cpSync(join(ROOT, 'LICENSE'), join(stageDir, 'LICENSE'))
cpSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), join(stageDir, 'THIRD-PARTY-NOTICES.md'))
cpSync(binarySource, join(stageDir, 'bin', TARGET, process.platform === 'win32' ? 'backend.exe' : 'backend'))

// 2. 改写 manifest：把后端入口指向平台目录
const packagedManifest = structuredClone(manifest)
packagedManifest.entrypoints.backend.executable = `bin/${TARGET}/${process.platform === 'win32' ? 'backend.exe' : 'backend'}`
writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)

// 3. 校验和（除 checksums.json 本身）
function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

const files = walk(stageDir).sort()
const checksums = {}
for (const file of files) {
  const key = relative(stageDir, file).split(sep).join('/')
  checksums[key] = createHash('sha256').update(readFileSync(file)).digest('hex')
}
writeFileSync(
  join(stageDir, 'checksums.json'),
  `${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`,
)

// 4. 打包 zip（保持正斜杠路径）
const zip = new JSZip()
for (const file of walk(stageDir).sort()) {
  const key = relative(stageDir, file).split(sep).join('/')
  zip.file(key, readFileSync(file), { createFolders: false })
}
const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })

mkdirSync(releaseDir, { recursive: true })
const fileName = `${manifest.id}-${manifest.version}-${TARGET}.dbxp`
const outputPath = join(releaseDir, fileName)
writeFileSync(outputPath, buffer)

const sha256 = createHash('sha256').update(buffer).digest('hex')
writeFileSync(
  join(releaseDir, `${manifest.id}-${manifest.version}-${TARGET}.artifact.json`),
  `${JSON.stringify({ target: TARGET, url: fileName, sha256, size: buffer.length }, null, 2)}\n`,
)

console.log(`已生成 ${relative(ROOT, outputPath)}`)
console.log(`  大小：${(buffer.length / 1024 / 1024).toFixed(2)} MB`)
console.log(`  sha256：${sha256}`)
console.log(`  文件数：${files.length + 1}（含 checksums.json）`)
