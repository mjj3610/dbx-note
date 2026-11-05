/**
 * 文件树辅助：把嵌套结构拍平，供下拉选择、对照面板、分屏默认目标复用
 */
import type { TreeNode } from '@/lib/rpc'

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
