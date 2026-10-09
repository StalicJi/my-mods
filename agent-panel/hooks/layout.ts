// 面板的版面：把一個子代理變成每一列的文字、顏色與進度條格子，以及時間、token、費用的格式。
// displayWidth、fitToWidth、colorRuns、cometColor、describeTool 照搬自 clean-view/hooks/register.tsx
// （mod 之間不能共用程式碼），改那邊的用字或配色時這裡要一起改
import type { AgentRow, Batch } from '../types'
import { agentTokens } from './batch'
import { contextPercent, modelInfo } from './pricing'
import type { ModelFamily } from './pricing'

export type Span = { text: string; color?: string; isDim?: boolean; isBold?: boolean }

// lines 是進度條以外的每一列；bar 是進度條每一格的顏色
export type Card = { lines: Span[][]; bar: string[] }

const ORANGE = '#f79a4f'
const PINK = '#ec4f8f'
const PURPLE = '#b45ce6'
const BLUE = '#6f7df2'
const GREEN = '#46b06e'
const GRAY = '#8a8a94'
const TRACK_COLOR = '#4a4a52'
const ACCENT_COLORS = [ORANGE, PINK, PURPLE, BLUE]
const FAMILY_COLORS: Record<ModelFamily, string> = { opus: ORANGE, sonnet: BLUE, haiku: GREEN, fable: PURPLE, unknown: GRAY }

const INDENT = '  '
// 彗星：頭最亮，後面四格一格比一格淡，融進底色
const COMET_FADE = [1, 0.7, 0.45, 0.25, 0.1]
const COMET_COLOR_HALF_PERIOD_FRAMES = 15 // 從橘變到藍約 3 秒（每拍 0.2 秒）
// 面板內寬窄於這個欄數時，三格統計放不下，改成一行
const TILES_MIN_COLUMNS = 36

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count))
  const thousands = Math.round(count / 1000)
  if (thousands < 1000) return `${thousands}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

// 費用一律是估算，標「≈」；有請求的模型不在價目表時補「?」
export function formatCost(costUsd: number, hasUnpriced: boolean): string {
  if (hasUnpriced && costUsd === 0) return '≈?'
  return `≈$${costUsd.toFixed(2)}${hasUnpriced ? '+?' : ''}`
}

export function summaryMode(columns: number): 'tiles' | 'line' {
  return columns < TILES_MIN_COLUMNS ? 'line' : 'tiles'
}

// 失敗的也放在 Finished；各組維持派出順序
export function splitSections(batch: Batch): { running: AgentRow[]; finished: AgentRow[] } {
  return {
    running: batch.agents.filter(agent => agent.status === 'running'),
    finished: batch.agents.filter(agent => agent.status !== 'running'),
  }
}

export function agentCard(row: AgentRow, options: { columns: number; now: number; frame: number }): Card {
  const { columns, now, frame } = options
  const barWidth = Math.max(0, columns - INDENT.length)
  const lines = [titleLine(row, frame), modelLine(row)]
  if (row.status === 'running') lines.push([{ text: INDENT }, { text: row.activity || '思考中', isDim: true }])
  if (row.status === 'failed') lines.push([{ text: INDENT }, { text: row.failureReason ?? '', color: 'error' }])
  lines.push(usageLine(row, now))
  return { lines: lines.map(line => fitLine(line, columns)), bar: cardBar(row, barWidth, frame) }
}

function titleLine(row: AgentRow, frame: number): Span[] {
  const isRunning = row.status === 'running'
  const mark: Span =
    row.status === 'running'
      ? { text: '● ', color: cometColor(frame), isBold: true }
      : row.status === 'done'
        ? { text: '✓ ', color: 'success' }
        : { text: '✗ ', color: 'error' }
  return [mark, { text: `${row.isNested ? '↳ ' : ''}${row.description}`, isBold: isRunning }]
}

function modelLine(row: AgentRow): Span[] {
  const model = row.model === null ? null : modelInfo(row.model)
  const name: Span = model === null ? { text: 'starting', isDim: true } : { text: model.name, color: FAMILY_COLORS[model.family] }
  const effort = row.effort === null ? '' : ` · ${row.effort}`
  return [{ text: INDENT }, name, { text: `${effort} · ${row.toolCount} tools`, isDim: true }]
}

function usageLine(row: AgentRow, now: number): Span[] {
  const percent = row.model !== null && row.lastUsage !== null ? contextPercent(row.model, row.lastUsage) : null
  const parts = [
    ...(percent === null ? [] : [`ctx ${percent}%`]),
    formatTokens(agentTokens(row)),
    formatCost(row.costUsd, row.hasUnpricedUsage),
    formatElapsed((row.endedAt ?? now) - row.startedAt),
  ]
  return [{ text: INDENT }, { text: parts.join(' · '), isDim: true }]
}

function cardBar(row: AgentRow, width: number, frame: number): string[] {
  const positions = Array.from({ length: width }, (_, index) => index)
  if (row.status === 'failed') return positions.map(() => GRAY)
  if (row.status === 'done') {
    const family = row.model === null ? 'unknown' : modelInfo(row.model).family
    return positions.map(() => FAMILY_COLORS[family])
  }
  // 執行中：一顆彗星從左往右走，尾巴也離開右邊後再從左邊進來，frame 每拍加一
  const head = frame % (width + COMET_FADE.length)
  const headColor = cometColor(frame)
  return positions.map(index => {
    const intensity = COMET_FADE[head - index]
    return intensity === undefined ? TRACK_COLOR : mixColor(TRACK_COLOR, headColor, intensity)
  })
}

// 一列超過寬度時從尾端截斷：名稱、正在做什麼可能很長，模型與用量列在很窄的面板也可能放不下
function fitLine(spans: Span[], columns: number): Span[] {
  const fitted: Span[] = []
  let used = 0
  for (const span of spans) {
    const width = displayWidth(span.text)
    if (used + width <= columns) {
      fitted.push(span)
      used += width
      continue
    }
    const text = fitToWidth(span.text, columns - used)
    if (text) fitted.push({ ...span, text })
    break
  }
  return fitted
}

// 彗星此刻的顏色：沿著 ACCENT_COLORS 來回走，一個來回是兩個半週期
export function cometColor(frame: number): string {
  const phase = frame % (COMET_COLOR_HALF_PERIOD_FRAMES * 2)
  const progress = (phase <= COMET_COLOR_HALF_PERIOD_FRAMES ? phase : COMET_COLOR_HALF_PERIOD_FRAMES * 2 - phase) / COMET_COLOR_HALF_PERIOD_FRAMES
  return paletteAt(ACCENT_COLORS, progress)
}

// 沿著一串顏色取色：progress 0 是第一個、1 是最後一個，中間在相鄰兩色之間內插
function paletteAt(colors: readonly string[], progress: number) {
  const position = progress * (colors.length - 1)
  const lower = Math.min(Math.floor(position), colors.length - 2)
  return mixColor(colors[lower]!, colors[lower + 1]!, position - lower)
}

// 兩個顏色之間取比例：0 是 from、1 是 to
function mixColor(from: string, to: string, ratio: number) {
  const target = hexChannels(to)
  const mixed = hexChannels(from).map((channel, i) => Math.round(channel + (target[i]! - channel) * ratio))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function hexChannels(hex: string) {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16))
}

// 連續同色的格子合併成一段，少畫很多元素
export function colorRuns(cells: readonly string[]): { color: string; count: number }[] {
  const runs: { color: string; count: number }[] = []
  for (const color of cells) {
    const last = runs[runs.length - 1]
    if (last?.color === color) last.count += 1
    else runs.push({ color, count: 1 })
  }
  return runs
}

// 東亞寬字元、全形符號與 emoji 在終端機佔兩格；範圍用 \u 跳脫，避免存檔時字元被正規化成別的碼位
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

function charWidth(char: string) {
  return WIDE_CHAR.test(char) ? 2 : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

// 超過寬度時依顯示寬度截斷，補「…」；中文一個字算兩格
export function fitToWidth(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return ''
  if (displayWidth(text) <= maxColumns) return text
  let kept = ''
  let width = 0
  for (const char of text) {
    if (width + charWidth(char) > maxColumns - 1) break
    kept += char
    width += charWidth(char)
  }
  return `${kept}…`
}

// 一句話說出子代理在做什麼；用字跟 clean-view 的 describe 一致
export function describeTool(tool: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  const file = (path: string) => path.split('/').slice(-2).join('/')
  if (tool === 'Bash') return `執行：${text('description') || text('command').slice(0, 80)}`
  if (tool === 'Read') return `讀取 ${file(text('file_path'))}`
  if (tool === 'Write') return `寫入 ${file(text('file_path'))}`
  if (tool === 'Edit') return `編輯 ${file(text('file_path'))}`
  if (tool === 'NotebookEdit') return `編輯 ${file(text('notebook_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `搜尋 "${text('pattern').slice(0, 40)}"`
  if (tool === 'WebSearch') return `搜尋網路「${text('query').slice(0, 40)}」`
  if (tool === 'WebFetch') return `讀取網頁 ${hostOf(text('url'))}`
  if (tool === 'Agent') return `委派 agent：${text('description')}`
  if (tool === 'Skill') return `使用 skill：${text('skill')}`
  if (tool === 'AskUserQuestion') return '詢問你問題'
  if (tool === 'ToolSearch') return '載入工具'
  if (tool.startsWith('mcp__')) return `使用 ${tool.split('__').slice(1).join(' ')}`
  return `使用 ${tool}`
}

function hostOf(url: string) {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)
  return match?.[1] ?? url.slice(0, 40)
}
