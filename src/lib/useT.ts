import { useCallback } from 'react'

import { translate } from './i18n'
import { useSettingsStore } from '@/stores/settings'

/**
 * 文案钩子：切换语言后所有使用方自动重渲染
 * @returns t(key, params?) 取当前语言的文案
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useSettingsStore((state) => state.locale)
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )
}
