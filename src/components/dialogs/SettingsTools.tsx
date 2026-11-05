import { useEffect, useState } from 'react'
import { ChevronDown, Loader2, Play, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { mcpCall, mcpList, mcpSave, mcpTools, type McpServer, type McpTool } from '@/lib/rpc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { useSettingsStore } from '@/stores/settings'

/**
 * 设置 → 工具：本机 MCP 服务
 *
 * 服务由 Sidecar 拉起（页面在沙箱里没有子进程能力），
 * 这里只负责配置、探测工具清单，以及手动试跑一次调用。
 */
export function ToolsSection() {
  const t = useT()
  const mcpEnabled = useSettingsStore((state) => state.mcpEnabled)
  const patchSettings = useSettingsStore((state) => state.patch)
  const [servers, setServers] = useState<McpServer[]>([])
  const [busy, setBusy] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [tools, setTools] = useState<Record<string, McpTool[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [openTool, setOpenTool] = useState('')
  const [argsText, setArgsText] = useState('{}')
  const [result, setResult] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const data = await mcpList()
        setServers(data.servers)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  /**
   * 落盘并回填 id
   *
   * 只把后端分配的 id 补回本地状态，绝不用响应整体覆盖——
   * 否则「失焦保存」的旧响应会盖掉用户正在输入的内容。
   */
  const persist = async (next: McpServer[]): Promise<McpServer[]> => {
    setServers(next)
    try {
      const saved = await mcpSave(next)
      setServers((current) =>
        current.map((item, index) =>
          item.id ? item : { ...item, id: saved.servers[index]?.id ?? item.id },
        ),
      )
      return saved.servers
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return next
    }
  }

  const patch = (id: string, part: Partial<McpServer>) =>
    setServers((current) => current.map((item) => (item.id === id ? { ...item, ...part } : item)))

  const detect = async (server: McpServer, index: number) => {
    const key = server.id || `${server.command}#${index}`
    setBusy(key)
    setErrors((current) => ({ ...current, [key]: '' }))
    try {
      // 先落盘：新加的服务还没 id，探测要拿 id 去后端取配置
      const saved = await persist(servers)
      const targetId = server.id || saved[index]?.id
      if (!targetId) throw new Error(t('tools.empty'))
      const data = await mcpTools(targetId)
      setTools((current) => ({ ...current, [targetId]: data.tools }))
      toast.success(t('tools.found', { count: data.tools.length }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrors((current) => ({ ...current, [key]: message }))
      toast.error(message)
    } finally {
      setBusy('')
    }
  }

  const runTool = async (server: McpServer, tool: McpTool) => {
    let args: Record<string, unknown> = {}
    try {
      args = argsText.trim() ? (JSON.parse(argsText) as Record<string, unknown>) : {}
    } catch {
      toast.error(t('tools.argsInvalid'))
      return
    }
    setBusy(`${server.id}:${tool.name}`)
    setResult('')
    try {
      const data = await mcpCall(server.id, tool.name, args)
      setResult(data.text || t('tools.emptyResult'))
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('tools.title')}</h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t('tools.hint')}</p>
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
          <div>
            <p className="text-[13px]">{t('tools.enableInChat')}</p>
            <p className="text-[11px] text-muted-foreground">{t('tools.enableInChatHint')}</p>
          </div>
          <Switch
            checked={mcpEnabled}
            aria-label={t('tools.enableInChat')}
            onCheckedChange={(checked) => patchSettings({ mcpEnabled: checked })}
          />
        </div>
      </section>

      <section className="space-y-3">
        {servers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t('tools.empty')}
          </p>
        ) : null}

        {servers.map((server, index) => {
          const key = server.id || `${server.command}#${index}`
          const list = tools[server.id]
          const error = errors[key]
          return (
            <div key={server.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                <Input
                  value={server.name}
                  onChange={(event) => patch(server.id, { name: event.target.value })}
                  onBlur={() => void persist(servers)}
                  placeholder={t('tools.name')}
                  aria-label={t('tools.name')}
                  className="h-7 flex-1 text-[13px]"
                />
                <Switch
                  checked={server.enabled}
                  aria-label={t('tools.enabled')}
                  onCheckedChange={(checked) =>
                    void persist(
                      servers.map((item) =>
                        item.id === server.id ? { ...item, enabled: checked } : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('tools.remove')}
                  onClick={() => void persist(servers.filter((item) => item.id !== server.id))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              <div className="grid grid-cols-[1fr_1fr] gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">{t('tools.command')}</Label>
                  <Input
                    value={server.command}
                    onChange={(event) => patch(server.id, { command: event.target.value })}
                    onBlur={() => void persist(servers)}
                    placeholder="npx"
                    aria-label={t('tools.command')}
                    className="h-7 font-mono text-[11px]"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{t('tools.args')}</Label>
                  <Input
                    value={server.args.join(' ')}
                    onChange={(event) =>
                      patch(server.id, { args: event.target.value.split(/\s+/).filter(Boolean) })
                    }
                    onBlur={() => void persist(servers)}
                    placeholder="-y @modelcontextprotocol/server-filesystem /path"
                    aria-label={t('tools.args')}
                    className="h-7 font-mono text-[11px]"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== '' || !server.command.trim()}
                  onClick={() => void detect(server, index)}
                >
                  {busy === key ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t('tools.detect')}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {list ? t('tools.found', { count: list.length }) : ''}
                </span>
              </div>

              {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

              {list && list.length > 0 ? (
                <div className="space-y-1 rounded-md bg-muted/40 p-1.5">
                  {list.map((tool) => {
                    const key = `${server.id}:${tool.name}`
                    const expanded = openTool === key
                    return (
                      <div key={tool.name}>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenTool(expanded ? '' : key)
                            setResult('')
                            setArgsText('{}')
                          }}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-background"
                        >
                          <ChevronDown
                            className={cn(
                              'size-3 shrink-0 text-muted-foreground transition-transform',
                              expanded && 'rotate-180',
                            )}
                          />
                          <span className="truncate font-medium">{tool.name}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {tool.description}
                          </span>
                        </button>
                        {expanded ? (
                          <div className="space-y-1.5 px-2 pb-2">
                            <textarea
                              value={argsText}
                              onChange={(event) => setArgsText(event.target.value)}
                              spellCheck={false}
                              aria-label={t('tools.argsJson')}
                              className="h-16 w-full resize-none rounded border border-border bg-background p-1.5 font-mono text-[11px] outline-none"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== ''}
                              onClick={() => void runTool(server, tool)}
                            >
                              {busy === key ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <Play className="size-3" />
                              )}
                              {t('tools.run')}
                            </Button>
                            {result ? (
                              <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[11px] whitespace-pre-wrap">
                                {result}
                              </pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}

        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void persist([
              ...servers,
              { id: '', name: '', command: '', args: [], enabled: true },
            ])
          }
        >
          <Plus className="size-3.5" />
          {t('tools.add')}
        </Button>
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('tools.footer')}</p>
    </div>
  )
}
