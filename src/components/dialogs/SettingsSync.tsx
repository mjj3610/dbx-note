import { useCallback, useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  Database,
  Download,
  GitBranch,
  GitFork,
  Github,
  Gitlab,
  HardDrive,
  Loader2,
  RefreshCw,
  Save,
  Server,
  ServerCog,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge, Switch } from '@/components/ui/misc'
import { Field, SettingItem } from '@/components/dialogs/settings/Parts'
import {
  backupDelete,
  backupExport,
  backupImport,
  backupList,
  syncCommit,
  syncInit,
  syncOptions,
  syncPull,
  syncPush,
  syncRemote,
  syncSaveOptions,
  syncSaveStoreOptions,
  syncStatus,
  syncStoreCheck,
  syncStoreLogs,
  syncStoreOptions,
  syncStorePull,
  syncStorePush,
  syncStoreStatus,
  syncPrefs,
  syncSavePrefs,
  type BackupItem,
  type AutoSyncInterval,
  type ConflictPolicy,
  type StoreConfig,
  type StoreLogEntry,
  type StoreStatus,
  type SyncPrefs,
  type SyncOptions,
  type SyncStatus,
} from '@/lib/rpc'
import { invalidateAutoSyncConfig } from '@/lib/autoSync'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'

/** 走文件镜像通道的三个平台（不依赖 git） */
const STORE_PROVIDERS = ['s3', 'webdav', 'selfHosted'] as const
type StoreProvider = (typeof STORE_PROVIDERS)[number]

function isStoreProvider(value: string): value is StoreProvider {
  return (STORE_PROVIDERS as readonly string[]).includes(value)
}

/**
 * 同步平台清单（对齐 NoteGen 的「选择同步平台」列表）
 *
 * `value` 为 null 表示不启用远端同步，只在本机保存。
 */
const PLATFORM_LIST: Array<{
  value: string | null
  labelKey: string
  icon: typeof HardDrive
}> = [
  { value: null, labelKey: 'sync.platform.local', icon: HardDrive },
  { value: 'github', labelKey: 'sync.platform.github', icon: Github },
  { value: 'gitee', labelKey: 'sync.platform.gitee', icon: GitFork },
  { value: 'gitlab', labelKey: 'sync.platform.gitlab', icon: Gitlab },
  { value: 'gitea', labelKey: 'sync.platform.gitea', icon: Server },
  { value: 's3', labelKey: 'sync.platform.s3', icon: Database },
  { value: 'webdav', labelKey: 'sync.platform.webdav', icon: Cloud },
  { value: 'selfHosted', labelKey: 'sync.platform.selfHosted', icon: ServerCog },
]

/**
 * 各托管平台的远端地址示例，切换平台时更新占位提示。
 *
 * 统一给 HTTPS 形式：本插件的认证是「访问令牌 + HTTPS」，推送时把令牌临时拼进 URL，
 * 提示成 SSH 形式会让用户以为要配 SSH key，反而走不通。
 */
const REMOTE_PLACEHOLDER: Record<string, string> = {
  github: 'https://github.com/user/notes.git',
  gitee: 'https://gitee.com/user/notes.git',
  gitlab: 'https://gitlab.com/user/notes.git',
  gitea: 'https://your-gitea.com/user/notes.git',
}

/** S3 预设（与图床模块共用一套文案） */
const S3_PRESETS = [
  'custom',
  'aws',
  'cloudflare-r2',
  'aliyun-oss',
  'tencent-cos',
  'minio',
  'backblaze-b2',
] as const

const S3_ENDPOINT_PLACEHOLDER: Record<string, string> = {
  'cloudflare-r2': 'https://<账户 ID>.r2.cloudflarestorage.com',
  minio: 'http://127.0.0.1:9000',
  custom: 'https://s3.example.com',
  aws: 'https://s3.us-east-1.amazonaws.com',
  'aliyun-oss': 'https://oss-cn-hangzhou.aliyuncs.com',
  'tencent-cos': 'https://cos.ap-guangzhou.myqcloud.com',
  'backblaze-b2': 'https://s3.us-west-004.backblazeb2.com',
}

/** 自动同步间隔候选（秒），与 NoteGen 的「自动同步笔记」下拉一致 */
const AUTO_SYNC_OPTIONS: AutoSyncInterval[] = ['disabled', '2', '3', '5', '10', '20', '30', '60', '120']
const AUTO_SYNC_LABELS: Record<AutoSyncInterval, string> = {
  disabled: 'disabled',
  '2': '2s',
  '3': '3s',
  '5': '5s',
  '10': '10s',
  '20': '20s',
  '30': '30s',
  '60': '1m',
  '120': '2m',
}

/**
 * 设置 → 同步
 *
 * 左栏选择平台；右侧按平台渲染：
 * - GitHub / Gitee / GitLab / Gitea：Git 仓库（远端地址、令牌、提交信息模板）；
 * - 对象存储 / WebDAV / 自托管：文件镜像（配置 + 连接检测 + 立即上传/下载）；
 * 底部固定是工作区备份与恢复（本地 zip，不依赖任何远端）。
 */
export function SyncSection() {
  const t = useT()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [options, setOptions] = useState<SyncOptions | null>(null)
  const [remote, setRemote] = useState('')
  const [token, setToken] = useState('')
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  // 上传 / 下载后让状态卡片重新拉一次
  const [storeTick, setStoreTick] = useState(0)

  const provider = options?.provider ?? 'github'
  const store = isStoreProvider(provider)

  const refresh = useCallback(async () => {
    try {
      const [next, config] = await Promise.all([syncStatus(), syncOptions()])
      setStatus(next)
      setOptions(config.options)
      setTemplate((current) => current || config.options.messageTemplate)
      setRemote((current) => current || next.remote)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: string, task: () => Promise<string>) => {
    setBusy(action)
    setError('')
    setOutput('')
    try {
      const message = await task()
      setOutput(message)
      await refresh()
      toast.success(message)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(message)
    } finally {
      setBusy('')
    }
  }

  const saveOptions = (patch: Parameters<typeof syncSaveOptions>[0]) =>
    void run('options', async () => {
      const saved = await syncSaveOptions(patch)
      setOptions(saved.options)
      setToken('')
      return t('toast.saved')
    })

  const actions = [
    {
      key: 'commit',
      label: t('sync.commit'),
      icon: Save,
      run: async () => (await syncCommit('')).message,
    },
    {
      key: 'pull',
      label: t('sync.pull'),
      icon: ArrowDownToLine,
      run: async () => (await syncPull()).output || t('sync.done'),
    },
    {
      key: 'push',
      label: t('sync.push'),
      icon: ArrowUpFromLine,
      run: async () => (await syncPush()).output || t('sync.done'),
    },
  ]

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('sync.title')}</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {store ? t('sync.store.hint') : t('sync.hint')}
        </p>

        {/* 选择同步平台：左侧平台列表，右侧当前平台说明 */}
        <div className="grid grid-cols-[176px_minmax(0,1fr)] items-start gap-3">
          <div className="rounded-xl border border-border">
            <div className="border-b border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
              {t('sync.selectPlatform')}
            </div>
            <div className="space-y-0.5 p-1">
              {PLATFORM_LIST.map((item) => {
                const Icon = item.icon
                const active = item.value === null ? !status?.isRepo && !store : provider === item.value
                return (
                  <button
                    key={item.labelKey}
                    type="button"
                    data-sync-platform={item.value ?? 'local'}
                    aria-pressed={active}
                    onClick={() => {
                      setRemote('')
                      if (!item.value) return
                      void run('platform', async () => {
                        const saved = await syncSaveOptions({ provider: item.value as string })
                        setOptions(saved.options)
                        return t('sync.saved')
                      })
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                      active
                        ? 'bg-primary/5 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            {store ? (
              <StoreStatusCard
                provider={provider as StoreProvider}
                tick={storeTick}
                onRefresh={() => setStoreTick((value) => value + 1)}
              />
            ) : (
              <div className="rounded-xl border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] font-medium">
                    {status?.isRepo ? status.branch || 'main' : t('sync.noRepo')}
                  </span>
                  {status?.isRepo ? (
                    <Badge className="ml-auto">{t('sync.gitRepo')}</Badge>
                  ) : (
                    <Badge className="ml-auto">{t('sync.localOnly')}</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('common.refresh')}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </div>

                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
                  <dt className="text-muted-foreground">{t('sync.git')}</dt>
                  <dd className="truncate">
                    {status?.available ? status.gitVersion : t('sync.gitMissing')}
                  </dd>
                  <dt className="text-muted-foreground">{t('sync.remote')}</dt>
                  <dd className="truncate">{status?.remote || '—'}</dd>
                  <dt className="text-muted-foreground">{t('sync.changes')}</dt>
                  <dd>
                    {status?.isRepo
                      ? t('sync.changeCount', {
                          count: status.changed.length,
                          ahead: status.ahead,
                          behind: status.behind,
                        })
                      : '—'}
                  </dd>
                  <dt className="text-muted-foreground">{t('sync.lastCommit')}</dt>
                  <dd className="truncate">
                    {status?.lastCommit ? `${status.lastCommit} ${status.lastCommitMessage ?? ''}` : '—'}
                  </dd>
                </dl>
              </div>
            )}
          </div>
        </div>
      </section>

      {store ? (
        <StoreSyncPanel provider={provider} onChanged={() => setStoreTick((value) => value + 1)} />
      ) : (
        <>
          <section className="space-y-2">
            <Label>{t('sync.remoteUrl')}</Label>
            <div className="flex items-center gap-2">
              <Input
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                placeholder={REMOTE_PLACEHOLDER[options?.provider ?? 'github'] ?? 'https://github.com/user/notes.git'}
                aria-label={t('sync.remoteUrl')}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!remote.trim() || busy !== ''}
                onClick={() =>
                  void run('remote', async () => {
                    const next = status?.isRepo ? await syncRemote(remote.trim()) : await syncInit({ url: remote.trim() })
                    return next.isRepo ? t('sync.remoteSaved') : t('sync.saved')
                  })
                }
              >
                {t('common.save')}
              </Button>
            </div>
            {!status?.isRepo ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== '' || !status?.available}
                onClick={() =>
                  void run('init', async () => {
                    await syncInit({ url: remote.trim() || undefined })
                    return t('sync.inited')
                  })
                }
              >
                {t('sync.init')}
              </Button>
            ) : null}
          </section>

          {/* 托管平台与令牌 */}
          <section className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('sync.token')}</Label>
              <div className="flex items-center gap-2" data-token-row="1">
                <Input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={options?.hasToken ? options.tokenMask : 'ghp_...'}
                  aria-label={t('sync.token')}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!token.trim() || busy !== ''}
                  onClick={() => saveOptions({ token: token.trim() })}
                >
                  {busy === 'options' ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {t('common.save')}
                </Button>
                {options?.hasToken ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== ''}
                    onClick={() => saveOptions({ clearToken: true })}
                  >
                    {t('sync.clearToken')}
                  </Button>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {options?.hasToken ? t('sync.tokenKeep', { mask: options.tokenMask }) : t('sync.tokenHint')}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{t('sync.autoCommit')}</div>
                <p className="text-[11px] text-muted-foreground">{t('sync.autoCommitHint')}</p>
              </div>
              <Switch
                aria-label={t('sync.autoCommit')}
                checked={Boolean(options?.autoCommit)}
                onCheckedChange={(checked) => saveOptions({ autoCommit: checked })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('sync.messageTemplate')}</Label>
              <Input
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                onBlur={() => {
                  if (template !== (options?.messageTemplate ?? '')) saveOptions({ messageTemplate: template })
                }}
                placeholder="chore: sync notes {date} {time}"
                aria-label={t('sync.messageTemplate')}
              />
              <p className="text-[11px] text-muted-foreground">{t('sync.messageTemplateHint')}</p>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {actions.map((action) => {
                const Icon = action.icon
                return (
                  <Button
                    key={action.key}
                    size="sm"
                    variant="outline"
                    disabled={!status?.isRepo || busy !== '' || !status?.available}
                    onClick={() => void run(action.key, action.run)}
                  >
                    {busy === action.key ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                    {action.label}
                  </Button>
                )
              })}
            </div>
            {output ? (
              <pre className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">
                {output}
              </pre>
            ) : null}
            {error ? (
              <pre className="max-h-32 overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] whitespace-pre-wrap text-destructive">
                {error}
              </pre>
            ) : null}
          </section>
        </>
      )}

      {/* 同步选项：与平台无关，Git / 对象存储 / 自托管都显示 */}
      <SyncOptionsPanel provider={provider} />
    </div>
  )
}

/* ---------------- 同步选项（平台无关） ---------------- */

/**
 * 同步选项
 *
 * 对齐 NoteGen「同步 → 同步选项」页签的两个卡片：
 * 「笔记设置」（自动同步延迟 + 打开即拉取）与「应用数据同步」
 * （记录 / 配置 / 对话 / 敏感配置）。配置存在后端 `app.sync.prefs`，
 * 所以切平台不会丢；这里每一项改动即时落盘。
 */
function SyncOptionsPanel({ provider }: { provider: string }) {
  const t = useT()
  const [prefs, setPrefs] = useState<SyncPrefs>({
    autoSync: '5',
    autoPullOnOpen: true,
    autoRecordSync: true,
    autoSettingsSync: true,
    autoConversationSync: true,
    excludeSensitiveConfig: true,
  })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const next = await syncPrefs()
        if (!alive) return
        setPrefs((current) => ({ ...current, ...next }))
      } catch {
        /* 读不到就按默认值展示，改动时再写 */
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  const update = (patch: SyncPrefs) => {
    setPrefs((current) => ({ ...current, ...patch }))
    setSaving(true)
    void (async () => {
      try {
        const saved = await syncSavePrefs(patch)
        setPrefs((current) => ({ ...current, ...saved }))
        // 让自动同步的配置缓存立刻失效
        invalidateAutoSyncConfig()
      } catch (error) {
        toast.error(t('toast.error', { message: error instanceof Error ? error.message : String(error) }))
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <>
      <section className="space-y-2" data-sync-options>
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">{t('sync.options')}</h3>
          {saving || !loaded ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : null}
        </div>

        {/* 笔记设置 */}
        <div className="space-y-2 rounded-xl border border-border p-2.5" data-sync-note-options>
          <div className="space-y-0.5">
            <div className="text-[12px] font-medium">{t('sync.store.noteSettings')}</div>
            <p className="text-[11px] text-muted-foreground">{t('sync.store.noteSettingsDesc')}</p>
          </div>

          <SettingItem title={t('sync.store.autoSync')} desc={t('sync.store.autoSyncDesc')}>
            <select
              value={prefs.autoSync ?? '5'}
              aria-label={t('sync.store.autoSync')}
              onChange={(event) => update({ autoSync: event.target.value as AutoSyncInterval })}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
            >
              {AUTO_SYNC_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`sync.store.autoSyncOptions.${AUTO_SYNC_LABELS[option]}`)}
                </option>
              ))}
            </select>
          </SettingItem>

          <SettingItem title={t('sync.store.autoPullOnOpen')} desc={t('sync.store.autoPullOnOpenDesc')}>
            <Switch
              aria-label={t('sync.store.autoPullOnOpen')}
              checked={prefs.autoPullOnOpen !== false}
              onCheckedChange={(checked) => update({ autoPullOnOpen: checked })}
            />
          </SettingItem>
        </div>

        {/* 应用数据同步 */}
        <div className="space-y-2 rounded-xl border border-border p-2.5" data-sync-data-options>
          <div className="space-y-0.5">
            <div className="text-[12px] font-medium">{t('sync.store.recordConfigSettings')}</div>
            <p className="text-[11px] text-muted-foreground">
              {t('sync.store.recordConfigSettingsDesc')}
            </p>
          </div>

          <SettingItem title={t('sync.store.autoRecordSync')} desc={t('sync.store.autoRecordSyncDesc')}>
            <Switch
              aria-label={t('sync.store.autoRecordSync')}
              checked={prefs.autoRecordSync !== false}
              onCheckedChange={(checked) => update({ autoRecordSync: checked })}
            />
          </SettingItem>

          <SettingItem title={t('sync.store.autoSettingsSync')} desc={t('sync.store.autoSettingsSyncDesc')}>
            <Switch
              aria-label={t('sync.store.autoSettingsSync')}
              checked={prefs.autoSettingsSync !== false}
              onCheckedChange={(checked) => update({ autoSettingsSync: checked })}
            />
          </SettingItem>

          <SettingItem
            title={t('sync.store.autoConversationSync')}
            desc={t('sync.store.autoConversationSyncDesc')}
          >
            <Switch
              aria-label={t('sync.store.autoConversationSync')}
              checked={prefs.autoConversationSync !== false}
              onCheckedChange={(checked) => update({ autoConversationSync: checked })}
            />
          </SettingItem>

          <SettingItem title={t('sync.store.privacyTitle')} desc={t('sync.store.privacyDesc')}>
            <Switch
              aria-label={t('sync.store.privacyTitle')}
              checked={prefs.excludeSensitiveConfig !== false}
              onCheckedChange={(checked) => update({ excludeSensitiveConfig: checked })}
            />
          </SettingItem>
        </div>
      </section>
    </>
  )
}

/* ---------------- 对象存储 / WebDAV / 自托管 ---------------- */

/** 当前平台的状态卡片（文件数、待上传/待下载、上次同步） */
function StoreStatusCard({
  provider,
  tick,
  onRefresh,
}: {
  provider: StoreProvider
  tick: number
  onRefresh: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<StoreStatus | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const next = await syncStoreStatus()
      setStatus(next)
      setError(next.reachable ? '' : next.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    // provider 切换、tick（上传 / 下载 / 保存之后）都要重新拉一次状态
  }, [load, tick, provider])

  return (
    <div className="rounded-xl border border-border px-3 py-2" data-store-status="1">
      <div className="flex items-center gap-2">
        <Database className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">
          {status?.prefix ? `${status.provider} · ${status.prefix}` : t(`sync.platform.${provider}`)}
        </span>
        {status?.reachable ? (
          <Badge className="ml-auto">{t('sync.store.reachable')}</Badge>
        ) : (
          <Badge className="ml-auto">{t('sync.store.unreachable')}</Badge>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={onRefresh}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{t('sync.store.localFiles')}</dt>
        <dd>
          {t('sync.store.fileCount', { count: status?.localFiles ?? 0 })}
          {status ? ` · ${formatSize(status.localBytes)}` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('sync.store.remoteFiles')}</dt>
        <dd>{t('sync.store.fileCount', { count: status?.remoteFiles ?? 0 })}</dd>
        <dt className="text-muted-foreground">{t('sync.store.pending')}</dt>
        <dd>
          {t('sync.store.pendingDetail', {
            upload: status?.pendingUpload ?? 0,
            download: status?.pendingDownload ?? 0,
            conflicts: status?.conflicts ?? 0,
          })}
        </dd>
        <dt className="text-muted-foreground">{t('sync.store.lastSync')}</dt>
        <dd>{status?.lastSyncAt || t('sync.store.never')}</dd>
      </dl>
      {error ? <p className="mt-1 text-[11px] break-all text-destructive">{error}</p> : null}
    </div>
  )
}

/** 三个平台的配置表单 + 检测 / 上传 / 下载 */
function StoreSyncPanel({
  provider,
  onChanged,
}: {
  provider: StoreProvider
  /** 上传 / 下载 / 保存完成后通知外层刷新状态卡片 */
  onChanged: () => void
}) {
  const t = useT()
  const [config, setConfig] = useState<StoreConfig>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [removeDeleted, setRemoveDeleted] = useState(false)
  const [policy, setPolicy] = useState<ConflictPolicy>('local')
  const [logs, setLogs] = useState<StoreLogEntry[]>([])

  useEffect(() => {
    let alive = true
    setLoaded(false)
    void (async () => {
      try {
        const [result, history] = await Promise.all([syncStoreOptions(), syncStoreLogs()])
        if (!alive) return
        setConfig(result.config ?? {})
        setPolicy((result.conflictPolicy as ConflictPolicy) ?? 'local')
        setLogs(history.items ?? [])
        setLoaded(true)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      alive = false
    }
  }, [provider])

  const patch = (next: StoreConfig) => setConfig((current) => ({ ...current, ...next }))
  const text = (key: string) => String(config[key] ?? '')

  const run = async (action: string, task: () => Promise<string>) => {
    setBusy(action)
    setError('')
    setOutput('')
    try {
      const message = await task()
      setOutput(message)
      toast.success(message)
      onChanged()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(message)
    } finally {
      setBusy('')
    }
  }

  /** 保存当前平台的连接配置；冲突策略这类开关改动即时落盘 */
  const persist = (patch: Partial<Parameters<typeof syncSaveStoreOptions>[0]> = {}) =>
    void run('save', async () => {
      const saved = await syncSaveStoreOptions({
        provider,
        config,
        conflictPolicy: policy,
        ...patch,
      })
      setConfig(saved.config)
      setPolicy((saved.conflictPolicy as ConflictPolicy) ?? 'local')
      invalidateAutoSyncConfig()
      return t('toast.saved')
    })

  const save = () => persist({})

  return (
    <>
      <section className="space-y-3">
        {!loaded ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        ) : provider === 's3' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ih.s3.provider')} hint={t('ih.s3.providerDesc')}>
                <select
                  value={text('preset') || 'custom'}
                  aria-label={t('ih.s3.provider')}
                  onChange={(event) => patch({ preset: event.target.value })}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
                >
                  {S3_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {t(`ih.s3.presets.${preset}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('ih.s3.region')} hint="us-east-1">
                <Input
                  value={text('region')}
                  aria-label={t('ih.s3.region')}
                  placeholder="us-east-1"
                  onChange={(event) => patch({ region: event.target.value })}
                />
              </Field>
            </div>

            <Field label={t('ih.s3.endpoint')} hint={t('ih.s3.endpointAutomaticDesc')}>
              <Input
                value={text('endpoint')}
                aria-label={t('ih.s3.endpoint')}
                placeholder={S3_ENDPOINT_PLACEHOLDER[text('preset') || 'custom'] ?? S3_ENDPOINT_PLACEHOLDER.custom}
                onChange={(event) => patch({ endpoint: event.target.value })}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ih.s3.bucket')}>
                <Input
                  value={text('bucket')}
                  aria-label={t('ih.s3.bucket')}
                  placeholder="my-notes"
                  onChange={(event) => patch({ bucket: event.target.value })}
                />
              </Field>
              <Field label={t('ih.s3.addressingStyle')} hint={t('ih.s3.addressingStyleDesc')}>
                <select
                  value={text('addressingStyle') || 'auto'}
                  aria-label={t('ih.s3.addressingStyle')}
                  onChange={(event) => patch({ addressingStyle: event.target.value })}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
                >
                  {(['auto', 'path', 'virtual'] as const).map((style) => (
                    <option key={style} value={style}>
                      {t(`ih.s3.addressingStyles.${style}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Access Key ID">
                <Input
                  value={text('accessKeyId')}
                  aria-label="Access Key ID"
                  placeholder="AKIA..."
                  onChange={(event) => patch({ accessKeyId: event.target.value })}
                />
              </Field>
              <Field
                label="Secret Access Key"
                hint={config.hasSecretAccessKey ? t('sync.store.secretKeep') : undefined}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={text('secretAccessKey')}
                  aria-label="Secret Access Key"
                  placeholder={String(config.secretAccessKeyMask ?? '')}
                  onChange={(event) => patch({ secretAccessKey: event.target.value })}
                />
              </Field>
            </div>
          </>
        ) : provider === 'webdav' ? (
          <>
            <Field label={t('ih.webdav.baseUrl')} hint="https://dav.example.com/notes">
              <Input
                value={text('baseUrl')}
                aria-label={t('ih.webdav.baseUrl')}
                placeholder="https://dav.example.com/notes"
                onChange={(event) => patch({ baseUrl: event.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ih.webdav.username')}>
                <Input
                  value={text('username')}
                  aria-label={t('ih.webdav.username')}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </Field>
              <Field label={t('ih.webdav.password')} hint={config.hasPassword ? t('sync.store.secretKeep') : undefined}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={text('password')}
                  aria-label={t('ih.webdav.password')}
                  placeholder={String(config.passwordMask ?? '')}
                  onChange={(event) => patch({ password: event.target.value })}
                />
              </Field>
            </div>
          </>
        ) : (
          <>
            <Field label={t('sync.store.selfHostedUrl')} hint={t('sync.store.selfHostedHint')}>
              <Input
                value={text('baseUrl')}
                aria-label={t('sync.store.selfHostedUrl')}
                placeholder="https://note.example.com/api/sync"
                onChange={(event) => patch({ baseUrl: event.target.value })}
              />
            </Field>
            <Field label={t('sync.token')} hint={config.hasToken ? t('sync.store.secretKeep') : undefined}>
              <Input
                type="password"
                autoComplete="off"
                value={text('token')}
                aria-label={t('sync.store.serviceToken')}
                placeholder={String(config.tokenMask ?? '')}
                onChange={(event) => patch({ token: event.target.value })}
              />
            </Field>
          </>
        )}

        <Field label={t('ih.pathPrefix')} hint={t('sync.store.prefixDesc')}>
          <Input
            value={text('pathPrefix')}
            aria-label={t('ih.pathPrefix')}
            placeholder="dbx-note"
            onChange={(event) => patch({ pathPrefix: event.target.value })}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy !== '' || !loaded} onClick={save}>
            {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {t('common.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== '' || !loaded}
            onClick={() =>
              void run('check', async () => {
                const result = await syncStoreCheck()
                if (!result.ok) throw new Error(result.message)
                return result.message || t('sync.done')
              })
            }
          >
            {busy === 'check' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('ih.testConnection')}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <SettingItem title={t('sync.store.conflictPolicy')} desc={t('sync.store.conflictPolicyDesc')}>
          <select
            value={policy}
            aria-label={t('sync.store.conflictPolicy')}
            onChange={(event) => {
              const next = event.target.value as ConflictPolicy
              setPolicy(next)
              persist({ conflictPolicy: next })
            }}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
          >
            {(['local', 'remote', 'skip'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`sync.store.policies.${value}`)}
              </option>
            ))}
          </select>
        </SettingItem>

        <SettingItem
          title={t('sync.store.removeDeleted')}
          desc={t('sync.store.removeDeletedDesc')}
        >
          <Switch
            aria-label={t('sync.store.removeDeleted')}
            checked={removeDeleted}
            onCheckedChange={setRemoveDeleted}
          />
        </SettingItem>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== '' || !loaded}
            onClick={() =>
              void run('push', async () => {
                const result = await syncStorePush({ removeDeleted })
                if (result.failed.length > 0) {
                  throw new Error(`${result.message}\n${result.failed.slice(0, 5).join('\n')}`)
                }
                return result.message
              })
            }
          >
            {busy === 'push' ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpFromLine className="size-3.5" />}
            {t('sync.store.push')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== '' || !loaded}
            onClick={() =>
              void run('pull', async () => {
                const result = await syncStorePull()
                if (result.failed.length > 0) {
                  throw new Error(`${result.message}\n${result.failed.slice(0, 5).join('\n')}`)
                }
                return result.message
              })
            }
          >
            {busy === 'pull' ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />}
            {t('sync.store.pull')}
          </Button>
        </div>

        {output ? (
          <pre className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">
            {output}
          </pre>
        ) : null}
        {error ? (
          <pre className="max-h-32 overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] whitespace-pre-wrap text-destructive">
            {error}
          </pre>
        ) : null}

        {/* 同步历史（最近 100 条，与 NoteGen 的 sync_logs 一致） */}
        <div className="space-y-1.5 pt-1" data-sync-logs>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('sync.store.logs')}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== ''}
              onClick={() =>
                void run('logs', async () => {
                  const history = await syncStoreLogs()
                  setLogs(history.items ?? [])
                  return t('common.refresh')
                })
              }
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {logs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
              {t('sync.store.noLogs')}
            </p>
          ) : (
            <ul className="max-h-32 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {logs.slice(0, 20).map((entry) => (
                <li key={`${entry.at}-${entry.action}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                  <span className={cn('size-1.5 shrink-0 rounded-full', entry.ok ? 'bg-primary' : 'bg-destructive')} />
                  <span className="w-10 shrink-0 text-muted-foreground">
                    {entry.action === 'push' ? t('sync.store.pushShort') : t('sync.store.pullShort')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.action === 'push'
                      ? t('sync.store.logPush', { count: entry.pushed ?? 0 })
                      : t('sync.store.logPull', {
                          count: entry.pulled ?? 0,
                          conflicts: entry.conflicts ?? 0,
                        })}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatLogTime(entry.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  )
}

function formatLogTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/* ---------------- 备份与恢复 ---------------- */

/** 独立的「备份与恢复」设置页（NoteGen 把它与同步拆成两项） */
export function BackupSection() {
  return (
    <div className="space-y-6">
      <BackupBlock standalone />
    </div>
  )
}

function BackupBlock({ standalone = false }: { standalone?: boolean }) {
  const t = useT()
  const [items, setItems] = useState<BackupItem[]>([])
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState('')
  const [includeGit, setIncludeGit] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = await backupList()
      setItems(result.items)
      setDir(result.dir)
    } catch {
      // 备份目录还不存在时忽略，导出后自然出现
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const exportNow = async () => {
    setBusy('export')
    try {
      const result = await backupExport(includeGit)
      toast.success(t('backup.created', { name: result.name }))
      await refresh()
    } catch (cause) {
      toast.error(t('toast.error', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy('')
    }
  }

  const restore = async (item: BackupItem, overwrite: boolean) => {
    setBusy(item.path)
    try {
      const result = await backupImport({ path: item.path, overwrite })
      toast.success(t('backup.imported', { path: result.path }))
    } catch (cause) {
      toast.error(t('toast.error', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy('')
    }
  }

  const remove = async (item: BackupItem) => {
    setBusy(item.path)
    try {
      await backupDelete(item.path)
      toast.success(t('backup.deleted'))
      await refresh()
    } catch (cause) {
      toast.error(t('toast.error', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className={standalone ? 'space-y-2' : 'space-y-2 border-t border-border pt-4'}>
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold">{t('backup.title')}</h3>
        <Archive className="size-3.5 text-muted-foreground" />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('backup.hint')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void exportNow()} disabled={busy !== ''}>
          {busy === 'export' ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {busy === 'export' ? t('backup.exporting') : t('backup.export')}
        </Button>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            aria-label={t('backup.includeGit')}
            checked={includeGit}
            onCheckedChange={setIncludeGit}
            className="scale-90"
          />
          {t('backup.includeGit')}
        </label>
      </div>

      {dir ? (
        <p className="text-[11px] break-all text-muted-foreground">
          {t('backup.dir')}: {dir}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
          {t('backup.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => (
            <li key={item.path} className="flex items-center gap-2 px-3 py-2" data-backup={item.name}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">{item.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatSize(item.size)} · {formatTime(item.createdAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== ''}
                aria-label={`${t('backup.import')} ${item.name}`}
                onClick={() => void restore(item, false)}
              >
                {busy === item.path ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArchiveRestore className="size-3.5" />
                )}
                {t('backup.import')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== ''}
                title={t('backup.overwriteWarn')}
                aria-label={`${t('backup.overwrite')} ${item.name}`}
                onClick={() => void restore(item, true)}
              >
                {t('backup.overwrite')}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy !== ''}
                aria-label={`${t('common.delete')} ${item.name}`}
                onClick={() => void remove(item)}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatTime(value: number): string {
  const date = new Date(value < 1e12 ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}
