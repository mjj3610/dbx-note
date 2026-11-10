/**
 * 全局设置：外观、语言、编辑器偏好、AI 模型、工作区
 *
 * 全部持久化在 Sidecar 的 SQLite `settings` 表（key = `app.settings`）。
 * 首次加载失败时使用默认值，保证界面永远可用。
 */
import { create } from 'zustand'

import type { Locale } from '@/lib/i18n'
import { getSetting, setSetting, type WorkspaceInfo } from '@/lib/rpc'
import { hostAppearance, hostLocale } from '@/lib/bridge'
import { localId } from '@/lib/utils'

export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * 模型用途。
 *
 * 与 NoteGen 的 `modelType` 对齐：一个厂商下可以同时配置对话、视觉、转写、嵌入等
 * 不同用途的模型，各用途在「默认模型」里分别指定由谁执行。
 */
export type AiModelType = 'chat' | 'vision' | 'stt' | 'embedding' | 'tts'

/** 单个模型配置：同一厂商下可以有多个，按用途区分 */
export interface AiModelConfig {
  /** 本地唯一 id（不是模型名，模型名允许重复） */
  id: string
  /** 模型名，原样下发到 OpenAI 兼容接口的 `model` 字段 */
  name: string
  modelType: AiModelType
  temperature: number
  topP: number
  /** 是否流式；仅 chat 生效 */
  enableStream: boolean
  /** 0 表示不下发 max_tokens，用服务端默认 */
  maxTokens: number
  /** 0 表示未知 */
  contextWindow: number
  /** TTS 音色 / STT 语言提示，留空则不下发 */
  voice: string
}

/** 厂商 = 一个 baseURL + 一组密钥 + 若干模型 */
export interface AiProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: AiModelConfig[]
}

/** 各用途默认使用哪个模型（存的是 AiModelConfig.id） */
export interface AiModelDefaults {
  chat: string
  vision: string
  stt: string
  embedding: string
  tts: string
}

export interface AiSettings {
  /** 厂商列表，可增可删 */
  providers: AiProvider[]
  /** 用途 → 模型 id */
  defaults: AiModelDefaults
}

/** 旧版单模型配置，只在迁移存量数据时出现，不再写入 */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
}

/** 技能 = 一组可复用的提示词（NoteGen 的 skills） */
export interface SkillItem {
  id: string
  name: string
  prompt: string
}

/** 图片存放规则（粘贴 / 截图入库时用） */
export interface ImageSettings {
  dir: string
  nameMode: 'uuid' | 'date' | 'original'
}

/* ---------------- 图床 ---------------- */

export type ImageProvider =
  | 'local'
  | 'github'
  | 'smms'
  | 'picgo'
  | 's3'
  | 'qiniu'
  | 'upyun'
  | 'lsky'
  | 'webdav'
  | 'custom-http'
  | 'cloudinary'
  | 'imagekit'

export type ObjectStoragePreset =
  | 'aws'
  | 'cloudflare-r2'
  | 'aliyun-oss'
  | 'tencent-cos'
  | 'backblaze-b2'
  | 'minio'
  | 'custom'

export interface GithubHosting {
  token: string
  username: string
  repo: string
  branch: string
  pathPrefix: string
}

export interface SmmsHosting {
  token: string
}

export interface PicgoHosting {
  url: string
}

export interface S3Hosting {
  preset: ObjectStoragePreset
  accessKeyId: string
  secretAccessKey: string
  region: string
  bucket: string
  endpoint: string
  customDomain: string
  pathPrefix: string
  addressingStyle: 'auto' | 'path' | 'virtual'
}

export interface QiniuHosting {
  accessKey: string
  secretKey: string
  bucket: string
  publicUrl: string
  uploadUrl: string
  pathPrefix: string
}

export interface UpyunHosting {
  bucket: string
  operator: string
  password: string
  publicUrl: string
  pathPrefix: string
}

export interface LskyHosting {
  apiUrl: string
  token: string
  strategyId: string
}

export interface WebdavHosting {
  baseUrl: string
  username: string
  password: string
  publicUrl: string
  pathPrefix: string
}

export interface CustomHttpHosting {
  url: string
  method: 'POST' | 'PUT'
  headers: string
  formFields: string
  fileField: string
  responseUrlPath: string
}

export interface CloudinaryHosting {
  cloudName: string
  uploadPreset: string
  folder: string
}

export interface ImagekitHosting {
  privateKey: string
  folder: string
}

/** 图床整体配置：`provider` 为 `local` 表示保存在工作区 */
export interface ImageHostingSettings {
  provider: ImageProvider
  jsdelivr: boolean
  github: GithubHosting
  smms: SmmsHosting
  picgo: PicgoHosting
  s3: S3Hosting
  qiniu: QiniuHosting
  upyun: UpyunHosting
  lsky: LskyHosting
  webdav: WebdavHosting
  customHttp: CustomHttpHosting
  cloudinary: CloudinaryHosting
  imagekit: ImagekitHosting
}

/** 图床清单（顺序与设置页左栏一致） */
export const IMAGE_PROVIDERS: ImageProvider[] = [
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

/** 图像识别（多模态模型） */
export interface OcrSettings {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
}

/** 语音转写（OpenAI 兼容 /audio/transcriptions） */
export interface VoiceSettings {
  baseUrl: string
  apiKey: string
  model: string
}

/** 正文宽度预设（与 NoteGen 的 contentWidth 四档对齐） */
export type EditorContentWidth = 'narrow' | 'standard' | 'wide' | 'full'
/** 正文行高预设 */
export type EditorLineHeight = 'compact' | 'comfortable' | 'relaxed'
/** 编辑模式：所见即所得 / Markdown 源码 */
export type EditorViewMode = 'visual' | 'source'

/** contentWidth 四档对应的像素宽度（写入 editorWidth，通用页滑块同步反映） */
export const EDITOR_CONTENT_WIDTH: Record<EditorContentWidth, number> = {
  narrow: 620,
  standard: 760,
  wide: 960,
  full: 1400,
}

/** 行高三档对应的 CSS 值 */
export const EDITOR_LINE_HEIGHT: Record<EditorLineHeight, number> = {
  compact: 1.55,
  comfortable: 1.75,
  relaxed: 2,
}

/** 编辑器偏好（设置 → 编辑器设置） */
export interface EditorSettings {
  /** 默认编辑模式 */
  viewMode: EditorViewMode
  /** 行高预设 */
  lineHeight: EditorLineHeight
  /** 显示写作统计（字数 / 阅读时长） */
  showStats: boolean
  /** 工具栏显示撤销 / 重做 */
  showUndoRedo: boolean
  /** 源码模式显示行号 */
  showSourceLineNumbers: boolean
  /** 源码模式自动换行 */
  sourceWrap: boolean
  /** 默认启用大纲 */
  outlineEnabled: boolean
  /** 大纲显示区域 */
  outlinePlacement: 'editor' | 'sidebar'
  /** 大纲位置 */
  outlinePosition: 'left' | 'right'
  spellcheck: boolean
  /** 自动保存防抖（毫秒） */
  autoSaveMs: number
  /** 粘贴图片时是否自动压缩到最长边（px，0 表示不处理） */
  pasteMaxEdge: number
}

/** 记录设置 */
export interface RecordSettings {
  /** 记录列表默认视图 */
  view: 'list' | 'compact' | 'cards'
  /** 默认排序 */
  sort: 'newest' | 'oldest' | 'type'
  defaultType: 'text' | 'link' | 'todo'
  /** 新建记录后是否自动聚焦输入框 */
  focusAfterSaved: boolean
}

/** 画布设置 */
export interface CanvasSettings {
  showGrid: boolean
  snapToGrid: boolean
  minimap: boolean
  gridStyle: 'dots' | 'lines' | 'none'
  gridGap: number
  defaultZoom: number
  wheel: 'zoom' | 'pan'
  afterInsert: 'keep' | 'select'
}

/** 网络搜索（对话时附带搜索结果） */
export interface WebSearchSettings {
  enabled: boolean
  /** 模型原生搜索 */
  nativeEnabled: boolean
  /** 第三方搜索 */
  thirdPartyEnabled: boolean
  provider: 'tavily' | 'brave' | 'exa' | 'zhipu'
  apiKey: string
}

/** 语音（朗读 + 录音识别） */
export interface AudioSettings {
  mode: 'auto' | 'local' | 'model'
  /** 朗读语速，0.5–2 */
  speed: number
  /** 录音后自动识别 */
  recognitionEnabled: boolean
}

/** 图像识别总开关（模型与提示词在 ocr 里） */
export interface ImageMethodSettings {
  enabled: boolean
}

/** 整理模板 / 提示词模板 */
export interface PromptTemplate {
  id: string
  name: string
  prompt: string
}

export interface TemplateSettings {
  items: PromptTemplate[]
}

/** 快捷键绑定：action → 组合键（空字符串表示清空） */
export interface ShortcutSettings {
  bindings: Record<string, string>
}

/** 提示词与整理模板 */
export interface PromptSettings {
  /** 追加到系统提示词末尾的全局约束 */
  systemExtra: string
  /** 记录 → 笔记 的整理提示词 */
  organize: string
}

/** 文件树视图偏好（参考项目 file-more-menu 的「文件视图 / 远程文件 / 知识库」开关） */
export interface FileViewSettings {
  /** 排序字段 */
  sortBy: 'name' | 'mtime' | 'size'
  /** 升序 / 降序 */
  sortOrder: 'asc' | 'desc'
  /** 显示资源文件夹（assets 等纯图片目录） */
  showAssetsFolders: boolean
  /** 文件树上标出已收录知识库的笔记 */
  showKnowledgeBaseStatus: boolean
  /** 合并远端「仅云端」节点 */
  showRemoteFiles: boolean
  /** 上传时包含静态资源 */
  syncStaticAssets: boolean
  /** 保存笔记后自动更新知识库索引 */
  autoUpdateKnowledgeBase: boolean
}

/**
 * 知识库（RAG）参数：与参考项目 knowledge-search.ts 的默认配置对齐。
 * 后端 kb 系列 RPC 会读取这些值作为缺省参数，索引与检索共用同一份配置。
 */
export interface RagSettings {
  /** 单个分块的最大字符数 */
  chunkSize: number
  /** 相邻分块的重叠字符数 */
  chunkOverlap: number
  /** 混合检索召回条数 */
  topK: number
  /** 最低相似度阈值 */
  threshold: number
  /** 保存笔记后自动重算本篇向量 */
  autoVector: boolean
  /** 对话前自动注入检索到的上下文 */
  autoInject: boolean
}

export interface SettingsSnapshot {
  theme: ThemeMode
  locale: Locale
  fontSize: number
  editorWidth: number
  ai: AiSettings
  /** 长期记忆：一句一条，对话时自动注入 */
  memories: string[]
  /** 技能提示词库 */
  skills: SkillItem[]
  /** 对话前是否检索工作区作为知识库 */
  knowledgeEnabled: boolean
  /** 对话时是否允许调用本机 MCP 工具 */
  mcpEnabled: boolean
  image: ImageSettings
  imageHosting: ImageHostingSettings
  ocr: OcrSettings
  voice: VoiceSettings
  editor: EditorSettings
  record: RecordSettings
  canvas: CanvasSettings
  webSearch: WebSearchSettings
  prompt: PromptSettings
  audio: AudioSettings
  imageMethod: ImageMethodSettings
  template: TemplateSettings
  shortcuts: ShortcutSettings
  fileView: FileViewSettings
  rag: RagSettings
}

/** 内置技能：覆盖最常见的四类写作需求 */
export const DEFAULT_SKILLS: SkillItem[] = [
  {
    id: 'summarize',
    name: '总结要点',
    prompt: '请把内容压缩成 3-7 条要点，每条一行，保留关键数据与结论，不要复述原文措辞。',
  },
  {
    id: 'continue',
    name: '续写',
    prompt: '请接着原文的语气与结构继续写下去，不重复已写过的内容，保持段落长度接近。',
  },
  {
    id: 'outline',
    name: '生成大纲',
    prompt: '请先给出分层大纲（最多三级），只列标题，不要展开正文。',
  },
  {
    id: 'polish',
    name: '润色改写',
    prompt: '请在不改变事实的前提下把文字改得更通顺精炼，去掉冗余修饰，保持原意。',
  },
]

const STORAGE_KEY = 'app.settings'

/**
 * 设置落盘的串行队列
 *
 * `patch` / `patchHosting` 都是「先更新内存、再异步写盘」。连续两次修改会发出
 * 两个 setSetting 请求；后端较慢时先发的那个可能后到，把旧快照覆盖回新值
 * （典型表现：刚点完「使用此服务」，磁盘上的 provider 又变回 local）。
 * 这里把写盘串成一条链，并且每次真正写之前才读一次最新状态。
 */
let persistChain: Promise<void> = Promise.resolve()

/** 应用级快捷键默认绑定（与 NoteGen 的快捷键页对齐，可改可清空） */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  'app.search': 'Ctrl+Shift+F',
  'app.newNote': 'Ctrl+N',
  'app.settings': 'Ctrl+,',
  'app.toggleSidebar': 'Ctrl+B',
  'app.toggleChat': 'Ctrl+J',
  'app.voice': 'Ctrl+Shift+V',
  'app.sync': 'Ctrl+Shift+S',
  'app.screenshot': 'Alt+Shift+Z',
}

/**
 * 旧版默认值迁移
 *
 * `app.screenshot` 先后用过 `Ctrl+Shift+A`（被宿主占用）和 `Alt+Shift+A`，
 * 现在对齐参考实现用 `Shift+Alt+Z`。用户没改过就跟着升级，改过的一律尊重原值。
 */
const LEGACY_SHORTCUTS: Record<string, string[]> = {
  'app.screenshot': ['Ctrl+Shift+A', 'Alt+Shift+A'],
}

function migrateShortcuts(bindings: Record<string, string>): Record<string, string> {
  const next = { ...bindings }
  for (const [action, legacy] of Object.entries(LEGACY_SHORTCUTS)) {
    if (legacy.includes(next[action])) next[action] = DEFAULT_SHORTCUTS[action] ?? next[action]
  }
  return next
}

/** 编辑器内置快捷键（Tiptap 原生，只读展示） */
export const BUILTIN_EDITOR_SHORTCUTS: Array<{ labelKey: string; combo: string }> = [
  { labelKey: 'sc.builtin.bold', combo: 'Ctrl+B' },
  { labelKey: 'sc.builtin.italic', combo: 'Ctrl+I' },
  { labelKey: 'sc.builtin.underline', combo: 'Ctrl+U' },
  { labelKey: 'sc.builtin.strike', combo: 'Ctrl+Shift+X' },
  { labelKey: 'sc.builtin.code', combo: 'Ctrl+E' },
  { labelKey: 'sc.builtin.heading', combo: 'Ctrl+Alt+1..6' },
  { labelKey: 'sc.builtin.list', combo: 'Ctrl+Shift+8' },
  { labelKey: 'sc.builtin.task', combo: 'Ctrl+Shift+9' },
  { labelKey: 'sc.builtin.quote', combo: 'Ctrl+Shift+B' },
  { labelKey: 'sc.builtin.hr', combo: 'Ctrl+Shift+-' },
  { labelKey: 'sc.builtin.undo', combo: 'Ctrl+Z' },
  { labelKey: 'sc.builtin.redo', combo: 'Ctrl+Shift+Z' },
  { labelKey: 'sc.builtin.slash', combo: 'Ctrl+/' },
]

/** 内置整理模板 */
export const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'structure',
    name: '结构化笔记',
    prompt:
      '请把下面的碎片记录整理成一篇结构化笔记：先给一个二级标题，按主题分组，保留原始事实与数据，不要编造内容。',
  },
  {
    id: 'meeting',
    name: '会议纪要',
    prompt:
      '请把内容整理成会议纪要：分别列出「结论」「待办（含负责人与时间）」「待确认问题」三段，不要添加未提及的信息。',
  },
  {
    id: 'weekly',
    name: '周报',
    prompt:
      '请把内容整理成周报：分「本周完成」「下周计划」「风险与求助」三部分，每条一句话，尽量带上数字。',
  },
]

/** 各用途的中文名，仅用于兜底展示；界面文案走 i18n */
export const AI_MODEL_TYPES: AiModelType[] = ['chat', 'vision', 'stt', 'embedding', 'tts']

export const EMPTY_MODEL_DEFAULTS: AiModelDefaults = {
  chat: '',
  vision: '',
  stt: '',
  embedding: '',
  tts: '',
}

/** 新建模型的默认参数：温度沿用 NoteGen 的 0.7，topP 用 1（不下发偏置） */
export function createModelConfig(name = '', modelType: AiModelType = 'chat'): AiModelConfig {
  return {
    id: localId(),
    name,
    modelType,
    temperature: 0.7,
    topP: 1,
    enableStream: true,
    maxTokens: 0,
    contextWindow: 0,
    voice: '',
  }
}

export function createProvider(name = '', baseUrl = '', apiKey = ''): AiProvider {
  return { id: localId(), name, baseUrl, apiKey, models: [] }
}

/** 未传 id / 缺字段时补齐，并保证同一次迁移里 id 不重复 */
function normalizeModel(raw: Partial<AiModelConfig> | undefined, seen: Set<string>): AiModelConfig {
  const base = createModelConfig()
  let id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : base.id
  while (seen.has(id)) id = localId()
  seen.add(id)
  return {
    id,
    name: typeof raw?.name === 'string' ? raw.name : '',
    modelType: AI_MODEL_TYPES.includes(raw?.modelType as AiModelType)
      ? (raw!.modelType as AiModelType)
      : 'chat',
    temperature: typeof raw?.temperature === 'number' ? raw.temperature : base.temperature,
    topP: typeof raw?.topP === 'number' ? raw.topP : base.topP,
    enableStream: raw?.enableStream !== false,
    maxTokens: typeof raw?.maxTokens === 'number' ? raw.maxTokens : 0,
    contextWindow: typeof raw?.contextWindow === 'number' ? raw.contextWindow : 0,
    voice: typeof raw?.voice === 'string' ? raw.voice : '',
  }
}

/**
 * 把存量的单模型配置或多厂商配置归一成 `AiSettings`。
 *
 * 迁移规则：
 * - 新结构（有 providers）→ 逐层补默认值，丢掉悬空的模型 id；
 * - 旧结构（只有 baseUrl/apiKey/model）→ 包成一个厂商 + 一个对话模型，
 *   这样老用户升级后不必重新填一遍密钥；
 * - 两者都没有 → 空配置，首次使用引导用户添加厂商。
 */
export function migrateAiSettings(raw: unknown): AiSettings {
  const source = (raw ?? {}) as Partial<AiSettings> & LegacyAiSettings
  const seen = new Set<string>()
  const providers: AiProvider[] = []

  if (Array.isArray(source.providers) && source.providers.length > 0) {
    for (const provider of source.providers) {
      if (!provider || typeof provider !== 'object') continue
      const models = Array.isArray(provider.models)
        ? provider.models.map((model) => normalizeModel(model, seen))
        : []
      providers.push({
        id: typeof provider.id === 'string' && provider.id.trim() ? provider.id.trim() : localId(),
        name: typeof provider.name === 'string' ? provider.name : '',
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
        apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '',
        models,
      })
    }
  } else if (source.baseUrl || source.apiKey || source.model) {
    const provider = createProvider('默认厂商', source.baseUrl ?? '', source.apiKey ?? '')
    if (source.model) {
      const model = createModelConfig(source.model, 'chat')
      if (typeof source.temperature === 'number') model.temperature = source.temperature
      seen.add(model.id)
      provider.models.push(model)
    }
    providers.push(provider)
  }

  // 默认值只在对应模型真实存在时保留，避免指向已删除的模型
  const validIds = new Set(providers.flatMap((provider) => provider.models.map((model) => model.id)))
  const defaults = source.defaults ?? EMPTY_MODEL_DEFAULTS
  const pickFor = (type: AiModelType, candidate?: string): string => {
    if (candidate && validIds.has(candidate)) return candidate
    const fallback = providers
      .flatMap((provider) => provider.models)
      .find((model) => model.modelType === type)
    return fallback?.id ?? ''
  }

  return {
    providers,
    defaults: {
      chat: pickFor('chat', defaults.chat),
      vision: pickFor('vision', defaults.vision),
      stt: pickFor('stt', defaults.stt),
      embedding: pickFor('embedding', defaults.embedding),
      tts: pickFor('tts', defaults.tts),
    },
  }
}

const DEFAULT_SETTINGS: SettingsSnapshot = {
  theme: 'system',
  locale: 'zh-CN',
  fontSize: 16,
  editorWidth: 760,
  ai: {
    providers: [],
    defaults: { ...EMPTY_MODEL_DEFAULTS },
  },
  memories: [],
  skills: DEFAULT_SKILLS,
  knowledgeEnabled: false,
  mcpEnabled: false,
  image: { dir: 'assets', nameMode: 'uuid' },
  imageHosting: {
    provider: 'local',
    jsdelivr: false,
    github: { token: '', username: '', repo: '', branch: 'main', pathPrefix: '' },
    smms: { token: '' },
    picgo: { url: 'http://127.0.0.1:36677/upload' },
    s3: {
      preset: 'aws',
      accessKeyId: '',
      secretAccessKey: '',
      region: '',
      bucket: '',
      endpoint: '',
      customDomain: '',
      pathPrefix: '',
      addressingStyle: 'auto',
    },
    qiniu: {
      accessKey: '',
      secretKey: '',
      bucket: '',
      publicUrl: '',
      uploadUrl: 'https://upload.qiniup.com',
      pathPrefix: 'images',
    },
    upyun: { bucket: '', operator: '', password: '', publicUrl: '', pathPrefix: 'images' },
    lsky: { apiUrl: '', token: '', strategyId: '' },
    webdav: { baseUrl: '', username: '', password: '', publicUrl: '', pathPrefix: 'images' },
    customHttp: {
      url: '',
      method: 'POST',
      headers: '',
      formFields: '',
      fileField: 'file',
      responseUrlPath: 'url',
    },
    cloudinary: { cloudName: '', uploadPreset: '', folder: '' },
    imagekit: { privateKey: '', folder: '' },
  },
  ocr: { baseUrl: '', apiKey: '', model: '', prompt: '' },
  voice: { baseUrl: '', apiKey: '', model: 'whisper-1' },
  editor: {
    viewMode: 'visual',
    lineHeight: 'comfortable',
    showStats: false,
    showUndoRedo: true,
    showSourceLineNumbers: true,
    sourceWrap: true,
    outlineEnabled: true,
    outlinePlacement: 'sidebar',
    outlinePosition: 'right',
    spellcheck: false,
    autoSaveMs: 800,
    pasteMaxEdge: 0,
  },
  record: { view: 'list', sort: 'newest', defaultType: 'text', focusAfterSaved: true },
  canvas: {
    showGrid: true,
    snapToGrid: false,
    minimap: false,
    gridStyle: 'dots',
    gridGap: 20,
    defaultZoom: 100,
    wheel: 'zoom',
    afterInsert: 'keep',
  },
  webSearch: {
    enabled: false,
    nativeEnabled: true,
    thirdPartyEnabled: false,
    provider: 'tavily',
    apiKey: '',
  },
  prompt: {
    systemExtra: '',
    organize:
      '请把下面的碎片记录整理成一篇结构化笔记：先给一个二级标题，按主题分组，保留原始事实与数据，不要编造内容。',
  },
  audio: { mode: 'auto', speed: 1, recognitionEnabled: true },
  imageMethod: { enabled: true },
  template: { items: DEFAULT_TEMPLATES },
  shortcuts: { bindings: DEFAULT_SHORTCUTS },
  fileView: {
    sortBy: 'name',
    sortOrder: 'asc',
    showAssetsFolders: true,
    showKnowledgeBaseStatus: false,
    showRemoteFiles: true,
    syncStaticAssets: true,
    autoUpdateKnowledgeBase: false,
  },
  rag: {
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
    threshold: 0.25,
    autoVector: true,
    autoInject: true,
  },
}

interface SettingsState extends SettingsSnapshot {
  ready: boolean
  workspace: WorkspaceInfo | null
  /** 读取设置并应用外观 */
  load: () => Promise<void>
  /** 局部更新（自动持久化） */
  patch: (patch: Partial<SettingsSnapshot>) => void
  /** 文件树视图偏好的局部更新（自动持久化） */
  patchFileView: (patch: Partial<FileViewSettings>) => void
  /** 知识库（RAG）参数的局部更新（自动持久化） */
  patchRag: (patch: Partial<RagSettings>) => void
  patchAi: (patch: Partial<AiSettings>) => void
  /** 新增或整体替换一个厂商（按 id 判断） */
  upsertProvider: (provider: AiProvider) => void
  /** 删除厂商；其下模型若被默认值引用会被自动改派 */
  removeProvider: (providerId: string) => void
  /** 厂商字段局部更新 */
  patchProvider: (providerId: string, patch: Partial<Omit<AiProvider, 'id' | 'models'>>) => void
  /** 新增或整体替换某个厂商下的模型 */
  upsertModel: (providerId: string, model: AiModelConfig) => void
  /** 删除模型；若它是某用途的默认模型会被自动改派 */
  removeModel: (providerId: string, modelId: string) => void
  /** 指定某用途使用哪个模型 */
  setDefaultModel: (type: AiModelType, modelId: string) => void
  /** 图床局部更新（provider 内部字段） */
  patchHosting: <K extends keyof ImageHostingSettings>(
    key: K,
    patch: Partial<ImageHostingSettings[K]>,
  ) => void
  setWorkspace: (info: WorkspaceInfo) => void
  persist: () => Promise<void>
}

/** 外观落盘到 html 根节点，CSS 用 .dark 与 [data-appearance] 双通道匹配 */
function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement
  const systemDark =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  const appearance = theme === 'system' ? (hostAppearance() === 'dark' || systemDark ? 'dark' : 'light') : theme
  root.classList.toggle('dark', appearance === 'dark')
  root.dataset.appearance = appearance
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  ready: false,
  workspace: null,

  load: async () => {
    let snapshot = DEFAULT_SETTINGS
    try {
      const stored = await getSetting<Partial<SettingsSnapshot>>(STORAGE_KEY)
      if (stored && typeof stored === 'object') {
        snapshot = {
          ...DEFAULT_SETTINGS,
          ...stored,
          ai: migrateAiSettings(stored.ai),
          memories: Array.isArray(stored.memories) ? stored.memories : [],
          image: { ...DEFAULT_SETTINGS.image, ...(stored.image ?? {}) },
          imageHosting: {
            ...DEFAULT_SETTINGS.imageHosting,
            ...(stored.imageHosting ?? {}),
            github: { ...DEFAULT_SETTINGS.imageHosting.github, ...(stored.imageHosting?.github ?? {}) },
            smms: { ...DEFAULT_SETTINGS.imageHosting.smms, ...(stored.imageHosting?.smms ?? {}) },
            picgo: { ...DEFAULT_SETTINGS.imageHosting.picgo, ...(stored.imageHosting?.picgo ?? {}) },
            s3: { ...DEFAULT_SETTINGS.imageHosting.s3, ...(stored.imageHosting?.s3 ?? {}) },
            qiniu: { ...DEFAULT_SETTINGS.imageHosting.qiniu, ...(stored.imageHosting?.qiniu ?? {}) },
            upyun: { ...DEFAULT_SETTINGS.imageHosting.upyun, ...(stored.imageHosting?.upyun ?? {}) },
            lsky: { ...DEFAULT_SETTINGS.imageHosting.lsky, ...(stored.imageHosting?.lsky ?? {}) },
            webdav: { ...DEFAULT_SETTINGS.imageHosting.webdav, ...(stored.imageHosting?.webdav ?? {}) },
            customHttp: {
              ...DEFAULT_SETTINGS.imageHosting.customHttp,
              ...(stored.imageHosting?.customHttp ?? {}),
            },
            cloudinary: {
              ...DEFAULT_SETTINGS.imageHosting.cloudinary,
              ...(stored.imageHosting?.cloudinary ?? {}),
            },
            imagekit: {
              ...DEFAULT_SETTINGS.imageHosting.imagekit,
              ...(stored.imageHosting?.imagekit ?? {}),
            },
          },
          ocr: { ...DEFAULT_SETTINGS.ocr, ...(stored.ocr ?? {}) },
          voice: { ...DEFAULT_SETTINGS.voice, ...(stored.voice ?? {}) },
          editor: { ...DEFAULT_SETTINGS.editor, ...(stored.editor ?? {}) },
          record: { ...DEFAULT_SETTINGS.record, ...(stored.record ?? {}) },
          canvas: { ...DEFAULT_SETTINGS.canvas, ...(stored.canvas ?? {}) },
          webSearch: { ...DEFAULT_SETTINGS.webSearch, ...(stored.webSearch ?? {}) },
          prompt: { ...DEFAULT_SETTINGS.prompt, ...(stored.prompt ?? {}) },
          audio: { ...DEFAULT_SETTINGS.audio, ...(stored.audio ?? {}) },
          imageMethod: { ...DEFAULT_SETTINGS.imageMethod, ...(stored.imageMethod ?? {}) },
          fileView: { ...DEFAULT_SETTINGS.fileView, ...(stored.fileView ?? {}) },
          rag: { ...DEFAULT_SETTINGS.rag, ...(stored.rag ?? {}) },
          template: {
            items:
              Array.isArray(stored.template?.items) && stored.template.items.length > 0
                ? stored.template.items
                : DEFAULT_TEMPLATES,
          },
          shortcuts: {
            bindings: migrateShortcuts({ ...DEFAULT_SHORTCUTS, ...(stored.shortcuts?.bindings ?? {}) }),
          },
          skills:
            Array.isArray(stored.skills) && stored.skills.length > 0
              ? stored.skills
              : DEFAULT_SKILLS,
        }
      }
    } catch (error) {
      console.warn('[settings] 读取失败，使用默认设置', error)
    }

    // 未显式设置过语言时跟随宿主
    if (!localStorageSafe()?.getItem('dbx-note:locale-touched')) {
      snapshot.locale = hostLocale() as Locale
    }

    set({ ...snapshot, ready: true })
    applyTheme(snapshot.theme)
    applyEditorPreferences(snapshot)
  },

  patch: (patch) => {
    set(patch as Partial<SettingsState>)
    const state = get()
    if (patch.theme) applyTheme(patch.theme)
    if (patch.locale) localStorageSafe()?.setItem('dbx-note:locale-touched', '1')
    applyEditorPreferences(state)
    void get().persist()
  },

  patchFileView: (patch) => {
    set({ fileView: { ...get().fileView, ...patch } })
    void get().persist()
  },

  patchRag: (patch) => {
    set({ rag: { ...get().rag, ...patch } })
    void get().persist()
  },

  patchAi: (patch) => {
    const ai = { ...get().ai, ...patch }
    set({ ai })
    void get().persist()
  },

  upsertProvider: (provider) => {
    const current = get().ai
    const exists = current.providers.some((item) => item.id === provider.id)
    const providers = exists
      ? current.providers.map((item) => (item.id === provider.id ? provider : item))
      : [...current.providers, provider]
    // 走一遍迁移：新厂商的模型补默认字段，默认值指向仍然有效
    set({ ai: migrateAiSettings({ ...current, providers }) })
    void get().persist()
  },

  removeProvider: (providerId) => {
    const current = get().ai
    const providers = current.providers.filter((item) => item.id !== providerId)
    // 迁移会把悬空的默认模型改派到同类模型，没有同类就清空
    set({ ai: migrateAiSettings({ providers, defaults: current.defaults }) })
    void get().persist()
  },

  patchProvider: (providerId, patch) => {
    const current = get().ai
    const providers = current.providers.map((item) =>
      item.id === providerId ? { ...item, ...patch } : item,
    )
    set({ ai: { ...current, providers } })
    void get().persist()
  },

  upsertModel: (providerId, model) => {
    const current = get().ai
    const providers = current.providers.map((provider) => {
      if (provider.id !== providerId) return provider
      const exists = provider.models.some((item) => item.id === model.id)
      return {
        ...provider,
        models: exists
          ? provider.models.map((item) => (item.id === model.id ? model : item))
          : [...provider.models, model],
      }
    })
    set({ ai: migrateAiSettings({ ...current, providers }) })
    void get().persist()
  },

  removeModel: (providerId, modelId) => {
    const current = get().ai
    const providers = current.providers.map((provider) =>
      provider.id === providerId
        ? { ...provider, models: provider.models.filter((item) => item.id !== modelId) }
        : provider,
    )
    set({ ai: migrateAiSettings({ providers, defaults: current.defaults }) })
    void get().persist()
  },

  setDefaultModel: (type, modelId) => {
    const current = get().ai
    set({ ai: { ...current, defaults: { ...current.defaults, [type]: modelId } } })
    void get().persist()
  },

  patchHosting: (key, patch) => {
    const current = get().imageHosting
    const value = current[key]
    // provider / jsdelivr 是标量，其余是分组对象
    const next =
      typeof value === 'object' && value !== null
        ? { ...current, [key]: { ...value, ...patch } }
        : { ...current, [key]: patch }
    set({ imageHosting: next as ImageHostingSettings })
    void get().persist()
  },

  setWorkspace: (info) => set({ workspace: info }),

  persist: () => {
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => writeSettings());
    return persistChain
  },
}))

/** 真正落盘：执行时才读状态，保证队列里最后一写用的是最新值 */
async function writeSettings(): Promise<void> {
  const {
    theme,
    locale,
    fontSize,
    editorWidth,
    ai,
    memories,
    skills,
    knowledgeEnabled,
    mcpEnabled,
    image,
    imageHosting,
    ocr,
    voice,
    editor,
    record,
    canvas,
    webSearch,
    prompt,
    audio,
    imageMethod,
    template,
    shortcuts,
    fileView,
    rag,
  } = useSettingsStore.getState()
  try {
    await setSetting(STORAGE_KEY, {
      theme,
      locale,
      fontSize,
      editorWidth,
      ai,
      memories,
      skills,
      knowledgeEnabled,
      mcpEnabled,
      image,
      imageHosting,
      ocr,
      voice,
      editor,
      record,
      canvas,
      webSearch,
      prompt,
      audio,
      imageMethod,
      template,
      shortcuts,
      fileView,
      rag,
    })
  } catch (error) {
    console.warn('[settings] 保存失败', error)
  }
}

/** 编辑器字号、正文宽度与行高通过 CSS 变量下发，避免逐组件传参 */
function applyEditorPreferences(
  snapshot: Pick<SettingsSnapshot, 'fontSize' | 'editorWidth' | 'editor'>,
): void {
  const root = document.documentElement
  root.style.setProperty('--dbx-note-editor-size', `${snapshot.fontSize}px`)
  root.style.setProperty('--dbx-note-editor-width', `${snapshot.editorWidth}px`)
  const lineHeight = EDITOR_LINE_HEIGHT[snapshot.editor?.lineHeight ?? 'comfortable']
  root.style.setProperty('--dbx-note-line-height', String(lineHeight))
}

/** 由像素宽度反推最接近的预设档位（内容宽度按钮的高亮依据） */
export function contentWidthOf(width: number): EditorContentWidth {
  let best: EditorContentWidth = 'standard'
  let min = Number.POSITIVE_INFINITY
  for (const [key, value] of Object.entries(EDITOR_CONTENT_WIDTH) as Array<[EditorContentWidth, number]>) {
    const distance = Math.abs(value - width)
    if (distance < min) {
      min = distance
      best = key
    }
  }
  return best
}

/** 沙箱里 localStorage 可能直接抛异常，这里做安全包装 */
function localStorageSafe(): Storage | null {
  try {
    const storage = window.localStorage
    storage.getItem('dbx-note:probe')
    return storage
  } catch {
    return null
  }
}

/** 系统深浅色变化时刷新（仅 theme = system 生效） */
export function watchSystemTheme(): () => void {
  if (!window.matchMedia) return () => {}
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const { theme } = useSettingsStore.getState()
    if (theme === 'system') applyTheme('system')
  }
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}

/** 供非 React 环境（如 store 内部）读取当前语言 */
export function currentLocale(): Locale {
  return useSettingsStore.getState().locale
}
