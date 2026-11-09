/**
 * 文件树辅助：把嵌套结构拍平，供下拉选择、对照面板、分屏默认目标复用
 */
import type { RemoteTreeFile, TreeNode } from '@/lib/rpc'

export interface FlatFile {
  path: string
  name: string
}

/** 拍平出所有 Markdown 文本文件（跳过图片与文件夹） */
export function flattenFiles(nodes: TreeNode[]): FlatFile[] {
  const result: FlatFile[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'folder') {
        if (node.children) walk(node.children)
        continue
      }
      if (node.kind === 'file') result.push({ path: node.path, name: node.name })
    }
  }
  walk(nodes)
  return result
}

/** 拍平出所有节点路径（含文件夹），用于展开状态等场景 */
export function flattenPaths(nodes: TreeNode[]): string[] {
  const result: string[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      result.push(node.path)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

/**
 * 从 `fromPath` 所在目录出发，算到 `targetPath` 的相对链接
 *
 * 两个参数都是工作区相对路径（如 `项目/周报.md`）。
 * 结果用于 Markdown 链接，空格按 `%20` 转义，否则 `[名 称](路 径.md)` 会被解析断。
 */
export function relativeLink(fromPath: string, targetPath: string): string {
  const fromParts = fromPath.split('/').filter(Boolean)
  const targetParts = targetPath.split('/').filter(Boolean)
  const fromDir = fromParts.slice(0, -1)

  let common = 0
  while (
    common < fromDir.length &&
    common < targetParts.length - 1 &&
    fromDir[common] === targetParts[common]
  ) {
    common += 1
  }

  const parts = [
    ...Array.from({ length: fromDir.length - common }, () => '..'),
    ...targetParts.slice(common),
  ]
  return parts.join('/').replace(/ /g, '%20')
}

/* ---------------- 远端清单合并 ----------------
 *
 * 对齐参考项目 `mergeRemoteDirectoryEntries()`：
 * 1. 先把上一轮留下的「仅云端」节点清掉（参考项目会 splice 掉远端快照里没有的
 *    `isLocale: false` 条目），本地节点始终保留；
 * 2. 再把本次远端快照插进树，只存在于远端的条目标 `remoteOnly`；
 * 3. 本地已有的条目顺带更新 `remoteSha`，远端版本不同就标 `remoteUpdated`。
 *
 * 清单只有元信息，没有任何正文 —— 正文在点开节点时才拉，这一点也和参考项目一致。
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'mdx'])

function isTreeFile(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return NOTE_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension)
}

function kindOf(name: string): 'file' | 'image' {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file'
}

/** 清掉上一轮的云端节点与状态标记，本地节点原样保留 */
function stripRemote(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    if (node.remoteOnly) continue
    const next: TreeNode = { ...node }
    delete next.remoteSha
    delete next.remoteUpdated
    if (next.children) next.children = stripRemote(next.children)
    result.push(next)
  }
  return result
}

/** 远端快照里已经消失的空云端文件夹不该继续占位 */
function pruneRemoteFolders(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((node) => {
    if (!node.children) return true
    node.children = pruneRemoteFolders(node.children)
    return !(node.remoteOnly && node.children.length === 0)
  })
}

/** 目录在前、同类按名称排序，与本地文件树一致 */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind === 'folder' && right.kind !== 'folder') return -1
    if (left.kind !== 'folder' && right.kind === 'folder') return 1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
  for (const node of nodes) {
    if (node.children) sortNodes(node.children)
  }
}

/**
 * 把远端目录清单合并进本地文件树
 *
 * 传入的 `local` 不被修改；返回一棵新树，方便直接交给 zustand `set`。
 */
export function mergeRemoteTree(local: TreeNode[], files: RemoteTreeFile[]): TreeNode[] {
  const root = stripRemote(local)
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    const name = parts[parts.length - 1]
    if (parts.length === 0 || !isTreeFile(name)) continue

    // 逐层找到 / 建出目录链；只存在于云端的目录同样标 remoteOnly
    let level = root
    let parentPath = ''
    for (const segment of parts.slice(0, -1)) {
      const path = parentPath ? `${parentPath}/${segment}` : segment
      let folder = level.find((node) => node.kind === 'folder' && node.name === segment)
      if (!folder) {
        folder = { kind: 'folder', name: segment, path, children: [], remoteOnly: true }
        level.push(folder)
      }
      folder.children ??= []
      level = folder.children
      parentPath = path
    }

    const existing = level.find((node) => node.path === file.path)
    if (existing && !existing.remoteOnly) {
      existing.remoteSha = file.sha
      existing.remoteUpdated = file.status === 'updated' || file.status === 'conflict'
      continue
    }
    if (existing) {
      existing.remoteSha = file.sha
      existing.size = file.size
      existing.mtime = file.mtime
      continue
    }
    level.push({
      kind: kindOf(name),
      name,
      path: file.path,
      size: file.size,
      mtime: file.mtime,
      remoteSha: file.sha,
      // 本地磁盘没有这个文件：点开时才下载正文
      remoteOnly: !file.localExists,
    })
  }

  const pruned = pruneRemoteFolders(root)
  sortNodes(pruned)
  return pruned
}

/** 在树里按路径找节点，用于判断当前点开的是不是「仅云端」条目 */
export function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findTreeNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

/* ---------------- 文件树视图偏好（参考项目 file-more-menu） ---------------- */

export type FileSortBy = 'name' | 'mtime' | 'size'

export interface FileViewOptions {
  sortBy: FileSortBy
  sortOrder: 'asc' | 'desc'
  /** 显示 assets 等纯图片资源文件夹 */
  showAssetsFolders: boolean
  /** 显示「仅云端」节点 */
  showRemoteFiles: boolean
}

const ASSET_FOLDER_NAMES = new Set([
  'assets',
  'asset',
  'images',
  'image',
  'img',
  'static',
  'media',
  '附件',
  '资源',
])

/** 目录里是否只有图片（含子目录），用于识别「资源文件夹」 */
function isAssetsFolder(node: TreeNode): boolean {
  if (node.kind !== 'folder') return false
  if (ASSET_FOLDER_NAMES.has(node.name.toLowerCase())) return true
  let sawFile = false
  let sawNonImage = false
  const walk = (list: TreeNode[]) => {
    for (const item of list) {
      if (item.kind === 'folder') walk(item.children ?? [])
      else {
        sawFile = true
        if (item.kind !== 'image') sawNonImage = true
      }
    }
  }
  walk(node.children ?? [])
  return sawFile && !sawNonImage
}

/**
 * 应用视图偏好：过滤隐藏节点 + 按设置排序。
 *
 * 返回新数组，不改传入的树；目录始终排在文件前面（与参考项目一致），
 * 组内再按名称 / 修改时间 / 大小和升降序排列。
 */
export function applyFileView(nodes: TreeNode[], options: FileViewOptions): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    if (!options.showRemoteFiles && node.remoteOnly) continue
    if (node.kind === 'folder' && !options.showAssetsFolders && isAssetsFolder(node)) continue
    const next: TreeNode = node.children
      ? { ...node, children: applyFileView(node.children, options) }
      : { ...node }
    result.push(next)
  }
  const factor = options.sortOrder === 'asc' ? 1 : -1
  result.sort((left, right) => {
    if (left.kind === 'folder' && right.kind !== 'folder') return -1
    if (left.kind !== 'folder' && right.kind === 'folder') return 1
    let value = 0
    if (options.sortBy === 'mtime') {
      value = (left.mtime ?? 0) - (right.mtime ?? 0)
    } else if (options.sortBy === 'size') {
      value = (left.size ?? 0) - (right.size ?? 0)
    }
    if (value === 0) value = left.name.localeCompare(right.name, 'zh-CN')
    return value * factor
  })
  return result
}

/** 收集树里所有文件夹路径，供「全部折叠」与粘贴目标使用 */
export function collectFolderPaths(nodes: TreeNode[]): string[] {
  const result: string[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'folder') {
        result.push(node.path)
        walk(node.children ?? [])
      }
    }
  }
  walk(nodes)
  return result
}
