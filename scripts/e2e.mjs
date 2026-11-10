#!/usr/bin/env node
/**
 * 端到端测试（在开发宿主 + 真实 Sidecar + 假模型服务下运行）
 *
 * 覆盖：搜索、重命名、删除确认、源码模式、AI 流式对话、插入到笔记、语言切换、目录选择器。
 *
 * 前置：
 *   DBX_NOTE_SCREENSHOT_MODE=plugin DBX_NOTE_SHOT_HOTKEY=Ctrl+Alt+F9 \
 *     DBX_NOTE_SCREENSHOT_AUTO=40,40,600,300,900 DBX_NOTE_SCREENSHOT_AUTO_EXIT=record \
 *     node scripts/devhost.mjs --port 5196 --data .tmp/e2e-data
 *   node scripts/mock-ai.mjs --port 5199
 * 运行：node scripts/e2e.mjs
 *
 * 环境变量说明：
 * - `plugin` 让 screenshot/select 跳过「桌面全屏框选窗口」，交给插件浮层框选（自动化没法拉鼠标）；
 * - `DBX_NOTE_SHOT_HOTKEY=Ctrl+Alt+F9`：只注册这个冷门组合——既不抢开发机的常用热键，
 *   又让「全局热键 → 原生窗口 → 就地标注 → 出口」这条链路可以真实触发；
 * - `DBX_NOTE_SCREENSHOT_AUTO`：原生框选窗口到点自动松手；
 * - `DBX_NOTE_SCREENSHOT_AUTO_EXIT`：自动点一个出口（record / insert / copy）。全局截图是
 *   **原地标注**，松手后窗口会等人点出口，自动化必须给一个，否则这条用例只能按 Esc 收掉。
 *   锁屏 / 远程会话里注入按键会被系统丢掉，此时用例自动改用 `screenshot/globalShot`
 *   跑同一条链路（同样受这几个环境变量约束）。
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const CHROMIUM = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1140', 'chrome-win', 'chrome.exe')
const SHOTS = join(ROOT, 'screenshots')
const WORKSPACE = join(ROOT, '.tmp', 'e2e-data', 'workspace')
const DATA_DIR = join(ROOT, '.tmp', 'e2e-data')
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
const errors = []
const badResponses = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 删除目录：回收站二进制对大目录（.git 上千小文件）过慢或卡死时，
 * 改名挪到 .tmp/stale 保证测试可以继续（stale 目录留给人工清理，避免再次触发卡死）。
 */
function rmDirRobust(target) {
  if (!existsSync(target)) return
  // 直接改名挪走：WorkBuddy 的 safe-delete shim 对含上千小文件的 .git 目录会先等
  // genie-trash 超时再抛错，rmSync → catch 的老写法每轮都要白等几十秒。
  const aside = join(ROOT, '.tmp', 'stale', `${basename(target)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dirname(aside), { recursive: true })
  try {
    renameSync(target, aside)
  } catch {
    rmSync(target, { recursive: true, force: true })
  }
}

/**
 * 生成一张纯色 PNG。
 *
 * 之前这里用的是 1×1 的 base64 图，结果「点击图片弹出图片设置」这条用例有一半概率失败：
 * Playwright 点击元素中心，1×1 的中心点经亚像素取整后有一半落在图片外，
 * 事件目标是段落而不是 <img>，面板自然不弹。图必须要有真实点击面积。
 */
function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }
  const table = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 直接写文件，模拟已有工作区 */
function seedWorkspace() {
  // 只清理 Markdown 文件，避免删除被宿主占用的目录
  mkdirSync(join(WORKSPACE, '项目'), { recursive: true })
  for (const dir of [WORKSPACE, join(WORKSPACE, '项目')]) {
    const aside = join(ROOT, '.tmp', 'stale', `seed-${basename(dir)}-${Date.now()}`)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      // 不直接 unlink：批量删除保护会在 genie-trash 上超时；改名挪走后下面重新 seed 同名文件
      mkdirSync(aside, { recursive: true })
      renameSync(join(dir, name), join(aside, name))
    }
  }
  // 清掉上一轮的 Git 仓库与画布，保证「初始化仓库」「新建画布」每次都从零开始
  rmDirRobust(join(WORKSPACE, '.git'))
  rmDirRobust(join(WORKSPACE, 'canvases'))
  const note = ['# 周会纪要', '', '本周完成插件骨架，下周补充测试。', '', '## 待办', '', '- [ ] 补齐 e2e', ''].join('\n')
  writeFileSync(join(WORKSPACE, '周会纪要.md'), note)
  writeFileSync(join(WORKSPACE, '项目', '规划.md'), '# 规划\n\n- 记录\n- 整理\n')
  // 图片设置面板用例的载体：一张无尺寸的本地图
  writeFileSync(join(WORKSPACE, '图片笔记.md'), '# 图片笔记\n\n![示意图](assets/示意图.png)\n')
  // 公式往返用例：模拟「远端同步下来、本地从未编辑过」的 .md 文件，
  // 直接以原始 $...$ / $$...$$ 落盘，用来验证打开时不会被 Markdown 解析器吃掉
  writeFileSync(
    join(WORKSPACE, '公式往返.md'),
    [
      '# 公式往返',
      '',
      '行内：$E = mc^2$ 与 $\\frac{a}{b}$。',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
      '',
    ].join('\n'),
  )
  // 1x1 PNG：验证图片预览链路（Sidecar 读成 data URL 再交给 img）
  mkdirSync(join(WORKSPACE, 'assets'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'assets', '示意图.png'), makePng(160, 120, [0x2f, 0x6f, 0xd8]))
}
seedWorkspace()

/**
 * 上一轮 e2e 末尾会把图床切到 PicGo 并写进 app.settings；复用同一数据目录时，
 * 画布插图会去连 36677（本机没起 PicGo）而整条链路失败。启动前归一到 local，
 * 保证每次回归从干净状态开始，且不影响后面「切到 PicGo 图床生效」那条用例。
 */
async function resetImageHosting() {
  const call = async (method, params) => {
    const response = await fetch('http://127.0.0.1:5196/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    const payload = await response.json()
    if (payload.error) throw new Error(payload.error.message)
    return payload.result
  }
  const stored = await call('settings/get', { key: 'app.settings' })
  const settings = stored?.value
  if (!settings || typeof settings !== 'object' || settings.imageHosting?.provider === 'local') return
  settings.imageHosting = { ...(settings.imageHosting ?? {}), provider: 'local' }
  await call('settings/set', { key: 'app.settings', value: settings })
  console.log('  （已把上轮残留的图床设置归一为 local）')
}
await resetImageHosting()

const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))
page.on('response', (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
})

await page.goto('http://127.0.0.1:5196/', { waitUntil: 'networkidle' })
// 冷启动要读设置 / 探活 Sidecar / 扫工作区 / 恢复标签，显式等外壳可见再开始断言
await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(300)

/**
 * 顶栏「设置」按钮。
 * 设置弹窗内的导航项名字都含「设置」（记录设置 / 编辑器设置 / 画布设置 / 语音设置），
 * 用子串匹配会命中多个元素；必须精确匹配才唯一。
 */
const settingsButton = () => page.getByRole('button', { name: '设置', exact: true })

/** 关闭设置弹窗：焦点在原生 select 上时 Esc 会被它吃掉，先失焦再按 */
async function closeSettings() {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

// 已有文件应出现在树中
check('工作区文件已加载', (await page.locator('text=周会纪要').count()) > 0)

// 标签记忆会把上次运行的标签带回来，先清空保证起点干净（同时覆盖「关闭全部」）
const tabList = page.getByRole('tablist', { name: '打开的标签' })
await page.keyboard.press('Control+Shift+W')
await page.waitForTimeout(600)
check('关闭全部标签回到空态', (await tabList.getByRole('tab').count()) === 0)

await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(700)
// 编辑器模式会落盘，上一次运行可能停在源码视图，先切回可视化保证起点一致
if ((await page.locator('.ProseMirror').count()) === 0) {
  const toVisual = page.getByRole('button', { name: '可视化' })
  if ((await toVisual.count()) > 0) {
    await toVisual.click()
    await page.waitForTimeout(800)
  }
}
check('打开笔记显示正文', (await page.locator('.ProseMirror').innerText()).includes('本周完成'))

// 多标签：打开第二篇 → 两个标签 → 切换 → Ctrl+W 关闭
check('打开文件生成标签', (await tabList.getByRole('tab').count()) === 1)
// 用文件树的数据钩子做确定性展开，别靠 400ms 猜状态或宽泛的 text= 匹配。
// 冷启动时第一次点击可能被初始化流程吃掉，轮询到真的开出第二个标签为止。
const projectNode = page.locator('[data-tree-node="项目"]')
const planNode = page.locator('[data-tree-node="项目/规划.md"]')
for (let attempt = 0; attempt < 6 && (await tabList.getByRole('tab').count()) < 2; attempt += 1) {
  if ((await planNode.count()) === 0) await projectNode.first().click()
  await planNode.first().waitFor({ state: 'visible', timeout: 15_000 })
  await planNode.first().click()
  // 编辑器内容会先切过去、标签元素可能晚一拍才挂载；固定 700ms 在冷启动 / 高负载下不够。
  // 这里轮询等标签真正出现，否则后续重复点同一文件会被 open() 的 activePath 短路。
  for (let tick = 0; tick < 20 && (await tabList.getByRole('tab').count()) < 2; tick += 1) {
    await page.waitForTimeout(200)
  }
}
await page.waitForTimeout(300)
check('第二个文件追加标签', (await tabList.getByRole('tab').count()) === 2)
await tabList.getByRole('tab', { name: /周会纪要/ }).click()
// 切标签要读盘 + 重渲染编辑器，慢机器上 700ms 不够，轮询等正文回来
let restoredText = ''
for (let attempt = 0; attempt < 24; attempt += 1) {
  restoredText = await page.locator('.ProseMirror').innerText().catch(() => '')
  if (restoredText.includes('本周完成')) break
  await page.waitForTimeout(400)
}
check('切换标签恢复上一篇正文', restoredText.includes('本周完成'))
await page.screenshot({ path: join(SHOTS, '14-tabs.png') })
await page.keyboard.press('Control+w')
// 回归「关一个 tab 时其它 tab 先全部消失、过一会才回来」：
// 在接管邻居的整段异步窗口里，标签栏必须一直挂载且不能闪出空状态。
let tabFlicker = false
for (let attempt = 0; attempt < 8; attempt += 1) {
  const visibleTabs = await tabList.getByRole('tab').count()
  const emptyState = await page.locator('text=选择一篇笔记开始编辑').count()
  if (visibleTabs === 0 || emptyState > 0) tabFlicker = true
  await page.waitForTimeout(60)
}
check('关闭标签过程中其它 tab 不闪退', !tabFlicker)
// 关标签要写盘 + 重渲染，固定 800ms 在慢机器上不够；轮询到标签数稳定为 1
let tabsAfterClose = 0
for (let attempt = 0; attempt < 25; attempt += 1) {
  tabsAfterClose = await tabList.getByRole('tab').count()
  if (tabsAfterClose === 1) break
  await page.waitForTimeout(200)
}
check('Ctrl+W 关闭当前标签', tabsAfterClose === 1)
check('关闭后自动接管剩余标签', (await page.locator('.ProseMirror').innerText()).includes('记录'))

// 切换标签不丢改动：当前是「规划」，输入后切到「周会纪要」再切回
await page.locator('.ProseMirror').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('切换标签前的输入。')
await page.waitForTimeout(300)
await page.locator('text=周会纪要').first().click()
let reopenedTabs = 0
for (let attempt = 0; attempt < 25; attempt += 1) {
  reopenedTabs = await tabList.getByRole('tab').count()
  if (reopenedTabs === 2) break
  await page.waitForTimeout(200)
}
check('再次打开文件生成新标签', reopenedTabs === 2)
await tabList.locator('[data-tab-path="项目/规划.md"]').click()
let preservedText = ''
for (let attempt = 0; attempt < 25; attempt += 1) {
  preservedText = await page.locator('.ProseMirror').innerText().catch(() => '')
  if (preservedText.includes('切换标签前的输入')) break
  await page.waitForTimeout(200)
}
check('切回标签保留未保存前的改动', preservedText.includes('切换标签前的输入'))

/* ---------- 图片设置面板（对齐 NoteGen 的 image-bubble-menu） ---------- */

await page.locator('text=图片笔记').first().click()
// 图片经 Sidecar 读成 data URL 后再渲染，显式等 <img> 出现
await page.locator('.ProseMirror img').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
check('图片笔记里渲染出图片', (await page.locator('.ProseMirror img').count()) >= 1)

const imageMenu = page.locator('[data-editor-image-menu]')
// 面板锚定在图片正上方，坐标点击会受滚动/重排影响而落到段落上；
// 直接对 <img> 派发 click，event.target 才是图片，判定条件与真实点击一致。
await page.locator('.ProseMirror img').first().dispatchEvent('click')
await page.waitForTimeout(400)
let imageMenuCount = await imageMenu.count()
if (imageMenuCount === 0) {
  const diag = await page.evaluate(() => ({
    editors: document.querySelectorAll('.ProseMirror').length,
    imgs: [...document.querySelectorAll('.ProseMirror img')].map((img) => {
      const rect = img.getBoundingClientRect()
      return { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) }
    }),
    active: document.activeElement?.className?.toString().slice(0, 60) ?? null,
    menus: document.querySelectorAll('[data-editor-image-menu]').length,
  }))
  console.error('  [诊断] 点击后 400ms 无面板:', JSON.stringify(diag))
  await page.waitForTimeout(1200)
  imageMenuCount = await imageMenu.count()
  console.error('  [诊断] 再等 1.2s 后面板数:', imageMenuCount)
}
check('点击图片弹出「图片设置」', imageMenuCount === 1)
check(
  '面板回填图片地址',
  (await page.locator('#image-src').inputValue()) === 'assets/示意图.png',
  await page.locator('#image-src').inputValue(),
)
await page.locator('#image-alt').fill('示意图')
await page.locator('#image-width').fill('180')
await page.locator('#image-height').fill('120')
await imageMenu.locator('button:has-text("确认")').click()
await page.waitForTimeout(1600)
const sizedNote = readFileSync(join(WORKSPACE, '图片笔记.md'), 'utf8')
check(
  '改宽高后落盘成 <img>',
  sizedNote.includes('width="180"') && sizedNote.includes('height="120"'),
  sizedNote.replace(/\n/g, '⏎'),
)

await page.locator('.ProseMirror img').first().dispatchEvent('click')
await page.waitForTimeout(300)
await page.locator('[data-editor-image-menu] button:has-text("重置尺寸")').click()
await page.waitForTimeout(1600)
check(
  '重置尺寸回到 ![](…)',
  readFileSync(join(WORKSPACE, '图片笔记.md'), 'utf8').includes('![示意图](assets/示意图.png)'),
  readFileSync(join(WORKSPACE, '图片笔记.md'), 'utf8').replace(/\n/g, '⏎'),
)
await page.screenshot({ path: join(SHOTS, '14-image-menu.png') })
// 面板关掉，避免影响后面的用例
await page.locator('.ProseMirror p').first().click().catch(() => undefined)
await page.waitForTimeout(300)
check(
  '切标签前已落盘',
  readFileSync(join(WORKSPACE, '项目', '规划.md'), 'utf8').includes('切换标签前的输入'),
)

// 搜索（快捷键取自「设置 → 快捷键」的默认绑定）
await page.keyboard.press('Control+Shift+F')
await page.waitForTimeout(400)
await page.locator('input[placeholder="搜索文件与内容…"]').fill('规划')
await page.waitForTimeout(900)
check('搜索弹窗有结果', (await page.locator('text=规划').count()) > 0)
await page.screenshot({ path: join(SHOTS, '06-search.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 源码模式
await page.getByRole('button', { name: '源码' }).click()
await page.waitForTimeout(700)
check('源码模式渲染 CodeMirror', (await page.locator('.cm-editor').count()) > 0)
await page.screenshot({ path: join(SHOTS, '07-source.png') })
await page.getByRole('button', { name: '可视化' }).click()
await page.waitForTimeout(500)

// 重命名（右键菜单；目录可能已被前面的标签测试展开）
if ((await page.locator('text=规划').count()) === 0) {
  await page.getByText('项目', { exact: true }).first().click()
  await page.waitForTimeout(400)
}
await page.locator('text=规划').first().click({ button: 'right' })
await page.waitForTimeout(400)
await page.getByRole('menuitem', { name: '重命名' }).click()
const renameInput = page.locator('input[placeholder="输入名称"]')
await renameInput.fill('规划-2026')
await renameInput.press('Enter')
await page.waitForTimeout(900)
check('重命名后磁盘出现新文件', existsSync(join(WORKSPACE, '项目', '规划-2026.md')))

// 配置 AI（通过设置界面）
await settingsButton().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'AI 模型' }).click()
await page.waitForTimeout(300)
// 多厂商多模型：先添加厂商，再填地址与密钥，拉取模型后点选加入列表
// 数据目录跨轮次复用，历史轮次可能已留下厂商卡，因此所有操作都锁在「新加的那张卡」内。
await page.getByRole('button', { name: '添加厂商' }).click()
await page.waitForTimeout(200)
const providerCard = page.locator('[data-provider-card]').last()
await providerCard.locator('input[aria-label="服务地址"]').fill('http://127.0.0.1:5199/v1')
await providerCard.locator('input[aria-label="API Key"]').fill('test-key')
await providerCard.getByRole('button', { name: '测试连接' }).click()
await providerCard
  .locator('button', { hasText: 'mock-note-model' })
  .first()
  .waitFor({ state: 'visible', timeout: 15_000 })
  .catch(() => {})
check(
  '拉取到可选模型',
  (await providerCard.locator('button', { hasText: 'mock-note-model' }).count()) > 0,
)
// 点选模型名加入该厂商的模型列表
await providerCard.locator('button', { hasText: 'mock-note-model' }).first().click()
await page.waitForTimeout(400)
check('厂商卡片模型数变为 1', (await providerCard.locator('[data-model-row]').count()) === 1)
// 默认模型：把「对话与写作」指向刚加入的模型
const chatSelect = page.locator('select[aria-label="对话与写作"]')
const chatOption = await chatSelect.locator('option', { hasText: 'mock-note-model' }).first().getAttribute('value')
check('对话用途出现可选项', Boolean(chatOption))
if (chatOption) await chatSelect.selectOption(chatOption)
await page.waitForTimeout(300)
await page.screenshot({ path: join(SHOTS, '08-settings-ai.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

// 打开笔记并对话
await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(600)
const composer = page.locator('textarea[placeholder*="输入问题"]')
await composer.fill('总结一下这篇笔记')
await composer.press('Enter')
await page.waitForTimeout(400)
check('用户消息已显示', (await page.locator('text=总结一下这篇笔记').count()) > 0)
await page.waitForTimeout(2500)
const assistantText = await page.locator('.markdown-body').last().innerText()
check('流式回复已渲染', assistantText.includes('笔记摘要'), assistantText.slice(0, 60))
check('回复中的列表已渲染', (await page.locator('.markdown-body li').count()) > 0)
await page.screenshot({ path: join(SHOTS, '09-chat.png') })

// 插入到笔记
await page.locator('.markdown-body').last().hover()
await page.getByRole('button', { name: '插入到笔记' }).last().click()
await page.waitForTimeout(1600)
const saved = readFileSync(join(WORKSPACE, '周会纪要.md'), 'utf8')
check('AI 内容已插入并落盘', saved.includes('笔记摘要'), saved.slice(-120))

// 会话落库：刷新后仍能看到历史
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'AI 助手' }).click().catch(() => undefined)

// 记录 → AI 整理成笔记
await page.getByRole('button', { name: '记录' }).click()
await page.waitForTimeout(500)
const recordComposer = page.locator('textarea').first()
await recordComposer.fill('整理测试：完成插件打包与文档')
await page.getByRole('button', { name: '记录', exact: true }).last().click()
await page.waitForTimeout(900)
await page.locator('div.group').first().locator('button').first().click()
await page.waitForTimeout(300)
check('勾选记录后出现操作条', (await page.locator('text=整理成笔记').count()) > 0)
await page.getByRole('button', { name: '整理成笔记' }).click()
await page.waitForTimeout(1000)
// 整理结果落盘是异步的：文件先建出来、正文后写进去，固定 2.5s 可能读到半截内容
const organized = []
for (let attempt = 0; attempt < 24; attempt += 1) {
  organized.length = 0
  organized.push(...readdirSync(WORKSPACE).filter((name) => name.startsWith('记录整理')))
  if (organized.length > 0 && readFileSync(join(WORKSPACE, organized[0]), 'utf8').includes('笔记摘要')) break
  await page.waitForTimeout(350)
}
check('AI 整理了新笔记', organized.length > 0, organized.join(','))
if (organized.length > 0) {
  const content = readFileSync(join(WORKSPACE, organized[0]), 'utf8')
  check('整理后的笔记包含结构化内容', content.includes('笔记摘要'), content.slice(0, 80))
}
await page.screenshot({ path: join(SHOTS, '13-organize.png') })

/* ---------- 记录：搜索 / 待办完成 / 回收站 ---------- */

const recordSearch = page.locator('input[placeholder="搜索记录…"]')
check('记录面板带搜索框', (await recordSearch.count()) === 1)
await recordSearch.fill('不会命中的关键词zzz')
await page.waitForTimeout(700)
check('搜索无结果时列表清空', (await page.locator('[data-record]').count()) === 0)
await recordSearch.fill('整理测试')
await page.waitForTimeout(700)
check('搜索命中目标记录', (await page.locator('[data-record]').count()) >= 1)
await recordSearch.fill('')
await page.waitForTimeout(700)

// 待办记录可以直接勾选完成
await page.getByRole('button', { name: '待办', exact: true }).first().click()
await page.waitForTimeout(300)
await page.locator('textarea').first().fill('勾选这道待办')
await page.getByRole('button', { name: '记录', exact: true }).last().click()
await page.waitForTimeout(1000)
const todoItem = page.locator('[data-record]').filter({ hasText: '勾选这道待办' }).first()
check('待办记录已创建', (await todoItem.count()) === 1)
await todoItem.getByRole('checkbox').click()
await page.waitForTimeout(900)
check('勾选后待办显示完成态', (await todoItem.locator('p.line-through').count()) > 0)
await page.screenshot({ path: join(SHOTS, '38-records-todo-done.png') })

// 回收站：空态 → 返回列表
await page.getByRole('button', { name: '回收站' }).click()
await page.waitForTimeout(900)
check('回收站为空态提示', (await page.getByText('回收站是空的').count()) > 0)
await page.getByRole('button', { name: '返回列表' }).click()
await page.waitForTimeout(900)
check('返回列表后记录回来', (await page.locator('[data-record]').count()) > 0)

// 删除确认（真正删除）
await page.getByRole('button', { name: '文件' }).click()
await page.waitForTimeout(400)
const target = organized[0] ?? '周会纪要.md'
await page.getByText(target.replace(/\.md$/, ''), { exact: true }).first().click({ button: 'right' })
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: '删除' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '删除', exact: true }).last().click()
await page.waitForTimeout(900)
check('确认后文件已从磁盘删除', !existsSync(join(WORKSPACE, target)), target)

// 语言切换
await settingsButton().click()
await page.waitForTimeout(400)
await page.locator('select').selectOption('en')
await page.waitForTimeout(500)
check('切换英文后界面更新', (await page.locator('text=Appearance').count()) > 0)
await page.screenshot({ path: join(SHOTS, '10-english.png') })
await page.locator('select').selectOption('zh-CN')
await page.waitForTimeout(400)
await closeSettings()
check('设置弹窗已关闭', (await page.getByRole('dialog').count()) === 0)
// 目录选择器（设置 → 工作区 → 更换目录）
await settingsButton().click()
await page.waitForTimeout(400)
await page.getByRole('dialog').getByRole('button', { name: '文件管理' }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: '更换目录' }).click()
await page.waitForTimeout(900)
check('目录选择器打开', (await page.locator('text=磁盘').count()) > 0)
await page.screenshot({ path: join(SHOTS, '11-dirpicker.png') })
// 先关目录选择器，再关设置弹窗，避免遮罩挡住后续点击
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
// Radix 的遮罩在焦点丢失时可能不吃 Escape；显式兜底到遮罩真的消失，
// 否则后面的右键点击会被 overlay 拦截并等满 30s 超时
for (let attempt = 0; attempt < 5; attempt += 1) {
  const overlay = page.locator('div[data-state="open"][data-aria-hidden="true"].fixed.inset-0')
  if ((await overlay.count()) === 0) break
  const cancel = page.getByRole('dialog').getByRole('button', { name: /取消|关闭/ }).first()
  if ((await cancel.count()) > 0) await cancel.click({ force: true }).catch(() => {})
  else await overlay.first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(350)
}

// 删除确认
await page.locator('text=周会纪要').first().click({ button: 'right' })
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: '删除' }).click()
await page.waitForTimeout(400)
check('删除确认弹窗出现', (await page.locator('text=此操作无法撤销').count()) > 0)
await page.screenshot({ path: join(SHOTS, '12-delete-confirm.png') })
await page.getByRole('button', { name: '取消' }).click()
await page.waitForTimeout(300)
check('取消后文件仍在', existsSync(join(WORKSPACE, '周会纪要.md')))

// 标签记忆：刷新后恢复上次打开的标签
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(800)
// 刷新恢复标签属于冷启动链路（读设置 → 探活 Sidecar → 扫工作区 → restoreTabs），
// 固定 1.6s 在慢机器上不够；轮询等标签真正挂载
let restoredTabs = 0
for (let attempt = 0; attempt < 32; attempt += 1) {
  restoredTabs = await page.getByRole('tablist', { name: '打开的标签' }).getByRole('tab').count()
  if (restoredTabs >= 1) break
  await page.waitForTimeout(300)
}
check('刷新后恢复上次的标签', restoredTabs >= 1, `tabs=${restoredTabs}`)


/* ---------- 选区 AI ---------- */

await page.getByRole('button', { name: '文件', exact: true }).first().click()
await page.waitForTimeout(400)
await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(900)

// 三击选中整段 → 气泡工具条出现 AI 入口
await page.locator('.ProseMirror p').first().click({ clickCount: 3 })
await page.waitForTimeout(400)
check('选中文字后出现 AI 入口', (await page.locator('[data-selection-ai]').count()) === 1)

await page.locator('[data-selection-ai]').click()
await page.waitForTimeout(400)
check('AI 菜单打开', (await page.locator('[data-selection-ai-menu]').count()) === 1)
check('菜单含三个文本动作', (await page.locator('[data-ai-action]').count()) === 3)
check('菜单含四个画布动作', (await page.locator('[data-ai-canvas]').count()) === 4)

// 翻译子菜单：8 种常用语言 + 自定义输入
await page.locator('[data-ai-translate]').hover()
await page.waitForTimeout(400)
check('翻译子菜单展开', (await page.locator('[data-ai-translate-menu]').count()) === 1)
check('翻译含八种语言', (await page.locator('[data-ai-lang]').count()) === 8)
await page.screenshot({ path: join(SHOTS, '53-selection-ai.png') })

// 润色：走假模型 → 面板流式输出 → 替换选区
await page.locator('[data-ai-action="polish"]').click()
await page.waitForTimeout(1400)
check('AI 结果面板打开', (await page.locator('[data-selection-ai-panel]').count()) === 1)
const aiOutput = await page.locator('[data-selection-ai-output]').innerText()
check('面板显示流式结果', aiOutput.includes('已润色'), aiOutput.slice(0, 60))
await page.getByRole('button', { name: '替换选区' }).click()
await page.waitForTimeout(900)
check(
  '替换后正文已更新',
  (await page.locator('.ProseMirror').innerText()).includes('已润色'),
)
await page.screenshot({ path: join(SHOTS, '54-selection-ai-result.png') })

// 从选区生成流程图：落一份 canvas.json 并直接打开
const selCanvasDir = join(WORKSPACE, 'canvases')
const canvasesBefore = existsSync(selCanvasDir) ? readdirSync(selCanvasDir) : []
await page.locator('.ProseMirror p').first().click({ clickCount: 3 })
await page.waitForTimeout(300)
await page.locator('[data-selection-ai]').click()
await page.waitForTimeout(300)
await page.locator('[data-ai-canvas="flowchart"]').click()
await page.waitForTimeout(1800)
const canvasesAfter = existsSync(selCanvasDir) ? readdirSync(selCanvasDir) : []
const generatedCanvas = canvasesAfter.find((name) => !canvasesBefore.includes(name))
const canvasToast = await page
  .locator('[data-sonner-toast]')
  .first()
  .innerText()
  .catch(() => '')
check('生成画布提示已插值', canvasToast.includes('已生成画布「'), canvasToast)
check('从选区生成了画布文件', Boolean(generatedCanvas), generatedCanvas ?? '无新增文件')
const generatedNodes = generatedCanvas
  ? (JSON.parse(readFileSync(join(selCanvasDir, generatedCanvas), 'utf8')).nodes?.length ?? 0)
  : 0
check('生成的画布带流程节点', generatedNodes > 0, `节点数 ${generatedNodes}`)
check('画布编辑器已打开', (await page.locator('input[aria-label="画布标题"]').count()) === 1)
await page.screenshot({ path: join(SHOTS, '55-selection-canvas.png') })

// 清掉这份自动生成的画布，后面的画布用例仍从零开始
await page.getByRole('button', { name: '关闭', exact: true }).last().click()
await page.waitForTimeout(600)
for (const name of existsSync(selCanvasDir) ? readdirSync(selCanvasDir) : []) {
  if (!canvasesBefore.includes(name)) unlinkSync(join(selCanvasDir, name))
}

/* ---------- 画布 ---------- */

await page.getByRole('button', { name: '画布', exact: true }).first().click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: '新建画布' }).first().click()
await page.waitForTimeout(300)
const canvasNameInput = page.locator('input[placeholder="输入画布名称"]')
await canvasNameInput.fill('需求梳理')
await canvasNameInput.press('Enter')
await page.waitForTimeout(1500)
check('画布编辑器打开', (await page.locator('input[aria-label="画布标题"]').count()) === 1)

// 左侧工具条：选择 / 平移 / 铅笔 / 荧光笔 / 橡皮 / 图形库 / 数据图表 / 图片
check('画布显示左侧工具条', (await page.locator('[data-canvas-tools]').count()) === 1)
check('工具条含八个入口', (await page.locator('[data-canvas-tool]').count()) === 8)
check(
  '默认选中选择工具',
  (await page.locator('[data-canvas-tool="select"]').getAttribute('aria-pressed')) === 'true',
)

// 双击空白处新增卡片并输入内容
await page.mouse.dblclick(700, 420)
await page.waitForTimeout(500)
await page.keyboard.type('第一个想法')
await page.keyboard.press('Escape')
await page.waitForTimeout(1400)
check('画布卡片已渲染', (await page.getByText('第一个想法').count()) > 0)
const canvasDir = join(WORKSPACE, 'canvases')
const canvasFile = existsSync(canvasDir)
  ? readdirSync(canvasDir).find((name) => name.endsWith('.canvas.json'))
  : undefined
check('画布文件已落盘', Boolean(canvasFile), canvasDir)
check(
  '画布内容已写入',
  canvasFile ? readFileSync(join(canvasDir, canvasFile), 'utf8').includes('第一个想法') : false,
)
await page.screenshot({ path: join(SHOTS, '15-canvas.png') })

// 小地图：开启后应画出视口框，点「适应画布内容」会改变缩放
await settingsButton().click()
await page.waitForTimeout(700)
await page.getByRole('dialog').getByRole('button', { name: '画布设置', exact: true }).click()
await page.waitForTimeout(600)
// 开关是持久化的，重复执行时必须先确认状态再点，否则会把「开」切回「关」
const minimapSwitch = page.getByRole('switch', { name: '显示小地图' })
if ((await minimapSwitch.getAttribute('aria-checked')) !== 'true') {
  await minimapSwitch.click()
}
await page.waitForTimeout(500)
// 关设置面板：作用域限定在 dialog 内，避免点到画布头部的「关闭」
await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click()
await page.waitForTimeout(900)
if ((await page.locator('input[aria-label="画布标题"]').count()) === 0) {
  // 画布被关掉时从左侧列表重新打开
  await page.getByText('需求梳理', { exact: true }).first().click()
  await page.waitForTimeout(1400)
}

check('小地图已显示', (await page.locator('[data-minimap]').count()) === 1)
check('小地图画出视口框', (await page.locator('[data-minimap-viewport]').count()) === 1)
const zoomLabel = page.locator('span.tabular-nums').first()
const zoomBefore = await zoomLabel.innerText()
await page.getByRole('button', { name: '适应画布内容' }).click()
await page.waitForTimeout(500)
const zoomAfter = await zoomLabel.innerText()
check('适应画布内容改变缩放', zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`)
await page.screenshot({ path: join(SHOTS, '39-canvas-minimap.png') })

// 工具行为：单键切工具 + 图形库 / 图形 / 图表 / 连线 / 橡皮
await page.locator('[data-canvas-tool="select"]').click()
await page.keyboard.press('p')
await page.waitForTimeout(200)
check(
  '单键 P 切到铅笔工具',
  (await page.locator('[data-canvas-tool="pen"]').getAttribute('aria-pressed')) === 'true',
)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// 图形库：三组、17 个图形（常用 4 + 流程图 10 + 数据与存储 3）
await page.locator('[data-canvas-tool="shapes"]').click()
await page.waitForTimeout(500)
check('图形库面板打开', (await page.locator('[data-canvas-shapes-panel]').count()) === 1)
check('图形库分三组', (await page.locator('[data-shape-group]').count()) === 3)
check('图形库含 17 个图形', (await page.locator('[data-canvas-shape-item]').count()) === 17)
await page.screenshot({ path: join(SHOTS, '48-canvas-shapes.png') })
await page.locator('[data-canvas-shape-item="decision"]').click()
await page.waitForTimeout(800)
check('插入判断条件图形', (await page.locator('[data-canvas-shape="decision"]').count()) === 1)
check('图形插入后关闭图形库', (await page.locator('[data-canvas-shapes-panel]').count()) === 0)
check(
  '空图形显示占位文案而非原始 key',
  (await page.getByText('canvas.shape.empty', { exact: false }).count()) === 0,
)

// 数据图表：插入后出图，并可切类型
await page.locator('[data-canvas-tool="chart"]').click()
await page.waitForTimeout(900)
check('插入数据图表', (await page.locator('[data-canvas-chart="bar"]').count()) === 1)
check('图表打开数据面板', (await page.locator('[data-canvas-chart-panel]').count()) === 1)
await page.locator('[data-chart-type="pie"]').click()
await page.waitForTimeout(600)
check('图表可切换为饼图', (await page.locator('[data-canvas-chart="pie"]').count()) === 1)
const chartData = page.getByLabel('数据（首行表头，首列类目）')
await chartData.fill('阶段,计划,实际\n需求,40,32\n开发,60,55\n测试,30,28')
await page.getByRole('button', { name: '应用' }).click()
await page.waitForTimeout(700)
check('图表数据可粘贴覆盖', (await page.locator('[data-canvas-chart]').count()) === 1)
await page.screenshot({ path: join(SHOTS, '49-canvas-chart.png') })
await page.locator('[data-canvas-chart-panel]').getByRole('button', { name: '关闭' }).click()
await page.waitForTimeout(400)

// 连线：先适应视图，保证卡片与图形同时在视野内
// 先选中卡片（工具按钮常显），点连接圆点，再点目标图形
await page.getByRole('button', { name: '适应画布内容' }).click()
await page.waitForTimeout(500)
const cardA = page.locator('[data-canvas-kind="card"]').first()
await cardA.click({ position: { x: 40, y: 20 } })
await page.waitForTimeout(300)
await cardA.getByRole('button', { name: '连线' }).click()
await page.waitForTimeout(300)
const targetNode = page.locator('[data-canvas-shape="decision"]').first()
const targetBox = await targetNode.boundingBox()
await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
await page.waitForTimeout(600)
check('卡片可连到图形', (await page.locator('[data-canvas-edge]').count()) === 1)

// 橡皮：点图形即删，关联连线一并移除
await page.locator('[data-canvas-tool="eraser"]').click()
await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
await page.waitForTimeout(600)
check('橡皮工具删除图形', (await page.locator('[data-canvas-shape="decision"]').count()) === 0)
check('删除图形后连线同时移除', (await page.locator('[data-canvas-edge]').count()) === 0)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check(
  'Esc 回到选择工具',
  (await page.locator('[data-canvas-tool="select"]').getAttribute('aria-pressed')) === 'true',
)
await page.screenshot({ path: join(SHOTS, '46-canvas-tools.png') })

// 手绘：铅笔一笔、荧光笔一笔，各自收成一个自由笔迹节点
await page.locator('[data-canvas-tool="pen"]').click()
await page.waitForTimeout(200)
await page.mouse.move(620, 260)
await page.mouse.down()
for (const [x, y] of [[620, 260], [660, 285], [700, 262], [740, 300]]) {
  await page.mouse.move(x, y)
  await page.waitForTimeout(40)
}
await page.mouse.up()
await page.waitForTimeout(700)
check('铅笔手绘生成笔迹', (await page.locator('[data-canvas-stroke="pen"]').count()) === 1)

await page.locator('[data-canvas-tool="highlighter"]').click()
await page.waitForTimeout(200)
await page.mouse.move(620, 360)
await page.mouse.down()
for (const [x, y] of [[620, 360], [700, 372], [780, 358]]) {
  await page.mouse.move(x, y)
  await page.waitForTimeout(40)
}
await page.mouse.up()
await page.waitForTimeout(700)
check('荧光笔生成笔迹', (await page.locator('[data-canvas-stroke="highlighter"]').count()) === 1)
await page.screenshot({ path: join(SHOTS, '51-canvas-freehand.png') })

await page.locator('[data-canvas-tool="select"]').click()
await page.waitForTimeout(200)

// 图片节点：走真实的 file input → Sidecar 落盘 → 画布节点显示
const uploadPng = join(ROOT, '.tmp', 'e2e-upload.png')
writeFileSync(
  uploadPng,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const canvasAssetsDir = join(WORKSPACE, 'assets')
const canvasAssetsBefore = existsSync(canvasAssetsDir) ? readdirSync(canvasAssetsDir).length : 0
await page.locator('[data-canvas-image-input]').setInputFiles(uploadPng)
await page
  .locator('[data-canvas-kind="image"]')
  .first()
  .waitFor({ state: 'visible', timeout: 15_000 })
  .catch(() => {})
await page.waitForTimeout(400)
check('插入图片节点', (await page.locator('[data-canvas-kind="image"]').count()) === 1)
check(
  '图片已落盘到资产目录',
  (existsSync(canvasAssetsDir) ? readdirSync(canvasAssetsDir).length : 0) > canvasAssetsBefore,
  `${canvasAssetsBefore} -> ${existsSync(canvasAssetsDir) ? readdirSync(canvasAssetsDir).length : 0}`,
)
check('图片节点显示出图像', (await page.locator('[data-canvas-kind="image"] img').count()) === 1)

// 缩放手柄：选中图片节点后拖动右下角，宽高都应变化
// 先确认节点没有被「让位」逻辑甩出视野（曾经会一路下推几千像素），再适应视图便于拖拽
const insertedBox = await page.locator('[data-canvas-kind="image"]').first().boundingBox()
const boardBox = await page.locator('[data-canvas-board]').boundingBox()
check(
  '插入的节点落在可视区内',
  Boolean(insertedBox) &&
    Boolean(boardBox) &&
    insertedBox.x >= boardBox.x - 2 &&
    insertedBox.y >= boardBox.y - 2 &&
    insertedBox.y <= boardBox.y + boardBox.height &&
    insertedBox.x <= boardBox.x + boardBox.width,
  `节点 ${JSON.stringify(insertedBox)} / 画布 ${JSON.stringify(boardBox)}`,
)
await page.getByRole('button', { name: '适应画布内容' }).click()
await page.waitForTimeout(600)
const imageNode = page.locator('[data-canvas-kind="image"]').first()
await imageNode.click({ position: { x: 20, y: 20 } })
await page.waitForTimeout(400)
check('选中节点后出现缩放手柄', (await page.locator('[data-canvas-resize]').count()) === 1)
const widthBefore = await imageNode.evaluate((el) => el.getBoundingClientRect().width)
const resizeHandle = page.locator('[data-canvas-resize]').first()
const handleBox = await resizeHandle.boundingBox()
if (handleBox) {
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + 70, handleBox.y + 50, { steps: 8 })
  await page.mouse.up()
}
await page.waitForTimeout(700)
const widthAfter = await imageNode.evaluate((el) => el.getBoundingClientRect().width)
check(
  '拖动手柄可缩放节点',
  widthAfter > widthBefore + 20,
  `${Math.round(widthBefore)} -> ${Math.round(widthAfter)}，手柄 ${JSON.stringify(handleBox)}`,
)
await page.screenshot({ path: join(SHOTS, '52-canvas-image.png') })

// 关闭画布回到笔记
await page.getByRole('button', { name: '关闭', exact: true }).last().click()
await page.waitForTimeout(500)
check('关闭画布后回到编辑区', (await page.locator('input[aria-label="画布标题"]').count()) === 0)

/* ---------- 并排对照 ---------- */

await page.getByRole('button', { name: '文件', exact: true }).first().click()
await page.waitForTimeout(500)
await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(900)

await page.getByRole('button', { name: '并排对照' }).click()
await page.waitForTimeout(1400)
check('对照面板出现两栏编辑器', (await page.locator('.ProseMirror').count()) === 2)
await page.screenshot({ path: join(SHOTS, '19-split.png') })

// 对照文件由面板自己选（不是当前笔记），这里按它实际打开的文件校验落盘
const sidePath = await page.locator('[data-side-path]').first().getAttribute('data-side-path')
const sideEditor = page.locator('.ProseMirror').nth(1)
await sideEditor.click()
await page.keyboard.press('Control+End')
await page.keyboard.type('对照面板写入的内容。')
await page.waitForTimeout(1800)
check(
  '对照面板独立落盘',
  Boolean(sidePath) && readFileSync(join(WORKSPACE, sidePath), 'utf8').includes('对照面板写入的内容'),
  sidePath ?? '',
)

await page.getByRole('button', { name: '关闭对照面板' }).click()
await page.waitForTimeout(700)
check('关闭对照面板回到单栏', (await page.locator('.ProseMirror').count()) === 1)

/* ---------- 编辑器细节：元信息栏 + 斜杠命令 ---------- */

await page.locator('text=周会纪要').first().click()
await page.waitForTimeout(900)

check('编辑器顶部有笔记信息入口', (await page.getByRole('button', { name: '笔记信息' }).count()) > 0)
await page.getByRole('button', { name: '笔记信息' }).first().click()
await page.waitForTimeout(400)
check('笔记信息展示字数统计', (await page.getByRole('menu').locator('text=/\\d+ 字/').count()) > 0)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

const prose = page.locator('.ProseMirror').first()
// 光标放到正文段落末尾的空白段落里，命令作用在普通段落上更好断言
await page.locator('.ProseMirror p', { hasText: '本周完成插件骨架' }).first().click()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const h1Before = await page.locator('.ProseMirror h1').count()

// 「插入块」按钮等价于在光标处输入 `/`
// 块手柄上也有「在下方插入块」，这里限定顶部工具条那枚
await page.getByRole('button', { name: '插入块', exact: true }).click()
await page.waitForTimeout(700)
const slashPanel = page.getByRole('listbox', { name: '插入内容' })
check('插入块按钮唤起命令面板', (await slashPanel.count()) === 1)
check('命令面板默认停在 AI 分类', (await page.locator('text=续写').count()) > 0)

// 分组必须一屏列全：之前做成三组一页，块级 / 数学 / 图表被藏到第二页
const leftRail = page.locator('[data-slash-menu] > div').first()
const railGroups = await leftRail.locator('button').count()
check('命令面板一次列出全部分组', railGroups === 6, String(railGroups))
const railText = (await leftRail.innerText()).replace(/\s+/g, ' ')
check(
  '块级 / 数学 / 图表 无需翻页即可见',
  ['块级', '数学', '图表'].every((name) => railText.includes(name)),
  railText,
)
await page.screenshot({ path: join(SHOTS, '22-slash.png') })

await page.keyboard.press('ArrowRight')
await page.waitForTimeout(400)
check('方向键切换分类到标题', (await page.locator('text=一级标题').count()) > 0)

// 搜索优先：输入「一级标题」后回车执行
await page.keyboard.type('一级标题')
await page.waitForTimeout(500)
await page.keyboard.press('Enter')
await page.waitForTimeout(900)
check(
  '执行命令后段落变成一级标题',
  (await page.locator('.ProseMirror h1').count()) === h1Before + 1,
  `${h1Before} → ${await page.locator('.ProseMirror h1').count()}`,
)
check(
  '命令面板执行后关闭',
  (await page.getByRole('listbox', { name: '插入内容' }).count()) === 0,
)
check(
  '斜杠与搜索词已被清掉',
  !(await page.locator('.ProseMirror').innerText()).includes('一级标题'),
)

// Esc 取消：行首的斜杠要一并清掉
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
await page.keyboard.type('/')
await page.waitForTimeout(600)
check('手动输入 / 也能唤起面板', (await page.getByRole('listbox', { name: '插入内容' }).count()) === 1)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
check('Esc 关闭命令面板', (await page.getByRole('listbox', { name: '插入内容' }).count()) === 0)
check(
  'Esc 会清掉行首斜杠',
  !(await page.locator('.ProseMirror').innerText()).trimEnd().endsWith('/'),
)

// 参考项目的触发规则：/ 在块首或空白/标点之后即可，不要求整行为空。
// 回归「列表项里已有正文时输入 / 带不出块编辑菜单」。
await page.keyboard.press('Enter')
await page.waitForTimeout(250)
await page.keyboard.type('1. 计算均值（数学期望）： ')
await page.waitForTimeout(450)
await page.keyboard.type('/')
await page.waitForTimeout(650)
check('列表项正文后输入 / 也能唤起面板', (await page.locator('[data-slash-menu]').count()) === 1)
await page.keyboard.press('Escape')
await page.waitForTimeout(350)

/* ---------- 颜色 / 块菜单 / 公式 / 图表 / 代码块语言 / 表格 ---------- */

await page.keyboard.press('Enter')
await page.waitForTimeout(200)
await page.keyboard.type('颜色与块能力')
await page.keyboard.press('Shift+Home')
await page.waitForTimeout(700)

await page.getByRole('button', { name: '字体颜色' }).click()
await page.waitForTimeout(400)
await page.getByRole('menuitem', { name: '红色' }).click()
await page.waitForTimeout(500)
// 选色后选区会丢，重新选一次再上高亮
await page.keyboard.press('End')
await page.keyboard.press('Shift+Home')
await page.waitForTimeout(500)
await page.getByRole('button', { name: '高亮颜色' }).click()
await page.waitForTimeout(400)
await page.getByRole('menuitem', { name: '黄色' }).click()
await page.waitForTimeout(600)
check('选中文字可设字体色', (await page.locator('.ProseMirror [data-dbx-color] span, .ProseMirror span[data-dbx-color]').count()) > 0)
check('选中文字可设高亮色', (await page.locator('.ProseMirror mark[data-dbx-color]').count()) > 0)
await page.screenshot({ path: join(SHOTS, '25-editor-colors.png') })

// 块手柄菜单
const colorParagraph = page.locator('.ProseMirror p', { hasText: '颜色与块能力' }).first()
const colorBox = await colorParagraph.boundingBox()
if (colorBox) {
  await page.mouse.move(colorBox.x + 40, colorBox.y + colorBox.height / 2)
  await page.waitForTimeout(700)
}
const gripButton = page.locator('[data-block-handle] button').first()
check('块手柄在悬停时出现', await gripButton.isVisible())
await gripButton.click()
await page.waitForTimeout(500)
check('块菜单含复制与移动操作', (await page.getByRole('menuitem', { name: '创建副本' }).count()) > 0)
await page.getByRole('menuitem', { name: '转换为' }).hover()
await page.waitForTimeout(700)
check(
  '转换为列出 10 种块类型',
  (await page.getByRole('menuitemradio').count()) === 10,
  String(await page.getByRole('menuitemradio').count()),
)
await page.screenshot({ path: join(SHOTS, '26-block-turn-into.png') })
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// 块手柄的 + 号与 / 是同一套录入方式：在下方开空行并唤起同一个面板
await page.getByRole('button', { name: '在下方插入块' }).click()
await page.waitForTimeout(1000)
check('块手柄 + 号唤起命令面板', (await page.locator('[data-slash-menu]').count()) === 1)
check(
  '加号面板同样列全分组',
  (await page.locator('[data-slash-menu] > div').first().locator('button').count()) === 6,
)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

// 回归「块前面的 + 鼠标移动时消失很快不好点击」：
// Playwright 的 .click() 会瞬移到元素中心，测不出经过装订线时的 hover 断裂，
// 这里按真实轨迹分步移动，再检查按钮仍可点击。
const handlePathBox = await page
  .locator('.ProseMirror p', { hasText: '颜色与块能力' })
  .first()
  .boundingBox()
if (handlePathBox) {
  const centerY = handlePathBox.y + handlePathBox.height / 2
  await page.mouse.move(handlePathBox.x + 60, centerY)
  await page.waitForTimeout(250)
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(handlePathBox.x + 60 - step * 8, centerY)
    await page.waitForTimeout(45)
  }
  await page.waitForTimeout(200)
  const addButton = page.getByRole('button', { name: '在下方插入块' })
  check('鼠标穿过装订线后 + 仍可见', await addButton.isVisible())
  const handlePointer = await page
    .locator('[data-block-handle]')
    .evaluate((node) => getComputedStyle(node).pointerEvents)
    .catch(() => 'none')
  check('鼠标穿过装订线后 + 未失去指针事件', handlePointer === 'auto', handlePointer)
  const addBox = await addButton.boundingBox()
  if (addBox) {
    await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2)
    await page.waitForTimeout(950)
    check('真实鼠标点击 + 能唤起块编辑菜单', (await page.locator('[data-slash-menu]').count()) === 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
}

// 焦点在块菜单按钮上，先点回正文末尾再继续
const focusEnd = async () => {
  await page.locator('.ProseMirror').first().click({ position: { x: 24, y: 12 } })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
}

// 公式：插入行内公式节点，KaTeX 渲染成 <math>
await focusEnd()
await page.keyboard.type('/行内公式')
await page.waitForTimeout(600)
await page.keyboard.press('Enter')
await page.waitForTimeout(900)
check('行内公式渲染为 MathML', (await page.locator('.ProseMirror [data-math="inline"] math').count()) > 0)

// 行内公式编辑态也要有「常用公式示例」：点示例能把 LaTeX 插到光标处
await page.locator('.ProseMirror [data-math="inline"]').last().click()
await page.waitForTimeout(400)
check(
  '行内公式编辑态列出八个常用公式示例',
  (await page.locator('[data-math-chip]').count()) === 8,
)
await page.locator('[data-math-chip="分数"]').click()
await page.waitForTimeout(300)
check(
  '点示例插入 LaTeX 到公式输入框',
  (
    await page
      .locator('.ProseMirror textarea[aria-label="LaTeX"]')
      .last()
      .inputValue()
      .catch(() => '')
  ).includes('\\frac{a}{b}'),
)
await page.screenshot({ path: join(SHOTS, '67-math-inline-examples.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 块级公式走弹窗：Σ 标题 + 输入 + 实时预览 + 八个示例 + 插入
await focusEnd()
await page.keyboard.type('/块级公式')
await page.waitForTimeout(600)
await page.keyboard.press('Enter')
await page.waitForTimeout(800)
check('块级公式弹窗打开', (await page.locator('[data-math-dialog]').count()) === 1)
check(
  '弹窗列出八个常用公式示例',
  (await page.locator('[data-math-example]').count()) === 8,
)
await page.locator('[data-math-example="积分"]').click()
await page.waitForTimeout(500)
check('点示例后有 KaTeX 预览', (await page.locator('[data-math-preview] .katex').count()) > 0)
await page.screenshot({ path: join(SHOTS, '66-math-dialog.png') })
await page.locator('[data-math-insert]').click()
await page.waitForTimeout(800)
check(
  '插入后正文出现块级公式',
  (await page.locator('.ProseMirror [data-math="block"] math, .ProseMirror [data-node-view-wrapper] .katex').count()) > 0,
)

// 标题折叠：hover 出按钮 → 折叠 → 内容不可见 → 展开恢复
await focusEnd()
await page.keyboard.type('# 折叠标题甲\n折叠区内容一\n折叠区内容二\n')
await page.waitForTimeout(600)
check('标题行出现折叠按钮', (await page.locator('[data-fold-button]').count()) > 0)
// 常显：不 hover 也要看得见（opacity 不再为 0），并带 svg 箭头与 aria-expanded
const foldBtn = page.locator('[data-fold-button]').last()
check('折叠按钮未 hover 也可见', await foldBtn.isVisible())
check(
  '折叠按钮常显不透明 + 有箭头图标',
  await foldBtn.evaluate(
    (el) =>
      Number(getComputedStyle(el).opacity) > 0.5 &&
      !!el.querySelector('svg path') &&
      el.getAttribute('aria-expanded') === 'true',
  ),
)
await foldBtn.click()
await page.waitForTimeout(600)
check(
  '折叠后按钮标记为收起态',
  await page
    .locator('[data-fold-button]')
    .last()
    .evaluate(
      (el) =>
        el.getAttribute('aria-expanded') === 'false' &&
        el.className.includes('border-primary/60'),
    ),
)
check('折叠后出现提示条', (await page.locator('[data-fold-placeholder]').count()) > 0)
check(
  '折叠后内容不可见',
  !(await page.locator('text=折叠区内容一').first().isVisible().catch(() => false)),
)
await page.screenshot({ path: join(SHOTS, '65-fold-collapsed.png') })
await page.locator('[data-fold-button]').last().click()
await page.waitForTimeout(600)
check(
  '展开后内容恢复可见',
  await page.locator('text=折叠区内容一').first().isVisible().catch(() => false),
)

// 图表：插入流程图节点，mermaid 渲染成 svg
await focusEnd()
await page.keyboard.type('/流程图')
await page.waitForTimeout(600)
await page.keyboard.press('Enter')
await page.waitForTimeout(4000)
check('流程图插入为图表节点', (await page.locator('.ProseMirror [data-mermaid-block]').count()) > 0)
check('流程图渲染出 SVG', (await page.locator('.ProseMirror [data-mermaid-preview] svg').count()) > 0)
await page.screenshot({ path: join(SHOTS, '27-mermaid.png') })

// 代码块语言选择
await focusEnd()
await page.keyboard.type('/代码块')
await page.waitForTimeout(600)
await page.keyboard.press('Enter')
await page.waitForTimeout(700)
await page.keyboard.type('const answer = 42')
await page.waitForTimeout(700)
const codeBlock = page.locator('.ProseMirror [data-code-block]').first()
check('代码块带语言选择器', (await codeBlock.locator('select').count()) === 1)
check('代码块带复制按钮', (await codeBlock.getByRole('button', { name: '复制代码块' }).count()) === 1)
await codeBlock.locator('select').selectOption('python')
await page.waitForTimeout(600)
check(
  '切换语言写回 data-code-block',
  (await page.locator('.ProseMirror [data-code-block]').first().getAttribute('data-code-block')) === 'python',
)

// 表格：单元格内出现增删行列与对齐
await focusEnd()
await page.keyboard.type('/表格')
await page.waitForTimeout(600)
await page.keyboard.press('Enter')
await page.waitForTimeout(900)
check('插入表格', (await page.locator('.ProseMirror table').count()) > 0)
// 工具条在表格内浮在选区下方，点末行单元格最稳（不会贴着工具条）
await page.locator('.ProseMirror table th, .ProseMirror table td').last().click()
await page.waitForTimeout(800)
// 表格上方浮出独立工具栏（对齐参考实现，替代头部工具栏里的表格段）
check('表格浮动工具栏出现', (await page.locator('[data-table-toolbar]').count()) === 1)
check(
  // 对齐参考项目：行 3（上插 / 下插 / 删）+ 列 3 + 对齐 3 + 删表 1
  '浮动工具栏含十个操作',
  (await page.locator('[data-table-toolbar] [data-table-action]').count()) === 10,
)
check('表格内浮出列操作', (await page.getByRole('button', { name: '在右侧插入列' }).count()) > 0)
await page.getByRole('button', { name: '在右侧插入列' }).click()
await page.waitForTimeout(600)
check(
  '插入列后表头变 4 列',
  (await page.locator('.ProseMirror table tr').first().locator('th, td').count()) === 4,
)
await page.getByRole('button', { name: '居中' }).first().click()
await page.waitForTimeout(500)
check(
  '列居中写入 data-align',
  (await page.locator('.ProseMirror table [data-align="center"]').count()) > 0,
)
await page.screenshot({ path: join(SHOTS, '28-table-toolbar.png') })

// 文件命令：插入指向工作区笔记的相对链接
await focusEnd()
await page.keyboard.type('/文件')
await page.waitForTimeout(700)
await page.keyboard.press('Enter')
await page.waitForTimeout(700)
check('文件命令打开文件面板', (await page.locator('[data-slash-menu] input').count()) === 1)
await page.locator('[data-slash-menu] [data-index]').first().click()
await page.waitForTimeout(800)

// 从磁盘确认全部写回了 Markdown（CodeMirror 只渲染可视行，读 DOM 不可靠）
await page.getByRole('button', { name: '源码' }).click()
await page.waitForTimeout(1200)
const noteFile = join(WORKSPACE, '周会纪要.md')
let diskSource = ''
for (let attempt = 0; attempt < 25; attempt += 1) {
  diskSource = readFileSync(noteFile, 'utf8')
  if (
    diskSource.includes('data-dbx-color') &&
    diskSource.includes('```mermaid') &&
    diskSource.includes('```python') &&
    /\[[^\]]+\]\([^)]+\.md\)/.test(diskSource)
  ) {
    break
  }
  await page.waitForTimeout(400)
}
check('颜色写回 span/mark 属性', diskSource.includes('data-dbx-color'))
// 公式必须原样写回 Markdown；以前 markdownTokenName 漏配导致 parse 时整段丢弃
check('行内公式写回 $...$', /\$[^$\n]+\$/.test(diskSource))
check('块级公式写回 $$ 围栏', /\$\$\s*\n[\s\S]*?\n\$\$/.test(diskSource))
check('图表写回 mermaid 围栏', diskSource.includes('```mermaid'))
check('代码块写回语言围栏', diskSource.includes('```python'))
check(
  '文件命令写回相对链接',
  /\[[^\]]+\]\([^)]+\.md\)/.test(diskSource),
  diskSource.split('\n').filter((line) => line.includes('](')).slice(-2).join(' / '),
)
await page.getByRole('button', { name: '可视化' }).click()
await page.waitForTimeout(2500)
check('源码往返后图表节点仍在', (await page.locator('.ProseMirror [data-mermaid-block]').count()) > 0)
// 切回可视化会重新以 Markdown 解析一次；公式若被 tokenizer 丢掉，这里就查不到节点
check(
  '源码往返后行内公式仍在',
  (await page.locator('.ProseMirror [data-math="inline"]').count()) > 0,
)
check(
  '源码往返后块级公式仍在',
  (await page.locator('.ProseMirror [data-math="block"]').count()) > 0,
)

/* ---------- 云同步（Git） ---------- */

await settingsButton().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '同步', exact: true }).click()
await page.waitForTimeout(700)
// 上一次运行会把平台留在「自托管」，这里先切回 GitHub，保证用例可重复执行
await page.locator('[data-sync-platform="github"]').click()
// git --version 由 Sidecar 异步返回，轮询等文案出现，避免固定等待在冷启动时误报
let gitVersionShown = false
for (let attempt = 0; attempt < 30 && !gitVersionShown; attempt += 1) {
  gitVersionShown = (await page.locator('text=git version').count()) > 0
  if (!gitVersionShown) await page.waitForTimeout(250)
}
check('同步面板显示 git 版本', gitVersionShown)
// 同步选项（自动同步 / 应用数据同步）与平台无关，Git 通道也要能看到
check('Git 平台显示同步选项', (await page.locator('[data-sync-options]').count()) === 1)
check('Git 平台有笔记设置区', (await page.locator('[data-sync-note-options]').count()) === 1)
check('Git 平台有应用数据同步区', (await page.locator('[data-sync-data-options]').count()) === 1)
const autoSyncSelect = page.getByLabel('自动同步笔记')
check('Git 平台可设置自动同步间隔', (await autoSyncSelect.count()) === 1)
await autoSyncSelect.selectOption('10')
await page.waitForTimeout(900)
check('自动同步间隔已保存', (await autoSyncSelect.inputValue()) === '10')
// 已经初始化过时按钮不再出现，保证用例可重复执行
const initButton = page.getByRole('button', { name: '初始化仓库' })
if ((await initButton.count()) > 0) {
  await initButton.click()
  await page.waitForTimeout(2000)
}
check('工作区已初始化为 Git 仓库', existsSync(join(WORKSPACE, '.git')))
try {
  // 补一个本地身份，避免 commit 因缺少 user.name/email 失败（仓库已存在，--local 生效）
  execFileSync('git', ['-C', WORKSPACE, 'config', 'user.email', 'e2e@example.com'])
  execFileSync('git', ['-C', WORKSPACE, 'config', 'user.name', 'DBX E2E'])
} catch {
  /* git 不可用时下面的断言会体现 */
}
// 「提交改动」在没有差异时是禁用的（初始化仓库已经提交过一次），
// 这里按需造一个改动并让面板重新扫描，避免用例随写入时序抖动。
const commitButton = page.getByRole('button', { name: '提交改动' })
if (!(await commitButton.isEnabled())) {
  writeFileSync(join(WORKSPACE, '.e2e-dirty.txt'), `e2e ${Date.now()}\n`)
  await page.locator('[data-sync-platform="gitee"]').click()
  await page.waitForTimeout(600)
  await page.locator('[data-sync-platform="github"]').click()
  await page.waitForTimeout(1500)
}
if (await commitButton.isEnabled()) {
  await commitButton.click()
  await page.waitForTimeout(3000)
}
rmSync(join(WORKSPACE, '.e2e-dirty.txt'), { force: true })
check('提交后状态栏显示仓库信息', (await page.locator('text=最近提交').count()) > 0)

// 同步平台 / 令牌 / 自动提交 / 提交信息模板
check('列出全部同步平台', (await page.locator('[data-sync-platform]').count()) === 8)
await page.locator('[data-sync-platform="gitee"]').click()
await page.waitForTimeout(900)
check(
  '可选择代码托管平台',
  (await page.locator('[data-sync-platform="gitee"]').getAttribute('aria-pressed')) === 'true',
)
const autoCommit = page.getByRole('switch', { name: '自动提交' })
// saveOptions 会等 refresh()（syncStatus + syncOptions）跑完才回写开关并清 busy；
// 慢机器上可能要好几秒，轮询等状态稳定，别在 busy 期间重复点击
if ((await autoCommit.getAttribute('aria-checked')) !== 'true') await autoCommit.click()
for (let attempt = 0; attempt < 30; attempt += 1) {
  if ((await autoCommit.getAttribute('aria-checked')) === 'true') break
  await page.waitForTimeout(500)
}
check('自动提交开关可开启', (await autoCommit.getAttribute('aria-checked')) === 'true')

const tokenInput = page.getByLabel('访问令牌')
await tokenInput.fill('e2e-token-123456')
const tokenSave = page.locator('[data-token-row]').getByRole('button', { name: '保存' })
for (let attempt = 0; attempt < 30 && !(await tokenSave.isEnabled()); attempt += 1) {
  // 面板异步重建时输入可能被清掉，补填几次；按钮始终 disabled 也不能让整轮 e2e 崩掉
  if (attempt % 3 === 2) await tokenInput.fill('e2e-token-123456').catch(() => {})
  await page.waitForTimeout(500)
}
if (await tokenSave.isEnabled()) await tokenSave.click().catch(() => {})
// toast 只停留几秒，固定 waitForTimeout 在慢机器上会错过；改成轮询等它出现
let tokenToastSeen = false
for (let attempt = 0; attempt < 25 && !tokenToastSeen; attempt += 1) {
  tokenToastSeen = (await page.locator('text=已保存 e2e').count()) > 0
  if (!tokenToastSeen) await page.waitForTimeout(200)
}
check('提示已保存的令牌', tokenToastSeen)
check('令牌保存后只显示掩码', (await page.getByLabel('访问令牌').inputValue()) === '')

const templateInput = page.getByLabel('提交信息模板')
await templateInput.fill('notes {date}')
await templateInput.blur()
await page.waitForTimeout(900)
check('提交信息模板已保存', (await templateInput.inputValue()) === 'notes {date}')

// 对象存储 / WebDAV / 自托管：配置表单真的能填能存
// 「服务地址」「Secret Access Key」等标签在别的设置页也有同名项，全部限定在同步面板内
const syncPanel = page.locator('[data-settings-panel="sync"]')

/**
 * 平台切换要读一次配置并异步重建表单，保存成功的 toast 又常盖住平台按钮。
 * 统一用 force 点击 + 轮询等目标控件，返回是否就绪；**不抛异常**，
 * 否则单个 waitFor 超时会中断整轮 e2e，后面的公式冷启动等用例全跑不到。
 */
async function selectSyncPlatform(name, label, exact = false) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await page.getByRole('dialog').getByRole('button', { name, exact }).click({ force: true, timeout: 4_000 })
    } catch {
      // 控件还没挂载 / 弹窗正在重建，下一轮重试
    }
    if ((await syncPanel.getByLabel(label).count()) > 0) return true
    await page.waitForTimeout(350)
  }
  return false
}

const s3Ready = await selectSyncPlatform('对象存储（S3）', '存储桶')
check('对象存储显示配置表单', s3Ready && (await syncPanel.getByLabel('存储桶').count()) === 1)
if (s3Ready) {
  check('对象存储列出预设服务商', (await syncPanel.getByLabel('服务商').count()) === 1)
  await syncPanel.getByLabel('存储桶').fill('e2e-bucket')
  await syncPanel.getByLabel('Access Key ID').fill('AKIAE2E')
  await syncPanel.getByLabel('Secret Access Key').fill('secret-e2e-value')
  await page.waitForTimeout(200)
  await syncPanel.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1400)
  check('对象存储配置已保存', (await syncPanel.getByLabel('存储桶').inputValue()) === 'e2e-bucket')
  // 保存后 Sidecar 会回读并把明文换成掩码，轮询等它落定，别用固定 1.4s 猜
  let secretPlain = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    secretPlain = await syncPanel.getByLabel('Secret Access Key').inputValue()
    if (secretPlain === '') break
    await page.waitForTimeout(300)
  }
  check('同步密钥保存后只显示掩码', secretPlain === '', secretPlain)
}
check('显示同步状态卡片', (await page.locator('[data-store-status]').count()) === 1)
// 换平台后同步选项要保留，且值不丢
check('对象存储平台也显示同步选项', (await page.locator('[data-sync-note-options]').count()) === 1)
const intervalInput = page.getByLabel('自动同步笔记')
const intervalValue = (await intervalInput.count()) > 0 ? await intervalInput.inputValue() : ''
check('切平台后自动同步间隔不丢', intervalValue === '10', intervalValue)
await page.screenshot({ path: join(SHOTS, '47-sync-options-store.png') })
await page.screenshot({ path: join(SHOTS, '16-sync-store.png') })

const webdavReady = await selectSyncPlatform('WebDAV', 'WebDAV 目录地址', true)
check('WebDAV 显示目录地址表单', webdavReady && (await syncPanel.getByLabel('WebDAV 目录地址').count()) >= 1)
const selfHostedReady = await selectSyncPlatform('自托管', '服务地址', true)
check('自托管显示服务地址表单', selfHostedReady && (await syncPanel.getByLabel('服务地址').count()) === 1)
check('自托管提供立即上传入口', (await page.getByRole('button', { name: '立即上传' }).count()) === 1)

// 备份与恢复（独立设置页）
await page.screenshot({ path: join(SHOTS, '16-sync.png') })
await page.getByRole('dialog').getByRole('button', { name: '备份与恢复' }).click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: '立即备份' }).click()
await page.waitForTimeout(3500)
check('备份后出现在备份列表', (await page.locator('[data-backup]').count()) > 0)
const backupDir = join(DATA_DIR, 'backups')
check(
  '备份文件落到数据目录',
  existsSync(backupDir) && readdirSync(backupDir).some((name) => name.endsWith('.zip')),
  backupDir,
)
await page.screenshot({ path: join(SHOTS, '16-backup.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

/* ---------- 文件管理设置 ---------- */

await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '文件管理' }).click()
await page.waitForTimeout(500)
check('图片目录默认 assets', (await page.getByLabel('图片目录').inputValue()) === 'assets')
await page.getByRole('button', { name: '日期时间' }).click()
await page.waitForTimeout(600)
check(
  '命名规则可切换',
  (await page.getByRole('button', { name: '日期时间' }).getAttribute('aria-pressed')) === 'true',
)
await page.getByLabel('图片目录').fill('media')
await page.waitForTimeout(900)
check('图片目录已保存', (await page.getByLabel('图片目录').inputValue()) === 'media')
await page.getByRole('button', { name: '随机 UUID' }).click()
await page.getByLabel('图片目录').fill('assets')
await page.waitForTimeout(900)
check('截图说明已给出降级路径', (await page.locator('text=Win + Shift + S').count()) > 0)
await page.screenshot({ path: join(SHOTS, '25-media.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

/* ---------- 图片存储（图床） ---------- */

await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '图片存储' }).click()
await page.waitForTimeout(600)
check('图床页展示本地存储为主选项', (await page.locator('[data-provider="local"]').count()) > 0)
check(
  '默认使用本地存储',
  (await page.locator('[data-provider="local"]').getAttribute('aria-pressed')) === 'true',
)
check('图床列表含 12 家服务', (await page.locator('[data-provider]').count()) === 12)

await page.locator('[data-provider="github"]').click()
await page.waitForTimeout(600)
check(
  '切到 GitHub 后出现令牌输入',
  (await page.locator('input[aria-label="GitHub Access Token"]').count()) > 0,
)
check(
  '未配置时不能启用该服务',
  (await page.getByRole('button', { name: '使用此服务' }).isDisabled()) === true,
)
await page.screenshot({ path: join(SHOTS, '26-image-hosting.png') })

await page.locator('[data-provider="local"]').click()
await page.waitForTimeout(500)
check(
  '切回本地存储仍是使用中',
  (await page.locator('[data-provider="local"]').getAttribute('aria-pressed')) === 'true',
)

/* ---------- 编辑器设置 ---------- */

await page.getByRole('dialog').getByRole('button', { name: '编辑器设置' }).click()
await page.waitForTimeout(500)
check(
  '内容宽度默认标准',
  (await page.getByRole('button', { name: '标准', exact: true }).getAttribute('aria-pressed')) === 'true',
)
await page.getByRole('button', { name: '宽', exact: true }).click()
await page.waitForTimeout(600)
check(
  '内容宽度可切换',
  (await page.getByRole('button', { name: '宽', exact: true }).getAttribute('aria-pressed')) === 'true',
)
check(
  '正文宽度已写入 CSS 变量',
  (await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--dbx-note-editor-width'),
  )) === '960px',
)
await page.getByRole('button', { name: '标准', exact: true }).click()
await page.waitForTimeout(500)

const statsSwitch = page.getByRole('switch', { name: '写作统计' })
if ((await statsSwitch.getAttribute('aria-checked')) !== 'true') {
  await statsSwitch.click()
  await page.waitForTimeout(400)
}
check('写作统计可开启', (await statsSwitch.getAttribute('aria-checked')) === 'true')
await page.screenshot({ path: join(SHOTS, '27-editor-settings.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
check('开启后编辑器显示统计', (await page.locator('[data-editor-stats]').count()) > 0)

/* ---------- 快捷键 ---------- */

await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '快捷键' }).click()
await page.waitForTimeout(500)
const searchShortcut = page.getByLabel('全局搜索')
check('搜索快捷键默认 Ctrl+Shift+F', (await searchShortcut.inputValue()) === 'Ctrl+Shift+F')
await searchShortcut.fill('Ctrl+Alt+F')
await page.waitForTimeout(600)
check('快捷键可改写', (await searchShortcut.inputValue()) === 'Ctrl+Alt+F')
await searchShortcut.fill('Ctrl+Shift+F')
await page.waitForTimeout(500)
const shotShortcut = page.getByLabel('截图', { exact: true })
check('快捷键里有截图', (await shotShortcut.count()) === 1)
// 默认值与参考实现一致：Shift+Alt+Z
check(
  '截图快捷键绑定在 Shift+Z',
  /Shift\+Z$/.test(await shotShortcut.inputValue()),
  await shotShortcut.inputValue(),
)

// 全局截图热键由 Sidecar 注册（插件不在前台也能按），设置页要能看见实际生效的组合
const hotkeyHint = page.locator('[data-shot-hotkey]')
check('设置里显示全局截图热键状态', (await hotkeyHint.count()) === 1)
const hotkeyText = (await hotkeyHint.innerText().catch(() => '')) || ''
check('全局截图热键状态有内容', hotkeyText.trim().length > 4, hotkeyText)
check('全局热键注册成功且为指定组合', hotkeyText.includes('Ctrl+Alt+F9'), hotkeyText)

// 全局热键实测（模拟离开编辑器：不经前端 keydown，直接按系统热键）：
// Sidecar 热键线程 → 原生框选窗口（AUTO 到点自动松手）→ 图进挂起项 + 剪贴板 →
// 页面聚焦轮询 takePending → 标注浮层打开。这是「离开笔记也能截图」的完整链路。
const DIAG_KEYS = join(ROOT, 'backend', 'target', 'release', 'examples', 'diag_drag.exe')
const readLogTail = () =>
  page.evaluate(async () => {
    try {
      const result = await window.dbxPlugin.invoke('log/tail', { lines: 200 }, { timeoutMs: 10000 })
      return result?.text ?? ''
    } catch {
      return ''
    }
  })
const countOf = (text, needle) => text.split(needle).length - 1

/**
 * 量截图浮层的几何：工具栏是否在图片正下方、是否在视口内、是否落在自己的位置上
 *
 * 抽成函数是因为「全局热键接回」和「编辑器按钮打开」两条入口都要验同一件事，
 * 后者不依赖真实桌面，锁屏 / 无头机器上也能跑。
 */
const measureShotOverlay = (target) =>
  target.evaluate(() => {
    const canvas = document.querySelector('[data-screenshot-canvas]')
    const bar = document.querySelector('[data-screenshot-toolbar]')
    if (!canvas || !bar) return null
    const canvasBox = canvas.getBoundingClientRect()
    const barBox = bar.getBoundingClientRect()
    const style = getComputedStyle(bar)
    const centerX = barBox.left + barBox.width / 2
    const centerY = barBox.top + barBox.height / 2
    // 取命中栈而不是单一 elementFromPoint：截图流程会短暂弹 toast，
    // toast 压在工具条上层也说明工具条位置是对的，不能因此判失败
    const stack = document.elementsFromPoint(centerX, centerY)
    return {
      canvasBottom: Math.round(canvasBox.bottom),
      barTop: Math.round(barBox.top),
      barBottom: Math.round(barBox.bottom),
      barWidth: Math.round(barBox.width),
      barHeight: Math.round(barBox.height),
      opacity: Number(style.opacity),
      visibility: style.visibility,
      stackHasBar: stack.includes(bar),
      stackTop: stack[0] ? `${stack[0].tagName}.${String(stack[0].className).slice(0, 40)}` : 'null',
      viewportHeight: window.innerHeight,
      backing: [canvas.width, canvas.height],
      css: [Math.round(canvasBox.width), Math.round(canvasBox.height)],
      dpr: window.devicePixelRatio,
    }
  })

/**
 * 按时间戳切出「本轮之后」的日志
 *
 * Sidecar 日志是**追加**的，上一轮跑的「全局截图完成」还躺在文件里，
 * 直接 includes 会立刻命中旧记录（这条坑实际踩过：出口断言拿到了上一轮的行）。
 * 日志行首就是本地时间 `YYYY-MM-DD HH:MM:SS.mmm`，定长字符串比较即可。
 */
const stampOf = (date) => {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
const linesSince = (text, stamp) =>
  text
    .split('\n')
    .filter((line) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /.test(line)
      ? line.slice(0, 23) >= stamp
      : true))
    .join('\n')

/** 轮询 Sidecar 日志，直到**触发之后**出现某段文字（超时返回 false） */
const waitLog = async (needle, stamp, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (linesSince(await readLogTail(), stamp).includes(needle)) return true
    await page.waitForTimeout(250)
  }
  return false
}

if (existsSync(DIAG_KEYS)) {
  const assetsBeforeHotkey = existsSync(join(WORKSPACE, 'assets'))
    ? readdirSync(join(WORKSPACE, 'assets')).length
    : 0
  // 留 300ms 余量：日志时间戳取的是写入时刻，触发时刻可能比它早一点点
  const triggerStamp = stampOf(new Date(Date.now() - 300))
  const hotkeyStarted = Date.now()
  execFileSync(DIAG_KEYS, ['keys', 'Ctrl+Alt+F9'])

  // 关键回归：按热键后要在**桌面上原地**出标注工具栏，而不是把图丢进剪贴板再跳回插件弹浮层。
  // 用户反馈过「全局截图没有出现工具栏就直接复制到了剪贴板」「要切回 dbx 才能标注」。
  let annotateReady = await waitLog('截图工具栏已就绪', triggerStamp, 15000)
  check('全局热键当场弹出标注工具栏', annotateReady, `${Date.now() - hotkeyStarted}ms`)
  if (!annotateReady) {
    // 锁屏 / 远程会话里系统会丢掉注入的按键（RegisterHotKey 成功但收不到 WM_HOTKEY）。
    // 这种情况下改用自检入口跑**同一条链路**（capture_to_clipboard），
    // 断言的内容不变，只是触发方式从键盘换成 RPC。
    console.log('  （按键注入未生效：改用自检入口跑同一条全局截图链路）')
    const viaRpc = await page
      .evaluate(async () => {
        try {
          return await window.dbxPlugin.invoke(
            'screenshot/globalShot',
            { exit: 'record' },
            { timeoutMs: 60000 },
          )
        } catch (error) {
          return { error: String(error?.message ?? error) }
        }
      })
      .catch((error) => ({ error: String(error?.message ?? error) }))
    check('自检入口可跑通全局截图链路', viaRpc?.ok === true, JSON.stringify(viaRpc))
    annotateReady = await waitLog('截图工具栏已就绪', triggerStamp, 15000)
  }
  check(
    '全局截图不再跳回插件弹浮层',
    (await page.locator('[data-screenshot-overlay]').count()) === 0,
  )

  // 探针：工具栏是不是真的排出来了、按钮是不是都在窗口内、档位是不是和插件浮层同一套
  const probe = await page.evaluate(async () => {
    try {
      return await window.dbxPlugin.invoke('screenshot/window', {}, { timeoutMs: 10000 })
    } catch {
      return null
    }
  })
  const annotate = probe?.annotate ?? null
  check('原生窗口报告进入标注阶段', Boolean(annotate?.ready), JSON.stringify(annotate))
  check(
    '工具栏整条落在窗口内且按钮齐全',
    Boolean(annotate) &&
      annotate.barInsideWindow === true &&
      annotate.bar[2] > 200 &&
      annotate.bar[3] >= 24 &&
      // 默认工具是「选择」，没有颜色行与滑轨：
      // 7 工具 + 撤销/重做 + 关闭/复制/钉图/下载/插入 + 主按钮 = 15
      annotate.buttons >= 15,
    JSON.stringify(annotate && { bar: annotate.bar, buttons: annotate.buttons }),
  )
  check(
    '工具 / 颜色 / 粗细与插件浮层同一套',
    // 档位与参考项目 page.tsx 对齐：7 工具 / 8 色 / 线宽 1..12 连续滑轨。
    // 调色板固定 8（`palette`），`colors` 是这一版真的画出来的色点数（选择工具下 0）。
    JSON.stringify(annotate?.tools) ===
      JSON.stringify(['Select', 'Rect', 'Ellipse', 'Arrow', 'Pen', 'Text', 'Mosaic']) &&
      annotate?.palette === 8 &&
      JSON.stringify(annotate?.widths) === JSON.stringify([1, 12]),
    JSON.stringify(
      annotate && {
        tools: annotate.tools,
        palette: annotate.palette,
        colors: annotate.colors,
        widths: annotate.widths,
      },
    ),
  )

  // 出口：`AUTO_EXIT` 设了 record / insert 时 Sidecar 会挂起并前置宿主，页面拿到后**直接收尾**；
  // 没设则等于按 Esc，什么都不该发生。两种情况都必须有明确结局。
  let finished = await waitLog('全局截图完成', triggerStamp, 12000)
  if (!finished && !linesSince(await readLogTail(), triggerStamp).includes('全局截图已取消')) {
    // 热键真的弹了窗但没人点出口（devhost 没设 AUTO_EXIT）：按 Esc 收掉，
    // 否则这条置顶窗口会一直盖着桌面，把后面的用例也堵死
    execFileSync(DIAG_KEYS, ['keys', 'Escape'])
    await waitLog('全局截图已取消', triggerStamp, 8000)
  }
  const tail = linesSince(await readLogTail(), triggerStamp)
  if (finished) {
    const action = tail.includes('全局截图完成：Record') ? 'record' : 'insert'
    const settled = await waitLog(`出口=${action}`, triggerStamp, 15000)
    check('全局截图确认后直接收尾，不再弹第二个浮层', settled)
    check('收尾后页面依旧没有截图浮层', (await page.locator('[data-screenshot-overlay]').count()) === 0)
    // 图要真的落到工作区：落盘成功才算这条链路闭环
    let assetsAfter = assetsBeforeHotkey
    for (let index = 0; index < 20 && assetsAfter <= assetsBeforeHotkey; index += 1) {
      await page.waitForTimeout(250)
      assetsAfter = existsSync(join(WORKSPACE, 'assets'))
        ? readdirSync(join(WORKSPACE, 'assets')).length
        : 0
    }
    check(
      '全局截图落盘到工作区',
      assetsAfter > assetsBeforeHotkey,
      `${assetsBeforeHotkey} → ${assetsAfter}`,
    )
  } else if (tail.includes('全局截图已取消')) {
    console.log('  （跳过出口断言：devhost 未设 DBX_NOTE_SCREENSHOT_AUTO_EXIT，等价于按 Esc）')
  } else {
    check('全局截图有明确结局（完成或取消）', false, '既没有完成也没有取消')
  }
  check(
    '日志里新增了界面侧收尾记录',
    linesSince(await readLogTail(), triggerStamp).includes('取到全局截图') || !finished,
  )
  check('日志里记录了界面就绪', (await readLogTail()).includes('[ui] 界面就绪'))
} else {
  console.log('  （跳过全局热键实测：缺少 diag_drag.exe，先 cargo build --release --example diag_drag）')
}

// 不带头部 Ctrl/⌘ 的绑定也要能唤起（默认截图就是 Alt+Shift+Z，早期实现会在这里漏掉）
await shotShortcut.fill('Alt+Shift+F7')
await page.waitForTimeout(500)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.keyboard.press('Alt+Shift+F7')
const altShotOpened = await page
  .waitForSelector('[data-screenshot-overlay]', { timeout: 20000 })
  .then(() => true)
  .catch(() => false)
check('Alt 开头的绑定同样能唤出截图', altShotOpened)
if (altShotOpened) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}
await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '快捷键' }).click()
await page.waitForTimeout(500)
await page.getByLabel('截图', { exact: true }).fill('Alt+Shift+Z')
await page.waitForTimeout(400)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

/* ---------- 设置 → 关于：Sidecar 日志入口 ---------- */

await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '关于' }).click()
await page.waitForTimeout(700)
const logPathText = (await page.locator('[data-log-view]').isVisible().catch(() => false))
  ? await page.getByText(/sidecar\.log/).first().innerText().catch(() => '')
  : ''
check('关于页显示日志文件路径', logPathText.includes('sidecar.log'), logPathText)
await page.locator('[data-log-view]').click()
await page.waitForTimeout(900)
const logText = (await page.locator('[data-sidecar-log]').innerText().catch(() => '')) || ''
check('日志弹窗打开且有内容', logText.length > 10 && logText.includes('[dbx-note]'), logText.slice(0, 120))
check('日志里记录了启动信息', logText.includes('Sidecar 启动'), logText.slice(0, 120))
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

// 截图工具：快捷键唤出浮层 → 框选 → 标注 → 复制 / 插入笔记 / 保存到记录
const assetsDir = join(WORKSPACE, 'assets')
const countAssets = () => (existsSync(assetsDir) ? readdirSync(assetsDir).length : 0)
const shotsBefore = countAssets()
await page.locator('.ProseMirror').click()
await page.waitForTimeout(300)
// 先探一次：确认 /rpc 链路上的抓屏是通的（失败时下面断言才定位得到）
const captureProbe = await page.evaluate(async () => {
  const started = performance.now()
  try {
    const result = await window.dbxPlugin.invoke('screen/capture', {}, { timeoutMs: 30000 })
    return { ms: Math.round(performance.now() - started), length: result?.dataBase64?.length ?? 0 }
  } catch (error) {
    return { ms: Math.round(performance.now() - started), error: String(error) }
  }
})
console.log(`  抓屏探针：${JSON.stringify(captureProbe)}`)
check('RPC 抓屏链路可用', !('error' in captureProbe), JSON.stringify(captureProbe))

// 编辑器头部有可见的截图入口，点它比依赖按键更稳（宿主可能占用组合键）
await page.locator('[data-editor-screenshot]').click()
await page.waitForSelector('[data-screenshot-overlay]', { timeout: 30000 })
check('截图浮层已打开', (await page.locator('[data-screenshot-overlay]').count()) === 1)
check('截图工具条含七个工具', (await page.locator('[data-shot-tool]').count()) === 7)
// 同一条几何断言也放这里跑一遍：这条入口不依赖真实桌面（全局热键那条要桌面 + 按键），
// 锁屏 / 无头机器上也守得住「工具条跑出视口或没画出来」的回归
const overlayGeometry = await measureShotOverlay(page)
check(
  '浮层工具栏在图片正下方且在视口内',
  Boolean(overlayGeometry) &&
    overlayGeometry.barTop >= overlayGeometry.canvasBottom - 1 &&
    overlayGeometry.barBottom <= overlayGeometry.viewportHeight &&
    overlayGeometry.barWidth > 200 &&
    overlayGeometry.barHeight >= 28 &&
    overlayGeometry.visibility === 'visible',
  JSON.stringify(overlayGeometry),
)
check(
  '浮层工具栏占据的位置属于浮层',
  Boolean(overlayGeometry) && overlayGeometry.stackHasBar,
  JSON.stringify(overlayGeometry && { stackTop: overlayGeometry.stackTop }),
)
check(
  '浮层画布后备像素与 CSS 尺寸成 dpr 整数倍',
  Boolean(overlayGeometry) &&
    Math.abs(overlayGeometry.backing[0] - Math.round(overlayGeometry.css[0] * overlayGeometry.dpr)) <= 1 &&
    Math.abs(overlayGeometry.backing[1] - Math.round(overlayGeometry.css[1] * overlayGeometry.dpr)) <= 1,
  JSON.stringify(overlayGeometry && { backing: overlayGeometry.backing, css: overlayGeometry.css, dpr: overlayGeometry.dpr }),
)
await page.screenshot({ path: join(SHOTS, '56-screenshot-tool.png') })

// 框选一块区域：选区尺寸角标要出现
const shotBox = await page.locator('[data-screenshot-canvas]').boundingBox()
await page.mouse.move(shotBox.x + 80, shotBox.y + 60)
await page.mouse.down()
await page.mouse.move(shotBox.x + 420, shotBox.y + 300, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
check('框选后显示选区尺寸', (await page.locator('[data-screenshot-size]').count()) === 1)

// 矩形标注 + 撤销栈
await page.locator('[data-shot-tool="rectangle"]').click()
await page.mouse.move(shotBox.x + 120, shotBox.y + 100)
await page.mouse.down()
await page.mouse.move(shotBox.x + 300, shotBox.y + 220, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(300)
check('标注后撤销可用', await page.locator('[data-shot-undo]').isEnabled())
await page.screenshot({ path: join(SHOTS, '57-screenshot-annotate.png') })

// 复制：走 Sidecar 写系统剪贴板（宿主 iframe 里 Clipboard API 常被拒）
await page.locator('[data-shot-copy]').click()
let copyToasts = []
for (let attempt = 0; attempt < 20; attempt += 1) {
  await page.waitForTimeout(400)
  copyToasts = await page.locator('[data-sonner-toast]').allInnerTexts()
  if (copyToasts.some((text) => text.includes('已复制'))) break
}
check(
  '截图可复制到剪贴板',
  copyToasts.some((text) => text.includes('已复制')),
  JSON.stringify(copyToasts),
)

// 插入笔记：整屏（默认全选）落盘 → 正文出现图片
await page.locator('[data-editor-screenshot]').click()
await page.waitForSelector('[data-screenshot-overlay]', { timeout: 30000 })
await page.locator('[data-shot-insert]').click()
let shotsAfter = shotsBefore
for (let attempt = 0; attempt < 40; attempt += 1) {
  await page.waitForTimeout(500)
  shotsAfter = countAssets()
  if (shotsAfter > shotsBefore) break
}
check('截图落盘到图片目录', shotsAfter > shotsBefore, `${shotsBefore} -> ${shotsAfter}`)
check('截图已插入笔记', (await page.locator('.ProseMirror img').count()) > 0)
await page.screenshot({ path: join(SHOTS, '50-screenshot-inserted.png') })

// 保存到记录：记录面板里出现图片缩略图
// 先把图床切成 PicGo 并指向本地假服务——这一步同时验证「截图存记录会上传图床」
/** 从页面里打开发宿主的 /rpc，读到 Sidecar 真正落盘的设置 */
const rpcFromPage = (method, params) =>
  page.evaluate(
    async ([method, params]) => {
      const response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
      const payload = await response.json()
      return payload.error ? { __error: payload.error.message } : payload.result
    },
    [method, params],
  )
const hostingProvider = async () => {
  const stored = await rpcFromPage('settings/get', { key: 'app.settings' })
  const value = typeof stored === 'string' ? JSON.parse(stored) : stored
  const hosting = value?.value?.imageHosting ?? value?.imageHosting
  return hosting?.provider ?? ''
}

await settingsButton().click()
await page.waitForTimeout(600)
await page.getByRole('dialog').getByRole('button', { name: '图片存储' }).click()
await page.waitForTimeout(600)
await page.locator('[data-provider="picgo"]').click()
await page.waitForTimeout(500)
const picgoInput = page.locator('input[aria-label="PicGo 服务器地址"]')
check('切到 PicGo 后出现服务器地址输入', (await picgoInput.count()) > 0)
await picgoInput.fill('http://127.0.0.1:5199/upload')
await page.waitForTimeout(300)
await picgoInput.blur()
await page.waitForTimeout(400)
// 改完地址要显式点「测试连接」：进页面时那次自动检测用的是默认 36677，会失败
await page.getByRole('button', { name: '测试连接' }).first().click()
await page.waitForTimeout(800)
// 检测通过之后「使用此服务」才可点。全流程跑到这里时后端还在处理前面的请求，
// 自动检测 / 手动检测可能交错，所以等不到「已连接」就补点一次检测再等。
const picgoUse = page.getByRole('button', { name: '使用此服务' })
for (let attempt = 0; attempt < 30; attempt += 1) {
  if ((await picgoUse.count()) > 0 && !(await picgoUse.isDisabled())) break
  if (attempt === 4 || attempt === 10 || attempt === 18) {
    await page.getByRole('button', { name: '测试连接' }).first().click().catch(() => {})
  }
  await page.waitForTimeout(400)
}
if ((await picgoUse.count()) > 0 && !(await picgoUse.isDisabled())) {
  await picgoUse.click()
  await page.waitForTimeout(600)
} else if (process.env.DBX_NOTE_E2E_DEBUG) {
  console.log('  [debug] PicGo 仍未连接：', (await page.getByRole('dialog').innerText()).slice(-280))
}
// 以磁盘上真正保存的 provider 为准：按钮文案容易和左边页签选中混淆
let savedProvider = ''
for (let attempt = 0; attempt < 20; attempt += 1) {
  savedProvider = await hostingProvider()
  if (savedProvider === 'picgo') break
  await page.waitForTimeout(300)
}
check('切到 PicGo 图床生效', savedProvider === 'picgo', savedProvider)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)

await page.locator('[data-editor-screenshot]').click()
await page.waitForSelector('[data-screenshot-overlay]', { timeout: 30000 })
await page.locator('[data-shot-save]').click()
let recordToasts = []
for (let attempt = 0; attempt < 20; attempt += 1) {
  await page.waitForTimeout(400)
  recordToasts = await page.locator('[data-sonner-toast]').allInnerTexts()
  if (recordToasts.some((text) => text.includes('已保存到记录'))) break
}
check(
  '截图可保存到记录',
  recordToasts.some((text) => text.includes('已保存到记录')),
  JSON.stringify(recordToasts),
)
await page.getByRole('button', { name: '记录', exact: true }).first().click()
await page.waitForTimeout(900)
check('记录里出现图片缩略图', (await page.locator('[data-record-image]').count()) > 0)

// 存进记录后要请识别模型解读这张图，结果写在该记录的 meta.text 里。
// 记录会先落一条「正在识别图片…」占位，所以这里要等到真结果，不能只等元素出现。
let insightText = ''
for (let attempt = 0; attempt < 60; attempt += 1) {
  insightText = await page
    .locator('[data-record-insight]')
    .first()
    .innerText()
    .catch(() => '')
  if (insightText.includes('DBX 笔记')) break
  await page.waitForTimeout(500)
}
check('截图记录附带图像识别结果', insightText.includes('DBX 笔记'), insightText)

// 图床上传是「后置增强」：成功了记录里的图片地址要换成远端 URL
let hostedSrc = ''
for (let attempt = 0; attempt < 40; attempt += 1) {
  hostedSrc = await page
    .locator('[data-record-image] img')
    .first()
    .getAttribute('alt')
    .catch(() => '')
  if (hostedSrc && hostedSrc.startsWith('http://127.0.0.1:5199/files/')) break
  await page.waitForTimeout(500)
}
check(
  '截图上传图床后记录改用远端地址',
  Boolean(hostedSrc && hostedSrc.startsWith('http://127.0.0.1:5199/files/')),
  hostedSrc ?? '',
)

// 还原成本地存储，后面的用例仍然按工作区路径走
await settingsButton().click()
await page.waitForTimeout(500)
await page.getByRole('dialog').getByRole('button', { name: '图片存储' }).click()
await page.waitForTimeout(500)
await page.locator('[data-provider="local"]').click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: '使用本地存储' }).click().catch(() => {})
await page.waitForTimeout(500)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
check('图床已还原成本地存储', (await hostingProvider()) === 'local')
await page.screenshot({ path: join(SHOTS, '58-screenshot-record.png') })
await page.getByRole('button', { name: '文件', exact: true }).first().click()
await page.waitForTimeout(500)

/* ---------- 编辑器底栏：复制 / 导出 / 历史版本 ---------- */

// 先确保编辑器里有打开的笔记，底栏只在有 activePath 时渲染
if ((await tabList.getByRole('tab').count()) > 0) {
  await tabList.getByRole('tab').first().click()
} else {
  await page.locator('text=周会纪要').first().click()
}
await page.waitForTimeout(700)
check('编辑器底栏可见', await page.locator('[data-editor-footer]').isVisible())
check('底栏提供复制 / 导出', (await page.locator('[data-footer-copy]').count()) === 1
  && (await page.locator('[data-footer-export]').count()) === 1)
check('底栏显示字符数', (await page.locator('[data-footer-chars]').innerText()).includes('字符'))
// 与参考项目一致：没配置 Git 远端同步时不显示「历史版本」入口
check('未配置 Git 远端时历史版本入口隐藏', (await page.locator('[data-footer-history]').count()) === 0)

// 复制：4 种格式齐全，点 Markdown 后给出「已复制」反馈
await page.locator('[data-footer-copy]').click()
await page.waitForTimeout(300)
check('复制菜单含 4 种格式', (await page.locator('[data-copy-format]').count()) === 4)
await page.locator('[data-copy-format="markdown"]').click()
await page.waitForTimeout(500)
check(
  '复制 Markdown 给出反馈',
  (await page.locator('[data-sonner-toast]').allInnerTexts()).some((text) => text.includes('已复制')),
)

// 导出：4 种格式齐全；文件必须**真的落盘**，且 toast 回显保存位置
const EXPORT_DIR = join(ROOT, '.tmp', 'e2e-exports')
// 每次从空目录开始：下面用「新出现的文件名」判定格式是否串了，旧产物会让断言失效
rmSync(EXPORT_DIR, { recursive: true, force: true })
mkdirSync(EXPORT_DIR, { recursive: true })
await page.locator('[data-footer-export]').click()
await page.waitForTimeout(300)
check('导出菜单含 4 种格式', (await page.locator('[data-export-format]').count()) === 4)
await page.locator('[data-export-format="markdown"]').click()
await page.waitForTimeout(900)
const exportToasts = await page.locator('[data-sonner-toast]').allInnerTexts()
check('导出 Markdown 给出反馈', exportToasts.some((text) => text.includes('已导出')))
check('导出反馈回显保存位置', exportToasts.some((text) => text.includes('保存位置')))
const exportedMd = existsSync(EXPORT_DIR)
  ? readdirSync(EXPORT_DIR).filter((name) => name.endsWith('.md'))
  : []
check('导出文件真的写到磁盘', exportedMd.length >= 1, `找到 ${exportedMd.length} 个 .md`)
check(
  '导出内容是笔记 Markdown 正文',
  exportedMd.some((name) => /^# /m.test(readFileSync(join(EXPORT_DIR, name), 'utf8'))),
)

// 回归用户反馈「几种导出类型点完都是 html」：每种格式必须落盘对应后缀与正文，
// 不能串到 html，也不能出现「笔记.html.md」这类双后缀。
for (const format of ['html', 'json']) {
  const before = existsSync(EXPORT_DIR) ? readdirSync(EXPORT_DIR) : []
  await page.locator('[data-footer-export]').click()
  await page.waitForTimeout(250)
  await page.locator(`[data-export-format="${format}"]`).click()
  await page.waitForTimeout(800)
  const created = existsSync(EXPORT_DIR)
    ? readdirSync(EXPORT_DIR).filter((name) => !before.includes(name))
    : []
  check(
    `导出 ${format.toUpperCase()} 生成 .${format} 文件`,
    created.some((name) => name.endsWith(`.${format}`)),
    created.join(','),
  )
  if (format !== 'html') {
    check(
      `导出 ${format.toUpperCase()} 未错误产出 HTML`,
      !created.some((name) => /\.html(\.|$)/.test(name)),
      created.join(','),
    )
  }
  check(
    `导出 ${format.toUpperCase()} 未生成双后缀文件`,
    !created.some((name) => /\.(md|html|json)\.(md|html|json)$/.test(name)),
    created.join(','),
  )
  const target = created.find((name) => name.endsWith(`.${format}`))
  if (target) {
    const body = readFileSync(join(EXPORT_DIR, target), 'utf8')
    // 笔记正文会被前面的用例改写，这里只断言「完整 HTML 文档 + 确实渲染出块级内容」
    if (format === 'html') {
      check(
        '导出 HTML 含文档骨架与正文',
        /<html[\s>]/i.test(body) && /<(h[1-6]|p|ul|ol|li|blockquote|pre)[\s>]/i.test(body),
      )
    }
    else check('导出 JSON 是 Tiptap 文档', (() => { try { return JSON.parse(body).type === 'doc' } catch { return false } })())
  }
}

// 回归用户反馈「导出 PDF 弹出保存 print.html」：0.5.6 起只唤起系统打印预览，绝不写 HTML 文件
const beforePdf = existsSync(EXPORT_DIR) ? readdirSync(EXPORT_DIR) : []
await page.locator('[data-footer-export]').click()
await page.waitForTimeout(250)
await page.locator('[data-export-format="pdf"]').click()
await page.waitForTimeout(1200)
const pdfCreated = existsSync(EXPORT_DIR)
  ? readdirSync(EXPORT_DIR).filter((name) => !beforePdf.includes(name))
  : []
check('PDF 导出不再保存 print.html',
  !pdfCreated.some((name) => name.includes('print.html')), pdfCreated.join(','))

/* ---------- 文件树「更多」菜单与右键菜单（对齐参考项目） ---------- */

await page.getByRole('button', { name: '文件', exact: true }).first().click()
await page.waitForTimeout(400)
check('文件树工具栏出现「更多操作」', (await page.locator('[data-files-more]').count()) === 1)
await page.locator('[data-files-more]').click()
await page.waitForTimeout(350)
check('更多菜单含文件视图 / 远程 / 知识库三组', (await page.locator('[data-files-more-menu]').count()) === 1)
check('更多菜单含排序入口', (await page.locator('[data-files-sort]').count()) === 1)
check('更多菜单含全部折叠', (await page.locator('[data-files-collapse-all]').count()) === 1)
for (const key of ['show-assets', 'show-kb', 'show-remote', 'sync-assets', 'auto-kb']) {
  check(`更多菜单含开关 ${key}`, (await page.locator(`[data-files-${key}]`).count()) === 1)
}
for (const key of ['reindex', 'upload-kb', 'download-kb', 'import-notes', 'import-markdown', 'import-notion']) {
  check(`更多菜单含动作 ${key}`, (await page.locator(`[data-files-${key}]`).count()) === 1)
}
// 排序子菜单：切到「修改时间」并验证设置已持久化
await page.locator('[data-files-sort]').hover()
await page.waitForTimeout(400)
if ((await page.locator('[data-files-sort-by]').count()) === 0) {
  await page.locator('[data-files-sort]').click()
  await page.waitForTimeout(400)
}
check('排序子菜单列出三种字段', (await page.locator('[data-files-sort-by]').count()) === 3)
await page.locator('[data-files-sort-by="mtime"]').click()
await page.waitForTimeout(400)
const storedFileView = await rpcFromPage('settings/get', { key: 'app.settings' })
const fileViewValue = typeof storedFileView === 'string' ? JSON.parse(storedFileView) : storedFileView
check('排序偏好写入设置', (fileViewValue?.value?.fileView ?? fileViewValue?.fileView)?.sortBy === 'mtime',
  JSON.stringify(fileViewValue?.value?.fileView ?? fileViewValue?.fileView))
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 文件右键菜单：参考项目 file-item.tsx —— 新窗口 / 只读 / 导出 / 上传文件 + 知识库 + 剪贴板
await page.locator('[data-tree-node="周会纪要.md"]').click({ button: 'right' })
await page.waitForTimeout(400)
check('文件右键菜单已打开', (await page.locator('[data-tree-menu][data-tree-kind="file"]').count()) === 1)
for (const action of [
  'open-new-window', 'open-read-only', 'reveal', 'template', 'export', 'upload-file',
  'kb', 'cut', 'copy', 'paste', 'rename', 'delete',
]) {
  check(`文件右键含 ${action}`, (await page.locator(`[data-tree-action="${action}"]`).count()) === 1)
}
for (const action of ['new-file', 'new-folder', 'duplicate', 'upload-folder']) {
  check(`文件右键不含 ${action}`, (await page.locator(`[data-tree-action="${action}"]`).count()) === 0)
}
check('文件右键显示 F2 / Del 快捷键', (await page.locator('[data-tree-menu]').innerText()).includes('F2'))
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 文件夹右键菜单：参考项目 folder-item/index.tsx —— 新建 / 展开折叠 / 副本 / 上传下载文件夹
await page.locator('[data-tree-node="项目"]').click({ button: 'right' })
await page.waitForTimeout(400)
check('文件夹右键菜单已打开', (await page.locator('[data-tree-menu][data-tree-kind="folder"]').count()) === 1)
for (const action of [
  'new-file', 'new-folder', 'reveal', 'template', 'kb',
  'cut', 'copy', 'duplicate', 'paste', 'upload-folder', 'download-folder',
  'rename', 'delete',
]) {
  check(`文件夹右键含 ${action}`, (await page.locator(`[data-tree-action="${action}"]`).count()) === 1)
}
for (const action of ['open-new-window', 'open-read-only', 'export', 'upload-file']) {
  check(`文件夹右键不含 ${action}`, (await page.locator(`[data-tree-action="${action}"]`).count()) === 0)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

/* ---------- 历史版本：准备真实 Git 提交历史（对齐参考项目远端 commit 列表） ---------- */

/** 在工作区里跑 git；e2e 里 origin 是示例地址，devhost 已开 DBX_NOTE_HISTORY_OFFLINE 跳过联网 */
const gitE2e = (...args) => execFileSync('git', ['-C', WORKSPACE, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
try {
  gitE2e('init')
  gitE2e('config', 'user.email', 'e2e@example.com')
  gitE2e('config', 'user.name', 'dbx-note e2e')
  try { gitE2e('remote', 'remove', 'origin') } catch { /* 本来就没有 */ }
  gitE2e('remote', 'add', 'origin', 'https://github.com/e2e-user/e2e-notes.git')
  gitE2e('add', '-A')
  try { gitE2e('commit', '-m', 'e2e: 初始提交') } catch { /* 已有提交 */ }
  // 模拟「已 fetch 过的远端跟踪引用」，offline 模式下 history/commits 从这里取历史
  const head = gitE2e('rev-parse', 'HEAD').trim()
  gitE2e('update-ref', 'refs/remotes/origin/main', head)
} catch (error) {
  console.error('  ! 准备 Git 历史失败：', error.message)
}
// 同步平台可能在前文被切到对象存储，这里改回 github（走 devhost 的 /rpc 直达 Sidecar）
await page.evaluate(async () => {
  await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sync/saveOptions', params: { provider: 'github' } }),
  })
})
// 通知组件「同步配置已变化」重新判定入口，不触发 App 的远端清单刷新
await page.evaluate(() => window.dispatchEvent(new Event('dbx:sync-options-changed')))
await page.waitForTimeout(1200)
check('配置 Git 远端后出现历史版本入口', (await page.locator('[data-footer-history]').count()) === 1)

if ((await page.locator('[data-footer-history]').count()) === 1) {
  await page.locator('[data-footer-history]').click()
  await page.waitForTimeout(1200)
  check('历史版本面板列出远端提交', (await page.locator('[data-history-commit]').count()) >= 1)
  check('提交条目有可点开的短 sha 链接',
    (await page.locator('[data-history-commit-link]').first().getAttribute('href'))?.includes('/commit/') === true)
  check('面板提供「在仓库中打开」链接',
    (await page.locator('[data-history-open-repo]').first().getAttribute('href'))?.includes('/blob/') === true)
  await page.locator('[data-history-restore]').first().click()
  await page.waitForTimeout(500)
  check(
    '恢复历史版本前弹出二次确认',
    (await page.getByRole('button', { name: '确认恢复' }).count()) === 1
      && (await page.getByRole('button', { name: '取消' }).count()) >= 1,
  )
  await page.getByRole('button', { name: '取消' }).last().click()
  await page.waitForTimeout(400)
  check('取消恢复后确认框关闭', (await page.getByRole('button', { name: '确认恢复' }).count()) === 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

/* ---------- 知识库 / 记忆 ---------- */

await settingsButton().click()
await page.waitForTimeout(400)
await page.getByRole('dialog').getByRole('button', { name: '知识库', exact: true }).click()
await page.waitForTimeout(500)
const ragPanel = page.locator('[data-settings-panel="rag"]')
// 设置页切换是异步提交，先显式等面板出现再数控件，避免固定 waitForTimeout 在慢机器上误报
await ragPanel.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
check('知识库设置页渲染 RAG 面板', (await ragPanel.count()) >= 1)
check('RAG 索引参数四项齐全', (await ragPanel.locator('input[type="number"]').count()) === 4)
check('RAG 索引操作按钮齐全',
  (await ragPanel.locator('[data-rag-action="rebuild"]').count()) === 1
  && (await ragPanel.locator('[data-rag-action="clear"]').count()) === 1
  && (await ragPanel.locator('[data-rag-action="diagnose"]').count()) === 1)
const injectSwitch = ragPanel.getByRole('switch', { name: '对话前自动注入知识库' })
check('对话前自动注入知识库默认开启', (await injectSwitch.getAttribute('aria-checked')) === 'true')
const knowledgeSwitch = ragPanel.getByRole('switch', { name: '知识库检索' })
if ((await knowledgeSwitch.getAttribute('aria-checked')) !== 'true') {
  await knowledgeSwitch.click()
  await page.waitForTimeout(400)
}
check('知识库开关可开启', (await knowledgeSwitch.getAttribute('aria-checked')) === 'true')

await page.getByRole('dialog').getByRole('button', { name: '记忆管理', exact: true }).click()
await page.waitForTimeout(400)
const memoryInput = page.locator('input[aria-label="长期记忆"]')
await memoryInput.click()
await memoryInput.fill('回答先给结论')
await memoryInput.press('Enter')
await page.waitForTimeout(500)
check('记忆条目已保存', (await page.locator('text=回答先给结论').count()) > 0)
await page.screenshot({ path: join(SHOTS, '17-assistant.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

check(
  '对话面板默认引用知识库',
  (await page.locator('[data-chat-knowledge]').getAttribute('aria-pressed')) === 'true',
)
await page.locator('textarea[placeholder*="输入问题"]').fill('这个工作区有哪些需求？')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')
await page.waitForTimeout(4000)
check('知识库对话返回内容', (await page.locator('.markdown-body').count()) > 0)

/* ---------- 图片预览 ---------- */

await page.getByRole('button', { name: '文件', exact: true }).first().click()
await page.waitForTimeout(400)
await page.locator('text=assets').first().click()
await page.waitForTimeout(400)
await page.locator('text=示意图').first().click()
await page.waitForTimeout(1000)
check('图片预览弹窗打开', (await page.getByRole('dialog').count()) > 0)
check('图片内容已内联加载', (await page.getByRole('dialog').locator('img').count()) > 0)
await page.screenshot({ path: join(SHOTS, '20-image.png') })

// 图片识别（走假模型服务的多模态分支）
await page.getByRole('button', { name: '识别文字' }).click()
await page.waitForTimeout(3000)
check('图片识别返回文字', (await page.locator('[data-ocr-result]').count()) > 0)
check(
  '识别结果展示在图片下方',
  (await page.locator('[data-ocr-result]').innerText()).includes('测试图片'),
)
await page.screenshot({ path: join(SHOTS, '23-ocr.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

/* ---------- 语音转写 ---------- */

const audioFile = join(DATA_DIR, 'sample.webm')
writeFileSync(audioFile, Buffer.from('fake-webm-bytes'))
await page.keyboard.press('Control+Shift+V')
await page.waitForTimeout(700)
check('语音面板可打开', (await page.getByRole('dialog').count()) > 0)
// 录音走 Sidecar 的系统麦克风：有设备就进录音态，没有则给出可用提示（两条都不是死路）
await page.getByRole('button', { name: '开始录音' }).click()
await page.waitForTimeout(1800)
const recordLabel = await page.locator('[data-voice-record]').innerText()
const inRecording = recordLabel.includes('停止')
const hasNotice = (await page.locator('[data-voice-notice]').count()) === 1
check('点录音进入录音态或给出可用提示', inRecording || hasNotice, recordLabel.replace(/\s+/g, ' '))
if (inRecording) {
  await page.waitForTimeout(1500)
  await page.locator('[data-voice-record]').click()
  await page.waitForTimeout(3200)
  const recorded = await page.locator('[data-voice-result]').inputValue()
  check('录音结束后自动转写', recorded.length > 0, recorded.slice(0, 24))
}
await page.screenshot({ path: join(SHOTS, '45-voice-host-denied.png') })
await page.locator('input[type="file"][accept="audio/*"]').setInputFiles(audioFile)
await page.waitForTimeout(3000)
check(
  '音频文件转写返回文本',
  (await page.locator('[data-voice-result]').inputValue()).includes('语音'),
)
await page.screenshot({ path: join(SHOTS, '24-voice.png') })
await page.getByRole('button', { name: '取消' }).click()
await page.waitForTimeout(400)

/* ---------- 本地 MCP 工具 ---------- */

await settingsButton().click()
await page.waitForTimeout(500)
// 对话面板也有「工具」开关，这里限定在设置弹窗内
await page.getByRole('dialog').getByRole('button', { name: 'MCP', exact: true }).click()
await page.waitForTimeout(500)
// 已有配置就清掉，保证从「未配置」状态开始
while ((await page.getByRole('button', { name: '移除服务' }).count()) > 0) {
  await page.getByRole('button', { name: '移除服务' }).first().click()
  await page.waitForTimeout(400)
}
await page.getByRole('button', { name: '添加服务' }).click()
await page.waitForTimeout(500)
await page.getByLabel('启动命令').fill(process.execPath)
await page.getByLabel('启动参数').fill(join(ROOT, 'scripts', 'mock-mcp.mjs'))
await page.waitForTimeout(300)
await page.getByRole('button', { name: '检测工具' }).click()
// MCP 服务是 Sidecar 现场起的子进程，握手 + 列工具可能超过固定 4 秒；显式等结果
await page.locator('text=echo').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
check('检测到 MCP 工具', (await page.locator('text=echo').count()) > 0)
await page.screenshot({ path: join(SHOTS, '21-tools.png') })
await page.locator('button', { hasText: 'echo' }).last().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '试运行' }).click()
await page.waitForTimeout(4000)
check('工具试运行返回结果', (await page.locator('text=echo:').count()) > 0)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)

/* ---------- 窄屏布局 ---------- */

await page.setViewportSize({ width: 390, height: 780 })
await page.waitForTimeout(800)
check('窄屏出现底部导航', (await page.getByRole('navigation').count()) > 0)
await page.getByRole('navigation').getByRole('button', { name: '文件' }).click()
await page.waitForTimeout(500)
check(
  '窄屏可切到文件栏',
  // 侧栏页签只在侧栏里出现，用它判断单栏已切到文件栏
  (await page.getByRole('button', { name: '记录', exact: true }).count()) > 0,
)
await page.screenshot({ path: join(SHOTS, '18-mobile.png') })
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(500)

/* ---------- 公式：重新打开「同步下来」的笔记不丢公式 ---------- */

// 关掉所有标签，模拟冷启动 / 同步后重新进入；`公式往返.md` 是启动时直接以
// 原始 $...$ 与 $$...$$ 落盘的夹具，从未经过本编辑器写入。
await page.keyboard.press('Control+Shift+W')
// 关全部是异步的，且可能与启动时的 restoreTabs 竞态；先等到标签真的清空
for (let attempt = 0; attempt < 20; attempt += 1) {
  if ((await page.getByRole('tablist', { name: '打开的标签' }).getByRole('tab').count()) === 0) break
  await page.waitForTimeout(200)
}
const mathNode = page.locator('[data-tree-node="公式往返.md"]').first()
await mathNode.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
// 窄屏用例刚切回宽屏，第一次点击可能被布局重排吃掉；每 10 轮补点一次，
// 并等编辑器真的加载出这篇笔记（而不是只看节点数），避免末尾状态污染造成假阴性
let mathReady = false
for (let attempt = 0; attempt < 40 && !mathReady; attempt += 1) {
  if (attempt % 10 === 0 && (await mathNode.count()) > 0) await mathNode.click().catch(() => {})
  const mathText = await page.locator('.ProseMirror').innerText().catch(() => '')
  mathReady =
    mathText.includes('公式往返') &&
    (await page.locator('.ProseMirror [data-math="inline"] math').count()) > 0
  if (!mathReady) await page.waitForTimeout(300)
}
check(
  '重新打开同步来的笔记含行内公式',
  (await page.locator('.ProseMirror [data-math="inline"] math').count()) > 0,
)
check(
  '重新打开同步来的笔记含块级公式',
  (await page.locator('.ProseMirror [data-math="block"] math').count()) > 0,
)
const syncedMathSource = readFileSync(join(WORKSPACE, '公式往返.md'), 'utf8')
check(
  '重新打开后磁盘公式未被改写',
  syncedMathSource.includes('$E = mc^2$') && syncedMathSource.includes('$$'),
)

if (badResponses.length > 0) console.log(`  失败资源：${JSON.stringify([...new Set(badResponses)])}`)
check('控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
