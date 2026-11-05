import { useEffect, useState } from 'react'

/**
 * 媒体查询订阅（宿主是 iframe，窗口尺寸变化会直接反映到 matchMedia）
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const list = window.matchMedia(query)
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(list.matches)
    list.addEventListener('change', handler)
    return () => list.removeEventListener('change', handler)
  }, [query])

  return matches
}

/** 窄屏（手机 / 分屏小窗）判定：与 NoteGen 的移动端断点一致 */
export function useIsNarrow(): boolean {
  return useMediaQuery('(max-width: 860px)')
}
