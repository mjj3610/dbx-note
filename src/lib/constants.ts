/** 应用常量：版本号与外部链接 */
// 构建时由 Vite 注入（见 vite.config.ts 的 define），运行时兜底 '0.0.0'
declare const __APP_VERSION__: string
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
export const APP_ID = 'com.mjj3610.note'
export const APP_HOMEPAGE = 'https://github.com/mjj3610/dbx-note'

/** 温度滑块范围 */
export const TEMPERATURE_RANGE = { min: 0, max: 1.5, step: 0.1 }
/** 编辑器字号范围 */
export const FONT_SIZE_RANGE = { min: 13, max: 20, step: 1 }
/** 正文宽度范围（像素） */
export const EDITOR_WIDTH_RANGE = { min: 560, max: 1200, step: 20 }
