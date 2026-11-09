import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Cloud,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  Globe2,
  HardDrive,
  Image as ImageIcon,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  UploadCloud,
  WandSparkles,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge, Switch } from '@/components/ui/misc'
import * as rpc from '@/lib/rpc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import {
  useSettingsStore,
  type ImageProvider,
  type ObjectStoragePreset,
} from '@/stores/settings'

const PROVIDERS: ImageProvider[] = [
  'local',
  'github',
  'smms',
  'picgo',
  's3',
  'qiniu',
  'upyun',
  'lsky',
  'webdav',
  'custom-http',
  'cloudinary',
  'imagekit',
]

const PROVIDER_ICONS: Record<ImageProvider, typeof HardDrive> = {
  local: HardDrive,
  github: GitBranch,
  smms: ImageIcon,
  picgo: UploadCloud,
  s3: Database,
  qiniu: Cloud,
  upyun: UploadCloud,
  lsky: Server,
  webdav: FolderOpen,
  'custom-http': Globe2,
  cloudinary: Sparkles,
  imagekit: WandSparkles,
}

const S3_PRESETS: ObjectStoragePreset[] = [
  'aws',
  'cloudflare-r2',
  'aliyun-oss',
  'tencent-cos',
  'backblaze-b2',
  'minio',
  'custom',
]

/**
 * 设置 → 图片存储
 *
 * 左栏选择存储方式（本地 / 各家图床），右栏是该图床的配置卡片：
 * 连接状态、`使用此服务`、字段表单、测试连接，GitHub 另有仓库状态与 jsDelivr 加速。
 * 上传本身在 Sidecar 里完成（沙箱页面发不出请求）。
 */
export function ImageHostingSection() {
  const t = useT()
  const hosting = useSettingsStore((state) => state.imageHosting)
  const [section, setSection] = useState<ImageProvider>(hosting.provider)
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [message, setMessage] = useState('')
  const [info, setInfo] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  /**
   * 连接检测请求序号。切平台时会自动检测一次，用户改完地址又会手动点一次；
   * 后端较慢时，先发的那次（通常是默认地址、必然失败）可能后回来，把「已连接」
   * 覆盖成「未连接」，导致「使用此服务」按钮重新变灰。只允许最后一次请求写状态。
   */
  const checkSeq = useRef(0)

  const current = hosting.provider
  const provider = section

  const runCheck = useCallback(async (target: ImageProvider) => {
    const seq = ++checkSeq.current
    if (target === 'local') return
    setState('checking')
    setMessage('')
    try {
      // 从 store 读实时配置：用户刚填完地址就点检测时，闭包里的 hosting 可能还是旧值
      const config = { ...useSettingsStore.getState().imageHosting, provider: target }
      const result = await rpc.imageHostingCheck(config)
      if (seq !== checkSeq.current) return
      setState(result.ok ? 'ok' : 'fail')
      setMessage(result.message)
      setInfo(result.info ?? {})
    } catch (error) {
      if (seq !== checkSeq.current) return
      setState('fail')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [])

  // 切到某个图床时自动检测一次，让状态徽标真实反映配置
  useEffect(() => {
    // 先作废在飞请求（切到「本地存储」时尤其重要，那里不会再发新请求）
    checkSeq.current += 1
    setState('idle')
    setMessage('')
    setInfo({})
    if (section === 'local') return
    void runCheck(section)
  }, [section, runCheck])

  const useProvider = async (target: ImageProvider) => {
    setBusy(true)
    try {
      const latest = useSettingsStore.getState().imageHosting
      useSettingsStore.getState().patch({ imageHosting: { ...latest, provider: target } })
      toast.success(t('toast.saved'))
    } finally {
      setBusy(false)
    }
  }

  const Header = PROVIDER_ICONS[provider]
  const isCurrent = current === provider

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="size-4" />
          {t('ih.title')}
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('ih.desc')}</p>
      </div>

      <div className="grid grid-cols-[190px_minmax(0,1fr)] items-start gap-4">
        {/* 左：存储方式 */}
        <div className="rounded-xl border border-border">
          <div className="border-b border-border px-3 py-2 text-[12px] font-medium">
            {t('ih.platformSettings')}
          </div>
          <div className="max-h-[46vh] overflow-y-auto p-1.5">
            {PROVIDERS.map((item) => {
              const Icon = PROVIDER_ICONS[item]
              const selected = section === item
              return (
                <button
                  key={item}
                  type="button"
                  data-provider={item}
                  aria-pressed={selected}
                  onClick={() => setSection(item)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
                    selected
                      ? 'border border-primary/40 bg-primary/5 font-medium text-foreground'
                      : 'border border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t(`ih.name.${item}`)}</span>
                  {current === item ? <Badge className="shrink-0">{t('ih.current')}</Badge> : null}
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：当前平台 */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-start justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Header className="size-6 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{t(`ih.name.${provider}`)}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {t(`ih.desc.${provider}`)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {provider !== 'local' ? <StatusBadge state={state} message={message} /> : null}
              <Button
                size="sm"
                variant={isCurrent ? 'secondary' : 'default'}
                disabled={isCurrent || busy || (provider !== 'local' && state !== 'ok')}
                onClick={() => void useProvider(provider)}
              >
                {isCurrent ? <Check className="size-3.5" /> : null}
                {isCurrent
                  ? t('ih.current')
                  : provider === 'local'
                    ? t('ih.useLocal')
                    : t('ih.useThis')}
              </Button>
            </div>
          </div>

          {provider === 'local' ? <LocalForm /> : null}
          {provider === 'github' ? (
            <GithubForm
              state={state}
              info={info}
              onCheck={() => void runCheck('github')}
              checking={state === 'checking'}
            />
          ) : null}
          {provider === 'smms' ? <SmmsForm info={info} /> : null}
          {provider === 'picgo' ? <PicgoForm onCheck={() => void runCheck('picgo')} /> : null}
          {provider === 's3' ? (
            <S3Form onCheck={() => void runCheck('s3')} checking={state === 'checking'} />
          ) : null}
          {provider === 'qiniu' ? <QiniuForm /> : null}
          {provider === 'upyun' ? <UpyunForm onCheck={() => void runCheck('upyun')} /> : null}
          {provider === 'lsky' ? <LskyForm onCheck={() => void runCheck('lsky')} /> : null}
          {provider === 'webdav' ? <WebdavForm onCheck={() => void runCheck('webdav')} /> : null}
          {provider === 'custom-http' ? <CustomHttpForm /> : null}
          {provider === 'cloudinary' ? <CloudinaryForm /> : null}
          {provider === 'imagekit' ? <ImagekitForm onCheck={() => void runCheck('imagekit')} /> : null}

          {provider !== 'local' ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={state === 'checking'}
                onClick={() => void runCheck(provider)}
              >
                {state === 'checking' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t('ih.testConnection')}
              </Button>
              {message ? (
                <span
                  className={cn(
                    'truncate text-[11px]',
                    state === 'ok' ? 'text-muted-foreground' : 'text-destructive',
                  )}
                  title={message}
                >
                  {message}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ---------------- 小组件 ---------------- */

function StatusBadge({
  state,
  message,
}: {
  state: 'idle' | 'checking' | 'ok' | 'fail'
  message?: string
}) {
  const t = useT()
  if (state === 'checking') {
    return (
      <Badge className="gap-1 bg-muted text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t('ih.status.checking')}
      </Badge>
    )
  }
  if (state === 'ok') {
    return (
      <Badge className="gap-1" title={message}>
        <Check className="size-3" />
        {t('ih.status.connected')}
      </Badge>
    )
  }
  if (state === 'idle') return null
  return (
    <Badge className="gap-1 bg-destructive/10 text-destructive" title={message}>
      <XCircle className="size-3" />
      {t('ih.status.disconnected')}
    </Badge>
  )
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      {title ? <div className="text-[13px] font-semibold">{title}</div> : null}
      {children}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="truncate text-[12px]">{value}</span>
    </div>
  )
}

/* ---------------- 本地存储 ---------------- */

function LocalForm() {
  const t = useT()
  const image = useSettingsStore((state) => state.image)
  const patch = useSettingsStore((state) => state.patch)
  const modes: Array<'uuid' | 'date' | 'original'> = ['uuid', 'date', 'original']

  return (
    <Panel>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
          <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{t('ih.local.locationTitle')}</div>
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              {t('ih.local.locationDesc')}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
          <Link2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{t('ih.local.relativeTitle')}</div>
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              {t('ih.local.relativeDesc')}
            </div>
          </div>
        </div>
      </div>

      <Field label={t('media.imageDir')} hint={t('media.imageDirHint')}>
        <Input
          value={image.dir}
          aria-label={t('media.imageDir')}
          onChange={(event) => patch({ image: { ...image, dir: event.target.value } })}
          placeholder="assets"
        />
      </Field>

      <Field label={t('media.nameMode')}>
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={image.nameMode === mode}
              onClick={() => patch({ image: { ...image, nameMode: mode } })}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs transition-colors',
                image.nameMode === mode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground',
              )}
            >
              {t(`media.nameMode.${mode}`)}
            </button>
          ))}
        </div>
      </Field>
    </Panel>
  )
}

/* ---------------- GitHub ---------------- */

function GithubForm({
  state,
  info,
  onCheck,
  checking,
}: {
  state: string
  info: Record<string, unknown>
  onCheck: () => void
  checking: boolean
}) {
  const t = useT()
  const github = useSettingsStore((store) => store.imageHosting.github)
  const jsdelivr = useSettingsStore((store) => store.imageHosting.jsdelivr)
  const provider = useSettingsStore((store) => store.imageHosting.provider)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  const [visible, setVisible] = useState(false)
  const [repoBusy, setRepoBusy] = useState('')
  const [repo, setRepo] = useState<{
    exists: boolean
    owner?: string
    repoName?: string
    repo?: Record<string, unknown>
  } | null>(null)

  const checkRepo = useCallback(async () => {
    if (!github.token.trim()) return
    setRepoBusy('check')
    try {
      const hosting = useSettingsStore.getState().imageHosting
      const result = await rpc.imageHostingRepo({ ...hosting, provider: 'github' }, 'check')
      setRepo(result)
      if (result.owner && result.owner !== github.username) {
        patchHosting('github', { username: result.owner })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRepoBusy('')
    }
  }, [github.token, github.username, patchHosting])

  const createRepo = async () => {
    setRepoBusy('create')
    try {
      const hosting = useSettingsStore.getState().imageHosting
      const result = await rpc.imageHostingRepo({ ...hosting, provider: 'github' }, 'create')
      setRepo({ ...result, exists: true })
      toast.success(t('ih.github.created'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRepoBusy('')
    }
  }

  // 填了 Token 就先查一次仓库
  useEffect(() => {
    if (github.token.trim() && repo === null) void checkRepo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github.token])

  const repoName = github.repo || 'note-gen-image-sync'

  return (
    <Panel>
      <Row
        label={t('ih.github.repoStatus')}
        value={
          repoBusy
            ? t('ih.github.checking')
            : repo?.exists
              ? t('ih.github.repoExists')
              : state === 'ok'
                ? t('ih.github.repoNotExists')
                : t('ih.github.repoNotExists')
        }
      />

      {github.token && repo && !repo.exists ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void createRepo()} disabled={repoBusy !== ''}>
            {repoBusy === 'create' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('ih.github.createNewRepo')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void checkRepo()} disabled={repoBusy !== ''}>
            {repoBusy === 'check' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('ih.github.recheckRepo')}
          </Button>
        </div>
      ) : null}

      <Field label={t('ih.customRepoName')} hint={t('ih.customRepoNameDesc')}>
        <Input
          value={github.repo}
          aria-label={t('ih.customRepoName')}
          placeholder={repoName}
          onChange={(event) => patchHosting('github', { repo: event.target.value })}
          onBlur={() => void checkRepo()}
        />
      </Field>

      <Field
        label="GitHub Access Token"
        hint={t('ih.github.tokenHint')}
      >
        <div className="flex items-center gap-2" data-token-row="github">
          <Input
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            value={github.token}
            aria-label="GitHub Access Token"
            placeholder={t('ih.tokenPlaceholder')}
            onChange={(event) => patchHosting('github', { token: event.target.value })}
            onBlur={() => void checkRepo()}
          />
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={visible ? t('ih.hideToken') : t('ih.showToken')}
            onClick={() => setVisible((value) => !value)}
          >
            {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
          <Button size="sm" asChild>
            <a
              href="https://github.com/settings/personal-access-tokens/new?name=NoteGen&description=NoteGen+image+hosting&expires_in=none&contents=write&administration=write"
              target="_blank"
              rel="noreferrer"
            >
              {t('ih.github.createToken')}
            </a>
          </Button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t('ih.github.tokenRights')}
        </p>
      </Field>

      {repo?.exists ? (
        <Field label={t('ih.github.repoInfo')}>
          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <GitBranch className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium">
                {String(repo.repo?.fullName ?? `${repo.owner}/${repo.repoName}`)}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {repo.repo?.createdAt
                  ? `${t('ih.github.createdAt')} ${formatRepoDate(String(repo.repo.createdAt))}`
                  : ''}
                {repo.repo?.updatedAt
                  ? ` · ${t('ih.github.updatedAt')} ${formatRepoDate(String(repo.repo.updatedAt))}`
                  : ''}
              </div>
            </div>
          </div>
        </Field>
      ) : null}

      {repo?.exists ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{t('ih.jsdelivr')}</div>
            <p className="text-[11px] text-muted-foreground">{t('ih.jsdelivrDesc')}</p>
          </div>
          <Switch
            aria-label={t('ih.jsdelivr')}
            checked={jsdelivr}
            disabled={provider !== 'github'}
            onCheckedChange={(checked) =>
              useSettingsStore.getState().patch({
                imageHosting: { ...useSettingsStore.getState().imageHosting, jsdelivr: checked },
              })
            }
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}>
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
          {t('ih.testConnection')}
        </Button>
        {typeof info.login === 'string' && info.login ? (
          <span className="text-[11px] text-muted-foreground">@{String(info.login)}</span>
        ) : null}
      </div>
    </Panel>
  )
}

/* ---------------- S.EE / PicGo ---------------- */

function SmmsForm({ info }: { info: Record<string, unknown> }) {
  const t = useT()
  const smms = useSettingsStore((store) => store.imageHosting.smms)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label="Token" hint={t('ih.smms.tokenHint')}>
        <Input
          autoComplete="off"
          value={smms.token}
          aria-label="S.EE Token"
          placeholder={t('ih.smms.tokenPlaceholder')}
          onChange={(event) => patchHosting('smms', { token: event.target.value })}
        />
      </Field>
      <Button size="sm" variant="outline" asChild>
        <a href="https://s.ee/user/password/" target="_blank" rel="noreferrer">
          {t('ih.smms.createToken')}
        </a>
      </Button>
      {Object.keys(info).length > 0 ? (
        <Row label={t('ih.smms.disk')} value={JSON.stringify(info).slice(0, 60)} />
      ) : null}
    </Panel>
  )
}

function PicgoForm({ onCheck }: { onCheck: () => void }) {
  const t = useT()
  const picgo = useSettingsStore((store) => store.imageHosting.picgo)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label={t('ih.picgo.url')} hint={t('ih.picgo.hint')}>
        <div className="flex gap-2">
          <Input
            value={picgo.url}
            aria-label={t('ih.picgo.url')}
            onChange={(event) => patchHosting('picgo', { url: event.target.value })}
          />
          <Button size="sm" variant="outline" onClick={onCheck}>
            {t('ih.testConnection')}
          </Button>
        </div>
      </Field>
    </Panel>
  )
}

/* ---------------- S3 ---------------- */

function S3Form({ onCheck, checking }: { onCheck: () => void; checking: boolean }) {
  const t = useT()
  const s3 = useSettingsStore((store) => store.imageHosting.s3)
  const patchHosting = useSettingsStore((store) => store.patchHosting)

  return (
    <Panel>
      <Field label={t('ih.s3.provider')} hint={t('ih.s3.providerDesc')}>
        <div className="flex flex-wrap gap-1">
          {S3_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={s3.preset === preset}
              onClick={() => patchHosting('s3', { preset })}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors',
                s3.preset === preset
                  ? 'border-primary/40 bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`ih.s3.presets.${preset}`)}
            </button>
          ))}
        </div>
      </Field>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(`ih.s3.providerDetails.${s3.preset}`)}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Access Key ID">
          <Input
            value={s3.accessKeyId}
            aria-label="Access Key ID"
            placeholder="AKIA..."
            onChange={(event) => patchHosting('s3', { accessKeyId: event.target.value })}
          />
        </Field>
        <Field label="Secret Access Key">
          <Input
            type="password"
            autoComplete="off"
            value={s3.secretAccessKey}
            aria-label="Secret Access Key"
            onChange={(event) => patchHosting('s3', { secretAccessKey: event.target.value })}
          />
        </Field>
        <Field label={t('ih.s3.region')}>
          <Input
            value={s3.region}
            aria-label={t('ih.s3.region')}
            placeholder="us-east-1"
            onChange={(event) => patchHosting('s3', { region: event.target.value })}
          />
        </Field>
        <Field label={t('ih.s3.bucket')}>
          <Input
            value={s3.bucket}
            aria-label={t('ih.s3.bucket')}
            placeholder="my-bucket"
            onChange={(event) => patchHosting('s3', { bucket: event.target.value })}
          />
        </Field>
      </div>

      <Field
        label={t('ih.s3.endpoint')}
        hint={
          ['cloudflare-r2', 'minio', 'custom'].includes(s3.preset)
            ? t(`ih.s3.endpointRequiredDetails.${s3.preset}`)
            : t('ih.s3.endpointAutomaticDesc')
        }
      >
        <Input
          value={s3.endpoint}
          aria-label={t('ih.s3.endpoint')}
          placeholder="https://<account>.r2.cloudflarestorage.com"
          onChange={(event) => patchHosting('s3', { endpoint: event.target.value })}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ih.s3.addressingStyle')} hint={t('ih.s3.addressingStyleDesc')}>
          <select
            value={s3.addressingStyle}
            aria-label={t('ih.s3.addressingStyle')}
            onChange={(event) =>
              patchHosting('s3', { addressingStyle: event.target.value as typeof s3.addressingStyle })
            }
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
          >
            {(['auto', 'path', 'virtual'] as const).map((style) => (
              <option key={style} value={style}>
                {t(`ih.s3.addressingStyles.${style}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('ih.s3.customDomain')} hint={t('ih.s3.customDomainDesc')}>
          <Input
            value={s3.customDomain}
            aria-label={t('ih.s3.customDomain')}
            placeholder="https://img.example.com"
            onChange={(event) => patchHosting('s3', { customDomain: event.target.value })}
          />
        </Field>
      </div>

      <Field label={t('ih.pathPrefix')} hint={t('ih.pathPrefixDesc')}>
        <Input
          value={s3.pathPrefix}
          aria-label={t('ih.pathPrefix')}
          placeholder="images"
          onChange={(event) => patchHosting('s3', { pathPrefix: event.target.value })}
        />
      </Field>

      <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}>
        {checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t('ih.testConnection')}
      </Button>
    </Panel>
  )
}

/* ---------------- 七牛 / 又拍 ---------------- */

function QiniuForm() {
  const t = useT()
  const qiniu = useSettingsStore((store) => store.imageHosting.qiniu)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="AccessKey">
          <Input
            value={qiniu.accessKey}
            aria-label="AccessKey"
            onChange={(event) => patchHosting('qiniu', { accessKey: event.target.value })}
          />
        </Field>
        <Field label="SecretKey">
          <Input
            type="password"
            autoComplete="off"
            value={qiniu.secretKey}
            aria-label="SecretKey"
            onChange={(event) => patchHosting('qiniu', { secretKey: event.target.value })}
          />
        </Field>
        <Field label={t('ih.qiniu.bucket')}>
          <Input
            value={qiniu.bucket}
            aria-label={t('ih.qiniu.bucket')}
            onChange={(event) => patchHosting('qiniu', { bucket: event.target.value })}
          />
        </Field>
        <Field label={t('ih.qiniu.publicUrl')}>
          <Input
            value={qiniu.publicUrl}
            aria-label={t('ih.qiniu.publicUrl')}
            placeholder="https://cdn.example.com"
            onChange={(event) => patchHosting('qiniu', { publicUrl: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('ih.qiniu.uploadUrl')} hint={t('ih.qiniu.uploadUrlDesc')}>
        <Input
          value={qiniu.uploadUrl}
          aria-label={t('ih.qiniu.uploadUrl')}
          onChange={(event) => patchHosting('qiniu', { uploadUrl: event.target.value })}
        />
      </Field>
      <Field label={t('ih.pathPrefix')}>
        <Input
          value={qiniu.pathPrefix}
          aria-label={`${t('ih.name.qiniu')} ${t('ih.pathPrefix')}`}
          onChange={(event) => patchHosting('qiniu', { pathPrefix: event.target.value })}
        />
      </Field>
    </Panel>
  )
}

function UpyunForm({ onCheck }: { onCheck: () => void }) {
  const t = useT()
  const upyun = useSettingsStore((store) => store.imageHosting.upyun)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ih.upyun.bucket')}>
          <Input
            value={upyun.bucket}
            aria-label={t('ih.upyun.bucket')}
            onChange={(event) => patchHosting('upyun', { bucket: event.target.value })}
          />
        </Field>
        <Field label={t('ih.upyun.operator')}>
          <Input
            value={upyun.operator}
            aria-label={t('ih.upyun.operator')}
            onChange={(event) => patchHosting('upyun', { operator: event.target.value })}
          />
        </Field>
        <Field label={t('ih.upyun.password')}>
          <Input
            type="password"
            autoComplete="off"
            value={upyun.password}
            aria-label={t('ih.upyun.password')}
            onChange={(event) => patchHosting('upyun', { password: event.target.value })}
          />
        </Field>
        <Field label={t('ih.upyun.publicUrl')}>
          <Input
            value={upyun.publicUrl}
            aria-label={t('ih.upyun.publicUrl')}
            placeholder="https://cdn.example.com"
            onChange={(event) => patchHosting('upyun', { publicUrl: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('ih.pathPrefix')}>
        <Input
          value={upyun.pathPrefix}
          aria-label={`${t('ih.name.upyun')} ${t('ih.pathPrefix')}`}
          onChange={(event) => patchHosting('upyun', { pathPrefix: event.target.value })}
        />
      </Field>
      <Button size="sm" variant="outline" onClick={onCheck}>
        {t('ih.testConnection')}
      </Button>
    </Panel>
  )
}

/* ---------------- Lsky / WebDAV ---------------- */

function LskyForm({ onCheck }: { onCheck: () => void }) {
  const t = useT()
  const lsky = useSettingsStore((store) => store.imageHosting.lsky)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label={t('ih.lsky.apiUrl')} hint={t('ih.lsky.apiUrlDesc')}>
        <Input
          value={lsky.apiUrl}
          aria-label={t('ih.lsky.apiUrl')}
          placeholder="https://example.com/api/v1"
          onChange={(event) => patchHosting('lsky', { apiUrl: event.target.value })}
        />
      </Field>
      <Field label={t('ih.lsky.token')}>
        <Input
          autoComplete="off"
          value={lsky.token}
          aria-label={t('ih.lsky.token')}
          placeholder={t('ih.lsky.tokenPlaceholder')}
          onChange={(event) => patchHosting('lsky', { token: event.target.value })}
        />
      </Field>
      <Field label={t('ih.lsky.strategyId')} hint={t('ih.lsky.strategyIdDesc')}>
        <Input
          value={lsky.strategyId}
          aria-label={t('ih.lsky.strategyId')}
          placeholder={t('ih.lsky.strategyIdPlaceholder')}
          onChange={(event) => patchHosting('lsky', { strategyId: event.target.value })}
        />
      </Field>
      <Button size="sm" variant="outline" onClick={onCheck}>
        {t('ih.testConnection')}
      </Button>
    </Panel>
  )
}

function WebdavForm({ onCheck }: { onCheck: () => void }) {
  const t = useT()
  const webdav = useSettingsStore((store) => store.imageHosting.webdav)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label={t('ih.webdav.baseUrl')}>
        <Input
          value={webdav.baseUrl}
          aria-label={t('ih.webdav.baseUrl')}
          placeholder="https://dav.example.com/notes"
          onChange={(event) => patchHosting('webdav', { baseUrl: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ih.webdav.username')}>
          <Input
            autoComplete="off"
            value={webdav.username}
            aria-label={t('ih.webdav.username')}
            onChange={(event) => patchHosting('webdav', { username: event.target.value })}
          />
        </Field>
        <Field label={t('ih.webdav.password')}>
          <Input
            type="password"
            autoComplete="off"
            value={webdav.password}
            aria-label={t('ih.webdav.password')}
            onChange={(event) => patchHosting('webdav', { password: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('ih.webdav.publicUrl')} hint={t('ih.webdav.publicUrlDesc')}>
        <Input
          value={webdav.publicUrl}
          aria-label={t('ih.webdav.publicUrl')}
          placeholder="https://img.example.com"
          onChange={(event) => patchHosting('webdav', { publicUrl: event.target.value })}
        />
      </Field>
      <Field label={t('ih.pathPrefix')}>
        <Input
          value={webdav.pathPrefix}
          aria-label={`${t('ih.name.webdav')} ${t('ih.pathPrefix')}`}
          onChange={(event) => patchHosting('webdav', { pathPrefix: event.target.value })}
        />
      </Field>
      <Button size="sm" variant="outline" onClick={onCheck}>
        {t('ih.testConnection')}
      </Button>
    </Panel>
  )
}

/* ---------------- 自定义 HTTP / Cloudinary / ImageKit ---------------- */

function CustomHttpForm() {
  const t = useT()
  const http = useSettingsStore((store) => store.imageHosting.customHttp)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label={t('ih.customHttp.url')} hint={t('ih.customHttp.urlDesc')}>
        <Input
          value={http.url}
          aria-label={t('ih.customHttp.url')}
          placeholder="https://api.example.com/upload"
          onChange={(event) => patchHosting('customHttp', { url: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ih.customHttp.method')}>
          <select
            value={http.method}
            aria-label={t('ih.customHttp.method')}
            onChange={(event) =>
              patchHosting('customHttp', { method: event.target.value as 'POST' | 'PUT' })
            }
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none"
          >
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
          </select>
        </Field>
        <Field label={t('ih.customHttp.fileField')}>
          <Input
            value={http.fileField}
            aria-label={t('ih.customHttp.fileField')}
            onChange={(event) => patchHosting('customHttp', { fileField: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('ih.customHttp.headers')} hint={t('ih.customHttp.headersDesc')}>
        <textarea
          value={http.headers}
          aria-label={t('ih.customHttp.headers')}
          placeholder={'{"Authorization": "Bearer xxx"}'}
          onChange={(event) => patchHosting('customHttp', { headers: event.target.value })}
          className="min-h-16 w-full resize-y rounded-lg border border-border bg-transparent p-2 font-mono text-[11px] outline-none focus:border-ring/60"
        />
      </Field>
      <Field label={t('ih.customHttp.formFields')} hint={t('ih.customHttp.formFieldsDesc')}>
        <textarea
          value={http.formFields}
          aria-label={t('ih.customHttp.formFields')}
          placeholder={'{"album": "notes"}'}
          onChange={(event) => patchHosting('customHttp', { formFields: event.target.value })}
          className="min-h-16 w-full resize-y rounded-lg border border-border bg-transparent p-2 font-mono text-[11px] outline-none focus:border-ring/60"
        />
      </Field>
      <Field label={t('ih.customHttp.responseUrlPath')} hint={t('ih.customHttp.responseUrlPathDesc')}>
        <Input
          value={http.responseUrlPath}
          aria-label={t('ih.customHttp.responseUrlPath')}
          placeholder="data.url"
          onChange={(event) => patchHosting('customHttp', { responseUrlPath: event.target.value })}
        />
      </Field>
    </Panel>
  )
}

function CloudinaryForm() {
  const t = useT()
  const cloudinary = useSettingsStore((store) => store.imageHosting.cloudinary)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ih.cloudinary.cloudName')}>
          <Input
            value={cloudinary.cloudName}
            aria-label={t('ih.cloudinary.cloudName')}
            onChange={(event) => patchHosting('cloudinary', { cloudName: event.target.value })}
          />
        </Field>
        <Field label={t('ih.cloudinary.uploadPreset')} hint={t('ih.cloudinary.uploadPresetDesc')}>
          <Input
            value={cloudinary.uploadPreset}
            aria-label={t('ih.cloudinary.uploadPreset')}
            onChange={(event) => patchHosting('cloudinary', { uploadPreset: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('ih.cloudinary.folder')}>
        <Input
          value={cloudinary.folder}
          aria-label={`${t('ih.name.cloudinary')} ${t('ih.cloudinary.folder')}`}
          onChange={(event) => patchHosting('cloudinary', { folder: event.target.value })}
        />
      </Field>
    </Panel>
  )
}

function ImagekitForm({ onCheck }: { onCheck: () => void }) {
  const t = useT()
  const imagekit = useSettingsStore((store) => store.imageHosting.imagekit)
  const patchHosting = useSettingsStore((store) => store.patchHosting)
  return (
    <Panel>
      <Field label={t('ih.imagekit.privateKey')} hint={t('ih.imagekit.privateKeyDesc')}>
        <Input
          type="password"
          autoComplete="off"
          value={imagekit.privateKey}
          aria-label={t('ih.imagekit.privateKey')}
          onChange={(event) => patchHosting('imagekit', { privateKey: event.target.value })}
        />
      </Field>
      <Field label={t('ih.imagekit.folder')}>
        <Input
          value={imagekit.folder}
          aria-label={`${t('ih.name.imagekit')} ${t('ih.imagekit.folder')}`}
          onChange={(event) => patchHosting('imagekit', { folder: event.target.value })}
        />
      </Field>
      <Button size="sm" variant="outline" onClick={onCheck}>
        {t('ih.testConnection')}
      </Button>
    </Panel>
  )
}

/** 仓库时间戳可能是 ISO 字符串也可能是秒/毫秒数，这里统一格式化 */
function formatRepoDate(value: string): string {
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}
