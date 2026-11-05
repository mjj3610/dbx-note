/**
 * 图片识别：视觉模型优先，系统 OCR 回退
 *
 * 对齐 NoteGen 的 `recognizeImageWithFallback`：
 * 1. 配了视觉模型 → 先让模型看图写解读；返回空 / 抛错都**不算失败**，继续往下走；
 * 2. 系统 OCR（Windows.Media.Ocr）兜底——它只读文字，不理解画面，
 *    但"把纯文本模型填进识别配置"（例如 qwen3-8B 没有视觉能力）时，
 *    只有这条腿还能把图里的内容捞出来，不会整条记录变成"图片识别失败"；
 * 3. 两条都不行才写失败文案，并把两边的报错原因一起带回去，便于定位。
 */
import { translate } from '@/lib/i18n'
import * as rpc from '@/lib/rpc'
import { isModelReady, resolveModelWithFallback } from '@/lib/aiConfig'
import { useSettingsStore } from '@/stores/settings'

export type ImageRecognitionMethod = 'vlm' | 'ocr' | 'none'

export interface ImageRecognitionResult {
  /** 识别出的正文：模型描述或 OCR 文本 */
  content: string
  /** 记录里展示的短文本；彻底失败时就是失败文案 */
  desc: string
  method: ImageRecognitionMethod
  /** 失败原因（成功时为 null），写进 meta 供设置页 / 日志排查 */
  error: string | null
}

interface RecognizeOptions {
  /** 工作区相对路径：系统 OCR 直接读盘，不必再传 base64 */
  path?: string
  /** 图片 base64（刚截完图手里就有，省一次读盘） */
  dataBase64?: string
  mime?: string
  /** 自定义提示词，留空走默认 */
  prompt?: string
  /** 限制输出长度（参考项目描述用 120） */
  maxTokens?: number
  /** 阶段回调：记录里显示"正在识别图片…" */
  onStage?: (stage: 'vlm' | 'ocr') => void
}

/** 没配提示词时让模型"看图说话 + 抽字" */
const DEFAULT_PROMPT =
  '描述这张图片的内容与用途，并原样提取图中的关键文字；用简洁的中文输出，不要寒暄。'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 视觉模型配置
 *
 * 优先级：图片识别设置里的专用 `ocr.*` → 「图片识别」用途的默认模型。
 * 返回 null 表示没有可用的视觉通道，此时直接走系统 OCR。
 */
export function visionEndpoint(): { baseUrl: string; apiKey: string; model: string } | null {
  const { ocr, ai } = useSettingsStore.getState()
  // 1) 识别专用的独立配置（用户可能想用便宜的小模型专门看图）
  const ocrBaseUrl = ocr.baseUrl.trim()
  const ocrModel = ocr.model.trim()
  if (ocrBaseUrl && ocrModel) {
    return { baseUrl: ocrBaseUrl, apiKey: ocr.apiKey, model: ocrModel }
  }

  // 2) 多模型配置里「图片识别」用途的默认模型；未配置时退化为对话模型
  const resolved = resolveModelWithFallback(ai, 'vision')
  if (!isModelReady(resolved)) return null
  return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.modelName }
}

/** 图片识别总开关 */
export function recognitionEnabled(): boolean {
  return Boolean(useSettingsStore.getState().imageMethod?.enabled)
}

export async function recognizeImage(options: RecognizeOptions): Promise<ImageRecognitionResult> {
  const settings = useSettingsStore.getState()
  const t = (key: string) => translate(settings.locale, key)
  const prompt = options.prompt?.trim() || DEFAULT_PROMPT
  const endpoint = visionEndpoint()
  let vlmError: string | null = null

  // 1) 视觉模型
  if (endpoint && (options.dataBase64 || options.path)) {
    options.onStage?.('vlm')
    try {
      const result = await rpc.aiVision({
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        prompt,
        maxTokens: options.maxTokens,
        // base64 在手时不用后端再读盘
        imagePath: options.dataBase64 ? undefined : options.path,
        imageBase64: options.dataBase64,
        mime: options.mime,
      })
      const content = result.text.trim()
      if (content) return { content, desc: content, method: 'vlm', error: null }
      vlmError = t('shot.recognizeEmpty')
    } catch (error) {
      vlmError = messageOf(error)
      console.warn('[image] 视觉模型识别失败，回退系统 OCR', error)
    }
  }

  // 2) 系统 OCR
  if (!options.path && !options.dataBase64) {
    return { content: '', desc: t('shot.recognizeFailed'), method: 'none', error: vlmError ?? '缺少图片内容' }
  }
  options.onStage?.('ocr')
  try {
    const result = await rpc.ocrRun({
      path: options.path,
      imageBase64: options.dataBase64,
      mime: options.mime,
    })
    const content = result.text.trim()
    if (content) return { content, desc: content, method: 'ocr', error: null }
    return { content: '', desc: vlmError ?? t('shot.recognizeEmpty'), method: 'ocr', error: vlmError }
  } catch (error) {
    console.warn('[image] 系统 OCR 失败', error)
    const ocrError = messageOf(error)
    return {
      content: '',
      desc: t('shot.recognizeFailed'),
      method: 'none',
      error: [vlmError, ocrError].filter(Boolean).join(' · '),
    }
  }
}
