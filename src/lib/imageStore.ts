/**
 * 图片入库：本地工作区 或 图床
 *
 * 沙箱里发不出 HTTP 请求，远端上传统一交给 Sidecar 的 `image/upload`。
 * 这里只做「按当前设置分流 + 统一返回可写进 Markdown 的 src」。
 */
import * as rpc from '@/lib/rpc'
import { rememberPreview } from '@/lib/previewCache'
import { useSettingsStore } from '@/stores/settings'

export interface StoredImage {
  /** 可直接写进 Markdown 的地址：本地为工作区相对路径，远端为完整 URL */
  src: string
  /** 是否为远端图床地址 */
  remote: boolean
  /** 实际使用的图床标识 */
  provider: string
}

/** 把 data URL / base64 拆成 base64 与 mime */
export function splitBase64(input: string): { base64: string; mime: string } {
  if (!input.startsWith('data:')) {
    return { base64: input, mime: 'image/png' }
  }
  const comma = input.indexOf(',')
  const header = input.slice(5, comma)
  return {
    base64: input.slice(comma + 1),
    mime: header.split(';')[0] || 'image/png',
  }
}

/** 后缀猜测（图床按后缀决定 Content-Type） */
export function extensionOf(name: string, mime: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
  }
  return map[mime] ?? 'png'
}

/**
 * 按最长边等比缩小
 *
 * 设置里的「粘贴图片压缩」用它：超过阈值才处理，返回新的 base64 与 mime。
 * 浏览器里直接用 canvas，不需要额外依赖。
 */
async function downscale(
  base64: string,
  mime: string,
  maxEdge: number,
): Promise<{ base64: string; mime: string }> {
  if (maxEdge <= 0) return { base64, mime }
  try {
    const response = await fetch(`data:${mime};base64,${base64}`)
    const bitmap = await createImageBitmap(await response.blob())
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= maxEdge) {
      bitmap.close()
      return { base64, mime }
    }
    const scale = maxEdge / longest
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return { base64, mime }
    }
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const output = canvas.toDataURL('image/jpeg', 0.9)
    return { base64: output.slice(output.indexOf(',') + 1), mime: 'image/jpeg' }
  } catch {
    // 解码失败（例如 SVG）就按原图上传
    return { base64, mime }
  }
}

/**
 * 保存一张图片：`imageHosting.provider === 'local'` 落工作区，其余上传图床。
 *
 * 失败时抛错，调用方负责 toast。
 */
export async function persistImage(params: {
  name: string
  /** 不含 `data:` 前缀的 base64 */
  dataBase64: string
  mime?: string
}): Promise<StoredImage> {
  const settings = useSettingsStore.getState()
  const hosting = settings.imageHosting
  const scaled = await downscale(
    params.dataBase64,
    params.mime ?? 'image/png',
    settings.editor.pasteMaxEdge,
  )
  const mime = scaled.mime
  const dataBase64 = scaled.base64
  const name = params.name || `image.${extensionOf('', mime)}`

  if (hosting.provider === 'local') {
    const saved = await rpc.saveImage(name, dataBase64, {
      dir: settings.image.dir,
      nameMode: settings.image.nameMode,
    })
    return { src: saved.path, remote: false, provider: 'local' }
  }

  const uploaded = await rpc.imageUpload({
    name,
    dataBase64,
    mime,
    config: hosting,
  })
  // 图床回来的地址在宿主里是"外链"，得经 Sidecar 取回才能显示。但图片内容就在手里，
  // 先塞进预览缓存 → 插入后立刻可见，不用等一次网络往返（图床刚上传还没生效时尤其明显）。
  rememberPreview(uploaded.url, `data:${mime};base64,${dataBase64}`)
  return { src: uploaded.url, remote: true, provider: uploaded.provider }
}

/**
 * 远端图片的解析与缓存统一在 `previewCache` 里
 *
 * 两处各存一份曾经导致「图床上传成功、插入后却显示裂图」：上传时把 data URL 记进了
 * 预览缓存，而编辑器渲染远端地址时走的是另一个 `remoteCache`，于是又去网上抓一次，
 * 抓不到就只剩破图。现在只有一份缓存，`rememberPreview` 记下的内容任何渲染路径都能直接用。
 */
export {
  isRemoteImage,
  resolveRemoteImage,
} from '@/lib/previewCache'
