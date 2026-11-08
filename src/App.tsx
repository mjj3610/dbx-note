import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toaster, toast } from 'sonner'
import { Loader2, RefreshCw } from 'lucide-react'

import { ChatPanel } from '@/components/ChatPanel'
import { MobileNav } from '@/components/MobileNav'
import { CanvasEditor } from '@/components/canvas/CanvasEditor'
import { EditorPane } from '@/components/EditorPane'
import { LeftSidebar } from '@/components/LeftSidebar'
import { SidePane } from '@/components/SidePane'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import { DeleteConfirmDialog } from '@/components/dialogs/DeleteConfirmDialog'
import { DirPickerDialog } from '@/components/dialogs/DirPickerDialog'
import { ImageDialog } from '@/components/dialogs/ImageDialog'
import { ScreenshotOverlay } from '@/components/dialogs/ScreenshotOverlay'
import { VoiceDialog } from '@/components/dialogs/VoiceDialog'
import { SearchDialog } from '@/components/dialogs/SearchDialog'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { SyncConflictDialog } from '@/components/dialogs/SyncConflictDialog'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { awaitHostReady, isHosted, watchHostAppearance } from '@/lib/bridge'
import * as rpc from '@/lib/rpc'
import { captureMessage, pollPendingShot, startScreenshot } from '@/lib/screenshot'
import { toggleSidePane } from '@/lib/split'
import { useIsNarrow } from '@/lib/useMediaQuery'
import { useT } from '@/lib/useT'
import { currentFolder, rememberedTabs, useNotesStore } from '@/stores/notes'
import { useChatStore } from '@/stores/chat'
import { useCanvasStore } from '@/stores/canvas'
import { useRecordsStore } from '@/stores/records'
import { useSettingsStore, watchSystemTheme } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

type BootStatus = 'loading' | 'ready' | 'error'

/** 把按键事件压成 "Ctrl+Shift+F" 这种组合键字符串 */
function comboOf(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = event.key
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

/** 统一大小写与 Cmd/Ctrl 写法，便于和设置里保存的字符串比对 */
function normalizeCombo(value: string): string {
  return value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (/^(cmd|meta|command)$/i.test(part)) return 'Ctrl'
      if (/^(ctrl|control)$/i.test(part)) return 'Ctrl'
      if (/^(alt|option)$/i.test(part)) return 'Alt'
      if (/^shift$/i.test(part)) return 'Shift'
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
    })
    .join('+')
}

/** 防止 StrictMode 下 effect 双次执行导致重复初始化 */
let bootStarted = false

export default function App() {
  const t = useT()
  const [status, setStatus] = useState<BootStatus>('loading')
  const [bootError, setBootError] = useState('')
  const [hosted, setHosted] = useState(false)
  const starters = useRef(false)

  const leftVisible = useUiStore((state) => state.leftVisible)
  const rightVisible = useUiStore((state) => state.rightVisible)
  const toggleLeft = useUiStore((state) => state.toggleLeft)
  const toggleRight = useUiStore((state) => state.toggleRight)
  const openSettings = useUiStore((state) => state.openSettings)
  const setSearchOpen = useUiStore((state) => state.setSearchOpen)
  const startNewItem = useUiStore((state) => state.startNewItem)
  const mobilePane = useUiStore((state) => state.mobilePane)
  const sidePane = useUiStore((state) => state.sidePane)
  const narrow = useIsNarrow()
  const canvasPath = useCanvasStore((state) => state.activePath)
  const theme = useSettingsStore((state) => state.theme)

  /** 初始化：宿主握手 → 设置 → 后端探活 → 载入数据 */
  const boot = async () => {
    setStatus('loading')
    setBootError('')
    await awaitHostReady()
    setHosted(isHosted())

    await useSettingsStore.getState().load()

    const available = await rpc.probeSidecar()
    if (!available) {
      setStatus('error')
      setBootError('后端未响应')
      return
    }

    try {
      const workspace = await rpc.describeWorkspace()
      useSettingsStore.getState().setWorkspace(workspace)
      await Promise.all([
        useNotesStore.getState().loadTree(),
        useRecordsStore.getState().load(),
        useRecordsStore.getState().loadTags(),
        useChatStore.getState().loadChats(),
        useCanvasStore.getState().loadList(),
      ])
      // 恢复上次打开的标签（文件缺失时自动跳过）
      const remembered = await rememberedTabs()
      if (remembered.tabs.length > 0) {
        await useNotesStore.getState().restoreTabs(remembered.tabs, remembered.activePath)
      }
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      setBootError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (bootStarted) return
    bootStarted = true
    void boot()
  }, [])

  /**
   * 回到应用时重新拉一次远端目录清单
   *
   * 参考项目的 `unified-sync-status` 在窗口重新可用时也会重跑 loadRemoteSyncFiles。
   * 「刚启动」由 boot 里的 loadTree() 负责，这里覆盖「切走再回来」这一半场景。
   * 当前笔记的正文更新由 refreshRemoteTree() 复用清单结果完成，不再额外发一次
   * compare / fetch —— 否则每次 focus 都会多跑一个 git 进程。
   */
  useEffect(() => {
    if (status !== 'ready') return
    let lastRefresh = 0
    const refresh = () => {
      if (Date.now() - lastRefresh < 5_000) return
      lastRefresh = Date.now()
      void useNotesStore.getState().refreshRemoteTree({ force: true })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [status])

  // 深浅色：系统主题 + 宿主主题变化都要跟随
  useEffect(() => {
    const stopSystem = watchSystemTheme()
    const stopHost = watchHostAppearance(() => useSettingsStore.getState().patch({ theme: useSettingsStore.getState().theme }))
    return () => {
      stopSystem()
      stopHost()
    }
  }, [])

  // 全局快捷键
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // 编辑器先接到的组合（如 Ctrl/⌘+F 的「笔记内搜索」、Ctrl/⌘+Alt+T 插表）
      // 已经 preventDefault 了，这里不再重复处理，否则会同时弹出两个搜索框
      if (event.defaultPrevented) return
      // 先按「设置 → 快捷键」里的绑定分发，命中即返回
      // 注意：绑定不一定是 Ctrl/⌘ 开头（默认截图是 Alt+Shift+Z），所以这一步不能提前按 meta 过滤
      const combo = normalizeCombo(comboOf(event))
      const bindings = useSettingsStore.getState().shortcuts.bindings
      const action = Object.entries(bindings).find(
        ([, value]) => value && normalizeCombo(value) === combo,
      )?.[0]
      if (action) {
        event.preventDefault()
        const ui = useUiStore.getState()
        switch (action) {
          case 'app.search':
            ui.setSearchOpen(true)
            break
          case 'app.newNote':
            ui.startNewItem('file', currentFolder())
            break
          case 'app.settings':
            ui.openSettings('general')
            break
          case 'app.toggleSidebar':
            ui.toggleLeft()
            break
          case 'app.toggleChat':
            ui.toggleRight()
            break
          case 'app.voice':
            ui.setVoiceOpen(true)
            break
          case 'app.sync':
            ui.openSettings('sync')
            break
          case 'app.screenshot':
            // 先告诉 Sidecar「前端已接手」：它注册的同款全局热键线程会让位，
            // 避免桌面上弹两个框选窗口（必须先于 startScreenshot 发出）
            void rpc.screenshotUiHotkey().catch(() => {})
            void startScreenshot().then((result) => {
              // 浮层本身就是反馈；用户主动取消也不打扰
              if (result.status === 'opened' || result.status === 'cancelled') return
              const notice = captureMessage(result)
              if (notice.tone === 'success') toast.success(t(notice.key))
              else if (notice.tone === 'warning') toast.warning(t(notice.key))
              else toast.error(result.status === 'error' ? result.message : t(notice.key))
            })
            break
          default:
            break
        }
        return
      }

      // 下面是编辑器内置组合，仍要求带 Ctrl/⌘
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return

      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void useNotesStore.getState().save({ force: true })
        return
      }
      if (event.key.toLowerCase() === 'w') {
        // Ctrl/⌘ + W 关标签，Shift 加成关全部
        event.preventDefault()
        const notes = useNotesStore.getState()
        if (event.shiftKey) void notes.closeAllTabs()
        else if (notes.activePath) void notes.closeTab(notes.activePath)
        return
      }
      if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        // Ctrl/⌘ + Alt + ←/→ 在标签间切换
        const notes = useNotesStore.getState()
        if (notes.tabs.length < 2) return
        event.preventDefault()
        const index = notes.tabs.findIndex((tab) => tab.path === notes.activePath)
        const step = event.key === 'ArrowRight' ? 1 : -1
        const next = notes.tabs[(index + step + notes.tabs.length) % notes.tabs.length]
        if (next) void notes.open(next.path)
        return
      }
      if (event.key === '\\') {
        // Ctrl/⌘ + \ 开关并排对照面板
        event.preventDefault()
        toggleSidePane()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [startNewItem])

  // 全局热键（Sidecar 注册，插件不在前台也能按）产出的截图：回到窗口时接过来标注
  useEffect(() => {
    let stopped = false
    const tick = () => {
      // 不再限制「页面可见 / 有焦点」：插件在 iframe 里，面板被折叠、刚切回宿主、
      // 焦点在记录或画布面板时都会判成不可见，用户就会觉得「截完没有工具栏」。
      // 挂起项本身只有 2 分钟有效期，多取几次没有副作用。
      if (stopped) return
      void pollPendingShot()
    }
    // 热键截完图后 Sidecar 会把宿主窗口拉到前台，这里几条触发都能第一时间接上：
    // 定时兜底 + 宿主聚焦 + 可见性变化 + 用户一点就补一次
    const timer = window.setInterval(tick, 700)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void rpc.logWrite('宿主回到前台，开始收取挂起截图').catch(() => {})
      }
      tick()
    }
    window.addEventListener('focus', tick)
    window.addEventListener('pointerdown', tick)
    document.addEventListener('visibilitychange', onVisible)
    // 记录一次「界面起来了」：之后如果没有「取到挂起截图」，就说明页面根本没在轮询
    void rpc.logWrite(`界面就绪（可见性=${document.visibilityState}）`).catch(() => {})
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      window.removeEventListener('pointerdown', tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-foreground">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <RefreshCw className="size-5" />
        </div>
        <p className="text-sm font-medium">{t('status.noSidecar')}</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {bootError || '请确认插件自带的原生后端已正确安装。'}
        </p>
        <Button
          size="sm"
          onClick={() => {
            bootStarted = false
            void boot()
            starters.current = true
          }}
        >
          {t('common.retry')}
        </Button>
        {!hosted ? (
          <p className="max-w-sm text-[11px] text-muted-foreground">
            当前不在 DBX 宿主中运行，文件读写与 AI 能力需要宿主注入的 Sidecar 通道。
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="min-h-0 flex-1">
          {narrow ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">
                {mobilePane === 'sidebar' ? (
                  <div className="h-full overflow-hidden border-r border-border">
                    <LeftSidebar />
                  </div>
                ) : mobilePane === 'chat' ? (
                  <ChatPanel />
                ) : canvasPath ? (
                  <CanvasEditor />
                ) : (
                  <EditorPane />
                )}
              </div>
              <MobileNav />
            </div>
          ) : (
            <PanelGroup direction="horizontal" className="h-full">
              {leftVisible ? (
                <>
                  <Panel defaultSize={23} minSize={16} maxSize={42} className="min-w-0">
                    <LeftSidebar />
                  </Panel>
                  <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring/40 data-[resize-handle-state=drag]:bg-ring/60" />
                </>
              ) : null}

              <Panel minSize={30} className="min-w-0">
                {canvasPath ? <CanvasEditor /> : <EditorPane />}
              </Panel>

              {sidePane ? (
                <>
                  <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring/40 data-[resize-handle-state=drag]:bg-ring/60" />
                  <Panel defaultSize={26} minSize={18} maxSize={50} className="min-w-0">
                    <SidePane />
                  </Panel>
                </>
              ) : null}

              {rightVisible ? (
                <>
                  <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring/40 data-[resize-handle-state=drag]:bg-ring/60" />
                  <Panel defaultSize={27} minSize={19} maxSize={46} className="min-w-0">
                    <ChatPanel />
                  </Panel>
                </>
              ) : null}
            </PanelGroup>
          )}
        </div>
        <StatusBar />

        <SettingsDialog />
        <SearchDialog />
        <DirPickerDialog />
        <ImageDialog />
        <VoiceDialog />
        <SyncConflictDialog />
        <ScreenshotOverlay />
        <DeleteConfirmDialog />
        <Toaster
          position="top-center"
          theme={
            theme === 'dark' ||
            (theme === 'system' &&
              typeof document !== 'undefined' &&
              document.documentElement.classList.contains('dark'))
              ? 'dark'
              : 'light'
          }
          // 让出标题栏(36) + 标签栏(48)，避免 Toast 盖住页签
          offset={{ top: 92 }}
          toastOptions={{ className: 'text-sm' }}
        />
      </div>
    </TooltipProvider>
  )
}
