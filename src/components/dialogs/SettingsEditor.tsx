/**
 * 设置 → 编辑器设置
 *
 * 对齐 NoteGen `settings/editor`：写作布局（内容宽度 / 行高）、
 * 编辑器显示（编辑模式 / 源码行号 / 自动换行 / 写作统计 / 大纲 / 撤销重做）。
 */
import {
  AlignCenterHorizontal,
  ChartNoAxesColumnIncreasing,
  Code2,
  ListOrdered,
  ListTree,
  PanelLeft,
  PanelRight,
  TextCursorInput,
  Undo2,
  WrapText,
} from 'lucide-react'

import { Switch } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/useT'
import {
  EDITOR_CONTENT_WIDTH,
  contentWidthOf,
  useSettingsStore,
  type EditorContentWidth,
  type EditorLineHeight,
} from '@/stores/settings'

import { Segmented, SettingItem, SettingPage, SettingSection } from './settings/Parts'

const CONTENT_WIDTHS: EditorContentWidth[] = ['narrow', 'standard', 'wide', 'full']
const LINE_HEIGHTS: EditorLineHeight[] = ['compact', 'comfortable', 'relaxed']

export function EditorSection() {
  const t = useT()
  const editor = useSettingsStore((state) => state.editor)
  const editorWidth = useSettingsStore((state) => state.editorWidth)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const patch = useSettingsStore((state) => state.patch)

  const patchEditor = (next: Partial<typeof editor>) => patch({ editor: { ...editor, ...next } })
  const width = contentWidthOf(editorWidth)

  return (
    <SettingPage title={t('ed.title')} desc={t('ed.desc')}>
      <SettingSection title={t('ed.layout.title')} desc={t('ed.layout.desc')}>
        <SettingItem
          icon={AlignCenterHorizontal}
          title={t('ed.layout.width.title')}
          desc={t('ed.layout.width.desc')}
        >
          <Segmented
            label={t('ed.layout.width.title')}
            value={width}
            options={CONTENT_WIDTHS.map((value) => ({
              value,
              label: t(`ed.layout.width.options.${value}`),
            }))}
            onChange={(value) => patch({ editorWidth: EDITOR_CONTENT_WIDTH[value] })}
          />
        </SettingItem>

        <SettingItem
          icon={TextCursorInput}
          title={t('ed.layout.lineHeight.title')}
          desc={t('ed.layout.lineHeight.desc')}
        >
          <Segmented
            label={t('ed.layout.lineHeight.title')}
            value={editor.lineHeight}
            options={LINE_HEIGHTS.map((value) => ({
              value,
              label: t(`ed.layout.lineHeight.options.${value}`),
            }))}
            onChange={(value) => patchEditor({ lineHeight: value })}
          />
        </SettingItem>

        <SettingItem icon={TextCursorInput} title={t('ed.fontSize')} desc={`${fontSize}px`}>
          <input
            type="range"
            aria-label={t('ed.fontSize')}
            min={13}
            max={20}
            step={1}
            value={fontSize}
            onChange={(event) => patch({ fontSize: Number(event.target.value) })}
            className="w-40 accent-primary"
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('ed.display.title')} desc={t('ed.display.desc')}>
        <SettingItem icon={Code2} title={t('ed.mode.title')} desc={t('ed.mode.desc')}>
          <Segmented
            label={t('ed.mode.title')}
            value={editor.viewMode}
            options={[
              { value: 'visual' as const, label: t('ed.mode.options.visual') },
              { value: 'source' as const, label: t('ed.mode.options.source') },
            ]}
            onChange={(value) => patchEditor({ viewMode: value })}
          />
        </SettingItem>

        {editor.viewMode === 'source' ? (
          <>
            <SettingItem
              icon={ListOrdered}
              title={t('ed.lineNumbers.title')}
              desc={t('ed.lineNumbers.desc')}
            >
              <Switch
                aria-label={t('ed.lineNumbers.title')}
                checked={editor.showSourceLineNumbers}
                onCheckedChange={(value) => patchEditor({ showSourceLineNumbers: value })}
              />
            </SettingItem>

            <SettingItem icon={WrapText} title={t('ed.wrap.title')} desc={t('ed.wrap.desc')}>
              <Switch
                aria-label={t('ed.wrap.title')}
                checked={editor.sourceWrap}
                onCheckedChange={(value) => patchEditor({ sourceWrap: value })}
              />
            </SettingItem>
          </>
        ) : null}

        <SettingItem icon={ChartNoAxesColumnIncreasing} title={t('ed.stats.title')} desc={t('ed.stats.desc')}>
          <Switch
            aria-label={t('ed.stats.title')}
            checked={editor.showStats}
            onCheckedChange={(value) => patchEditor({ showStats: value })}
          />
        </SettingItem>

        <SettingItem icon={ListTree} title={t('ed.outline.placement')} desc={t('ed.outline.placementDesc')}>
          <Segmented
            label={t('ed.outline.placement')}
            value={editor.outlinePlacement}
            options={[
              { value: 'editor' as const, label: t('ed.outline.placementOptions.editor') },
              { value: 'sidebar' as const, label: t('ed.outline.placementOptions.sidebar') },
            ]}
            onChange={(value) => patchEditor({ outlinePlacement: value })}
          />
        </SettingItem>

        {editor.outlinePlacement === 'editor' ? (
          <SettingItem icon={ListTree} title={t('ed.outline.enable')} desc={t('ed.outline.enableDesc')}>
            <Switch
              aria-label={t('ed.outline.enable')}
              checked={editor.outlineEnabled}
              onCheckedChange={(value) => patchEditor({ outlineEnabled: value })}
            />
          </SettingItem>
        ) : null}

        {editor.outlinePlacement === 'editor' ? (
          <SettingItem
            icon={editor.outlinePosition === 'left' ? PanelLeft : PanelRight}
            title={t('ed.outline.position')}
            desc={t('ed.outline.positionDesc')}
            disabled={!editor.outlineEnabled}
          >
            <Segmented
              label={t('ed.outline.position')}
              value={editor.outlinePosition}
              disabled={!editor.outlineEnabled}
              options={[
                { value: 'left' as const, label: t('ed.outline.positionOptions.left') },
                { value: 'right' as const, label: t('ed.outline.positionOptions.right') },
              ]}
              onChange={(value) => patchEditor({ outlinePosition: value })}
            />
          </SettingItem>
        ) : null}

        <SettingItem icon={Undo2} title={t('ed.undoRedo')} desc={t('ed.undoRedoDesc')}>
          <Switch
            aria-label={t('ed.undoRedo')}
            checked={editor.showUndoRedo}
            onCheckedChange={(value) => patchEditor({ showUndoRedo: value })}
          />
        </SettingItem>
      </SettingSection>

      <SettingSection title={t('ed.editing.title')} desc={t('ed.editing.desc')}>
        <SettingItem title={t('ed.spellcheck.title')} desc={t('ed.spellcheck.desc')}>
          <Switch
            aria-label={t('ed.spellcheck.title')}
            checked={editor.spellcheck}
            onCheckedChange={(value) => patchEditor({ spellcheck: value })}
          />
        </SettingItem>

        <SettingItem title={t('ed.autoSave.title')} desc={t('ed.autoSave.desc')}>
          <Segmented
            label={t('ed.autoSave.title')}
            value={String(editor.autoSaveMs)}
            options={[400, 800, 1500, 3000].map((value) => ({
              value: String(value),
              label: `${value}ms`,
            }))}
            onChange={(value) => patchEditor({ autoSaveMs: Number(value) })}
          />
        </SettingItem>

        <SettingItem title={t('ed.pasteMaxEdge.title')} desc={t('ed.pasteMaxEdge.desc')}>
          <Segmented
            label={t('ed.pasteMaxEdge.title')}
            value={String(editor.pasteMaxEdge)}
            options={[0, 1280, 1920, 2560].map((value) => ({
              value: String(value),
              label: value === 0 ? t('ed.pasteMaxEdge.off') : `${value}px`,
            }))}
            onChange={(value) => patchEditor({ pasteMaxEdge: Number(value) })}
          />
        </SettingItem>
      </SettingSection>

      <p className={cn('text-[11px] leading-relaxed text-muted-foreground')}>{t('ed.footnote')}</p>
    </SettingPage>
  )
}
