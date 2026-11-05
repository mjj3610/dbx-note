/**
 * DBX 宿主桥接
 *
 * 插件在沙箱工作台中运行，以下能力由宿主注入到 `window.dbxPlugin`：
 * - ready:    初始化完成的 Promise
 * - locale:   宿主界面语言（zh-CN / en …）
 * - theme:    { appearance: 'light' | 'dark' }
 * - request:  调用 Host API
 * - invoke:   调用本插件 Sidecar 的 JSON-RPC 方法
 * - copy:     写入系统剪贴板（沙箱里 navigator.clipboard 可能不可用）
 *
 * 本地 `npm run dev`（纯浏览器）下该对象不存在，所有能力自动降级。
 */

export interface DbxTheme {
  appearance?: 'light' | 'dark'
  tokens?: Record<string, string>
}

export interface DbxPluginBridge {
  ready: Promise<Record<string, unknown>>
  readonly context?: Record<string, unknown>
  readonly locale: string
  readonly theme?: DbxTheme
  request(method: string, params?: unknown): Promise<unknown>
  invoke?(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  copy?(text: string): Promise<unknown>
  onInit?(handler: (context: Record<string, unknown>) => void): () => void
}

declare global {
  interface Window {
    dbxPlugin?: DbxPluginBridge
  }
}

/** 宿主初始化超时（毫秒），避免宿主异常时白屏 */
const READY_TIMEOUT = 1500

export function bridge(): DbxPluginBridge | undefined {
  return typeof window !== 'undefined' ? window.dbxPlugin : undefined
}

export function isHosted(): boolean {
  return Boolean(bridge())
}

/** 宿主是否提供 Sidecar 通道 */
export function hasSidecar(): boolean {
  return typeof bridge()?.invoke === 'function'
}

/**
 * 判断宿主当前外观
 * 宿主切换深浅色时只会更新 `html[data-dbx-theme]`，注入时的 theme 值可能是旧的
 */
export function hostAppearance(): 'light' | 'dark' {
  const fromDom = document.documentElement.dataset.dbxTheme
  const source = fromDom || bridge()?.theme?.appearance || 'light'
  return source === 'dark' ? 'dark' : 'light'
}

/** 宿主语言归一化为 zh-CN / en */
export function hostLocale(): string {
  const raw = (bridge()?.locale ?? 'zh-CN').toLowerCase()
  return raw.startsWith('zh') ? 'zh-CN' : 'en'
}

/** 监听宿主切换外观 */
export function watchHostAppearance(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(() => onChange())
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-dbx-theme'],
  })
  return () => observer.disconnect()
}

/** 等待宿主就绪（失败也不阻塞，按独立模式继续） */
export async function awaitHostReady(): Promise<boolean> {
  const host = bridge()
  if (!host) return false
  try {
    await Promise.race([host.ready, new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT))])
    return true
  } catch (error) {
    console.warn('[host] 宿主初始化失败，按独立模式运行', error)
    return false
  }
}

/** 复制文本：优先宿主能力，降级到浏览器剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  const host = bridge()
  if (host?.copy) {
    try {
      await host.copy(text)
      return true
    } catch {
      /* 继续尝试浏览器剪贴板 */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
