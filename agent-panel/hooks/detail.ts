// 子代理詳細頁的紀錄區：把一個子代理的紀錄排成一列一列帶顏色的文字片段。
// 每一列都先排進面板寬度，畫面截斷時也不會折行
import type { AgentLog, LogEntry, ToolOutcome } from '../types'
import { displayWidth, fitToWidth, formatElapsed } from './layout'
import type { Span } from './layout'

export const BACK_LABEL = '← 返回'

export type DetailOptions = { columns: number; now: number; startedAt: number }

type RowLayout = DetailOptions & { timeWidth: number }
type ToolEntry = Extract<LogEntry, { kind: 'tool' }>

const REPORT_LABEL = '回報'
const EMPTY_HINT = 'mod 載入前的紀錄沒有保留'
const MESSAGE_MAX_LINES = 3
const MESSAGE_CUT = '…」'
const TOOL_ICONS: Record<ToolOutcome, { icon: string; color?: string }> = {
  ok: { icon: '✓', color: 'success' },
  error: { icon: '✗', color: 'error' },
  denied: { icon: '⊘', color: 'warning' },
  running: { icon: '…' },
  unfinished: { icon: '·' },
}
// 子代理執行中面板每 0.2 秒重畫一次，回報最長幾百列：換行結果依（寬度、文字）快取，不每次重算
const WRAP_CACHE_LIMIT = 50
const wrapCache = new Map<string, string[]>()

export function formatOffset(ms: number): string {
  return `+${formatElapsed(ms)}`
}

// rows：紀錄區的每一列；newestRow：最新一筆的第一列在 rows 裡的位置（點開時捲到這裡），沒有紀錄是 -1
export type DetailLayout = { rows: Span[][]; newestRow: number }

export function detailLayout(log: AgentLog, options: DetailOptions): DetailLayout {
  if (log.entries.length === 0 && log.dropped === 0) return { rows: [[{ text: EMPTY_HINT, isDim: true }]], newestRow: -1 }
  const times = log.entries.map(entry => formatOffset(entry.at - options.startedAt))
  // 時間欄依最寬的對齊，續行才能對到同一欄
  const layout: RowLayout = { ...options, timeWidth: Math.max(0, ...times.map(displayWidth)) }
  const rows: Span[][] = log.dropped > 0 ? [[{ text: `更早的 ${log.dropped} 筆已省略`, isDim: true }]] : []
  let newestRow = -1
  log.entries.forEach((entry, index) => {
    newestRow = rows.length
    rows.push(...entryRows(entry, padTime(times[index] ?? '', layout.timeWidth), layout))
  })
  return { rows, newestRow }
}

export function detailRows(log: AgentLog, options: DetailOptions): Span[][] {
  return detailLayout(log, options).rows
}

// 依顯示寬度逐字硬切（中文 2 欄），'\n' 分段，空段落是空字串
export function wrapToWidth(text: string, width: number): string[] {
  return text.split('\n').flatMap(paragraph => wrapParagraph(paragraph, width))
}

function entryRows(entry: LogEntry, time: string, layout: RowLayout): Span[][] {
  if (entry.kind === 'tool') return toolRows(entry, time, layout)
  if (entry.kind === 'message') return messageRows(entry.text, time, layout)
  return reportRows(entry.text, time, layout)
}

// 時間、圖示、一行摘要；執行中的右邊是已經跑了多久，出錯或被拒絕時下一列寫原因
function toolRows(entry: ToolEntry, time: string, layout: RowLayout): Span[][] {
  const { icon, color } = TOOL_ICONS[entry.outcome]
  const isDim = entry.outcome === 'unfinished'
  const prefixWidth = layout.timeWidth + 3
  const elapsed = entry.outcome === 'running' ? formatElapsed(layout.now - entry.at) : ''
  const summaryWidth = layout.columns - prefixWidth - (elapsed === '' ? 0 : displayWidth(elapsed) + 1)
  const summary = fitToWidth(entry.summary, summaryWidth)
  const first: Span[] = [
    { text: time, isDim: true },
    { text: ' ', isDim },
    { text: icon, color, isDim },
    { text: ' ', isDim },
    { text: summary, isDim },
  ]
  if (elapsed !== '') {
    const gap = layout.columns - prefixWidth - displayWidth(summary) - displayWidth(elapsed)
    first.push({ text: ' '.repeat(Math.max(1, gap)) }, { text: elapsed })
  }
  const hasReason = entry.errorLine !== null && (entry.outcome === 'error' || entry.outcome === 'denied')
  if (!hasReason) return [first]
  return [first, [{ text: ' '.repeat(prefixWidth) }, { text: fitToWidth(entry.errorLine ?? '', layout.columns - prefixWidth), color }]]
}

// 中途訊息：連續空白合成一個，包成「」後換行，最多 3 列，放不下時第 3 列結尾換成 …」
function messageRows(text: string, time: string, layout: RowLayout): Span[][] {
  const contentWidth = contentWidthOf(layout)
  const lines = wrapCached(`「${text.replace(/\s+/g, ' ').trim()}」`, contentWidth)
  const shown =
    lines.length > MESSAGE_MAX_LINES
      ? [...lines.slice(0, MESSAGE_MAX_LINES - 1), takeWidth(lines[MESSAGE_MAX_LINES - 1] ?? '', contentWidth - displayWidth(MESSAGE_CUT)) + MESSAGE_CUT]
      : lines
  const [head = '', ...rest] = shown
  return [[{ text: time, isDim: true }, { text: ' ' }, { text: head }], ...rest.map(line => continuationRow(line, layout))]
}

// 回報：一列標題，下面照原本的段落完整換行（空行保留）
function reportRows(text: string, time: string, layout: RowLayout): Span[][] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  const body = wrapCached(normalized, contentWidthOf(layout)).map(line => continuationRow(line, layout))
  return [[{ text: time, isDim: true }, { text: ' ' }, { text: REPORT_LABEL, isBold: true }], ...body]
}

function continuationRow(line: string, layout: RowLayout): Span[] {
  return [{ text: ' '.repeat(layout.timeWidth + 1) }, { text: line }]
}

function contentWidthOf(layout: RowLayout) {
  return layout.columns - layout.timeWidth - 1
}

function padTime(time: string, timeWidth: number) {
  return time + ' '.repeat(Math.max(0, timeWidth - displayWidth(time)))
}

function wrapCached(text: string, width: number): string[] {
  const key = `${width}|${text}`
  const cached = wrapCache.get(key)
  if (cached !== undefined) return cached
  if (wrapCache.size >= WRAP_CACHE_LIMIT) wrapCache.clear()
  const lines = wrapToWidth(text, width)
  wrapCache.set(key, lines)
  return lines
}

function wrapParagraph(paragraph: string, width: number): string[] {
  if (paragraph === '') return ['']
  const lines: string[] = []
  let line = ''
  let lineWidth = 0
  for (const char of paragraph) {
    const charWidth = displayWidth(char)
    // 一列至少放一個字，寬度比字還窄時也不會無限迴圈
    if (lineWidth + charWidth > width && line !== '') {
      lines.push(line)
      line = ''
      lineWidth = 0
    }
    line += char
    lineWidth += charWidth
  }
  lines.push(line)
  return lines
}

// 取開頭不超過 width 欄的部分，不補「…」
function takeWidth(text: string, width: number): string {
  let kept = ''
  let keptWidth = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (keptWidth + charWidth > width) break
    kept += char
    keptWidth += charWidth
  }
  return kept
}
