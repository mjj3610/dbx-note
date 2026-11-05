#!/usr/bin/env node
/**
 * 8.40 专项探针：表格工具栏提示 / 搜索替换 / 提示块 / 快捷键补齐
 *
 * 前置：node scripts/devhost.mjs --port 5196 --data .tmp/e2e-data（已构建 ui/）
 * 运行：node scripts/ui-probe-840.mjs
 */
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROMIUM = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1140', 'chrome-win', 'chrome.exe')
const WORKSPACE = join(ROOT, '.tmp', 'e2e-data', 'workspace')

let passed = 0
let failed = 0
const errors = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (error) => errors.push(error.message))
await page.goto('http://127.0.0.1:5196/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

// 清空标签，重新打开「周会纪要」，并保证停在可视化模式
await page.keyboard.press('Control+Shift+W')
await page.waitForTimeout(500)
await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(900)
if ((await page.locator('.ProseMirror').count()) === 0) {
  const toVisual = page.getByRole('button', { name: '可视化' })
  if ((await toVisual.count()) > 0) {
    await toVisual.click()
    await page.waitForTimeout(900)
  }
}

/* ---------- A. 表格浮动工具栏：提示朝上 + 带箭头 + portal 到 body ---------- */

const proseMirror = page.locator('.ProseMirror')
await proseMirror.click()
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)

// Ctrl+Alt+T 插入表格（本轮新增的快捷键）
await page.keyboard.press('Control+Alt+KeyT')
await page.waitForTimeout(700)
check('Ctrl+Alt+T 插入表格', (await page.locator('.ProseMirror table').count()) > 0)

// 光标已在表格里，浮层应出现
await page.waitForTimeout(400)
const bar = page.locator('[data-table-toolbar]')
check('表格浮动栏出现', (await bar.count()) === 1)
check(
  '浮动栏挂在 body 上（不被单元格裁切）',
  await page.evaluate(() => {
    const el = document.querySelector('[data-table-toolbar]')
    return Boolean(el && el.parentElement === document.body && getComputedStyle(el).position === 'fixed')
  }),
)
const actions = await page.locator('[data-table-toolbar] [data-table-action]').evaluateAll((nodes) =>
  nodes.map((node) => node.getAttribute('data-table-action')),
)
check(
  '按钮覆盖 行 / 列 / 对齐 / 删表',
  ['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter', 'deleteColumn', 'alignLeft', 'alignCenter', 'alignRight', 'deleteTable'].every((key) => actions.includes(key)),
  actions.join(','),
)

// 对齐高亮：默认 left 高亮，点 center 后高亮转移
const pressed = async (key) =>
  page.locator(`[data-table-toolbar] [data-table-action="${key}"]`).getAttribute('aria-pressed')
check('默认左对齐高亮', (await pressed('alignLeft')) === 'true')
await page.locator('[data-table-toolbar] [data-table-action="alignCenter"]').click()
await page.waitForTimeout(500)
check('点居中后高亮转移', (await pressed('alignCenter')) === 'true' && (await pressed('alignLeft')) === 'false')

// Tooltip：默认朝上、带小箭头、不压住表头
// 先把鼠标挪开——点击后指针正停在按钮上，不会再触发 pointerenter
await page.mouse.move(10, 10)
await page.waitForTimeout(200)
const centerBox = await page.locator('[data-table-toolbar] [data-table-action="alignCenter"]').boundingBox()
await page.mouse.move(centerBox.x + centerBox.width / 2, centerBox.y + centerBox.height / 2, { steps: 6 })
await page.waitForTimeout(700)
const tip = page.locator('[role="tooltip"]')
check('提示出现', (await tip.count()) === 1)
const tipInfo = await page.evaluate(() => {
  const el = document.querySelector('[role="tooltip"]')
  if (!el) return null
  const box = el.getBoundingClientRect()
  const btn = document.querySelector('[data-table-toolbar] [data-table-action="alignCenter"]').getBoundingClientRect()
  const table = document.querySelector('.ProseMirror table').getBoundingClientRect()
  return {
    side: el.getAttribute('data-side'),
    arrow: Boolean(el.querySelector('svg')),
    aboveButton: box.bottom <= btn.top + 1,
    aboveTable: box.bottom <= table.top + 1,
    height: Math.round(box.height),
  }
})
check('提示在按钮上方（side=top）', tipInfo?.side === 'top', JSON.stringify(tipInfo))
check('提示带箭头', tipInfo?.arrow === true)
check('提示不再压在表头上', tipInfo?.aboveTable === true, JSON.stringify(tipInfo))

/* ---------- B. 搜索替换（Ctrl+F） ---------- */

await proseMirror.click()
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.keyboard.type('alpha beta alpha gamma ALPHA')
await page.waitForTimeout(500)

await page.keyboard.press('Control+f')
await page.waitForTimeout(500)
const panel = page.locator('[data-search-panel]')
check('Ctrl+F 打开搜索面板', (await panel.count()) === 1)

const searchInput = panel.locator('input').first()
await searchInput.fill('alpha')
await page.waitForTimeout(600)
check('命中 3 处（不区分大小写）', (await panel.locator('text=1/3').count()) === 1)
check(
  '正文出现 3 处高亮',
  (await page.locator('.ProseMirror .dbx-search-hit').count()) === 3,
  String(await page.locator('.ProseMirror .dbx-search-hit').count()),
)
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
check('回车跳到下一个命中', (await panel.locator('text=2/3').count()) === 1)

// 区分大小写 → 只剩 2 处
await panel.locator('button[aria-pressed]').first().click()
await page.waitForTimeout(600)
check('区分大小写后命中 2 处', (await panel.locator('text=1/2').count()) === 1)

// 再切回不区分，避免影响后面的替换断言
await panel.locator('button[aria-pressed]').first().click()
await page.waitForTimeout(600)
check('取消区分大小写后回到 3 处', (await panel.locator('text=1/3').count()) === 1)

// 替换当前 + 全部替换
await panel.locator('input').nth(1).fill('OMEGA')
await panel.getByRole('button', { name: '替换', exact: true }).click()
await page.waitForTimeout(600)
const afterReplace = await proseMirror.innerText()
check('替换当前命中生效', (afterReplace.match(/OMEGA/g) ?? []).length === 1, afterReplace)

await panel.getByRole('button', { name: '全部替换' }).click()
await page.waitForTimeout(700)
const afterAll = await proseMirror.innerText()
check('全部替换后无残留 alpha', !afterAll.toLowerCase().includes('alpha'), afterAll)
check('全部替换后 3 处都是 OMEGA', (afterAll.match(/OMEGA/g) ?? []).length === 3, afterAll)

await page.keyboard.press('Escape')
await page.waitForTimeout(400)
check('Esc 关闭搜索面板', (await panel.count()) === 0)
check('关闭后高亮清空', (await page.locator('.ProseMirror .dbx-search-hit').count()) === 0)

/* ---------- C. 提示块（GitHub Alert） ---------- */

await proseMirror.click()
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)
await page.keyboard.type('/')
await page.waitForTimeout(500)
check('斜杠菜单打开', (await page.locator('[data-slash-menu]').count()) === 1)
await page.keyboard.type('提示块')
await page.waitForTimeout(600)
const alertItem = page.locator('[data-slash-menu] [data-index]').first()
check('斜杠菜单搜到「提示块」', (await alertItem.innerText()).includes('提示块'), await alertItem.innerText())
await alertItem.click()
await page.waitForTimeout(600)
check('插入提示块节点', (await page.locator('.ProseMirror [data-github-alert]').count()) === 1)

await page.keyboard.type('这是一段说明')
await page.waitForTimeout(800)

// 切到源码模式，确认写回 `> [!NOTE]` 引用写法
await page.getByRole('button', { name: '源码' }).click()
await page.waitForTimeout(1200)
const noteFile = join(WORKSPACE, '周会纪要.md')
let source = ''
for (let attempt = 0; attempt < 20; attempt += 1) {
  source = readFileSync(noteFile, 'utf8')
  if (source.includes('[!NOTE]')) break
  await page.waitForTimeout(300)
}
check('提示块写回 `> [!NOTE]`', source.includes('> [!NOTE]') && source.includes('这是一段说明'), source.slice(0, 160))

// 切回可视化：从 Markdown 重新解析，仍是提示块（说明 tokenizer 生效）
await page.getByRole('button', { name: '可视化' }).click()
await page.waitForTimeout(1500)
check('重新解析后仍是提示块', (await page.locator('.ProseMirror [data-github-alert]').count()) === 1)
check(
  '提示块正文保留',
  (await page.locator('.ProseMirror [data-github-alert]').innerText()).includes('这是一段说明'),
)

// 类型可切换（NOTE → WARNING），CSS 类跟着变
await page.locator('.ProseMirror [data-github-alert] select').selectOption('WARNING')
await page.waitForTimeout(700)
check(
  '切换类型后样式类跟随',
  (await page.locator('.ProseMirror .dbx-alert-warning').count()) === 1,
)

/* ---------- D. 快捷键：全部折叠 / 全部展开 ---------- */

await proseMirror.click()
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.keyboard.type('# 一级')
await page.keyboard.press('Enter')
await page.keyboard.type('正文一')
await page.keyboard.press('Enter')
await page.keyboard.type('## 二级')
await page.keyboard.press('Enter')
await page.keyboard.type('正文二')
await page.waitForTimeout(500)
const foldedCount = () => page.locator('.ProseMirror [data-folded-heading="true"]').count()
await page.keyboard.press('Control+Alt+ArrowDown')
await page.waitForTimeout(500)
check('全部展开后没有折叠标记', (await foldedCount()) === 0)
await page.keyboard.press('Control+Alt+ArrowUp')
await page.waitForTimeout(500)
check('Ctrl+Alt+↑ 全部折叠', (await foldedCount()) === 2, String(await foldedCount()))

// 还原文档，避免污染测试数据
await page.keyboard.press('Control+Alt+ArrowDown')
await page.waitForTimeout(300)
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)
await page.keyboard.type('本周完成')
await page.keyboard.press('Control+s')
await page.waitForTimeout(600)

/* ---------- 汇总 ---------- */

check('无运行时异常', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n通过 ${passed}，失败 ${failed}`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
