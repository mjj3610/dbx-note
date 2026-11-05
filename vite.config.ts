import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 版本号从 package.json 读，构建时注入，避免和清单漂移 */
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/**
 * 构建配置说明：
 * - base 使用相对路径 './'
 * - 产物输出到 ui/，与 manifest.json 中 entrypoints.ui.root = "ui" 保持一致
 * - 必须打成**单文件** bundle：DBX 宿主把插件页面注入沙箱 iframe
 *   （sandbox="allow-scripts"，CSP `default-src 'none'; script-src 'unsafe-inline' blob:`），
 *   宿主只会把 <script src> 与样式表**内联**进文档，无法加载额外的 chunk，
 *   一旦拆包就会白屏。因此关闭代码分割、预加载与 CSS 拆分。
 */
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'ui',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8192,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
