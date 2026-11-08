#!/usr/bin/env node
/**
 * Sidecar 协议自检
 *
 * 直接以 JSON-RPC 与 backend 可执行文件通信，覆盖：
 * 握手 / 工作区 / 文件树 / 读写 / 重命名 / 搜索 / 记录 / 标签 / 会话 / 设置 / 删除。
 *
 * 运行：node scripts/sidecar-check.mjs
 * 依赖：已构建的 backend（npm run backend）与 Node 18+
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BIN = join(ROOT, 'backend', 'target', 'release', process.platform === 'win32' ? 'backend.exe' : 'backend')
const DATA_DIR = join(ROOT, '.tmp', 'sidecar-check')
/** 以 manifest 为准，避免每次升版本都要改测试 */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))

let passed = 0
let failed = 0

/** 轮询等待本地服务可用 */
async function waitFor(url, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return false
}

/** 检查项：成功打印 ✓，失败累计 */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 本机是否装了 git（Git 通道用例依赖它） */
function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 调用 git；cwd 为空时在当前目录执行 */
function git(args, cwd) {
  return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 给临时仓库设提交身份，避免继承开发机的全局配置 */
function gitIdentity(dir) {
  git(['config', 'user.name', 'self-check'], dir)
  git(['config', 'user.email', 'check@example.com'], dir)
}

/**
 * 极简自托管同步服务：GET / PUT / DELETE 对象读写
 *
 * 用于验证「对象存储 / WebDAV / 自托管」通道真的能上传与下载，
 * 而不是只把配置存起来。
 */
function startMockStore() {
  const store = new Map()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/health') {
        response.writeHead(200)
        response.end('ok')
        return
      }
      if (request.headers.authorization !== 'Bearer test-token') {
        response.writeHead(401)
        response.end('unauthorized')
        return
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/api\/sync\//, ''))
      if (request.method === 'GET') {
        if (!store.has(key)) {
          response.writeHead(404)
          response.end('missing')
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(store.get(key))
        return
      }
      if (request.method === 'PUT') {
        store.set(key, Buffer.concat(chunks))
        response.writeHead(200)
        response.end('')
        return
      }
      if (request.method === 'DELETE') {
        store.delete(key)
        response.writeHead(204)
        response.end('')
        return
      }
      response.writeHead(405)
      response.end('')
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () =>
      resolvePromise({ server, store, port: server.address().port }),
    )
  })
}

if (!existsSync(BIN)) {
  console.error(`找不到后端可执行文件：${BIN}\n请先运行 npm run backend`)
  process.exit(1)
}

rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const child = spawn(BIN, [], {
  env: {
    ...process.env,
    DBX_PLUGIN_DATA_DIR: DATA_DIR,
    // 自检要跑在无人值守环境里：框选窗口用预设选区自动松手，全局热键不占用开发机
    DBX_NOTE_SCREENSHOT_AUTO: '120,100,360,240',
    DBX_NOTE_SHOT_HOTKEY: 'off',
    // 出口一律由 RPC 显式指定，清掉外部环境可能带进来的默认出口
    DBX_NOTE_SCREENSHOT_AUTO_EXIT: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let nextId = 1
const pending = new Map()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const resolver = pending.get(message.id)
    if (resolver) {
      pending.delete(message.id)
      if (message.error) resolver.reject(new Error(message.error.message))
      else resolver.resolve(message.result)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`))

function call(method, params = {}) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
    child.stdin.write(`${payload}\n`)
  })
}

async function main() {
  console.log('Sidecar 协议自检')

  const init = await call('plugin/initialize', { host: { protocolVersions: [1] } })
  check('握手协议版本为 1', init.protocolVersion === 1)
  check(
    '插件身份正确',
    init.plugin?.id === MANIFEST.id && init.plugin?.version === MANIFEST.version,
    `id=${init.plugin?.id} version=${init.plugin?.version} (manifest ${MANIFEST.id}@${MANIFEST.version})`,
  )

  const ping = await call('ping')
  check('ping 返回 ok', ping.ok === true)

  const workspace = await call('workspace/describe')
  check('默认工作区可用', workspace.exists && workspace.writable)

  // 文件：创建目录 / 文件 / 写入 / 读取
  await call('fs/mkdir', { parent: '', name: '日记' })
  const created = await call('fs/create', { kind: 'file', parent: '日记', name: '2026-11-02' })
  check('新建文件自动补 .md 后缀', created.path === '日记/2026-11-02.md', created.path)

  const markdown = '# 今天\n\n- 完成 DBX 笔记插件\n- 复习 Rust Sidecar\n'
  await call('fs/write', { path: created.path, content: markdown })
  const read = await call('fs/read', { path: created.path })
  check('写回内容一致', read.content === markdown)

  const tree = await call('fs/tree', {})
  check('文件树包含新建目录', tree.children.some((node) => node.name === '日记' && node.kind === 'folder'))
  const folder = tree.children.find((node) => node.name === '日记')
  check('目录内包含笔记', folder?.children?.some((node) => node.name === '2026-11-02.md'))

  // 路径穿越必须被拒绝
  let traversalBlocked = false
  try {
    await call('fs/read', { path: '../../etc/passwd' })
  } catch {
    traversalBlocked = true
  }
  check('拒绝路径穿越', traversalBlocked)

  // 重命名
  const renamed = await call('fs/rename', { path: created.path, newName: '今日总结' })
  check('重命名保留目录', renamed.path === '日记/今日总结.md', renamed.path)

  // 搜索
  const search = await call('fs/search', { query: 'Rust' })
  check('正文搜索命中', search.items.length === 1 && search.items[0].path === renamed.path)
  check('搜索摘要包含关键词', search.items[0]?.snippet?.includes('Rust'))

  // 记录与标签
  const record = await call('record/create', {
    type: 'text',
    content: '把碎片记录整理成笔记',
    tags: ['灵感', '产品'],
  })
  check('创建记录返回标签', record.tags?.length === 2)
  const recordList = await call('record/list', { tagId: record.tags[0].id })
  check('按标签过滤记录', recordList.items.length === 1)
  const tags = await call('tag/list')
  check('标签计数正确', tags.items.find((tag) => tag.name === '灵感')?.count === 1)

  await call('record/update', { id: record.id, content: '整理后的记录' })
  const updated = await call('record/list', {})
  check('更新记录内容', updated.items[0].content === '整理后的记录')

  // todo 完成态写在 meta 里，且与已有 meta 合并（不覆盖其它键）
  await call('record/update', { id: record.id, meta: { done: true, source: 'panel' } })
  await call('record/update', { id: record.id, meta: { done: false } })
  const metaRecord = (await call('record/list', {})).items.find((item) => item.id === record.id)
  check('todo 完成态可写回', metaRecord?.meta?.done === false)
  check('meta 是合并写入', metaRecord?.meta?.source === 'panel')

  // 图片记录的解读文字（meta.text）也要能被搜索命中
  const imageRecord = await call('record/create', {
    type: 'image',
    content: 'assets/ocr-shot.png',
    meta: { text: '图表里写着季度营收与同比增长' },
  })
  const matched = await call('record/list', { query: '季度营收' })
  check(
    '按关键词能搜到图片解读文字',
    matched.items?.some((item) => item.id === imageRecord.id),
  )
  await call('record/delete', { id: imageRecord.id })

  // 归档 → 回收站 → 恢复
  await call('record/update', { id: record.id, archived: true })
  check('归档后从列表消失', (await call('record/list', {})).items.length === 0)
  check('回收站能看到归档记录', (await call('record/list', { archived: 1 })).items.length === 1)
  await call('record/update', { id: record.id, archived: false })
  check('恢复后回到列表', (await call('record/list', {})).items.length === 1)

  // 会话
  const chat = await call('chat/create', { title: '' })
  await call('chat/append', { chatId: chat.id, role: 'user', content: '帮我写一段今天的工作总结，控制在 100 字以内。' })
  const chats = await call('chat/list')
  check('首条消息自动生成会话标题', chats.items[0]?.title?.length > 0)
  const messages = await call('chat/messages', { chatId: chat.id })
  check('会话消息落库', messages.items.length === 1 && messages.items[0].role === 'user')

  // 设置
  await call('settings/set', { key: 'app.settings', value: { theme: 'dark', locale: 'zh-CN' } })
  const setting = await call('settings/get', { key: 'app.settings' })
  check('设置读写一致', setting.value?.theme === 'dark')

  // 画布
  const canvas = await call('canvas/create', { name: '流程图' })
  check('新建画布返回路径', canvas.path?.endsWith('.canvas.json'), canvas.path)
  const canvasDoc = JSON.stringify({ version: 1, title: '流程图', nodes: [], edges: [], updatedAt: 1 })
  await call('canvas/save', { path: canvas.path, content: canvasDoc })
  const canvasRead = await call('canvas/read', { path: canvas.path })
  check('画布内容可读回', JSON.parse(canvasRead.content).title === '流程图')
  const canvasList = await call('canvas/list')
  check('画布列表包含新建项', canvasList.items?.some((item) => item.path === canvas.path))
  let canvasTraversal = false
  try {
    await call('canvas/read', { path: '../secret.canvas.json' })
  } catch {
    canvasTraversal = true
  }
  check('画布路径限制在 canvases/ 内', canvasTraversal)

  // 图片：1x1 透明 PNG
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = await call('image/save', { name: 'dot.png', dataBase64: pngBase64 })
  check('图片落到 assets/ 并给出 markdown', image.markdown?.startsWith('![](assets/'), image.markdown)
  const imageRead = await call('image/read', { path: image.path })
  check('图片可读成 data URL', imageRead.dataUrl?.startsWith('data:image/png;base64,'))

  // 宿主 iframe 拿不到的系统能力：截屏 / 剪贴板 / 录音
  try {
    const shot = await call('screen/capture')
    check(
      '截屏返回 PNG 与尺寸',
      shot.mime === 'image/png' && shot.width > 0 && shot.height > 0,
      `${shot.width}x${shot.height}`,
    )
    check(
      '截屏内容是合法 PNG',
      Buffer.from(shot.dataBase64, 'base64').subarray(1, 4).toString() === 'PNG',
    )
  } catch (error) {
    check('截屏返回 PNG 与尺寸', false, error.message)
  }

  // 先备份用户当下的剪贴板图片，测完还原（只有图片能量化还原，文本还原不了）
  let previousClip = null
  try {
    previousClip = await call('clipboard/image')
  } catch {
    previousClip = null
  }
  try {
    const clip = previousClip ?? (await call('clipboard/image'))
    check('剪贴板图片可读', clip.mime === 'image/png' && clip.dataBase64.length > 0)
  } catch (error) {
    // 剪贴板里没有图片时也要给明确错误，不能挂住
    check('剪贴板无图时给出明确错误', /剪贴板/.test(error.message), error.message)
  }

  // 截图工具的「复制」走 clipboard/write：PNG base64 → 系统剪贴板 CF_DIB
  let badPayload = ''
  try {
    await call('clipboard/write', {})
  } catch (error) {
    badPayload = error.message
  }
  check('clipboard/write 空数据给出明确错误', /缺少图片数据/.test(badPayload), badPayload)

  try {
    const written = await call('clipboard/write', { dataBase64: pngBase64, mime: 'image/png' })
    check('clipboard/write 写入成功并返回尺寸', written.ok === true && written.width === 1, JSON.stringify(written))
    const roundtrip = await call('clipboard/image')
    check(
      '剪贴板写入后可原样读回',
      roundtrip.mime === 'image/png' && roundtrip.width === 1 && roundtrip.height === 1,
      `${roundtrip.width}x${roundtrip.height}`,
    )
  } catch (error) {
    check('clipboard/write 写入成功并返回尺寸', false, error.message)
  } finally {
    // 还原用户原来的剪贴板图片，不留测试痕迹
    if (previousClip?.dataBase64) {
      await call('clipboard/write', { dataBase64: previousClip.dataBase64, mime: 'image/png' }).catch(
        () => {},
      )
    }
  }

  // 桌面 1:1 框选：正式路径会在桌面上弹一个全屏置顶窗口，自检里用预设选区自动松手
  try {
    const region = await call('screenshot/select')
    check('框选走原生模式', region.mode === 'native', region.mode)
    check(
      '框选按请求的尺寸裁切',
      region.width === 360 && region.height === 240,
      `${region.width}x${region.height}`,
    )
    check(
      '框选返回合法 PNG',
      Buffer.from(region.dataBase64, 'base64').subarray(1, 4).toString() === 'PNG',
    )
    const probe = await call('screenshot/window')
    // `visible` 只说明「此刻还在不在」，这一步窗口已经按出口关掉了，所以看的是
    // 关窗前那段快照里的实锤：真的画过帧（painted > 0）+ 矩形铺满整块桌面。
    check(
      '框选窗口真的盖在桌面上',
      probe?.painted > 0 &&
        (probe?.rect?.[2] ?? 0) >= 640 &&
        (probe?.rect?.[3] ?? 0) >= 480,
      JSON.stringify(probe),
    )
    check('框选完成后窗口自动退出', probe?.visible === false, JSON.stringify(probe?.visible))
    check(
      '框选窗口铺满整块桌面',
      (probe?.rect?.[2] ?? 0) >= 640 && (probe?.rect?.[3] ?? 0) >= 480,
      JSON.stringify(probe?.rect),
    )
    // 编辑器路径不该在这里弹原生工具栏：那张图交回插件浮层，用页面里同一套 UI 标注。
    // 反过来（编辑器里也弹一条原生工具栏）就是用户抱怨过的「做了两套」。
    check(
      '编辑器路径不弹原生标注工具栏',
      probe?.annotate === null,
      JSON.stringify(probe?.annotate),
    )
  } catch (error) {
    check('框选走原生模式', false, error.message)
  }

  const hotkey = await call('screenshot/hotkey')
  check(
    '全局热键状态可查询',
    typeof hotkey.registered === 'boolean' && typeof hotkey.combo === 'string',
    JSON.stringify(hotkey),
  )
  const noPending = await call('screenshot/takePending')
  check('没有全局截图时挂起项为空', noPending === null, JSON.stringify(noPending))

  // 全局截图：桌面框选 → **原地**出标注工具栏 → 选出口 → 收尾。
  // 注入按键在锁屏 / CI 里会被系统丢掉，所以这里直接调自检入口跑同一条链路。
  try {
    const shot = await call('screenshot/globalShot', { exit: 'record' })
    check('全局截图链路可跑通', shot.ok === true, JSON.stringify(shot))
    const annotateProbe = await call('screenshot/window')
    const annotate = annotateProbe?.annotate ?? null
    check('全局截图当场进入标注阶段', Boolean(annotate?.ready), JSON.stringify(annotate))
    check(
      '标注工具栏整条落在窗口内且有按钮',
      Boolean(annotate) &&
        annotate.barInsideWindow === true &&
        annotate.bar[2] > 200 &&
        annotate.bar[3] >= 24 &&
        // 选择工具下没有颜色行与滑轨：7 工具 + 撤销/重做 + 关闭/复制/钉图/下载/插入 + 主按钮
        annotate.buttons >= 15,
      JSON.stringify(annotate && { bar: annotate.bar, buttons: annotate.buttons }),
    )
    // 参考项目工具栏右侧是 X / Copy / Pin / Download，缺了「钉在顶层」用户就没法把图贴在屏幕上
    check(
      '工具栏带「钉在顶层」按钮（对齐参考项目 Pin）',
      Array.isArray(annotate?.actions) && annotate.actions.includes('Pin'),
      JSON.stringify(annotate?.actions),
    )
    // 两套 UI 的核心风险：档位漂了，用户在桌面上和在插件里看到的东西不一样
    // 档位与参考项目 `src/app/screenshot/page.tsx` 对齐：7 工具 / 8 色 / 线宽 1..12 连续滑轨
    // 注意：默认工具是「选择」，它没有颜色行与滑轨，所以颜色数看 `palette`（固定 8），
    // 画出来的色点数看 `colors`（选择工具下为 0）。
    check(
      '工具 / 颜色 / 粗细与插件浮层同一套',
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
    check(
      '打开就是「选择」工具（对齐参考项目 useState<Tool>("select")）',
      annotate?.tool === 'Select',
      String(annotate?.tool),
    )
    // 文字工具的画字颜色必须跟着当前选中的颜色走，不能恒定黑字：
    // 这里读的是 `WM_CTLCOLOREDIT` 用的同一套换算结果（浅色自动换深底）
    check(
      '文字输入框沿用当前选中色',
      annotate?.textColor === '#ef4444' && annotate?.textBackground === '#ffffff',
      `${annotate?.textColor} / ${annotate?.textBackground}`,
    )
    // 「拖拽时选区内显示的内容对不对」唯一客观的证据：选区内必须是 1:1 原像素、
    // 选区外必须是压暗版。任何截图相关的回归都应该先看这一项。
    const pixels = annotateProbe?.pixels
    check(
      '选区内外像素与桌面一致（内 1:1 原图 / 外压暗）',
      Boolean(pixels) &&
        pixels.inside?.checked > 0 &&
        pixels.inside?.mismatch === 0 &&
        pixels.outside?.checked > 0 &&
        pixels.outside?.mismatch === 0,
      JSON.stringify(pixels),
    )
    const pendingRecord = await call('screenshot/takePending')
    check(
      '选「保存到记录」后挂起项带出口',
      pendingRecord?.action === 'record' && pendingRecord?.source === 'global',
      JSON.stringify(pendingRecord && { action: pendingRecord.action, source: pendingRecord.source }),
    )
    check(
      '挂起项尺寸与选区一致',
      pendingRecord?.width === 360 && pendingRecord?.height === 240,
      `${pendingRecord?.width}x${pendingRecord?.height}`,
    )

    const insertShot = await call('screenshot/globalShot', { exit: 'insert' })
    const pendingInsert = await call('screenshot/takePending')
    check(
      '选「插入笔记」后挂起项出口正确',
      insertShot.ok === true && pendingInsert?.action === 'insert',
      JSON.stringify(pendingInsert && { action: pendingInsert.action }),
    )
    // 没指定出口 = 用户按 Esc 取消：不该留下任何挂起项
    const cancelShot = await call('screenshot/globalShot', { exit: 'cancel' })
    const pendingNone = await call('screenshot/takePending')
    check(
      '取消全局截图后不留挂起项',
      cancelShot.ok === true && pendingNone === null,
      JSON.stringify(pendingNone),
    )
    // 「钉在顶层」是桌面窗口，光看工具栏上有按钮不够——出口必须真的把窗口开出来。
    // 钉图窗口在独立线程里建，计数是异步涨上去的，所以这里等它一下再读。
    const pinShot = await call('screenshot/globalShot', { exit: 'pin' })
    let pinned = null
    for (let i = 0; i < 20; i += 1) {
      pinned = await call('screenshot/window')
      if ((pinned?.pins ?? 0) >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    check(
      '选「钉在顶层」后桌面多一个置顶窗口',
      pinShot.ok === true && (pinned?.pins ?? 0) >= 1 && pinned?.visible === false,
      JSON.stringify({ exit: pinShot, pins: pinned?.pins, visible: pinned?.visible }),
    )
    await call('screenshot/unpinAll')
    let left = (await call('screenshot/window'))?.pins
    for (let i = 0; i < 20 && left !== 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100))
      left = (await call('screenshot/window'))?.pins
    }
    check('可以一次收掉所有钉图窗口', left === 0, String(left))
  } catch (error) {
    check('全局截图链路可跑通', false, error.message)
  }
  // 全局截图会把标注结果写进剪贴板，测完把用户原来那张放回去
  if (previousClip?.dataBase64) {
    await call('clipboard/write', {
      dataBase64: previousClip.dataBase64,
      mime: 'image/png',
    }).catch(() => {})
  }

  const recordStatus = await call('audio/recordStatus')
  check('录音状态可查询', recordStatus.available === true && recordStatus.recording === false)
  let recordStarted = false
  try {
    await call('audio/recordStart')
    recordStarted = true
  } catch (error) {
    check('无麦克风时给出明确错误', /麦克风|设备|device/i.test(error.message), error.message)
  }
  if (recordStarted) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))
    const audio = await call('audio/recordStop')
    check('录音返回 wav base64', audio.mime === 'audio/wav' && audio.dataBase64.length > 0)
    check(
      'wav 头是 RIFF',
      Buffer.from(audio.dataBase64, 'base64').subarray(0, 4).toString() === 'RIFF',
    )
    const stopped = await call('audio/recordStatus')
    check('停止后回到未录音状态', stopped.recording === false)
  }

  // 本地 MCP：用自带的假服务走一遍「配置 → 列工具 → 调用」
  const savedServers = await call('mcp/save', {
    servers: [
      {
        id: '',
        name: 'mock',
        command: process.execPath,
        args: [join(ROOT, 'scripts', 'mock-mcp.mjs')],
        enabled: true,
      },
    ],
  })
  const serverId = savedServers.servers?.[0]?.id
  check('保存 MCP 服务并分配 id', Boolean(serverId))
  const mcpTools = await call('mcp/tools', { id: serverId })
  check('列出 MCP 工具', mcpTools.tools?.some((tool) => tool.name === 'echo'))
  const mcpResult = await call('mcp/call', { id: serverId, tool: 'echo', args: { text: '你好' } })
  check('调用 MCP 工具返回结果', mcpResult.text === 'echo: 你好', mcpResult.text)

  // 云同步：只读状态，不真的提交
  const syncStatus = await call('sync/status')
  check('同步状态可读取', typeof syncStatus.available === 'boolean')

  // 同步配置：写入 → 读回 → 令牌掩码
  await call('sync/saveOptions', {
    provider: 'gitee',
    token: 'abcdef1234567890',
    autoCommit: true,
    messageTemplate: 'notes {date}',
  })
  const syncOptions = await call('sync/options')
  check('同步配置可保存', syncOptions.options?.provider === 'gitee', syncOptions.options?.provider)
  check('令牌只回传掩码', syncOptions.options?.hasToken === true && syncOptions.options?.token === '')
  check('提交信息模板已保存', syncOptions.options?.messageTemplate === 'notes {date}')
  await call('sync/saveOptions', { clearToken: true })
  const clearedOptions = await call('sync/options')
  check('可清除已保存令牌', clearedOptions.options?.hasToken === false)
  // 恢复默认，避免影响后续手工调试
  await call('sync/saveOptions', { provider: 'github', autoCommit: false, messageTemplate: '' })

  // Git 通道单文件同步：远端更新 → 打开即拉取（对齐 NoteGen 的 compareFileVersions / pullFile）
  if (hasGit()) {
    const WORKSPACE = join(DATA_DIR, 'workspace')
    const originDir = join(DATA_DIR, 'git-origin.git')
    const peerDir = join(DATA_DIR, 'git-peer')
    rmSync(originDir, { recursive: true, force: true })
    rmSync(peerDir, { recursive: true, force: true })
    git(['init', '--bare', originDir])

    // 工作区当仓库，远端指向本地裸仓库（等价于 https 远端，只是不打网络）
    await call('sync/init', { url: originDir.replace(/\\/g, '/') })
    gitIdentity(WORKSPACE)
    const note = join(WORKSPACE, 'sync-test.md')
    writeFileSync(note, '# 第一版\n')
    await call('sync/commit', { message: 'seed' })
    await call('sync/push')
    await call('sync/recordBase')
    check('推送后基线已对齐', (await call('sync/compare', { path: 'sync-test.md' })).action === 'none')
    check('初始化仓库会忽略同步状态目录', readFileSync(join(WORKSPACE, '.gitignore'), 'utf8').includes('.dbx-note/'))

    // 另一台设备改了同一个笔记并推送
    git(['clone', originDir, peerDir])
    gitIdentity(peerDir)
    writeFileSync(join(peerDir, 'sync-test.md'), '# 远端改过的版本\n')
    git(['add', '-A'], peerDir)
    git(['commit', '-m', 'peer edit'], peerDir)
    git(['push'], peerDir)

    const changed = await call('sync/compare', { path: 'sync-test.md' })
    check('远端更新后判定需要拉取', changed.action === 'pull', `${changed.action} / ${changed.reason}`)
    const pulledFile = await call('sync/pullFile', { path: 'sync-test.md' })
    check(
      '拉取返回远端内容',
      pulledFile.updated === true && pulledFile.content.includes('远端改过的版本'),
      pulledFile.content,
    )
    check('拉取后磁盘内容已更新', readFileSync(note, 'utf8').includes('远端改过的版本'))
    check('拉取后判定已同步', (await call('sync/compare', { path: 'sync-test.md' })).action === 'none')

    // 两边都改过 → 冲突，由界面弹窗决定
    writeFileSync(note, '# 本地改过的版本\n')
    writeFileSync(join(peerDir, 'sync-test.md'), '# 远端第二次\n')
    git(['add', '-A'], peerDir)
    git(['commit', '-m', 'peer second'], peerDir)
    git(['push'], peerDir)
    const conflict = await call('sync/compare', { path: 'sync-test.md' })
    check('两边都改判定冲突', conflict.action === 'conflict', `${conflict.action} / ${conflict.reason}`)
    check(
      '冲突回传两边内容',
      String(conflict.localContent).includes('本地改过') &&
        String(conflict.remoteContent).includes('远端第二次'),
    )
    await call('sync/resolveConflict', { path: 'sync-test.md', side: 'remote' })
    check('采用远端后内容已更新', readFileSync(note, 'utf8').includes('远端第二次'))
    check('解决冲突后判定已同步', (await call('sync/compare', { path: 'sync-test.md' })).action === 'none')

    // 拉取全部：远端新增的文件也要下来（新设备首次使用场景）
    writeFileSync(join(peerDir, 'peer-new.md'), '# 远端新增\n')
    git(['add', '-A'], peerDir)
    git(['commit', '-m', 'peer add'], peerDir)
    git(['push'], peerDir)
    const pulledAll = await call('sync/pullAll')
    check(
      '拉取全部会下载远端新增文件',
      pulledAll.pulled >= 1 && existsSync(join(WORKSPACE, 'peer-new.md')),
      JSON.stringify(pulledAll),
    )
    check('新增文件基线已对齐', (await call('sync/compare', { path: 'peer-new.md' })).action === 'none')

    // 本地未推送的修改不能被远端覆盖（参考项目只比远端 SHA 会覆盖，这里必须判冲突）
    writeFileSync(join(WORKSPACE, 'peer-new.md'), '# 本地又改了\n')
    writeFileSync(join(peerDir, 'peer-new.md'), '# 远端也改了\n')
    git(['add', '-A'], peerDir)
    git(['commit', '-m', 'peer edit new'], peerDir)
    git(['push'], peerDir)
    check(
      '本地未推送的修改不会被静默覆盖',
      (await call('sync/compare', { path: 'peer-new.md' })).action === 'conflict',
    )
    await call('sync/resolveConflict', { path: 'peer-new.md', side: 'local' })
    await call('sync/commit', { message: 'keep local' })
    await call('sync/push')
    await call('sync/recordBase')
    check('保留本地后可以正常推送', (await call('sync/compare', { path: 'peer-new.md' })).action === 'none')

    // 清理用例文件，避免影响后面「文件树」与「备份」断言
    rmSync(note, { force: true })
    rmSync(join(WORKSPACE, 'peer-new.md'), { force: true })
  } else {
    console.log('  · 系统未安装 git，跳过 Git 单文件同步用例')
  }

  // 备份：导出 → 列表 → 删除
  const exported = await call('backup/export', { includeGit: false })
  check('备份生成 zip', exported.name?.endsWith('.zip') && exported.size > 0, exported.name)
  check('备份统计文件数', exported.files >= 1, String(exported.files))
  const backups = await call('backup/list')
  check('备份列表包含新文件', backups.items?.some((item) => item.name === exported.name))
  const backupInfo = await call('backup/info')
  check('备份目录位于数据目录下', backupInfo.dir?.includes('backups'), backupInfo.dir)
  const removed = await call('backup/delete', { path: exported.path })
  check('可删除备份', removed.deleted === true)
  let backupGuard = false
  try {
    await call('backup/delete', { path: join(DATA_DIR, 'dbx-note.db') })
  } catch {
    backupGuard = true
  }
  check('只允许删除 backups/ 下的文件', backupGuard)

  // 图片识别 / 语音转写：起一个假模型服务走一遍真实 HTTP 通道
  const MOCK_PORT = 5198
  const mock = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'mock-ai.mjs'), '--port', String(MOCK_PORT)],
    { stdio: 'ignore' },
  )
  const mockBase = `http://127.0.0.1:${MOCK_PORT}/v1`
  const ready = await waitFor(`${mockBase}/models`)
  check('假模型服务已就绪', ready)
  if (ready) {
    const vision = await call('ai/vision', {
      baseUrl: mockBase,
      apiKey: 'test',
      model: 'mock-vl',
      imagePath: image.path,
    })
    check('图片识别返回文字', vision.text?.includes('测试图片'), vision.text)
    const transcribed = await call('ai/transcribe', {
      baseUrl: mockBase,
      apiKey: 'test',
      model: 'whisper-1',
      audioBase64: Buffer.from('fake-audio').toString('base64'),
      mime: 'audio/webm',
    })
    check('语音转写返回文字', transcribed.text?.includes('语音'), transcribed.text)
  }
  mock.kill()

  // 同步通道：对象存储 / WebDAV / 自托管（这里用本地服务模拟自托管）
  const mockStore = await startMockStore()
  await call('sync/saveStoreOptions', {
    provider: 'selfHosted',
    config: {
      baseUrl: `http://127.0.0.1:${mockStore.port}/api/sync`,
      token: 'test-token',
      pathPrefix: 'dbx-note',
    },
  })
  const storeOptions = await call('sync/storeOptions')
  check('同步配置按平台保存', storeOptions.config?.pathPrefix === 'dbx-note')
  const prefsDefault = await call('sync/prefs')
  check('自动同步默认 5 秒（与参考实现一致）', prefsDefault.autoSync === '5', String(prefsDefault.autoSync))
  check('打开即拉取默认开启', prefsDefault.autoPullOnOpen === true)
  check(
    '应用数据同步默认全开',
    prefsDefault.autoRecordSync === true &&
      prefsDefault.autoSettingsSync === true &&
      prefsDefault.autoConversationSync === true &&
      prefsDefault.excludeSensitiveConfig === true,
  )

  await call('sync/savePrefs', { autoSync: '30', autoPullOnOpen: false })
  const savedPrefs = await call('sync/prefs')
  check('自动同步间隔可改', savedPrefs.autoSync === '30', String(savedPrefs.autoSync))
  check('打开即拉取可关', savedPrefs.autoPullOnOpen === false)

  await call('sync/savePrefs', { autoSync: 'disabled' })
  check('自动同步可关闭', (await call('sync/prefs')).autoSync === 'disabled')
  await call('sync/savePrefs', { autoSync: '5', autoPullOnOpen: true, autoRecordSync: false })
  check('应用数据同步可单独关', (await call('sync/prefs')).autoRecordSync === false)
  await call('sync/savePrefs', { autoRecordSync: true })

  // 偏好与平台无关：切到 Git 平台后仍是同一份
  await call('sync/saveOptions', { provider: 'github' })
  check('切平台后偏好保留', (await call('sync/prefs')).autoSync === '5')
  check(
    'storeOptions 内嵌同一份偏好',
    (await call('sync/storeOptions')).prefs?.autoPullOnOpen === true,
  )
  await call('sync/saveStoreOptions', {
    provider: 'selfHosted',
    config: {
      baseUrl: `http://127.0.0.1:${mockStore.port}/api/sync`,
      token: 'test-token',
      pathPrefix: 'dbx-note',
    },
  })

  check(
    '同步令牌只回传掩码',
    storeOptions.config?.token === '' && storeOptions.config?.hasToken === true,
  )

  const storeCheck = await call('sync/storeCheck')
  check('自托管连通性检测通过', storeCheck.ok === true, storeCheck.message)

  const beforeStatus = await call('sync/storeStatus')
  check('同步状态列出本地文件', beforeStatus.localFiles >= 2, String(beforeStatus.localFiles))
  check(
    '首次同步前全部待上传',
    beforeStatus.pendingUpload === beforeStatus.localFiles,
    `pending=${beforeStatus.pendingUpload} local=${beforeStatus.localFiles}`,
  )

  const firstPush = await call('sync/storePush', {})
  check(
    '首次上传覆盖全部本地文件',
    firstPush.pushed === beforeStatus.localFiles,
    JSON.stringify(firstPush),
  )
  check('远端出现清单文件', mockStore.store.has('dbx-note/manifest.json'))
  check(
    '远端出现文件本体',
    [...mockStore.store.keys()].some((key) => key.startsWith('dbx-note/files/')),
  )

  const afterPush = await call('sync/storeStatus')
  check(
    '上传后差异归零',
    afterPush.pendingUpload === 0 && afterPush.pendingDownload === 0,
    `up=${afterPush.pendingUpload} down=${afterPush.pendingDownload}`,
  )
  check('上传后远端文件数与本地一致', afterPush.remoteFiles === afterPush.localFiles)

  const secondPush = await call('sync/storePush', {})
  check('重复上传是幂等的', secondPush.pushed === 0 && secondPush.skipped >= 1, JSON.stringify(secondPush))

  // 模拟另一台设备：直接往远端写一个文件，再拉回来
  const remoteNote = '# 来自另一台设备\n\n同步通道验证。\n'
  const remoteSize = Buffer.byteLength(remoteNote)
  const remoteHash = `${remoteSize}:${createHash('sha1').update(remoteNote).digest('hex')}`
  mockStore.store.set('dbx-note/files/同步/远端笔记.md', Buffer.from(remoteNote))
  const remoteManifest = JSON.parse(mockStore.store.get('dbx-note/manifest.json').toString('utf8'))
  remoteManifest.files['同步/远端笔记.md'] = {
    size: remoteSize,
    mtime: Date.now(),
    hash: remoteHash,
  }
  mockStore.store.set('dbx-note/manifest.json', Buffer.from(JSON.stringify(remoteManifest)))

  const pulled = await call('sync/storePull', {})
  check('拉取远端新增文件', pulled.pulled === 1, JSON.stringify(pulled))
  const pulledFile = await call('fs/read', { path: '同步/远端笔记.md' })
  check('拉取内容与远端一致', pulledFile.content === remoteNote)
  const afterPull = await call('sync/storeStatus')
  check(
    '拉取后差异归零',
    afterPull.pendingUpload === 0 && afterPull.pendingDownload === 0,
    `up=${afterPull.pendingUpload} down=${afterPull.pendingDownload}`,
  )

  // 冲突策略：两边都改过时的三种处理
  const bumpRemote = (content) => {
    const size = Buffer.byteLength(content)
    const hash = `${size}:${createHash('sha1').update(content).digest('hex')}`
    mockStore.store.set('dbx-note/files/同步/远端笔记.md', Buffer.from(content))
    const manifest = JSON.parse(mockStore.store.get('dbx-note/manifest.json').toString('utf8'))
    manifest.files['同步/远端笔记.md'] = { size, mtime: Date.now(), hash }
    mockStore.store.set('dbx-note/manifest.json', Buffer.from(JSON.stringify(manifest)))
  }

  await call('fs/write', { path: '同步/远端笔记.md', content: '# 本地改动一\n' })
  bumpRemote('# 远端改动一\n')
  await call('sync/saveStoreOptions', {
    provider: 'selfHosted',
    config: { pathPrefix: 'dbx-note' },
    conflictPolicy: 'remote',
  })
  const remoteWins = await call('sync/storePull', {})
  const afterRemote = await call('fs/read', { path: '同步/远端笔记.md' })
  check('冲突策略 remote 用远端覆盖本地', afterRemote.content === '# 远端改动一\n', JSON.stringify(remoteWins))

  await call('fs/write', { path: '同步/远端笔记.md', content: '# 本地改动二\n' })
  bumpRemote('# 远端改动二\n')
  await call('sync/saveStoreOptions', {
    provider: 'selfHosted',
    config: { pathPrefix: 'dbx-note' },
    conflictPolicy: 'local',
  })
  const localWins = await call('sync/storePull', {})
  const afterLocal = await call('fs/read', { path: '同步/远端笔记.md' })
  check('冲突策略 local 保留本地并列入冲突', afterLocal.content === '# 本地改动二\n' && localWins.conflicts.includes('同步/远端笔记.md'))

  const logs = await call('sync/storeLogs')
  check('同步日志已记录上传与下载', logs.items.length >= 3 && logs.items.some((item) => item.action === 'pull'))

  mockStore.server.close()

  // 删除
  await call('fs/delete', { path: '日记' })
  const afterDelete = await call('fs/tree', {})
  check(
    '删除目录后文件树无残留笔记',
    afterDelete.children.filter((node) => node.kind === 'file').length === 0,
    afterDelete.children.map((node) => node.name).join(','),
  )
  check('磁盘文件已移除', !existsSync(join(DATA_DIR, 'workspace', '日记')))

  // 直接落盘的内容可被外部工具读取
  writeFileSync(join(DATA_DIR, 'workspace', 'external.md'), '# 外部写入\n')
  const external = await call('fs/tree', {})
  check('外部新增文件可被识别', external.children.some((node) => node.name === 'external.md'))

  /* ---------------- 系统 OCR（VLM 失败时的回退通道） ---------------- */

  const ocrStatus = await call('ocr/status')
  check('系统 OCR 引擎有明确标识', ocrStatus.engine === 'windows-ocr', String(ocrStatus.engine))
  check(
    '系统 OCR 可用时列出识别语言',
    ocrStatus.available === false || (Array.isArray(ocrStatus.languages) && ocrStatus.languages.length > 0),
    JSON.stringify(ocrStatus),
  )

  // 1×1 的 PNG 没有文字，但足以验证"能读图、能返回结构"
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  writeFileSync(join(DATA_DIR, 'workspace', 'ocr-blank.png'), Buffer.from(tinyPng, 'base64'))
  if (ocrStatus.available) {
    // 畸形 / 极小图在 WinRT 里可能让 OCR 直接崩：OCR 跑在独立子进程，
    // 这里只要求"要么给文本、要么给明确错误"，关键是紧接着的调用还得通
    let blankOk = false
    let blankDetail = ''
    try {
      const byPath = await call('ocr/run', { path: 'ocr-blank.png' })
      blankOk = byPath.engine === 'windows-ocr' && typeof byPath.text === 'string'
      blankDetail = `text=${JSON.stringify(byPath.text)}`
    } catch (error) {
      blankOk = /OCR/.test(error.message)
      blankDetail = error.message
    }
    check('OCR 支持工作区相对路径入参', blankOk, blankDetail)

    const byBase64 = await call('ocr/run', { imageBase64: tinyPng, mime: 'image/png' }).catch(
      (error) => ({ error: error.message }),
    )
    check('OCR 支持 base64 入参', !byBase64.error, String(byBase64.error ?? ''))
  } else {
    console.log('  · 系统未安装 OCR 语言包，跳过 ocr/run 用例')
  }

  // 关键回归：OCR 子进程崩了也不能带走主进程
  const afterOcr = await call('plugin/initialize', { protocolVersion: 1 })
  check('OCR 后 Sidecar 仍可响应', typeof afterOcr === 'object' && afterOcr !== null)

  let ocrError = ''
  try {
    await call('ocr/run', { path: 'not-exists.png' })
  } catch (error) {
    ocrError = error.message
  }
  check('OCR 对缺失图片如实报错', ocrError.includes('图片文件不存在'), ocrError)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  child.kill()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('自检异常：', error)
  child.kill()
  process.exit(1)
})
