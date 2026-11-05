/**
 * 斜杠命令（对应 NoteGen 输入 `/` 弹出的命令面板）
 *
 * - 结构性命令（标题 / 列表 / 块级 / 公式 / 图表）直接操作编辑器；
 * - AI 命令（续写 / 生成章节 / 总结 / 自定义指令）走 Sidecar 的流式接口，
 *   结果插入到光标处，不写入对话记录。
 */
import type { Editor } from '@tiptap/react'
import {
  Activity,
  Braces,
  CalendarRange,
  Code2,
  Database,
  FilePlus2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Map,
  Minus,
  PenLine,
  PieChart,
  Pilcrow,
  Quote,
  Sigma,
  Sparkles,
  Table,
  Wand2,
} from 'lucide-react'

import * as rpc from '@/lib/rpc'
import { isModelReady, resolveModel, toRpcConfig } from '@/lib/aiConfig'
import { mermaidTemplate } from '@/lib/mermaidNode'
import { useSettingsStore } from '@/stores/settings'
import { openBlockMathDialog } from '@/lib/editorBus'
import { useNotesStore } from '@/stores/notes'

export type SlashGroup = 'ai' | 'heading' | 'list' | 'block' | 'math' | 'chart'

export const SLASH_GROUPS: SlashGroup[] = ['ai', 'heading', 'list', 'block', 'math', 'chart']

export interface SlashItem {
  id: string
  group: SlashGroup
  icon: typeof Sparkles
  /** 中英文案：按当前界面语言取一组 */
  label: { zh: string; en: string }
  hint: { zh: string; en: string }
  /** 额外搜索词（英文 / 拼音首字母等） */
  keywords?: string
}

export const SLASH_ITEMS: SlashItem[] = [
  // ---- AI ----
  {
    id: 'ai.extend',
    group: 'ai',
    icon: Sparkles,
    label: { zh: '续写', en: 'Continue writing' },
    hint: { zh: 'AI 续写内容', en: 'Let AI continue the text' },
    keywords: 'continue xuxie',
  },
  {
    id: 'ai.chapter',
    group: 'ai',
    icon: Pilcrow,
    label: { zh: '生成章节', en: 'New chapter' },
    hint: { zh: '根据当前笔记生成一个新章节', en: 'Draft a new chapter from this note' },
    keywords: 'chapter zhangjie',
  },
  {
    id: 'ai.summary',
    group: 'ai',
    icon: FileText,
    label: { zh: '总结', en: 'Summarize' },
    hint: { zh: '总结当前笔记内容', en: 'Summarize the current note' },
    keywords: 'summary zongjie',
  },
  {
    id: 'ai.custom',
    group: 'ai',
    icon: Wand2,
    label: { zh: '自定义指令', en: 'Custom prompt' },
    hint: { zh: '输入自己的指令并让 AI 执行', en: 'Run your own instruction with AI' },
    keywords: 'custom prompt zidingyi',
  },

  // ---- 标题 ----
  { id: 'heading.1', group: 'heading', icon: Heading1, label: { zh: '一级标题', en: 'Heading 1' }, hint: { zh: 'H1', en: 'H1' } },
  { id: 'heading.2', group: 'heading', icon: Heading2, label: { zh: '二级标题', en: 'Heading 2' }, hint: { zh: 'H2', en: 'H2' } },
  { id: 'heading.3', group: 'heading', icon: Heading3, label: { zh: '三级标题', en: 'Heading 3' }, hint: { zh: 'H3', en: 'H3' } },
  { id: 'heading.4', group: 'heading', icon: Heading4, label: { zh: '四级标题', en: 'Heading 4' }, hint: { zh: 'H4', en: 'H4' } },
  { id: 'heading.5', group: 'heading', icon: Heading5, label: { zh: '五级标题', en: 'Heading 5' }, hint: { zh: 'H5', en: 'H5' } },
  { id: 'heading.6', group: 'heading', icon: Heading6, label: { zh: '六级标题', en: 'Heading 6' }, hint: { zh: 'H6', en: 'H6' } },

  // ---- 列表 ----
  {
    id: 'list.bullet',
    group: 'list',
    icon: List,
    label: { zh: '无序列表', en: 'Bullet list' },
    hint: { zh: '用圆点列点', en: 'Bulleted list' },
    keywords: 'bullet ul',
  },
  {
    id: 'list.ordered',
    group: 'list',
    icon: ListOrdered,
    label: { zh: '有序列表', en: 'Numbered list' },
    hint: { zh: '自动编号', en: 'Numbered list' },
    keywords: 'ordered ol',
  },
  {
    id: 'list.task',
    group: 'list',
    icon: ListTodo,
    label: { zh: '任务列表', en: 'Task list' },
    hint: { zh: '可勾选的待办', en: 'Checklist' },
    keywords: 'task todo',
  },

  // ---- 块级 ----
  {
    id: 'block.quote',
    group: 'block',
    icon: Quote,
    label: { zh: '引用', en: 'Quote' },
    hint: { zh: '引用一段内容', en: 'Blockquote' },
  },
  {
    id: 'block.code',
    group: 'block',
    icon: Code2,
    label: { zh: '代码块', en: 'Code block' },
    hint: { zh: '带语法高亮', en: 'Code block' },
  },
  {
    id: 'block.alert',
    group: 'block',
    icon: Lightbulb,
    label: { zh: '提示块', en: 'Callout' },
    hint: { zh: '说明 / 提示 / 警告等强调块', en: 'Note, tip, warning callout' },
    keywords: 'alert callout note tip warning 提示 警告 注意',
  },
  {
    id: 'block.table',
    group: 'block',
    icon: Table,
    label: { zh: '表格', en: 'Table' },
    hint: { zh: '插入 3×3 表格', en: 'Insert a 3×3 table' },
  },
  {
    id: 'block.divider',
    group: 'block',
    icon: Minus,
    label: { zh: '分割线', en: 'Divider' },
    hint: { zh: '横线分隔', en: 'Horizontal rule' },
  },
  {
    id: 'block.image',
    group: 'block',
    icon: ImageIcon,
    label: { zh: '图片', en: 'Image' },
    hint: { zh: '插入图片占位', en: 'Insert an image placeholder' },
  },
  {
    id: 'block.file',
    group: 'block',
    icon: FilePlus2,
    label: { zh: '文件', en: 'File' },
    hint: { zh: '插入工作区文件链接', en: 'Link a workspace file' },
    keywords: 'file attachment link 附件',
  },
  {
    id: 'block.link',
    group: 'block',
    icon: Link2,
    label: { zh: '链接', en: 'Link' },
    hint: { zh: '插入一段链接', en: 'Insert a link' },
  },

  // ---- 数学 ----
  {
    id: 'math.inline',
    group: 'math',
    icon: Sigma,
    label: { zh: '行内公式', en: 'Inline formula' },
    hint: { zh: '$E = mc^2$', en: '$E = mc^2$' },
  },
  {
    id: 'math.block',
    group: 'math',
    icon: Braces,
    label: { zh: '块级公式', en: 'Block formula' },
    hint: { zh: '$$ ... $$', en: '$$ ... $$' },
  },

  // ---- 图表（全部走 Mermaid，与参考实现同一套图类型）----
  { id: 'chart.flowchart', group: 'chart', icon: GitBranch, label: { zh: '流程图', en: 'Flowchart' }, hint: { zh: '步骤与分支', en: 'Steps and branches' }, keywords: 'mermaid flowchart' },
  { id: 'chart.sequence', group: 'chart', icon: GitCommitHorizontal, label: { zh: '时序图', en: 'Sequence' }, hint: { zh: '参与者交互顺序', en: 'Actor interactions' }, keywords: 'mermaid sequence' },
  { id: 'chart.gantt', group: 'chart', icon: CalendarRange, label: { zh: '甘特图', en: 'Gantt' }, hint: { zh: '项目排期', en: 'Project schedule' }, keywords: 'mermaid gantt' },
  { id: 'chart.classDiagram', group: 'chart', icon: Layers, label: { zh: '类图', en: 'Class diagram' }, hint: { zh: '类与继承关系', en: 'Classes and inheritance' }, keywords: 'mermaid class' },
  { id: 'chart.stateDiagram', group: 'chart', icon: Activity, label: { zh: '状态图', en: 'State diagram' }, hint: { zh: '状态流转', en: 'State transitions' }, keywords: 'mermaid state' },
  { id: 'chart.pie', group: 'chart', icon: PieChart, label: { zh: '饼图', en: 'Pie chart' }, hint: { zh: '占比分布', en: 'Share breakdown' }, keywords: 'mermaid pie' },
  { id: 'chart.er', group: 'chart', icon: Database, label: { zh: 'ER 图', en: 'ER diagram' }, hint: { zh: '实体关系', en: 'Entity relations' }, keywords: 'mermaid er' },
  { id: 'chart.journey', group: 'chart', icon: Map, label: { zh: '旅程图', en: 'Journey' }, hint: { zh: '用户旅程', en: 'User journey' }, keywords: 'mermaid journey' },
]

/** 按当前语言取文案 */
export function itemText(item: SlashItem, zh: boolean) {
  return zh ? item.label.zh : item.label.en
}

export function itemHint(item: SlashItem, zh: boolean) {
  return zh ? item.hint.zh : item.hint.en
}

/** 搜索：中英文名 + 关键词 */
export function matchItems(query: string): SlashItem[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return SLASH_ITEMS
  return SLASH_ITEMS.filter((item) => {
    const haystack = `${item.label.zh}${item.label.en}${item.keywords ?? ''}`.toLowerCase()
    return haystack.includes(keyword)
  })
}

/** 插入 markdown 文本（尽量走 markdown 解析，失败则退化为纯文本） */
function insertMarkdown(editor: Editor, markdown: string, position: 'cursor' | 'end' = 'cursor') {
  const content = position === 'end' ? `\n\n${markdown}\n` : markdown
  // 必须声明 contentType：否则 `[文字](地址)` 会被当成纯文本转义成 `\[文字\](地址)`
  try {
    if (position === 'end') {
      const end = editor.state.doc.content.size
      editor
        .chain()
        .focus()
        .insertContentAt(end, content, { contentType: 'markdown' })
        .run()
      return
    }
    editor.chain().focus().insertContent(content, { contentType: 'markdown' }).run()
  } catch {
    editor.chain().focus().insertContent(content).run()
  }
}

/** 执行一条斜杠命令；AI 类命令返回 Promise */
export async function runSlashCommand(
  id: string,
  editor: Editor,
  options: { customPrompt?: string } = {},
): Promise<void> {
  if (id.startsWith('ai.')) {
    await runAiCommand(id, editor, options.customPrompt)
    return
  }
  if (id.startsWith('heading.')) {
    const level = Number(id.split('.')[1]) as 1 | 2 | 3 | 4 | 5 | 6
    editor.chain().focus().toggleHeading({ level }).run()
    return
  }
  switch (id) {
    case 'list.bullet':
      editor.chain().focus().toggleBulletList().run()
      return
    case 'list.ordered':
      editor.chain().focus().toggleOrderedList().run()
      return
    case 'list.task':
      editor.chain().focus().toggleTaskList().run()
      return
    case 'block.quote':
      editor.chain().focus().toggleBlockquote().run()
      return
    case 'block.code':
      editor.chain().focus().toggleCodeBlock().run()
      return
    case 'block.alert':
      // GitHub Alert 提示块（`> [!NOTE]`），类型可在块内下拉切换
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'githubAlert',
          attrs: { alertType: 'NOTE' },
          content: [{ type: 'paragraph' }],
        })
        .run()
      return
    case 'block.table':
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      return
    case 'block.divider':
      editor.chain().focus().setHorizontalRule().run()
      return
    case 'block.image':
      insertMarkdown(editor, '![图片说明](assets/图片.png)')
      return
    case 'block.link':
      insertMarkdown(editor, '[链接文字](https://example.com)')
      return
    case 'math.inline':
      // 直接插入行内公式节点（KaTeX 渲染），而不是一段纯文本
      editor.chain().focus().insertContent({ type: 'inlineMath', attrs: { latex: 'E = mc^2' } }).run()
      return
    case 'math.block':
      // 块级公式走弹窗：示例列表 + 实时预览（对齐参考实现），见 BlockMathDialog
      if (openBlockMathDialog()) return
      editor
        .chain()
        .focus()
        .insertContent({ type: 'blockMath', attrs: { latex: '\\int_a^b f(x)\\,dx' } })
        .run()
      return
    case 'chart.flowchart':
    case 'chart.sequence':
    case 'chart.gantt':
    case 'chart.classDiagram':
    case 'chart.stateDiagram':
    case 'chart.pie':
    case 'chart.er':
    case 'chart.journey': {
      // 插入真正的图表节点（mermaid 渲染），不是一段代码块文本
      const type = id.slice('chart.'.length)
      const zh = useSettingsStore.getState().locale.startsWith('zh')
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'mermaidDiagram',
          attrs: { code: mermaidTemplate(type, zh), type },
        })
        .run()
      return
    }
    default:
      return
  }
}

/** AI 命令：取上下文 → 流式生成 → 插入 */
async function runAiCommand(id: string, editor: Editor, customPrompt?: string) {
  const settings = useSettingsStore.getState()
  // 斜杠里的写作指令复用「对话」用途的模型
  const model = resolveModel(settings.ai, { type: 'chat' })
  if (!isModelReady(model)) {
    throw new Error('请先在设置 → AI 模型里配置厂商与对话模型')
  }
  const zh = settings.locale.startsWith('zh')
  const noteContent = useNotesStore.getState().content || ''
  const selection = editor.state.doc.textBetween(
    editor.state.selection.from,
    editor.state.selection.to,
    '\n',
  )
  const before = editor.state.doc.textBetween(0, editor.state.selection.from, '\n')
  const context = (selection || noteContent).slice(-8000)

  const prompts: Record<string, string> = {
    'ai.extend': zh
      ? '请顺着下面的内容自然地继续写下去，不要重复已有句子，不要解释你在做什么，直接输出续写正文。'
      : 'Continue the text below naturally. Do not repeat existing sentences, do not explain, output only the continuation.',
    'ai.chapter': zh
      ? '请根据下面的笔记内容，生成一个新章节：先给一个二级标题，再写 2-4 段正文，保持原笔记的语气。'
      : 'Draft a new chapter from the note below: a level-2 heading followed by 2-4 paragraphs in the same voice.',
    'ai.summary': zh
      ? '请用 3-7 条要点总结下面的内容，每条一行，保留关键数据与结论。'
      : 'Summarize the content below in 3-7 bullet points, one per line, keeping key data and conclusions.',
    'ai.custom': customPrompt ?? '',
  }
  const instruction = prompts[id]?.trim()
  if (!instruction) throw new Error(zh ? '指令不能为空' : 'Instruction cannot be empty')

  const payload = [
    { role: 'system' as const, content: zh ? '你是中文写作助手，输出 Markdown。' : 'You are a writing assistant. Reply in Markdown.' },
    {
      role: 'user' as const,
      content: `${instruction}\n\n${before.trim() ? `【光标前的内容】\n${before.slice(-4000)}` : ''}\n\n【笔记内容】\n${context}`,
    },
  ]

  const started = await rpc.aiStart({
    ...toRpcConfig(model),
    messages: payload,
  })

  let text = ''
  const begin = Date.now()
  for (;;) {
    if (Date.now() - begin > 120_000) throw new Error(zh ? '生成超时' : 'Timed out')
    const chunk = await rpc.aiPoll(started.id)
    text = chunk.text
    if (chunk.done) {
      if (chunk.error) throw new Error(chunk.error)
      break
    }
    await new Promise((resolve) => window.setTimeout(resolve, 160))
  }

  const result = text.trim()
  if (!result) throw new Error(zh ? '模型没有返回内容' : 'Empty response')
  insertMarkdown(editor, result, id === 'ai.extend' ? 'cursor' : 'end')
}
