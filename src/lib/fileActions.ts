/**
 * 文件树「更多操作」与右键菜单共用的动作层
 *
 * 对齐参考项目 `file-more-menu.tsx` / `file-item.tsx`：UI 只负责菜单与文案，
 * 真正的文件搬运、导入解包、知识库快照读写集中在这里，避免两处菜单各写一套。
 */
import JSZip from 'jszip'
import { toast } from 'sonner'

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

/**
 * 最近一次还没结算的 DOM 文件选择框；再次点「上传」时先把它当取消结掉。
 * 只用于回退路径，原生对话框由 Sidecar 串行处理，不需要前端干预。
 */
let activePickerCancel: (() => void) | null = null

/** 把无 data: 前缀的 base64 解成字节（原生对话框回传内容用） */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * 把 Sidecar 原生对话框的结果包成 File 列表。
 *
 * 后续 `buildImportEntries` 只依赖 `file.name` / `file.text()` /
 * `file.arrayBuffer()`，这里包成 File 后整条导入链路无需改动。
 */
function nativeFilesToFiles(picked: rpc.NativePickedFile[]): File[] {
  return picked.map((item) => {
    const bytes = base64ToBytes(item.contentBase64)
    // 显式复制成 ArrayBuffer：TS 5.9 起 Uint8Array<ArrayBufferLike> 不再直接当 BlobPart
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return new File([buffer], item.name)
  })
}

/**
 * 回退路径：用隐藏的 file input 选本地文件；取消时返回空数组。
 *
 * 这里**刻意不再用 `window.focus` / `visibilitychange` 判定取消**：
 * 文件对话框打开时 iframe 必然收到焦点事件，用短超时判定会把「正在选择」
 * 误判成取消并移除 input，导致用户选完也没有任何结果。取消只认 input 的
 * `cancel` 事件（Chromium / WebView2 支持），重复点击则由 activePickerCancel 结算。
 */
function pickFilesViaInput(options: PickOptions): Promise<File[]> {
  // 上一次的选择框还没结算：先当「取消」处理，保证调用方一定能继续
  activePickerCancel?.()
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

    function finish(files: File[]): void {
      if (settled) return
      settled = true
      if (activePickerCancel === cancel) activePickerCancel = null
      input.remove()
      resolve(files)
    }

    function cancel(): void {
      finish([])
    }

    activePickerCancel = cancel
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', cancel)
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * 选本地文件：DBX 宿主优先走 Sidecar 的 Win32 原生对话框。
 *
 * 宿主把插件放进 `sandbox="allow-scripts"` 的 iframe，隐藏 input 的对话框
 * 在沙箱里不可靠（不弹 / 落在主窗口下面 / 被焦点事件误判取消），这正是
 * 「上传和导入都没响应」的根因。非 Windows 或自动化环境由后端返回
 * `unsupported`，这里自动回退到 DOM input 保持兼容。
 */
export async function pickFiles(options: PickOptions = {}): Promise<File[]> {
  try {
    const result = await rpc.dialogOpenFiles({
      multiple: options.multiple ?? true,
      directory: options.directory ?? false,
      accept: options.accept,
    })
    if (result.unsupported) return pickFilesViaInput(options)
    if (result.cancelled) return []
    return nativeFilesToFiles(result.files)
  } catch {
    // 原生通道不可用（旧 Sidecar / RPC 失败）：静默降级，不让用户卡住
    return pickFilesViaInput(options)
  }
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

/** 批量导入阶段，供界面给即时反馈（参考项目的导入过程没有任何提示） */
export type ImportStage = 'picking' | 'reading' | 'writing'
export interface ImportStageDetail {
  current?: number
  total?: number
}
export type ImportStageHandler = (stage: ImportStage, detail?: ImportStageDetail) => void

/** 导入反馈用的固定 toast id：阶段切换只更新文案，不刷出一串提示 */
export const IMPORT_TOAST_ID = 'dbx-note-import'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 生成导入阶段回调：点菜单立刻出「正在选择文件」，读取 / 写入阶段持续更新，
 * 结束时由 `endImportFeedback()` 关掉。
 *
 * 参考项目的导入全程没有 loading 提示，本项目跑在 DBX 宿主 iframe 里，
 * 用户会把「系统对话框 + 转码 + RPC 写盘」这段静默期理解成「没响应」。
 */
export function makeImportFeedback(t: Translate): ImportStageHandler {
  let lastLabel = ''
  return (stage, detail) => {
    const { current = 0, total = 0 } = detail ?? {}
    let label: string
    if (stage === 'picking') label = t('files.import.picking')
    else if (stage === 'writing') label = t('files.import.writing')
    else if (total > 0) label = t('files.import.readingProgress', { current, total })
    else label = t('files.import.reading')
    if (label === lastLabel) return
    // 逐文件更新太密，只在首 / 尾和每 5 个时刷新一次文案
    if (stage === 'reading' && total > 0 && current !== 0 && current !== total && current % 5 !== 0) {
      return
    }
    lastLabel = label
    toast.loading(label, { id: IMPORT_TOAST_ID })
  }
}

export function endImportFeedback(): void {
  toast.dismiss(IMPORT_TOAST_ID)
}

/** 把导入结果落到界面：增量插树 + 统一结果提示，取代旧的 `await loadTree()` */
export function reportImportResult(
  t: Translate,
  result: rpc.ImportResult | null,
  applyLocalPaths: (paths: string[]) => void,
): void {
  endImportFeedback()
  if (!result) return
  applyLocalPaths(result.paths)
  if (result.imported === 0) toast.message(t('files.more.nothingImported'))
  else if (result.skipped > 0) {
    toast.success(t('files.more.importSkipped', { count: result.imported, skipped: result.skipped }))
  } else toast.success(t('files.more.imported', { count: result.imported }))
}

/**
 * 有上限的并发 map：保持输入顺序。
 *
 * 旧实现 `for (const file of files) await readText(file)` 是严格串行，
 * 一次导入几十个文件时每个都要等一次 File API 回调，界面上就是「卡住不动」。
 * 6 路并发既能明显提速，又不会把大文件的 arrayBuffer 同时全塞进内存。
 */
const IMPORT_CONCURRENCY = 6

async function mapConcurrent<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const result = new Array<R>(items.length)
  let cursor = 0
  let done = 0
  const runners = Array.from({ length: Math.min(IMPORT_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      result[index] = await worker(items[index])
      done += 1
      onProgress?.(done, items.length)
    }
  })
  await Promise.all(runners)
  return result
}

/**
 * 把选中的本地文件转成 fs/import 的条目数组。
 *
 * - notes：原样导入 Markdown / 文本 / 图片；
 * - markdown：把 html / txt / json 等正文转成 .md 文件；
 * - notion：解开 .zip 里的 Markdown，去掉 Notion 的 32 位 id 后缀。
 */
export async function buildImportEntries(
  files: File[],
  mode: ImportMode,
  onProgress?: (done: number, total: number) => void,
): Promise<rpc.ImportEntry[]> {
  const result: rpc.ImportEntry[] = []

  if (mode === 'notion') {
    const zipFile = files.find((file) => /\.zip$/i.test(file.name)) ?? files[0]
    if (!zipFile) return result
    const zip = await JSZip.loadAsync(await zipFile.arrayBuffer())
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && /\.md$/i.test(entry.name))
    const notes = await mapConcurrent(
      entries,
      async (entry): Promise<rpc.ImportEntry | null> => {
        let content = await entry.async('string')
        // Notion 的正文里会引用带 id 的同目录 Markdown，导出后一并改回干净名字
        content = content.replace(/([^\s()[\]]+?)\s+[0-9a-f]{32}(\.md)/gi, '$1$2')
        const name = markdownName(entry.name.replace(NOTION_ID, ''))
        return name ? { name, content } : null
      },
      onProgress,
    )
    result.push(...notes.filter((item): item is rpc.ImportEntry => item !== null))
    // 静态资源也带上，避免导入后图片全丢
    const assets = Object.values(zip.files).filter(
      (entry) => !entry.dir && IMAGE_EXT.test(entry.name),
    )
    const assetEntries = await mapConcurrent(assets, async (entry): Promise<rpc.ImportEntry | null> => {
      const name = entry.name.replace(/\\/g, '/').replace(NOTION_ID, '')
      return name ? { name, contentBase64: await readBase64(await entry.async('blob')) } : null
    }, onProgress)
    result.push(...assetEntries.filter((item): item is rpc.ImportEntry => item !== null))
    return result
  }

  const converted = await mapConcurrent(
    files,
    async (file): Promise<rpc.ImportEntry | null> => {
      // 选文件夹时 File.webkitRelativePath 带上相对目录
      const rawName = directoryRelativePath(file) || file.name
      if (mode === 'notes') {
        if (!TEXT_EXT.test(rawName) && !IMAGE_EXT.test(rawName)) return null
        const name = rawName.replace(/\\/g, '/')
        if (IMAGE_EXT.test(name)) return { name, contentBase64: await readBase64(file) }
        return { name, content: await readText(file) }
      }
      // markdown：HTML 转成 Markdown，其余文本原样落成 .md 笔记
      if (/\.html?$/i.test(rawName)) {
        return { name: markdownName(rawName), content: htmlToMarkdown(await readText(file)) }
      }
      if (IMAGE_EXT.test(rawName)) return null
      return { name: markdownName(rawName), content: await readText(file) }
    },
    onProgress,
  )
  result.push(...converted.filter((item): item is rpc.ImportEntry => item !== null))
  return result
}

function directoryRelativePath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  if (!relative) return ''
  // 丢掉最外层选中目录名，直接落到目标目录下
  const parts = relative.split('/')
  return parts.slice(1).join('/')
}

/** 选文件 → 转码 → 批量写盘；`onStage` 用于给界面即时反馈 */
export async function importLocalFiles(
  target: string,
  mode: ImportMode,
  options: PickOptions = {},
  includeAssets = true,
  onStage?: ImportStageHandler,
): Promise<rpc.ImportResult | null> {
  const defaults: Record<ImportMode, PickOptions> = {
    notes: { accept: '.md,.markdown,.txt,.mdx,.png,.jpg,.jpeg,.gif,.webp,.svg' },
    markdown: { accept: '.html,.htm,.txt,.json,.csv,.log,.md' },
    notion: { multiple: false, accept: '.zip' },
  }
  // 点菜单到系统对话框弹出之间也要有反馈，否则宿主里看起来像「没响应」
  onStage?.('picking')
  const files = await pickFiles({ multiple: true, ...defaults[mode], ...options })
  if (files.length === 0) return null
  onStage?.('reading', { current: 0, total: files.length })
  let entries = await buildImportEntries(files, mode, (current, total) =>
    onStage?.('reading', { current, total }),
  )
  const before = entries.length
  if (!includeAssets) entries = entries.filter((entry) => !isStaticAssetPath(entry.name))
  const skippedByPreference = before - entries.length
  if (entries.length === 0) return { imported: 0, skipped: files.length, paths: [] }
  onStage?.('writing', { total: entries.length })
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
