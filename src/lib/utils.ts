import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 Tailwind 类名，后者覆盖前者同类属性 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** 毫秒时间戳 → 相对时间（刚刚 / 3 分钟前 / 昨天 12:03 / 2026-01-02） */
export function relativeTime(timestamp: number, locale = 'zh-CN'): string {
  if (!timestamp) return ''
  const now = Date.now()
  const diff = now - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const zh = locale.startsWith('zh')

  if (diff < minute) return zh ? '刚刚' : 'just now'
  if (diff < hour) {
    const value = Math.floor(diff / minute)
    return zh ? `${value} 分钟前` : `${value} min ago`
  }
  if (diff < day) {
    const value = Math.floor(diff / hour)
    return zh ? `${value} 小时前` : `${value} h ago`
  }
  if (diff < 2 * day) {
    const date = new Date(timestamp)
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    return zh ? `昨天 ${time}` : `Yesterday ${time}`
  }
  return formatDate(timestamp)
}

/** 毫秒时间戳 → YYYY-MM-DD */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 毫秒时间戳 → YYYY-MM-DD HH:mm */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${formatDate(timestamp)} ${hour}:${minute}`
}

/** 字节数 → 人类可读体积 */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 简单防抖 */
export function debounce<T extends (...args: never[]) => void>(handler: T, delay = 300): (...args: Parameters<T>) => void {
  let timer: number | undefined
  return (...args: Parameters<T>) => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => handler(...args), delay)
  }
}

/** 取文件名（不含扩展名） */
export function baseName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.(md|markdown|txt|mdx)$/i, '')
}

/** 取目录部分 */
export function dirName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** 统计 Markdown 字数（中英混合按字符计，忽略空白） */
export function countWords(text: string): number {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/[#>*_~`-]/g, ' ')
    .trim()
  const chinese = (stripped.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const latin = stripped
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return chinese + latin
}

/** 生成客户端临时 id */
export function localId(): string {
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 复制文本的降级实现（宿主 copy 失败时使用） */
export async function fallbackCopy(text: string): Promise<boolean> {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
