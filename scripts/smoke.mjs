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
await page.waitForTimeout(1200)

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

// 大纲
await page.getByRole('button', { name: '大纲' }).click()
await page.waitForTimeout(400)
check('大纲识别标题', (await page.locator('text=二级标题').count()) > 0)

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
