import { useState } from 'react'
import { Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { localId } from '@/lib/utils'
import { useT } from '@/lib/useT'
import { DEFAULT_SKILLS, useSettingsStore } from '@/stores/settings'

/**
 * 设置 → 知识库
 *
 * 对话前先在工作区做全文检索，把命中片段作为参考资料一起发给模型。
 */
export function KnowledgeSection() {
  const t = useT()
  const knowledgeEnabled = useSettingsStore((state) => state.knowledgeEnabled)
  const patch = useSettingsStore((state) => state.patch)

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{t('settings.knowledge')}</h2>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{t('settings.knowledge')}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {t('settings.knowledgeHint')}
          </p>
        </div>
        <Switch
          checked={knowledgeEnabled}
          onCheckedChange={(value: boolean) => patch({ knowledgeEnabled: value })}
          aria-label={t('settings.knowledge')}
        />
      </div>
    </div>
  )
}

/** 设置 → 记忆管理：一句一条，对话时自动注入 */
export function MemoriesSection() {
  const t = useT()
  const memories = useSettingsStore((state) => state.memories)
  const patch = useSettingsStore((state) => state.patch)
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    patch({ memories: [...memories, value].slice(0, 200) })
    setDraft('')
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{t('settings.memories')}</h2>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('settings.memoriesHint')}</p>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
          placeholder={t('settings.memoryPlaceholder')}
          aria-label={t('settings.memories')}
        />
        <Button size="sm" onClick={add} disabled={!draft.trim()} aria-label={t('settings.addMemory')}>
          <Plus className="size-3.5" />
          {t('common.create')}
        </Button>
      </div>
      <div className="space-y-1">
        {memories.length === 0 ? (
          <p className="rounded-md bg-muted/40 px-2 py-2 text-[11px] text-muted-foreground">
            {t('settings.memoriesEmpty')}
          </p>
        ) : (
          memories.map((item, index) => (
            <div
              key={`${item}-${index}`}
              className="group flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">{item}</span>
              <button
                type="button"
                aria-label={t('common.delete')}
                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                onClick={() => patch({ memories: memories.filter((_, i) => i !== index) })}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** 设置 → 技能：可复用的提示词片段 */
export function SkillsSection() {
  const t = useT()
  const skills = useSettingsStore((state) => state.skills)
  const patch = useSettingsStore((state) => state.patch)
  const [editing, setEditing] = useState('')

  const update = (id: string, value: { name?: string; prompt?: string }) => {
    patch({ skills: skills.map((item) => (item.id === id ? { ...item, ...value } : item)) })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('settings.skills')}</h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => patch({ skills: DEFAULT_SKILLS })}
            title={t('common.reset')}
            aria-label={t('common.reset')}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={t('settings.addSkill')}
            onClick={() =>
              patch({
                skills: [...skills, { id: localId(), name: t('settings.skillNew'), prompt: '' }],
              })
            }
          >
            <Plus className="size-3.5" />
            {t('common.create')}
          </Button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('settings.skillsHint')}</p>

      <div className="space-y-1.5">
        {skills.map((item) => (
          <div key={item.id} className="rounded-lg border border-border">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Wand2 className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={item.name}
                onChange={(event) => update(item.id, { name: event.target.value })}
                aria-label={t('settings.skillName')}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
              <button
                type="button"
                aria-label={t('common.delete')}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => patch({ skills: skills.filter((skill) => skill.id !== item.id) })}
              >
                <Trash2 className="size-3.5" />
              </button>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(editing === item.id ? '' : item.id)}
              >
                {editing === item.id ? t('common.done') : t('common.edit')}
              </button>
            </div>
            {editing === item.id ? (
              <textarea
                value={item.prompt}
                onChange={(event) => update(item.id, { prompt: event.target.value })}
                placeholder={t('settings.skillPrompt')}
                aria-label={t('settings.skillPrompt')}
                rows={3}
                className="w-full resize-none border-t border-border bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none"
              />
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t('settings.skillsFooter')}</p>
    </div>
  )
}
