/**
 * 图片预览缓存
 *
 * 宿主沙箱里 `<img src="assets/x.png">` 会 404（CSP 拦外部资源 + 相对路径在宿主里不存在），
 * 只能先用 Sidecar 读成 data URL 再显示。为了不在拿到 data URL 之前就发出一堆 404，
 * 编辑器渲染图片时先用透明占位，再由这里同步 / 异步补上真实内容。
 *
 * 缓存是进程内的，只影响显示；Markdown 里始终保留原始相对路径。
 */
import * as rpc from '@/lib/rpc'

/** 1×1 透明 GIF：占位期间不发任何外部请求 */
export const IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

/** 是否是需要 Sidecar 代理的远端地址 */
export function isRemoteImage(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

/**
 * 远端图片解析缓存
 *
 * 宿主 iframe 的 CSP 是 `default-src 'none'`，`<img src="https://...">` 会被直接拦掉，
 * 所以远端图床的图要经 Sidecar 取回并转成 data URL 才能显示。
 */
const remoteCache = new Map<string, string>()

/** 把远端图片地址转成 data URL；失败返回 null（界面上保留原地址，复制出去仍然可用） */
export async function resolveRemoteImage(url: string): Promise<string | null> {
  const cached = remoteCache.get(url)
  if (cached) return cached
  const remembered = cache.get(url)
  if (remembered) {
    remoteCache.set(url, remembered)
    return remembered
  }
  try {
    const result = await rpc.netRequest({ url, timeoutMs: 20_000 })
    if (result.status < 200 || result.status >= 300 || !result.body) return null
    const mime = result.headers['content-type'] ?? result.headers['Content-Type'] ?? 'image/png'
    const dataUrl = `data:${mime.split(';')[0]};base64,${result.body}`
    remoteCache.set(url, dataUrl)
    cache.set(url, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}

/** 已经是自带内容的形式（data / blob），不需要再读 */
export function isInlineImage(src: string): boolean {
  return src.startsWith('data:') || src.startsWith('blob:')
}

/** 工作区相对路径（需要经 Sidecar 读） */
export function isWorkspaceImage(src: string): boolean {
  if (!src) return false
  if (isInlineImage(src)) return false
  return !/^(?:https?:|dbx:|file:)/i.test(src)
}

export function previewOf(src: string): string | undefined {
  return cache.get(src)
}

export function rememberPreview(src: string, dataUrl: string): void {
  if (!src || !dataUrl) return
  cache.set(src, dataUrl)
}

/** 读取（命中缓存直接返回，失败返回 null 且不抛） */
export function loadPreview(src: string): Promise<string | null> {
  const cached = cache.get(src)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(src)
  if (running) return running
  // 图床地址同样是外链：宿主 CSP 会拦，得经 Sidecar 取回再内联
  const read = isRemoteImage(src)
    ? resolveRemoteImage(src)
    : rpc.readImage(src.replace(/^\.\//, '')).then((file) => file?.dataUrl ?? null)
  const task = read
    .then((dataUrl) => {
      if (dataUrl) cache.set(src, dataUrl)
      return dataUrl
    })
    .catch(() => null)
    .finally(() => inflight.delete(src))
  inflight.set(src, task)
  return task
}
