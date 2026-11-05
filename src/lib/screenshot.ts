/**
 * 截图：框选 + 落盘
 *
 * 框选在**真实桌面**上做：Sidecar 建一个覆盖全屏的置顶窗口，把抓到的画面 1:1 画上去，
 * 用户直接在原图上拉框，松手后返回裁剪好的 PNG。插件窗口本身只是后续的标注台，
 * 不再出现「整张桌面缩进插件窗口再选」的二次缩放。
 *
 * 三条路径按顺序尝试：
 * 1. `screenshot/select`：桌面 1:1 框选（正常路径）
 * 2. `screen/capture`：拿不到交互式桌面 / 测试环境时退成整屏，交给插件浮层框选
 * 3. `clipboard/image` 与浏览器剪贴板：最后兜底
 */
import { insertToEditor } from '@/lib/editorBus'
import { translate } from '@/lib/i18n'
import { recognitionEnabled, recognizeImage } from '@/lib/imageRecognition'
import { extensionOf, persistImage } from '@/lib/imageStore'
import { isWorkspaceImage, loadPreview, previewOf, rememberPreview } from '@/lib/previewCache'
import * as rpc from '@/lib/rpc'
import { useRecordsStore } from '@/stores/records'
import { useScreenshotStore, type ShotSource } from '@/stores/screenshot'
import { useSettingsStore } from '@/stores/settings'

export type CaptureResult =
  | { status: 'opened'; source: ShotSource }
  /** 用户主动取消（Esc / 右键），不该再弹提示 */
  | { status: 'cancelled' }
  | { status: 'empty' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

/** 剪贴板 API 是否可用（只影响最后一条路径） */
export function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function'
}

export function stampName(mime: string, prefix = 'screenshot'): string {
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${prefix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
    stamp.getHours(),
  )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${extensionOf('', mime)}`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取剪贴板图片失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把裁剪好的 PNG 落到工作区（或图床），返回相对路径 */
export async function saveCapturedImage(
  dataBase64: string,
  mime = 'image/png',
): Promise<{ src: string; name: string }> {
  const name = stampName(mime)
  const saved = await persistImage({ name, dataBase64, mime })
  // 已经拿到图片内容了，顺手写进预览缓存，插入后不用再多跑一次 image/read
  rememberPreview(saved.src, `data:${mime};base64,${dataBase64}`)
  return { src: saved.src, name }
}

/** 图片直接插入当前笔记 */
export async function insertCapturedImage(dataBase64: string, mime = 'image/png'): Promise<boolean> {
  const { src, name } = await saveCapturedImage(dataBase64, mime)
  return insertToEditor(`![${name}](${src})`)
}

/**
 * 记录面板上的「重试」：对一条已存在的图片记录重新跑识别
 *
 * 图床地址先取回内容再识别——宿主 CSP 拦外链，服务端也不该替我们出去抓图。
 */
export async function recognizeRecordImage(recordId: string, content: string): Promise<void> {
  const t = (key: string) => translate(useSettingsStore.getState().locale, key)
  // 只写库不够：记录面板读的是 store，写完要重新拉一次才会出现"正在识别"
  await rpc.updateRecord({ id: recordId, meta: { text: t('shot.recognizing'), method: 'running' } }).catch(() => {})
  await useRecordsStore.getState().load().catch(() => {})

  // 图床地址先取回内容再识别（宿主 CSP 拦外链，识别也不能让服务端去抓外链）
  let path: string | undefined
  let dataBase64: string | undefined
  let mime = 'image/png'
  if (isWorkspaceImage(content)) {
    path = content
  } else {
    const dataUrl = previewOf(content) ?? (await loadPreview(content)) ?? ''
    const comma = dataUrl.indexOf(',')
    if (comma > 0) {
      dataBase64 = dataUrl.slice(comma + 1)
      const head = dataUrl.slice(5, dataUrl.indexOf(';'))
      if (head.startsWith('image/')) mime = head
    }
  }

  const result = await recognizeImage({
    path,
    dataBase64,
    mime,
    prompt: useSettingsStore.getState().ocr.prompt.trim() || undefined,
    maxTokens: 120,
  })
  await rpc
    .updateRecord({
      id: recordId,
      meta: {
        text: result.desc,
        method: result.method,
        error: result.error ?? '',
      },
    })
    .catch(() => {})
  await useRecordsStore.getState().load()
}

/**
 * 把截图存成图片记录：**先本地落库，再异步增强**
 *
 * 对齐参考项目的顺序（`desktop-screenshot-bridge` → `processSavedScreenshot`）：
 * 1. 原图先落到工作区、记录立刻建好——图床 / 模型抖一下也不能让记录本身丢掉；
 * 2. 识别模型看图写解读，结果补进 `meta.text`（记录里显示在缩略图下面）；
 * 3. 配了图床就把图片传上去，成功后把记录的 `content` 换成远端 URL（失败保留本地）。
 *
 * 第 2、3 步互不阻塞、也都不影响第 1 步的成败。
 */
export async function saveShotToRecords(
  dataBase64: string,
  mime = 'image/png',
): Promise<{ src: string; recordId: string }> {
  const name = stampName(mime)
  const settings = useSettingsStore.getState()
  // 1) 本地落盘（不经过 `persistImage`：那条路径在图床模式下会跳过本地，失败就全丢了）
  const local = await rpc.saveImage(name, dataBase64, {
    dir: settings.image.dir,
    nameMode: settings.image.nameMode,
  })
  rememberPreview(local.path, `data:${mime};base64,${dataBase64}`)
  const record = await rpc.createRecord({
    type: 'image',
    content: local.path,
    meta: { name, source: 'screenshot' },
  })
  await useRecordsStore.getState().load()
  // 2)+3) 识别与图床并行推进，谁先好谁先写
  void rpc
    .logWrite(
      `截图已存记录：本地 ${local.path} · 图床=${settings.imageHosting?.provider ?? 'local'}`,
    )
    .catch(() => {})
  void describeRecordImage(record.id, dataBase64, mime, local.path)
  void hostRecordImage(record.id, name, dataBase64, mime)
  return { src: local.path, recordId: record.id }
}

/** 调图像识别给图片记录补一段解读文字（写进 meta.text） */
async function describeRecordImage(
  recordId: string,
  dataBase64: string,
  mime: string,
  imagePath: string,
): Promise<void> {
  // 设置里关掉「图片识别」就不打扰用户
  if (!recognitionEnabled()) return
  const t = (key: string) => translate(useSettingsStore.getState().locale, key)

  // 先占位：记录里立刻能看出「正在识别」，不用等模型（写完重新拉一次列表）
  await rpc
    .updateRecord({ id: recordId, meta: { text: t('shot.recognizing'), method: 'running' } })
    .catch(() => {})
  await useRecordsStore.getState().load().catch(() => {})
  const result = await recognizeImage({
    path: imagePath,
    dataBase64,
    mime,
    prompt: useSettingsStore.getState().ocr.prompt.trim() || undefined,
    maxTokens: 120,
  })

  // 识别失败只是少一段描述，不该把记录变成错误状态：
  // 失败文案 + 原因一起写进 meta，记录面板据此显示「重试」
  await rpc
    .updateRecord({
      id: recordId,
      meta: {
        text: result.desc,
        method: result.method,
        engine: result.method === 'none' ? '' : result.method,
        error: result.error ?? '',
      },
    })
    .catch(() => {})
  if (result.error) {
    console.warn('[screenshot] 图片识别未取到内容', result.error)
    void rpc.logWrite(`图片识别失败：${result.error}`).catch(() => {})
  }
  await useRecordsStore.getState().load()
}

/**
 * 配了图床就把截图传上去，成功后把记录的图片地址换成远端 URL
 *
 * 参考项目里这一步排在最末：先保证记录里有图（本地），上传只是「顺手改善」——
 * 失败时保留本地路径，只提示一句，记录内容不会坏。
 */
async function hostRecordImage(
  recordId: string,
  name: string,
  dataBase64: string,
  mime: string,
): Promise<void> {
  const settings = useSettingsStore.getState()
  const hosting = settings.imageHosting
  if (!hosting || hosting.provider === 'local') return
  try {
    void rpc.logWrite(`截图上传图床：provider=${hosting.provider}`).catch(() => {})
    const uploaded = await rpc.imageUpload({ name, dataBase64, mime, config: hosting })
    if (!uploaded?.url) return
    // 先把远端地址写进预览缓存：宿主 CSP 拦外链，缩略图仍要能立刻显示
    rememberPreview(uploaded.url, `data:${mime};base64,${dataBase64}`)
    await rpc.updateRecord({
      id: recordId,
      content: uploaded.url,
      meta: { name, source: 'screenshot', hosted: true, provider: uploaded.provider },
    })
    await useRecordsStore.getState().load()
    void rpc.logWrite(`截图已上传图床：${uploaded.url}`).catch(() => {})
  } catch (error) {
    console.warn('[screenshot] 图床上传失败，记录保留本地图片', error)
    void rpc
      .logWrite(
        `截图上传图床失败，已保留本地图片：${error instanceof Error ? error.message : String(error)}`,
      )
      .catch(() => {})
  }
}

/** 结果 → 提示文案 */
export function captureMessage(result: CaptureResult): { tone: 'success' | 'warning' | 'error'; key: string } {
  if (result.status === 'opened') return { tone: 'success', key: 'shot.opened' }
  if (result.status === 'cancelled') return { tone: 'warning', key: 'shot.cancelled' }
  if (result.status === 'empty') return { tone: 'warning', key: 'shot.empty' }
  if (result.status === 'denied') return { tone: 'warning', key: 'shot.denied' }
  return { tone: 'error', key: result.message }
}

/** 后端返回的区域 / 整屏图 → 浮层状态 */
function openOverlay(
  shot: { dataBase64: string; mime: string; width: number; height: number },
  source: ShotSource,
  preselected: boolean,
): void {
  useScreenshotStore.getState().open({
    dataUrl: `data:${shot.mime};base64,${shot.dataBase64}`,
    width: shot.width,
    height: shot.height,
    source,
    preselected,
  })
}

/** 唤出截图：先在桌面上 1:1 框选，拿到区域再开浮层标注 */
export async function startScreenshot(): Promise<CaptureResult> {
  // 1. Sidecar 全屏框选
  try {
    const region = await rpc.screenshotSelect()
    const native = region.mode === 'native'
    openOverlay(region, native ? 'region' : 'screen', native)
    return { status: 'opened', source: native ? 'region' : 'screen' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/已取消截图/.test(message)) return { status: 'cancelled' }
    // 热键线程已经先一步把窗口弹出来了，交给聚焦轮询去取挂起项
    if (/截图窗口已打开/.test(message)) return { status: 'cancelled' }
    // 其它失败（没有交互式桌面等）继续走老路径
  }

  // 2. 整屏交给插件浮层
  try {
    const shot = await rpc.screenCapture()
    openOverlay(shot, 'screen', false)
    return { status: 'opened', source: 'screen' }
  } catch {
    /* 抓屏被系统拒绝（锁屏 / 远程桌面）时退到剪贴板 */
  }

  // 3. Sidecar 读剪贴板位图
  try {
    const shot = await rpc.clipboardImage()
    openOverlay(shot, 'clipboard', false)
    return { status: 'opened', source: 'clipboard' }
  } catch {
    /* 剪贴板里没有图片时继续退 */
  }

  // 4. 浏览器剪贴板 API
  if (!canReadClipboard()) return { status: 'empty' }
  let items: ClipboardItems
  try {
    items = await navigator.clipboard.read()
  } catch {
    return { status: 'denied' }
  }
  for (const item of items) {
    const type = item.types.find((value) => value.startsWith('image/'))
    if (!type) continue
    try {
      const blob = await item.getType(type)
      const dataBase64 = await blobToBase64(blob)
      const size = await imageSize(`data:${type};base64,${dataBase64}`)
      useScreenshotStore
        .getState()
        .open({ dataUrl: `data:${type};base64,${dataBase64}`, ...size, source: 'clipboard', preselected: false })
      return { status: 'opened', source: 'clipboard' }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
  return { status: 'empty' }
}

/**
 * 全局热键产出的截图：插件下次获得焦点时接过来收尾
 *
 * 全局按下热键时插件可能根本看不见，所以标注是在**桌面上那个原生窗口里当场做完**的
 * （`screenshot_ink` 那套工具栏，和插件浮层同一套工具 / 颜色 / 粗细 / 出口）。
 * 用户点了「插入笔记 / 保存到记录」之后 Sidecar 才留一份挂起项并把宿主拉到前台，
 * 这里拿到就直接落库或插入——**不再开第二个标注浮层**。
 *
 * 只有老版本 / 兜底路径产出的、没带 `action` 的挂起项才会退回浮层标注。
 */
export async function pollPendingShot(): Promise<boolean> {
  if (useScreenshotStore.getState().shot) return false
  let pending: rpc.ScreenshotRegion | null = null
  try {
    pending = await rpc.screenshotTakePending()
  } catch {
    return false
  }
  if (!pending) return false

  // 已经标注确认过：直接收尾，路径上不再出现任何 UI
  const action = pending.action
  if (action === 'insert' || action === 'record') {
    void rpc
      .logWrite(
        `取到全局截图 ${pending.width}×${pending.height}，出口=${action}，直接收尾（不再弹浮层）`,
      )
      .catch(() => {})
    try {
      if (action === 'insert') {
        const inserted = await insertCapturedImage(pending.dataBase64, pending.mime)
        if (!inserted) {
          // 编辑器没挂载（比如停在记录页）：退成存记录，别让图丢了
          await saveShotToRecords(pending.dataBase64, pending.mime)
        }
      } else {
        await saveShotToRecords(pending.dataBase64, pending.mime)
      }
    } catch (error) {
      console.warn('[screenshot] 全局截图收尾失败', error)
      // 落库失败时至少把图还给用户：开浮层让他自己另存
      openOverlay(pending, 'global', true)
    }
    return true
  }

  openOverlay(pending, 'global', true)
  // 页面侧也记一行：Sidecar 日志里只有「图已交出」，浮层有没有真的弹出来要在这里才看得到
  void rpc
    .logWrite(`取到挂起截图 ${pending.width}×${pending.height}，打开标注浮层`)
    .catch(() => {})
  return true
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: 1, height: 1 })
    image.src = src
  })
}
