/**
 * Sidecar 调用层
 *
 * 与 Rust 后端（backend/src/main.rs）的方法一一对应，前端只依赖这里的类型，
 * 后续换实现不需要动 UI。所有调用都带超时，避免宿主卡死。
 */
import { bridge } from './bridge'

/* ---------------- 类型 ---------------- */

export interface WorkspaceInfo {
  dataDir: string
  root: string
  defaultRoot: string
  isDefault: boolean
  exists: boolean
  writable: boolean
  platform: string
  fileCount: number
}

export interface TreeNode {
  kind: 'file' | 'folder' | 'image'
  name: string
  path: string
  children?: TreeNode[]
  size?: number
  mtime?: number
}

export interface DirListing {
  path: string
  parent: string
  entries: Array<{ name: string; path: string }>
  roots: Array<{ name: string; path: string }>
  shortcuts: Array<{ key: string; path: string }>
  writable?: boolean
}

export interface TagItem {
  id: string
  name: string
  color: string
  count: number
}

export interface RecordItem {
  id: string
  type: string
  content: string
  meta: Record<string, unknown>
  archived: boolean
  createdAt: number
  updatedAt: number
  tags: TagItem[]
}

export interface ChatItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageItem {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  meta: Record<string, unknown>
  createdAt: number
}

export interface SearchHit {
  path: string
  name: string
  title: string
  snippet: string
  matchedName: boolean
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  /** 采样偏置；缺省或 1 时服务端不下发 */
  topP?: number
  /** 0 或未配置时不下发 max_tokens */
  maxTokens?: number
}

export interface StreamChunk {
  text: string
  done: boolean
  error: string | null
}

/* ---------------- 调用封装 ---------------- */

/** 默认超时：普通读写 */
const DEFAULT_TIMEOUT = 15_000
/** 大文件写入与目录迁移 */
const WRITE_TIMEOUT = 60_000

async function call<T>(method: string, params: object = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
  const host = bridge()
  if (typeof host?.invoke !== 'function') {
    throw new Error('当前环境没有可用的原生后端（Sidecar），请在 DBX 中运行本插件')
  }
  try {
    return (await host.invoke(method, params, { timeoutMs })) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 宿主会把错误对象序列化成 JSON，这里尽量取出可读的 message
    throw new Error(normalizeError(message) || `后端调用失败：${method}`)
  }
}

function normalizeError(message: string): string {
  if (!message) return ''
  try {
    const parsed = JSON.parse(message)
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return parsed.message
    }
  } catch {
    /* 不是 JSON，直接用原文 */
  }
  return message
}

/** 探测 Sidecar 是否可用 */
export async function probeSidecar(): Promise<boolean> {
  try {
    const result = await call<{ ok: boolean }>('ping', {}, 3000)
    return result?.ok === true
  } catch {
    return false
  }
}

/* ---------------- 工作区 ---------------- */

export function describeWorkspace(): Promise<WorkspaceInfo> {
  return call('workspace/describe')
}

export function setWorkspace(path: string): Promise<WorkspaceInfo> {
  return call('workspace/set', { path }, WRITE_TIMEOUT)
}

export function resetWorkspace(): Promise<WorkspaceInfo> {
  return call('workspace/reset', {}, WRITE_TIMEOUT)
}

export function listDirs(path = ''): Promise<DirListing> {
  return call('fs/listDirs', path ? { path } : {})
}

export function makeDir(parent: string, name: string): Promise<{ path: string }> {
  return call('fs/mkdir', { parent, name })
}

/* ---------------- 文件 ---------------- */

export function readTree(depth = 6): Promise<{ root: string; children: TreeNode[] }> {
  return call('fs/tree', { depth }, 20_000)
}

export function readFile(path: string): Promise<{ content: string; size: number; mtime: number }> {
  return call('fs/read', { path }, 30_000)
}

export function writeFile(path: string, content: string): Promise<{ path: string; size: number }> {
  return call('fs/write', { path, content }, WRITE_TIMEOUT)
}

export function createEntry(params: {
  kind: 'file' | 'folder'
  parent: string
  name: string
  content?: string
}): Promise<{ path: string; kind: string; name?: string }> {
  return call('fs/create', { ...params })
}

export function renameEntry(path: string, newName: string): Promise<{ path: string; name: string }> {
  return call('fs/rename', { path, newName })
}

export function deleteEntry(path: string): Promise<{ deleted: boolean }> {
  return call('fs/delete', { path }, WRITE_TIMEOUT)
}

export function searchFiles(query: string, limit = 60): Promise<{ items: SearchHit[] }> {
  return call('fs/search', { query, limit }, 30_000)
}

export function statEntry(path: string): Promise<{ exists: boolean; size: number; isDir: boolean }> {
  return call('fs/stat', { path })
}

export function saveImage(
  name: string,
  dataBase64: string,
  options: { dir?: string; nameMode?: 'uuid' | 'date' | 'original' } = {},
): Promise<{ path: string; markdown: string }> {
  return call('image/save', { name, dataBase64, ...options }, 30_000)
}

export interface ImageData {
  path: string
  size: number
  mime: string
  /** data URL：宿主 CSP 拦截外部资源，图片只能这样内联 */
  dataUrl: string
}

export function readImage(path: string): Promise<ImageData> {
  return call('image/read', { path }, 30_000)
}

/* ---------------- 宿主拿不到的系统能力 ---------------- */

export interface CapturedImage {
  width: number
  height: number
  mime: string
  /** screen=抓屏，clipboard=读剪贴板 */
  source: 'screen' | 'clipboard'
  /** 不含 `data:` 前缀的 base64 */
  dataBase64: string
}

/** 抓主屏（Sidecar 里用 GDI 抓，绕开宿主的屏幕捕获限制） */
export function screenCapture(): Promise<CapturedImage> {
  return call('screen/capture', {}, 30_000)
}

/** 读剪贴板里的图片 */
export function clipboardImage(): Promise<CapturedImage> {
  return call('clipboard/image', {}, 15_000)
}

export interface ScreenshotRegion {
  width: number
  height: number
  mime: string
  /** 不含 `data:` 前缀的 base64 */
  dataBase64: string
  /** native=桌面 1:1 框选出的区域；plugin=整屏，交给插件浮层自己框选 */
  mode: 'native' | 'plugin'
  /** 选区在屏幕上的左上角（仅 native 模式有） */
  x?: number
  y?: number
  /** global=全局热键产出 */
  source?: 'screen' | 'global'
  /**
   * 全局热键路径下用户在原生工具栏里选的出口
   *
   * 带这个字段说明**已经标注完并确认过了**，页面拿到后直接落库 / 插入，
   * 不能再弹一次标注浮层。
   */
  action?: 'insert' | 'record'
}

/**
 * 在真实桌面上框选（Sidecar 建全屏置顶窗口，1:1 显示原图）
 *
 * 这个调用会一直挂着直到用户松手或取消，所以超时给得很宽；用户取消时后端返回
 * “已取消截图”，由调用方当成静默取消处理。
 */
export function screenshotSelect(): Promise<ScreenshotRegion> {
  return call('screenshot/select', {}, 300_000)
}

/** 取走全局热键留下的截图（没有则返回 null） */
export function screenshotTakePending(): Promise<ScreenshotRegion | null> {
  return call('screenshot/takePending', {}, 10_000)
}

/**
 * 告诉 Sidecar：这次截图快捷键由前端 keydown 接手了
 *
 * Sidecar 的全局热键线程据此让位（只认这个精确标记——用「最近有 RPC」当信号
 * 会被宿主心跳 / 后台轮询误伤，导致插件不在前台时全局热键永远不触发）。
 */
export function screenshotUiHotkey(): Promise<{ ok: boolean }> {
  return call('screenshot/uiHotkey', {}, 5_000)
}

export interface ScreenshotHotkey {
  /** 实际生效的全局组合 */
  combo: string
  registered: boolean
  /** 注册失败原因 */
  reason: string
}

/** 全局截图热键的注册状态 */
export function screenshotHotkey(): Promise<ScreenshotHotkey> {
  return call('screenshot/hotkey', {}, 10_000)
}

export interface LogInfo {
  /** 日志文件绝对路径（未初始化时为 null） */
  path: string | null
  exists: boolean
  /** 字节数 */
  size: number
}

/** Sidecar 日志文件位置与体积（设置 → 关于 里展示） */
export function logInfo(): Promise<LogInfo> {
  return call('log/info', {}, 8_000)
}

/** 取 Sidecar 日志最近若干行 */
export function logTail(lines = 200): Promise<{ path: string | null; text: string; lines: number }> {
  return call('log/tail', { lines }, 10_000)
}

/** 把界面侧的关键节点写进同一份 Sidecar 日志（排查「截完没弹浮层」用） */
export function logWrite(line: string): Promise<{ ok: boolean }> {
  return call('log/write', { line }, 8_000)
}

/** 在系统文件管理器里打开日志目录 */
export function logOpen(): Promise<{ ok: boolean; dir: string }> {
  return call('log/open', {}, 8_000)
}

/** 把 PNG（base64）写进系统剪贴板（截图工具的「复制」） */
export function clipboardWrite(params: {
  dataBase64: string
  mime?: string
}): Promise<{ ok: boolean; width: number; height: number }> {
  return call('clipboard/write', params, 20_000)
}

/** 把 PNG（base64）钉到桌面上（截图工具的「钉在顶层」） */
export function screenshotPin(params: {
  dataBase64: string
  x?: number
  y?: number
}): Promise<{ ok: boolean; width: number; height: number }> {
  return call('screenshot/pin', params, 20_000)
}

export interface RecordedAudio {
  mime: string
  name: string
  durationMs: number
  size: number
  dataBase64: string
}

/** 开始录音（Sidecar 里用系统麦克风，不经过宿主的 iframe 权限） */
export function recordStart(): Promise<{ recording: boolean }> {
  return call('audio/recordStart', {}, 15_000)
}

export function recordStop(): Promise<RecordedAudio> {
  return call('audio/recordStop', {}, 30_000)
}

export function recordStatus(): Promise<{ recording: boolean; available: boolean }> {
  return call('audio/recordStatus', {})
}

/* ---------------- 图床 ---------------- */

/** 通用 HTTP 代理：沙箱里发不出请求，远端图片与第三方接口都走这里 */
export function netRequest(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string>; body: string; url: string }> {
  return call('net/request', params, 60_000)
}

/** 上传到图床，返回可公开访问的图片地址 */
export function imageUpload(params: {
  name: string
  dataBase64: string
  mime?: string
  config: unknown
}): Promise<{ url: string; provider: string }> {
  return call('image/upload', params, 120_000)
}

/** 图床连通性 / 配置完整性检测 */
export function imageHostingCheck(config: unknown): Promise<{
  provider: string
  ok: boolean
  message: string
  info?: Record<string, unknown>
}> {
  return call('image/hostingCheck', { config }, 60_000)
}

/** GitHub 图床仓库查询 / 创建 */
export function imageHostingRepo(
  config: unknown,
  action: 'check' | 'create' = 'check',
): Promise<{
  exists: boolean
  owner?: string
  repoName?: string
  repo?: {
    fullName: string
    htmlUrl: string
    avatarUrl: string
    defaultBranch: string
    private: boolean
    createdAt: string
    updatedAt: string
  }
}> {
  return call('image/hostingRepo', { config, action }, 60_000)
}

/* ---------------- 图像识别 / 语音转写 ---------------- */

export function aiVision(params: {
  baseUrl: string
  apiKey: string
  model: string
  prompt?: string
  /** 限制输出长度（描述图片时用 120，避免记录里一大段废话） */
  maxTokens?: number
  imagePath?: string
  imageBase64?: string
  mime?: string
}): Promise<{ text: string }> {
  return call('ai/vision', params, 130_000)
}

export function aiTranscribe(params: {
  baseUrl: string
  apiKey: string
  model: string
  /** 工作区里的音频路径；录音场景改用 audioBase64 */
  path?: string
  audioBase64?: string
  mime?: string
  name?: string
}): Promise<{ text: string }> {
  return call('ai/transcribe', params, 130_000)
}

/* ---------------- 系统 OCR（VLM 失败时的回退通道） ---------------- */

export function ocrStatus(): Promise<{
  engine: string
  available: boolean
  languages: string[]
  /** 实际选中的识别语言 */
  active?: string
  error?: string
}> {
  return call('ocr/status', {}, 15_000)
}

export function ocrRun(params: {
  /** 工作区相对路径 */
  path?: string
  imageBase64?: string
  mime?: string
}): Promise<{ text: string; engine: string; ms: number }> {
  return call('ocr/run', params, 40_000)
}

/* ---------------- 备份与恢复 ---------------- */

export interface BackupItem {
  path: string
  name: string
  size: number
  createdAt: number
}

export function backupExport(includeGit = false): Promise<{
  path: string
  name: string
  size: number
  files: number
}> {
  return call('backup/export', { includeGit }, 120_000)
}

export function backupList(): Promise<{ dir: string; items: BackupItem[] }> {
  return call('backup/list', {})
}

export function backupImport(params: { path: string; target?: string; overwrite?: boolean }): Promise<{
  path: string
  files: number
  overwrite: boolean
}> {
  return call('backup/import', params, 120_000)
}

export function backupDelete(path: string): Promise<{ deleted: boolean }> {
  return call('backup/delete', { path })
}

export function backupInfo(): Promise<{ dir: string; root: string }> {
  return call('backup/info', {})
}

/* ---------------- 本地 MCP 工具 ---------------- */

export interface McpServer {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
}

export function mcpList(): Promise<{ servers: McpServer[] }> {
  return call('mcp/list')
}

export function mcpSave(servers: McpServer[]): Promise<{ servers: McpServer[] }> {
  return call('mcp/save', { servers })
}

export function mcpTools(id: string): Promise<{ id: string; name: string; tools: McpTool[] }> {
  return call('mcp/tools', { id }, 70_000)
}

export function mcpCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return call('mcp/call', { id, tool, args }, 70_000)
}

/* ---------------- 记录 ---------------- */

export function listRecords(params: {
  tagId?: string
  type?: string
  query?: string
  /** 0 只看未归档（默认），1 只看回收站 */
  archived?: number
  limit?: number
} = {}): Promise<{ items: RecordItem[] }> {
  return call('record/list', params)
}

export function createRecord(params: {
  type: string
  content: string
  tags?: string[]
  meta?: Record<string, unknown>
}): Promise<RecordItem> {
  return call('record/create', params)
}

export function updateRecord(params: {
  id: string
  content?: string
  tags?: string[]
  archived?: boolean
  meta?: Record<string, unknown>
}): Promise<{ ok: boolean }> {
  return call('record/update', params)
}

export function deleteRecord(id: string): Promise<{ ok: boolean }> {
  return call('record/delete', { id })
}

export function listTags(): Promise<{ items: TagItem[] }> {
  return call('tag/list')
}

export function deleteTag(id: string): Promise<{ ok: boolean }> {
  return call('tag/delete', { id })
}

/* ---------------- 会话 ---------------- */

export function listChats(): Promise<{ items: ChatItem[] }> {
  return call('chat/list')
}

export function createChat(title = ''): Promise<ChatItem> {
  return call('chat/create', { title })
}

export function renameChat(id: string, title: string): Promise<{ ok: boolean }> {
  return call('chat/rename', { id, title })
}

export function deleteChat(id: string): Promise<{ ok: boolean }> {
  return call('chat/delete', { id })
}

export function listMessages(chatId: string): Promise<{ items: MessageItem[] }> {
  return call('chat/messages', { chatId })
}

export function appendMessage(params: {
  chatId: string
  role: string
  content: string
  meta?: Record<string, unknown>
}): Promise<{ id: string; createdAt: number }> {
  return call('chat/append', params)
}

/* ---------------- 设置 ---------------- */

export async function getSetting<T>(key: string): Promise<T | null> {
  const result = await call<{ key: string; value: T | null }>('settings/get', { key })
  return result.value ?? null
}

export function setSetting(key: string, value: unknown): Promise<{ ok: boolean }> {
  return call('settings/set', { key, value })
}

/* ---------------- 画布 ---------------- */

export interface CanvasItem {
  title: string
  path: string
  size: number
  updatedAt: number
}

export function canvasList(): Promise<{ items: CanvasItem[] }> {
  return call('canvas/list')
}

export function canvasRead(path: string): Promise<{ path: string; content: string }> {
  return call('canvas/read', { path })
}

export function canvasCreate(
  name: string,
): Promise<{ path: string; title: string; content: string }> {
  return call('canvas/create', { name }, 20_000)
}

export function canvasSave(
  path: string,
  content: string,
): Promise<{ ok: boolean; title: string; size: number }> {
  return call('canvas/save', { path, content }, 20_000)
}

export function canvasRename(
  path: string,
  name: string,
): Promise<{ path: string; title: string }> {
  return call('canvas/rename', { path, name })
}

export function canvasDelete(path: string): Promise<{ ok: boolean }> {
  return call('canvas/delete', { path })
}

/* ---------------- 云同步（Git） ---------------- */

export interface SyncStatus {
  available: boolean
  gitVersion: string
  root: string
  isRepo: boolean
  branch: string
  remote: string
  ahead: number
  behind: number
  changed: string[]
  lastCommit: string
  lastCommitMessage?: string
  lastCommitAt: string
  provider?: string
  autoCommit?: boolean
  hasToken?: boolean
}

/** 同步配置（provider / token / 自动提交 / 提交信息模板） */
export interface SyncOptions {
  provider: string
  token: string
  hasToken: boolean
  tokenMask: string
  autoCommit: boolean
  messageTemplate: string
}

export function syncOptions(): Promise<{ options: SyncOptions }> {
  return call('sync/options', {})
}

export function syncSaveOptions(params: {
  provider?: string
  token?: string
  clearToken?: boolean
  autoCommit?: boolean
  messageTemplate?: string
}): Promise<{ options: SyncOptions }> {
  return call('sync/saveOptions', params)
}

export function syncStatus(): Promise<SyncStatus> {
  return call('sync/status', {}, 30_000)
}

export function syncInit(params: { url?: string } = {}): Promise<SyncStatus> {
  return call('sync/init', params, 60_000)
}

export function syncRemote(url: string): Promise<SyncStatus> {
  return call('sync/remote', { url }, 30_000)
}

export function syncCommit(message: string): Promise<{ committed: boolean; message: string }> {
  return call('sync/commit', { message }, 60_000)
}

export function syncPull(): Promise<{ ok: boolean; output: string }> {
  return call('sync/pull', {}, 180_000)
}

export function syncPush(): Promise<{ ok: boolean; output: string }> {
  return call('sync/push', {}, 180_000)
}

/* ---------------- 云同步（对象存储 / WebDAV / 自托管） ---------------- */

/** 三条非 Git 通道的配置（字段随平台不同） */
export interface StoreConfig {
  [key: string]: string | number | boolean | undefined
}

export type ConflictPolicy = 'local' | 'remote' | 'skip'

/** 自动同步间隔（None 表示关闭），与 NoteGen 的选项集一致 */
export type AutoSyncInterval = 'disabled' | '2' | '3' | '5' | '10' | '20' | '30' | '60' | '120'

/**
 * 同步偏好：与平台无关，Git / 对象存储共用一份
 *
 * 后端存在设置表 `app.sync.prefs`，所以切平台不会丢配置。
 */
export interface SyncPrefs {
  /** 笔记编辑停止后按所选延迟自动同步 */
  autoSync?: AutoSyncInterval
  /** 打开或切换文件时自动拉取 */
  autoPullOnOpen?: boolean
  /** 自动同步记录（标签、画布等） */
  autoRecordSync?: boolean
  /** 自动同步应用配置 */
  autoSettingsSync?: boolean
  /** 自动同步对话 */
  autoConversationSync?: boolean
  /** 不同步敏感配置 */
  excludeSensitiveConfig?: boolean
}

export interface StoreOptions extends SyncPrefs {
  provider: string
  config: StoreConfig
  /** 两边都改动时的处理策略 */
  conflictPolicy?: ConflictPolicy
  /** 平台无关的同步偏好（后端统一从 app.sync.prefs 读） */
  prefs?: SyncPrefs
}

/** 一条同步日志（后端只保留最近 100 条） */
export interface StoreLogEntry {
  at: number
  provider: string
  action: 'push' | 'pull'
  pushed?: number
  pulled?: number
  skipped?: number
  deleted?: number
  conflicts?: number
  failed?: number
  ok: boolean
}

export interface StoreStatus {
  provider: string
  ready: boolean
  reachable: boolean
  message: string
  prefix: string
  localFiles: number
  localBytes: number
  remoteFiles: number
  pendingUpload: number
  pendingDownload: number
  conflicts: number
  lastSyncAt: string
  manifestAt?: number
  manifestDevice?: string
}

export function syncStoreOptions(): Promise<StoreOptions> {
  return call('sync/storeOptions', {})
}

/** 读同步偏好（不依赖当前平台） */
export function syncPrefs(): Promise<SyncPrefs> {
  return call('sync/prefs', {})
}

/** 写同步偏好（不依赖当前平台） */
export function syncSavePrefs(params: SyncPrefs): Promise<SyncPrefs> {
  return call('sync/savePrefs', params)
}

export function syncSaveStoreOptions(params: {
  provider?: string
  config: StoreConfig
  autoSync?: AutoSyncInterval
  autoPullOnOpen?: boolean
  autoRecordSync?: boolean
  autoSettingsSync?: boolean
  autoConversationSync?: boolean
  excludeSensitiveConfig?: boolean
  conflictPolicy?: ConflictPolicy
}): Promise<StoreOptions> {
  return call('sync/saveStoreOptions', params, 30_000)
}

export function syncStoreLogs(): Promise<{ items: StoreLogEntry[] }> {
  return call('sync/storeLogs', {}, 20_000)
}

export function syncStoreCheck(): Promise<{ provider: string; ok: boolean; message: string }> {
  return call('sync/storeCheck', {}, 90_000)
}

export function syncStoreStatus(): Promise<StoreStatus> {
  return call('sync/storeStatus', {}, 120_000)
}

export function syncStorePush(
  params: { removeDeleted?: boolean } = {},
): Promise<{
  provider: string
  pushed: number
  skipped: number
  deleted: number
  failed: string[]
  total: number
  message: string
}> {
  return call('sync/storePush', params, 600_000)
}

export function syncStorePull(
  params: { overwrite?: boolean } = {},
): Promise<{
  provider: string
  pulled: number
  skipped: number
  conflicts: string[]
  failed: string[]
  message: string
}> {
  return call('sync/storePull', params, 600_000)
}

/* ---------------- AI ---------------- */

export function aiChat(params: AiConfig & { messages: AiMessage[]; timeoutMs?: number }): Promise<{
  content: string
  usage: unknown
}> {
  const { timeoutMs = 120_000, ...rest } = params
  return call('ai/chat', rest, timeoutMs + 5_000)
}

export function aiStart(params: AiConfig & { messages: AiMessage[] }): Promise<{ id: string }> {
  return call('ai/start', params, 20_000)
}

export function aiPoll(id: string): Promise<StreamChunk> {
  return call('ai/poll', { id }, 10_000)
}

export function aiCancel(id: string): Promise<{ ok: boolean }> {
  return call('ai/cancel', { id }, 5_000)
}

export function aiModels(params: AiConfig): Promise<{ items: string[] }> {
  return call('ai/models', params, 25_000)
}
