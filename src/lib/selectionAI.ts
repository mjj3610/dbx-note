/**
 * 选中文字的 AI 动作（对齐 NoteGen 气泡工具条的 AI 菜单）
 *
 * 四类动作：润色 / 精简 / 扩展 / 翻译，提示词与参考实现保持一致
 * （「语言不变、直接返回结果」这类约束必须带上，否则模型会附赠解释）。
 */
import type { AiMessage } from '@/lib/rpc'

export type SelectionAIAction = 'polish' | 'concise' | 'expand' | 'translate'

/** 翻译子菜单里的常用语言（顺序与参考实现一致） */
export const TRANSLATE_LANGUAGES = [
  { code: 'en', key: 'english' },
  { code: 'ja', key: 'japanese' },
  { code: 'ko', key: 'korean' },
  { code: 'fr', key: 'french' },
  { code: 'de', key: 'german' },
  { code: 'es', key: 'spanish' },
  { code: 'pt', key: 'portuguese' },
  { code: 'ru', key: 'russian' },
] as const

/** 语言展示名（提示词里直接用它，模型对中文/英文语言名都能识别） */
const LANGUAGE_LABEL: Record<string, { zh: string; en: string }> = {
  english: { zh: '英语', en: 'English' },
  japanese: { zh: '日语', en: 'Japanese' },
  korean: { zh: '韩语', en: 'Korean' },
  french: { zh: '法语', en: 'French' },
  german: { zh: '德语', en: 'German' },
  spanish: { zh: '西班牙语', en: 'Spanish' },
  portuguese: { zh: '葡萄牙语', en: 'Portuguese' },
  russian: { zh: '俄语', en: 'Russian' },
}

export function languageLabel(key: string, zh: boolean): string {
  return LANGUAGE_LABEL[key]?.[zh ? 'zh' : 'en'] ?? key
}

const SYSTEM_PROMPT: Record<'zh' | 'en', string> = {
  zh: '你是文本编辑助手。只输出处理后的正文，不要解释、不要加引号或代码块。',
  en: 'You are a text-editing assistant. Return only the processed text, with no explanation, quotes or code fences.',
}

/** 组装一次选区 AI 请求 */
export function buildSelectionMessages(
  action: SelectionAIAction,
  text: string,
  options: { zh: boolean; language?: string },
): AiMessage[] {
  const { zh, language = '' } = options
  const body = text.trim()
  let user: string

  if (zh) {
    switch (action) {
      case 'polish':
        user = `润色这段文字：\n${body}\n要求语言不变，修复错别字和病句，直接返回润色后的结果。`
        break
      case 'concise':
        user = `精简这段文字：\n${body}\n这段文字过于臃肿，字数要求缩减一半以上，要求语言不变，直接返回优化后的结果。`
        break
      case 'expand':
        user = `扩写这段文字：\n${body}\n这段文字过于简短，字数要求增加一倍以上，要求语言不变，直接返回扩写后的结果。`
        break
      default:
        user = `将这段文字：\n${body}\n翻译为${language}语言，直接返回翻译后的结果。`
    }
  } else {
    switch (action) {
      case 'polish':
        user = `Polish the following text:\n${body}\nKeep the original language, fix typos and awkward sentences, and return only the polished result.`
        break
      case 'concise':
        user = `Condense the following text:\n${body}\nIt is too verbose — cut it by at least half, keep the original language, and return only the result.`
        break
      case 'expand':
        user = `Expand the following text:\n${body}\nIt is too short — at least double the length, keep the original language, and return only the result.`
        break
      default:
        user = `Translate the following text into ${language}:\n${body}\nReturn only the translation.`
    }
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT[zh ? 'zh' : 'en'] },
    { role: 'user', content: user },
  ]
}
