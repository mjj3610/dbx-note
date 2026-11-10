/**
 * 文件树「更多操作」与右键菜单共用的动作层
 *
 * 对齐参考项目 `file-more-menu.tsx` / `file-item.tsx`：UI 只负责菜单与文案，
 * 真正的文件搬运、导入解包、知识库快照读写集中在这里，避免两处菜单各写一套。
 */
import JSZip from 'jszip'

import * as rpc from '@/lib/rpc'
import type { TreeNode } from '@/lib/rpc'
import { pullRemoteFileOnDemand } from '@/lib/autoSync'
import { dirName } from '@/lib/utils'

/* ---------------- 本地文件选择 ---------------- */

export interface PickOptions {
  multiple?: boolean
  accept?: string
  /** 选择整个文件夹（webkitdirectory） */
  directory?: boolean
}

/** 用隐藏的 file input 选本地文件；取消时返回空数组 */
export function pickFiles(options: PickOptions = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple ?? true
    if (options.accept) input.accept = options.accept
    if (options.directory) {
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
    }
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => {
      finish(Array.from(input.files ?? []))
    })
    // 用户取消时 change 不触发；窗口重新获得焦点后再判定，避免提前 resolve
    const onFocus = () => {
      window.setTimeout(() => finish([]), 350)
    }
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

/** 读成 UTF-8 文本 */
export function readText(file: File): Promise<string> {
  return file.text()
}

/** 读成不含 data: 前缀的 base64（供 fs/import 写二进制） */
export async function readBase64(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

export type ImportMode = 'notes' | 'markdown' | 'notion'

const TEXT_EXT = /\.(md|markdown|txt|mdx)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i
/** Notion 导出会在文件名尾部附加 32 位十六进制 id */
const NOTION_ID = /\s+[0-9a-f]{32}(?=\.)/gi

/**
 * 极简 HTML → Markdown：把「导入为 Markdown」的 .html/.htm 转成可读笔记，
 * 保留标题、段落、列表、链接、图片、粗斜体与代码块；不追求完整还原。
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,noscript,iframe').forEach((node) => node.remove())
  const inline = (node: Node): string =>
    Array.from(node.childNodes)
      .map((child) => {
        if (child.nodeType === Node.TEXT_NODE) return (child.textContent ?? '').replace(/\s+/g, ' ')
        if (child.nodeType !== Node.ELEMENT_NODE) return ''
        const element = child as HTMLElement
        const text = inline(element)
        const tag = element.tagName.toLowerCase()
        if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`
        if (tag === 'strong' || tag === 'b') return `**${text}**`
        if (tag === 'em' || tag === 'i') return `*${text}*`
        if (tag === 'code') return `\`${text}\``
        if (tag === 'br') return '  \n'
        if (tag === 'a') {
          const href = element.getAttribute('href') ?? ''
          return href ? `[${text}](${href})` : text
        }
        if (tag === 'img') {
          const src = element.getAttribute('src') ?? ''
          const alt = element.getAttribute('alt') ?? ''
          return src ? `![${alt}](${src})` : ''
        }
        if (tag === 'li') return `- ${text}\n`
        if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return `${text}\n\n`
        if (tag === 'pre') return `\n\`\`\`\n${element.textContent ?? ''}\n\`\`\`\n\n`
        if (tag === 'blockquote') return `\n> ${text.trim()}\n\n`
        return text
      })
      .join('')
  return inline(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}

/** 把文件名里的路径分隔符与非法字符清掉，并转成 .md 后缀 */
function markdownName(raw: string): string {
  const clean = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(NOTION_ID, '').trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
  return clean.replace(/\.[^./]+$/, '') + '.md'
}

/**
 * 把选中的本地文件转成 fs/import 的条目数组。
 *
 * - notes：原样导入 Markdown / 文本 / 图片；
 * - markdown：把 html / txt / json 等正文转成 .md 文件；
 * - notion：解开 .zip 里的 Markdown，去掉 Notion 的 32 位 id 后缀。
 */
export async function buildImportEntries(files: File[], mode: ImportMode): Promise<rpc.ImportEntry[]> {
  const result: rpc.ImportEntry[] = []

  if (mode === 'notion') {
    const zipFile = files.find((file) => /\.zip$/i.test(file.name)) ?? files[0]
    if (!zipFile) return result
    const zip = await JSZip.loadAsync(await zipFile.arrayBuffer())
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && /\.md$/i.test(entry.name))
    for (const entry of entries) {
      let content = await entry.async('string')
      // Notion 的正文里会引用带 id 的同目录 Markdown，导出后一并改回干净名字
      content = content.replace(/([^\s()[\]]+?)\s+[0-9a-f]{32}(\.md)/gi, '$1$2')
      const name = markdownName(entry.name.replace(NOTION_ID, ''))
      if (name) result.push({ name, content })
    }
    // 静态资源也带上，避免导入后图片全丢
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !IMAGE_EXT.test(entry.name)) continue
      const name = entry.name.replace(/\\/g, '/').replace(NOTION_ID, '')
      if (name) result.push({ name, contentBase64: await readBase64(await entry.async('blob')) })
    }
    return result
  }

  for (const file of files) {
    // 选文件夹时 File.webkitRelativePath 带上相对目录
    const rawName = directoryRelativePath(file) || file.name
    if (mode === 'notes') {
      if (!TEXT_EXT.test(rawName) && !IMAGE_EXT.test(rawName)) continue
      const name = rawName.replace(/\\/g, '/')
      if (IMAGE_EXT.test(name)) result.push({ name, contentBase64: await readBase64(file) })
      else result.push({ name, content: await readText(file) })
      continue
    }
    // markdown：HTML 转成 Markdown，其余文本原样落成 .md 笔记
    if (/\.html?$/i.test(rawName)) {
      result.push({ name: markdownName(rawName), content: htmlToMarkdown(await readText(file)) })
      continue
    }
    if (IMAGE_EXT.test(rawName)) continue
    result.push({ name: markdownName(rawName), content: await readText(file) })
  }
  return result
}

function directoryRelativePath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  if (!relative) return ''
  // 丢掉最外层选中目录名，直接落到目标目录下
  const parts = relative.split('/')
  return parts.slice(1).join('/')
}

/** 选文件 → 转码 → 批量写盘 */
export async function importLocalFiles(
  target: string,
  mode: ImportMode,
  options: PickOptions = {},
  includeAssets = true,
): Promise<rpc.ImportResult | null> {
  const defaults: Record<ImportMode, PickOptions> = {
    notes: { accept: '.md,.markdown,.txt,.mdx,.png,.jpg,.jpeg,.gif,.webp,.svg' },
    markdown: { accept: '.html,.htm,.txt,.json,.csv,.log,.md' },
    notion: { multiple: false, accept: '.zip' },
  }
  const files = await pickFiles({ multiple: true, ...defaults[mode], ...options })
  if (files.length === 0) return null
  let entries = await buildImportEntries(files, mode)
  const before = entries.length
  if (!includeAssets) entries = entries.filter((entry) => !isStaticAssetPath(entry.name))
  const skippedByPreference = before - entries.length
  if (entries.length === 0) return { imported: 0, skipped: files.length, paths: [] }
  const result = await rpc.importEntries({ target, files: entries })
  return { ...result, skipped: result.skipped + skippedByPreference }
}

/* ---------------- 剪贴板与文件搬运 ---------------- */

/** 把剪切 / 复制的条目落到目标目录；返回新路径 */
export async function pasteClipboard(
  clip: { mode: 'cut' | 'copy'; path: string },
  toDir: string,
): Promise<string> {
  const result =
    clip.mode === 'cut'
      ? await rpc.moveEntry({ from: clip.path, toDir })
      : await rpc.copyEntry({ from: clip.path, toDir })
  return result.path
}

/** 创建副本（同目录下自动生成「副本」名） */
export async function duplicateEntry(path: string): Promise<string> {
  const result = await rpc.copyEntry({ from: path, duplicate: true })
  return result.path
}

/** 查看目录：在系统文件管理器里选中 */
export async function revealEntry(path: string): Promise<void> {
  await rpc.revealEntry(path)
}

/** 从模板新建笔记：复用 fs/create 的 content 参数 */
export async function createFromTemplate(parent: string, template: rpc.TemplateItem): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10)
  const result = await rpc.createEntry({
    kind: 'file',
    parent,
    name: `${template.name}-${stamp}`,
    content: template.content,
  })
  return result.path
}

/* ---------------- 远程文件 ---------------- */

/** 路径是不是静态资源（图片），用于「上传静态资源」开关 */
export function isStaticAssetPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path)
}

/** 递归收集「仅云端」文件路径 */
export function remoteOnlyPaths(nodes: TreeNode[], under = ''): string[] {
  const result: string[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'folder') {
        if (node.children) walk(node.children)
      } else if (node.remoteOnly && (!under || node.path.startsWith(`${under}/`))) {
        result.push(node.path)
      }
    }
  }
  walk(nodes)
  return result
}

/** 下载远程文件：逐个按需拉取（不下载正文以外的东西） */
export async function downloadRemotePaths(paths: string[]): Promise<number> {
  let pulled = 0
  for (const path of paths) {
    await pullRemoteFileOnDemand(path)
    pulled += 1
  }
  return pulled
}

/* ---------------- 知识库索引 ---------------- */

/** 上传知识库：导出向量库快照到工作区，再另存一份 JSON 便于人工备份 */
export async function uploadKnowledgeBase(): Promise<rpc.SaveTextResult> {
  const snapshot = await rpc.kbExportSnapshot()
  return rpc.saveTextFile({
    defaultName: 'dbx-note-rag-snapshot.json',
    extension: 'json',
    filterName: '知识库快照',
    content: snapshot.json,
  })
}

/** 下载知识库：从用户选的 JSON 快照恢复向量库 */
export async function downloadKnowledgeBase(): Promise<number | null> {
  const [file] = await pickFiles({ multiple: false, accept: '.json,application/json' })
  if (!file) return null
  const result = await rpc.kbImportSnapshot({ json: await readText(file) })
  return result.count
}

/** 当前节点应该作为「粘贴 / 上传」的目标目录 */
export function targetDirOf(node: TreeNode | null): string {
  if (!node) return ''
  return node.kind === 'folder' ? node.path : dirName(node.path)
}
