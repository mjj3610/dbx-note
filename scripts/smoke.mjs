#!/usr/bin/env node
/**
 * 界面冒烟测试：打开开发宿主，走一遍「新建笔记 → 输入 → 自动保存 → 记录 → 设置」
 * 并输出截图到 screenshots/。
 *
 * 运行：node scripts/smoke.mjs [--port 5195]
 */
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 5195
const SHOTS = join(ROOT, 'screenshots')
mkdirSync(SHOTS, { recursive: true })

const errors = []
let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 复用本机已安装的 Chromium（与 playwright-core 版本无关）
const CHROMIUM = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1140', 'chrome-win', 'chrome.exe')
const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })

page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
// 启动链路要读设置、探活 Sidecar、扫工作区并恢复标签，冷启动可能要几秒；
// 显式等外壳出现，别用固定 1.2s 猜（bundle 变大后在慢机器上会误报）
await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 })

check('应用外壳已渲染', await page.locator('header').first().isVisible())
check('左侧栏页签存在', (await page.getByRole('button', { name: '文件' }).count()) > 0)
await page.screenshot({ path: join(SHOTS, '01-empty.png') })

// 新建笔记
await page.getByRole('button', { name: '新建笔记' }).first().click()
const nameInput = page.locator('input[placeholder="输入名称"]')
await nameInput.waitFor({ state: 'visible', timeout: 4000 })
const noteName = `冒烟笔记-${Date.now().toString().slice(-6)}`
await nameInput.fill(noteName)
await nameInput.press('Enter')
await page.waitForTimeout(1200)

check('新建后进入编辑态', (await page.locator('.ProseMirror').count()) > 0)
await page.locator('.ProseMirror').click()
await page.keyboard.type('这是 DBX 笔记插件的冒烟测试内容。')
await page.waitForTimeout(400)
await page.keyboard.press('Enter')
await page.keyboard.type('## 二级标题')
await page.keyboard.press('Enter')
await page.keyboard.type('- 列表项 A')
await page.waitForTimeout(1600)

// 追加 H1~H6：大纲索引与「全级别点击定位」的回归数据。
// 连按两次 Enter 退出任务列表，确保 # 输入规则在普通段落里生效。
await page.locator('.ProseMirror').press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.press('Enter')
for (const [level, label] of [
  [1, '一级标题'],
  [2, '二级标题B'],
  [3, '三级标题'],
  [4, '四级标题'],
  [5, '五级标题'],
  [6, '六级标题'],
]) {
  await page.keyboard.type(`${'#'.repeat(level)} ${label}`)
  await page.keyboard.press('Enter')
}
await page.waitForTimeout(1600)

// 校验磁盘落盘
const workspaceDir = join(ROOT, '.tmp', 'dev-data', 'workspace')
const filePath = join(workspaceDir, `${noteName}.md`)
check('笔记文件已写入工作区', existsSync(filePath), filePath)
if (existsSync(filePath)) {
  const content = readFileSync(filePath, 'utf8')
  check('正文内容已保存', content.includes('冒烟测试内容'), content.slice(0, 60))
  check('Markdown 标题已保存', content.includes('## 二级标题'), content)
}

await page.screenshot({ path: join(SHOTS, '02-editor.png') })

// 记录面板
await page.getByRole('button', { name: '记录' }).click()
await page.waitForTimeout(500)
const composer = page.locator('textarea').first()
await composer.fill('记录一条：明天整理插件文档')
await page.getByRole('button', { name: '记录', exact: true }).last().click()
await page.waitForTimeout(900)
check('记录已创建', (await page.locator('text=明天整理插件文档').count()) > 0)
await page.screenshot({ path: join(SHOTS, '03-records.png') })

// 大纲：底栏也有同名「大纲」按钮，这里显式限定到左侧栏页签，避免 strict mode 歧义
await page.locator('.sidebar-tabs').getByRole('button', { name: '大纲' }).click()
await page.waitForTimeout(400)
const outlinePanel = page.locator('[data-outline-panel]').first()
check('大纲识别标题', (await page.locator('text=二级标题').count()) > 0)
check('大纲走编辑器标题索引', (await page.locator('[data-outline-panel][data-outline-source="editor"]').count()) >= 1)
for (const level of [1, 2, 3, 4, 5, 6]) {
  check(`大纲包含 ${level} 级标题`, (await page.locator(`[data-outline-level="${level}"]`).count()) >= 1)
}
// 全级别快速定位：点击后选区必须落在对应层级的标题节点里。
// 旧实现按「标题文本」精确匹配，二~六级标题常因 inline 语法 / 重复文本而失配。
for (const [level, label, tag] of [
  [1, '一级标题', 'H1'],
  [2, '二级标题B', 'H2'],
  [3, '三级标题', 'H3'],
  [4, '四级标题', 'H4'],
  [5, '五级标题', 'H5'],
  [6, '六级标题', 'H6'],
]) {
  await outlinePanel.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(320)
  const hit = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode
    const element = node instanceof HTMLElement ? node : node?.parentElement
    const heading = element?.closest('h1,h2,h3,h4,h5,h6')
    return heading ? { tag: heading.tagName, text: heading.textContent?.trim() ?? '' } : null
  })
  check(`点击 ${level} 级大纲可定位`, hit?.tag === tag && hit.text === label, JSON.stringify(hit))
}
check('编辑器底栏可见', await page.locator('[data-editor-footer]').isVisible())

// 0.5.9 知识图谱：点第 5 个页签后图谱占中间大区，编辑器只 hidden 不卸载
await page.locator('.sidebar-tabs').getByRole('button', { name: '图谱' }).click()
await page.waitForTimeout(900)
check('图谱页签切换到中间大区', await page.locator('[data-graph-workspace]').isVisible())
check('图谱侧栏控制器可见', await page.locator('[data-graph-control]').isVisible())
check('图谱知识块详情区常驻', await page.locator('[data-graph-detail]').isVisible())
check('图谱画布或空态已渲染',
  (await page.locator('[data-graph-canvas]').count()) + (await page.locator('[data-graph-empty]').count()) >= 1)
check('切换图谱时编辑器保持挂载',
  (await page.locator('[data-editor-keep-alive]').count()) === 1
    && (await page.locator('[data-editor-keep-alive] .ProseMirror').count()) >= 1)
check('图谱粒度切换可用',
  (await page.locator('[data-graph-granularity="source"]').count()) === 1
    && (await page.locator('[data-graph-granularity="chunk"]').count()) === 1)
await page.locator('[data-graph-granularity="chunk"]').click()
await page.waitForTimeout(500)
check('图谱切到知识块粒度后仍正常',
  (await page.locator('[data-graph-granularity="chunk"]').getAttribute('aria-pressed')) === 'true')
await page.locator('[data-graph-granularity="source"]').click()
await page.waitForTimeout(400)
await page.locator('[data-graph-refresh]').click()
await page.waitForTimeout(600)
check('图谱手动刷新不报错', (await page.locator('[data-graph-error]').count()) === 0)
await page.locator('.sidebar-tabs').getByRole('button', { name: '文件' }).click()
await page.waitForTimeout(500)
check('切回文件页签后编辑器内容仍在',
  await page.locator('.ProseMirror').isVisible()
    && (await page.locator('.ProseMirror').innerText()).includes('冒烟测试内容'))

// 设置
await page.getByRole('button', { name: '设置' }).click()
await page.waitForTimeout(600)
check('设置弹窗打开', (await page.locator('text=界面语言').count()) > 0)
await page.screenshot({ path: join(SHOTS, '04-settings.png') })

// 关闭设置
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

// 暗色：先归一到浅色（主题会持久化，避免上次运行残留影响断言），再切深色验证令牌生效
const themeButton = page.getByRole('button', { name: '外观' })
const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
if (await isDark()) {
  await themeButton.click()
  await page.waitForTimeout(400)
}
await themeButton.click()
await page.waitForTimeout(600)
const darkApplied = await page.evaluate(
  () => document.documentElement.classList.contains('dark')
    && getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)',
)
check('切换深色主题生效', darkApplied)
await page.screenshot({ path: join(SHOTS, '05-dark.png') })
await themeButton.click()
await page.waitForTimeout(400)

check('控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
