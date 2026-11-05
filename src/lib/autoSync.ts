/**
 * 自动同步（对齐 NoteGen 的 `auto-sync` 队列 + 打开即拉取）
 *
 * 同步偏好存在后端 `app.sync.prefs`，与平台无关：
 * - 自动同步笔记：编辑停止后按所选延迟同步（对象存储/自托管=增量上传，Git=提交并推送）；
 * - 打开或切换文件时自动拉取：远端有更新才拉（对象存储看待下载数，Git 看 behind）。
 *
 * 单实例 + 串行 + 配置缓存 60 秒，设置里一改就失效，下次保存 / 打开即生效。
 */
import {
  syncCommit,
  syncPrefs,
  syncPull,
  syncPush,
  syncStatus,
  syncStoreOptions,
  syncStorePull,
  syncStorePush,
  syncStoreStatus,
} from '@/lib/rpc'

const STORE_PROVIDERS = ['s3', 'webdav', 'selfHosted']
const GIT_PROVIDERS = ['github', 'gitee', 'gitlab', 'gitea']
/** 配置缓存时长 */
const CONFIG_TTL_MS = 60_000
/** 打开即拉取的节流间隔 */
const PULL_ON_OPEN_THROTTLE_MS = 300_000

type Mode = 'off' | 'store' | 'git'

interface AutoSyncConfig {
  mode: Mode
  /** 自动同步间隔，0 表示关闭 */
  delayMs: number
  pullOnOpen: boolean
  checkedAt: number
}

let config: AutoSyncConfig = { mode: 'off', delayMs: 0, pullOnOpen: false, checkedAt: 0 }
let timer: number | undefined
let running = false
let queued = false
let lastPullOnOpenAt = 0
let pullingOnOpen = false

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

async function flush(mode: Mode) {
  if (running) {
    queued = true
    return
  }
  running = true
  try {
    if (mode === 'store') await syncStorePush({ removeDeleted: false })
    else if (mode === 'git') {
      // Git 通道：先提交，再推送；没配置远端 / 无凭据时静默失败（同步页里能看到原因）
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

/** 打开 / 切换文件后调用：远端有更新且开启自动拉取时拉一次 */
export function schedulePullOnOpen(): void {
  if (pullingOnOpen) return
  if (Date.now() - lastPullOnOpenAt < PULL_ON_OPEN_THROTTLE_MS) return
  pullingOnOpen = true
  void (async () => {
    try {
      const next = await resolveConfig()
      if (!next.pullOnOpen || next.mode === 'off') return
      if (next.mode === 'store') {
        const status = await syncStoreStatus()
        if (!status.ready || status.pendingDownload <= 0) return
        lastPullOnOpenAt = Date.now()
        await syncStorePull()
        return
      }
      const status = await syncStatus()
      // 远端没有更新的提交时不打扰（相当于「仅提示可用更新」）
      if (!status.isRepo || status.behind <= 0) return
      lastPullOnOpenAt = Date.now()
      await syncPull()
    } catch {
      // 拉取失败（离线 / 凭据失效）时保持本地内容，用户可在同步设置里手动重试
    } finally {
      pullingOnOpen = false
    }
  })()
}

/** 设置变更后让缓存立即失效 */
export function invalidateAutoSyncConfig(): void {
  config = { mode: 'off', delayMs: 0, pullOnOpen: false, checkedAt: 0 }
}
