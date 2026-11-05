/**
 * 记录整理成笔记：提示词拼装 + 结果清洗
 *
 * 对齐 NoteGen 的 `organize-notes`：
 * - 记录按类型分组喂给模型（截图识别 / 文本 / 待办 / 图片 / 链接），每条带时间；
 * - 图片记录给出 `Image URL`，并要求模型把它放到正文合适位置、**地址完整返回**；
 * - 本地图片在工作区里本来就是 `assets/xxx.png` 之类的相对路径，不用像参考项目那样
 *   再从记录里复制一份到 assets（我们落库时已经在 assets 里了）。
 *
 * 参考项目会把模型原始输出直接写进笔记，模型顺手包一层 ```markdown 围栏时，
 * 笔记就整篇变成代码块（用户实际遇到的 bug）。这里补两步清洗：
 * 1. 整篇被单个围栏包住 → 剥掉围栏；
 * 2. 模型漏掉图片 → 末尾补「附图」小节，保证图床 / 本地图片都能显示出来。
 */

export interface OrganizeRecord {
  createdAt: number
  type: string
  content: string
  meta?: Record<string, unknown> | null
}

export interface OrganizeImage {
  /** 1 起的序号，提示词里用 `Image N` 指代 */
  index: number
  /** 正文里要嵌入的地址：工作区相对路径或图床 URL */
  url: string
  name: string
  /** 替代文本：优先取识别文本首行 */
  alt: string
  /** 识别出的描述，给模型当素材 */
  desc: string
}

/** `2026-11-04 23:05` */
function stamp(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 图片记录的替代文本：识别文本首行，其次文件名 */
function imageAlt(record: OrganizeRecord, name: string): string {
  const desc = textOf(record.meta?.text)
  const firstLine = desc.split('\n').map((line) => line.trim()).find(Boolean)
  return (firstLine ?? name).slice(0, 40)
}

/** 取出所有图片记录（保持选择顺序，跳过没有地址的） */
export function collectImages(records: OrganizeRecord[]): OrganizeImage[] {
  const images: OrganizeImage[] = []
  for (const record of records) {
    if (record.type !== 'image') continue
    const url = textOf(record.content)
    if (!url) continue
    const name = textOf(record.meta?.name) || url.split('/').pop() || 'image'
    images.push({
      index: images.length + 1,
      url,
      name,
      alt: imageAlt(record, name),
      desc: textOf(record.meta?.text),
    })
  }
  return images
}

/** 单条记录的占位行：`Record 1: 内容 （时间）` */
function bullet(index: number, content: string, createdAt: number): string {
  return `Record ${index}: ${content} （${stamp(createdAt)}）`
}

/**
 * 拼提示词正文（不含系统提示词）
 *
 * 分组顺序与参考项目一致：截图识别 → 复制文本 → 待办 → 图片 → 链接。
 */
export function buildRecordsPrompt(records: OrganizeRecord[]): { text: string; images: OrganizeImage[] } {
  const images = collectImages(records)
  const sections: string[] = []

  const scan = records.filter((item) => item.type === 'image' && textOf(item.meta?.text))
  if (scan.length) {
    sections.push(
      [
        '【截图识别记录】',
        scan.map((item, index) => bullet(index + 1, textOf(item.meta?.text), item.createdAt)).join('\n'),
      ].join('\n'),
    )
  }

  const texts = records.filter((item) => item.type === 'text' || item.type === 'todo')
  if (texts.length) {
    sections.push(
      [
        '【文本与待办记录】',
        texts.map((item, index) => bullet(index + 1, textOf(item.content), item.createdAt)).join('\n'),
      ].join('\n'),
    )
  }

  const links = records.filter((item) => item.type === 'link')
  if (links.length) {
    sections.push(
      [
        '【链接记录】',
        links
          .map(
            (item, index) =>
              `Link ${index + 1}: 标题：${textOf(item.meta?.title) || textOf(item.content)}；地址：${textOf(item.content)}；内容：${textOf(item.meta?.text)} （${stamp(item.createdAt)}）`,
          )
          .join('\n'),
      ].join('\n'),
    )
  }

  const files = records.filter((item) => item.type === 'file')
  if (files.length) {
    sections.push(
      [
        '【文件记录】',
        files.map((item, index) => bullet(index + 1, textOf(item.content), item.createdAt)).join('\n'),
      ].join('\n'),
    )
  }

  if (images.length) {
    sections.push(
      [
        '【图片记录】',
        images
          .map(
            (image) =>
              `Image ${image.index}: 描述：${image.desc || image.name}；Image URL: ${image.url}`,
          )
          .join('\n'),
      ].join('\n'),
    )
  }

  return { text: sections.join('\n\n'), images }
}

/** 整篇被单个 ``` 围栏包住时剥掉（正文里的代码块不受影响） */
export function stripCodeFence(markdown: string): string {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const lines = text.split('\n')
  if (lines.length < 3) return text

  const first = lines[0].trim()
  const last = lines[lines.length - 1].trim()
  if (!/^```[\w+#.-]*$/.test(first) || last !== '```') return text

  const inner = lines.slice(1, -1)
  // 内部还有围栏说明这不是"整篇包一层"，不能剥
  if (inner.some((line) => line.trim().startsWith('```'))) return text
  return inner.join('\n').trim()
}

/** `![alt](url)`，url 里的空格 / 括号做一次最小转义 */
function imageMarkdown(image: OrganizeImage): string {
  const alt = image.alt.replace(/[[\]]/g, '')
  const url = image.url.replace(/ /g, '%20')
  return `![${alt}](${url})`
}

/**
 * 整理结果清洗
 *
 * - 剥掉模型自带的围栏（用户的"整篇变代码块"就是这么来的）；
 * - 模型没把某张图放进去 → 文末补一节「附图」，图床图片不会再"消失"；
 * - 模型把提示词里的 `Image N:` 行照抄进来的 → 删掉这些残留行。
 */
export function finalizeOrganizedNote(
  markdown: string,
  images: OrganizeImage[],
  options?: { attachmentHeading?: string },
): string {
  let text = stripCodeFence(markdown)

  // 照抄提示词的残留行（例如 `Image 1: 描述：…；Image URL: …`）
  text = text
    .split('\n')
    .filter((line) => !/^\s*Image\s+\d+\s*[:：]/.test(line))
    .join('\n')
    .trim()

  const missing = images.filter((image) => !text.includes(image.url))
  if (missing.length === 0) return text

  const heading = options?.attachmentHeading?.trim() || '附图'
  const block = missing.map(imageMarkdown).join('\n\n')
  return `${text.trimEnd()}\n\n## ${heading}\n\n${block}\n`
}
