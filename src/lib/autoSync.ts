/**
 * 自动同步（对齐 NoteGen 的 `syncOnSave` / `syncOnOpen`）
 *
 * 两条通道的语义统一为「按文件、先比对、后拉取」：
 * - Git 通道：打开文件时 `sync/compare` 实时比对远端版本，需要时才 `sync/pullFile` 拉这一个文件；
 * - 对象存储通道：看待下载数 `pendingDownload`，大于 0 才整批拉。
 *
 * 与参考项目一致的两个细节：
 * 1. 每次打开都查一次远端，不做时间节流 —— 否则「远程改了但本地没反应」；
 * 2. 刚拉下来的文件 1 秒内不触发自动推送（参考项目的 `justPulledFile`），
 *    否则拉取引起的改动会被立刻当成本地修改再推回去。
 */
import {
  syncCommit,
  syncCompare,
  syncPrefs,
  syncPullFile,
  syncPush,
  syncStoreOptions,
  syncStorePull,
  syncStorePush,
  syncStoreStatus,
} from '@/lib/rpc'

const STORE_PROVIDERS = ['s3', 'webdav', 'selfHosted']
const GIT_PROVIDERS = ['github', 'gitee', 'gitlab', 'gitea']
/** 配置缓存时长 */
const CONFIG_TTL_MS = 60_000
/** 拉取后抑制回推的窗口，与参考项目 `justPulledFile` 的 1 秒一致 */
const JUST_PULLED_MS = 1_000

type Mode = 'off' | 'store' | 'git'

interface AutoSyncConfig {
  mode: Mode
  /** 自动同步间隔，0 表示关闭 */
  delayMs: number
  pullOnOpen: boolean
  checkedAt: number
}

/** 打开文件时拉取的结果，交给编辑器决定是否替换内容 */
export interface PullOnOpenResult {
  updated: boolean
  content?: string
  conflict?: { path: string; local: string; remote: string }
}

let config: AutoSyncConfig = { mode: 'off', delayMs: 0, pullOnOpen: false, checkedAt: 0 }
let timer: number | undefined
let running = false
let queued = false
/** 最近一次拉取完成的时间戳，用于 1 秒内抑制回推 */
let justPulledAt = 0

/** `autoSync` 取值 → 毫秒 */
function toDelayMs(value: unknown): number {
  if (value === 'disabled' || value === 0 || value === '0' || value === false) return 0
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return seconds * 1000
}

async function resolveConfig(): Promise<AutoSyncConfig> {
  const fresh = Date.now() - config.checkedAt < CONFIG_TTL_MS
  if (fresh) return config
  try {
    const [prefs, options] = await Promise.all([syncPrefs(), syncStoreOptions()])
    const provider = options.provider
    const mode: Mode = STORE_PROVIDERS.includes(provider)
      ? 'store'
      : GIT_PROVIDERS.includes(provider)
        ? 'git'
        : 'off'
    // 后端缺省与 NoteGen 一致，默认 5 秒
    const delayMs = mode === 'off' ? 0 : toDelayMs(prefs.autoSync ?? '5')
    config = {
      mode: delayMs > 0 ? mode : 'off',
      delayMs,
      pullOnOpen: mode !== 'off' && Boolean(prefs.autoPullOnOpen),
      checkedAt: Date.now(),
    }
  } catch {
    config = { mode: 'off', delayMs: 0, pullOnOpen: false, checkedAt: Date.now() }
  }
  return config
}

/** 拉取后调用：1 秒内不再触发自动推送 */
function markJustPulled(): void {
  justPulledAt = Date.now()
}

/** 当前是否处于「刚拉取完」的抑制窗口内 */
function isJustPulled(): boolean {
  return Date.now() - justPulledAt < JUST_PULLED_MS
}

async function flush(mode: Mode) {
  if (running) {
    queued = true
    return
  }
  // 刚拉下来的内容不是用户的修改，不推回去（参考项目用 justPulledFile 达到同样效果）
  if (isJustPulled()) return
  running = true
  try {
    if (mode === 'store') await syncStorePush({ removeDeleted: false })
    else if (mode === 'git') {
      // Git 通道：先提交，再推送；没配置远端 / 无凭据时静默失败（同步页里能看到原因）。
      // 基线由后端在推送成功后自己收口，这里不必再发一次 recordBase。
      await syncCommit('')
      await syncPush()
    }
  } catch {
    // 自动同步失败不打扰用户，设置页的日志与状态卡片里能看到原因
  } finally {
    running = false
    if (queued) {
      queued = false
      void flush(mode)
    }
  }
}

/** 保存笔记后调用：满足条件时按所选延迟排队一次同步 */
export function scheduleAutoSync(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
  void (async () => {
    const next = await resolveConfig()
    if (next.mode === 'off' || next.delayMs <= 0) return
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      void (async () => {
        // 到点时再确认一次：等待期间用户可能已经把自动同步关掉
        const latest = await resolveConfig()
        if (latest.mode !== 'off' && latest.delayMs > 0) await flush(latest.mode)
      })()
    }, next.delayMs)
  })()
}

/**
 * 打开 / 切换文件时调用：远端有更新就把这一个文件拉下来
 *
 * 返回 `{ updated, content }` 时调用方应当用 `content` 渲染编辑器；
 * 返回 `conflict` 时不动本地内容，由界面弹窗让用户选保留哪边。
 * 未开启自动拉取、远端无更新、离线时一律返回 null，调用方按本地内容渲染即可。
 */
export async function pullOnOpen(path: string): Promise<PullOnOpenResult | null> {
  const next = await resolveConfig()
  if (!next.pullOnOpen || next.mode === 'off') return null

  if (next.mode === 'store') {
    const status = await syncStoreStatus()
    if (!status.ready || status.pendingDownload <= 0) return null
    await syncStorePull()
    markJustPulled()
    return { updated: true }
  }

  const decision = await syncCompare(path)
  // 远端不可达：保持本地内容，不报错（与参考项目的静默处理一致）
  if (decision.offline) return null
  if (decision.action === 'conflict') {
    return {
      updated: false,
      conflict: {
        path,
        local: decision.localContent ?? '',
        remote: decision.remoteContent ?? '',
      },
    }
  }
  if (decision.action !== 'pull') return null

  const pulled = await syncPullFile(path)
  markJustPulled()
  return { updated: pulled.updated, content: pulled.binary ? undefined : pulled.content }
}

/** 设置变更后让缓存立即失效 */
export function invalidateAutoSyncConfig(): void {
  config = { mode: 'off', delayMs: 0, pullOnOpen: false, checkedAt: 0 }
}
