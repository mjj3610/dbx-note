/**
 * 网络搜索配置的可用性判断
 *
 * 对话请求里是否要带上搜索能力、以及 API Key 是否齐备，都从这里统一判断，
 * 避免设置页与对话面板各写一套判断逻辑。
 */
import type { WebSearchSettings } from '@/stores/settings'

export type WebSearchProvider = WebSearchSettings['provider']

export const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = ['tavily', 'brave', 'exa', 'zhipu']

/** 第三方搜索各家的申请地址（设置页给出跳转提示用） */
export const WEB_SEARCH_KEY_URLS: Record<WebSearchProvider, string> = {
  tavily: 'https://app.tavily.com/home',
  brave: 'https://brave.com/search/api/',
  exa: 'https://dashboard.exa.ai/api-keys',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
}

/**
 * 当前配置能否真正发起搜索
 *
 * - 总开关关闭 → false
 * - 只有原生搜索（由模型自己联网）→ true，无需 Key
 * - 启用第三方搜索 → 必须有 Key
 */
export function currentWebSearch(settings: WebSearchSettings): boolean {
  if (!settings.enabled) return false
  if (settings.nativeEnabled && !settings.thirdPartyEnabled) return true
  if (!settings.thirdPartyEnabled) return false
  return settings.apiKey.trim().length > 0
}
