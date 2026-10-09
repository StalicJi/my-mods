// 面板的版面：狀態列、子代理卡片、精簡模式的單列，以及時間、token 的格式。
// displayWidth、fitToWidth、colorRuns、cometColor、describeTool 照搬自 clean-view/hooks/register.tsx
// （mod 之間不能共用程式碼），改那邊的用字或配色時這裡要一起改
import type { AgentRow, Batch } from '../types'
import { agentLook, agentTokens, batchTotals } from './batch'
import { MASCOT_COLUMNS, mascotRaster } from './mascot'
import type { MascotSize, MascotState } from './mascot'
import { contextPercent, modelInfo } from './pricing'
import type { ModelFamily } from './pricing'

export type Span = { text: string; color?: string; isDim?: boolean; isBold?: boolean }

// lines 是進度條以外的每一列；bar 是進度條每一格的顏色，完成與失敗的卡片沒有進度條（空陣列）
export type Card = { lines: Span[][]; bar: string[] }

// 完整模式的卡片左邊會不會畫小人
export type FullModeOptions = { withMascot: boolean }
export type GroupEntry = { kind: 'card'; agent: AgentRow } | { kind: 'blank' }

type AgentStatus = AgentRow['status']
type LineOptions = { columns: number; now: number; frame: number }

// 這一步做太久就提醒使用者可能卡住了；思考本來就比工具慢，門檻放寬
export const STALL_THINKING_MS = 300_000
export const STALL_TOOL_MS = 180_000

// 卡片左邊的小人跟文字隔一欄；扣掉小人與間隔後文字至少要有這麼寬才畫，不然寧可不畫、把寬度留給文字
export const MASCOT_GAP = 1
export const MIN_TEXT_COLUMNS_WITH_MASCOT = 24

const ORANGE = '#f79a4f'
const PINK = '#ec4f8f'
const PURPLE = '#b45ce6'
const BLUE = '#6f7df2'
const GREEN = '#46b06e'
const GRAY = '#8a8a94'
const YELLOW = '#e5c07b'
const TRACK_COLOR = '#4a4a52'
const ACCENT_COLORS = [ORANGE, PINK, PURPLE, BLUE]
const FAMILY_COLORS: Record<ModelFamily, string> = { opus: ORANGE, sonnet: BLUE, haiku: GREEN, fable: PURPLE, unknown: GRAY }

const STATUS_LABEL = 'Agents'
// 狀態列的數量：執行中用固定的粉紅，不跟著彗星換色
const STATUS_COUNTS: { status: AgentStatus; mark: string; color: string }[] = [
  { status: 'running', mark: '●', color: PINK },
  { status: 'done', mark: '✓', color: 'success' },
  { status: 'failed', mark: '✗', color: 'error' },
]
// 每張卡片在完整模式佔幾列（執行中含進度條）；要跟 agentCard 畫出來的一致
const CARD_ROWS: Record<AgentStatus, number> = { running: 5, failed: 3, done: 2 }
// 小人的列數只看大小，跟造型、狀態、動畫拍數無關，各畫一次量出來
const MASCOT_ROWS: Record<MascotSize, number> = {
  large: mascotRaster({ look: 0, size: 'large', state: 'running', frame: 0 }).rows,
  small: mascotRaster({ look: 0, size: 'small', state: 'done', frame: 0 }).rows,
}
const STATUS_LINE_ROWS = 1
const BLANK_ROWS = 1

const THINKING = '思考中'
const INDENT = '  '
const SEPARATOR = ' · '
// 精簡模式裡描述與動作之間的空白
const ACTION_GAP = '  '
// 靠右的耗時跟左邊至少隔一格
const MIN_GAP = 1
// 彗星：頭最亮，後面四格一格比一格淡，融進底色
const COMET_FADE = [1, 0.7, 0.45, 0.25, 0.1]
const COMET_COLOR_HALF_PERIOD_FRAMES = 15 // 從橘變到藍約 3 秒（每拍 0.2 秒）

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

// 面板最上面一列：Agents、各狀態數量（0 的不列），整批耗時靠右
export function statusLine(batch: Batch, now: number, columns: number): Span[] {
  const counts = statusCounts(batch)
  const left: Span[] = [{ text: STATUS_LABEL, isBold: true }, ...(counts.length > 0 ? [{ text: '  ' }, ...joinSpans(counts, ' ')] : [])]
  return justify(left, [{ text: formatElapsed(batchTotals(batch, now).elapsedMs) }], columns)
}

// 給 $.ui.status 的純文字，例如「Agents ●2 ✓1 ✗1」
export function statusText(batch: Batch): string {
  return [STATUS_LABEL, ...statusCounts(batch).map(span => span.text)].join(' ')
}

function statusCounts(batch: Batch): Span[] {
  return STATUS_COUNTS.flatMap(({ status, mark, color }) => {
    const count = batch.agents.filter(agent => agent.status === status).length
    return count === 0 ? [] : [{ text: `${mark}${count}`, color }]
  })
}

// 各組維持派出順序
export function splitSections(batch: Batch): { running: AgentRow[]; failed: AgentRow[]; done: AgentRow[] } {
  const withStatus = (status: AgentStatus) => batch.agents.filter(agent => agent.status === status)
  return { running: withStatus('running'), failed: withStatus('failed'), done: withStatus('done') }
}

// 完整模式要幾列：狀態列，加上每個非空的組（組標題＋卡片與卡片間的空列，見 groupEntries），組與組之間空一列。
// register.tsx 拿它跟面板可用列數比，放不下就改用 compactLine 一個子代理一列；withMascot 要跟實際會不會畫小人一致
export function fullRowCount(batch: Batch, options: FullModeOptions): number {
  const groups = Object.values(splitSections(batch)).filter(group => group.length > 0)
  const entryRows = groups
    .flatMap(group => groupEntries(group, options))
    .reduce((sum, entry) => sum + (entry.kind === 'card' ? CARD_ROWS[entry.agent.status] : BLANK_ROWS), 0)
  return STATUS_LINE_ROWS + groups.length + entryRows + Math.max(0, groups.length - 1)
}

// 一組裡依序要畫的東西：卡片，或卡片之間的一列空白。
// 畫小人時，卡片不比小人高（目前是 2 列的完成卡片配 2 列的小小人），小人就佔滿卡片的上下緣，
// 同組下一張卡片的小人會直接接上來，看起來像一隻很高的小人，所以兩張之間空一列；比小人高的卡片底下本來就有空隙。
// 組的第一張之前、最後一張之後不加：那裡已經是組名、組間空行或面板底部
export function groupEntries(agents: readonly AgentRow[], options: FullModeOptions): GroupEntry[] {
  return agents.flatMap((agent, index): GroupEntry[] => {
    const hasNext = index < agents.length - 1
    const mascotFillsCard = options.withMascot && CARD_ROWS[agent.status] <= MASCOT_ROWS[mascotSize(agent)]
    return [{ kind: 'card', agent }, ...(hasNext && mascotFillsCard ? [{ kind: 'blank' } as const] : [])]
  })
}

// 執行中 4 列＋進度條；完成 2 列、失敗 3 列，都不畫進度條
export function agentCard(row: AgentRow, options: LineOptions): Card {
  const { columns } = options
  const title = titleLine(row, options)
  if (row.status === 'running') return runningCard(row, options, title)
  if (row.status === 'done') {
    return { lines: [title, modelLine(row, [...effortParts(row), toolsText(row), formatTokens(agentTokens(row))], columns)], bar: [] }
  }
  // 失敗：第二列寫失敗原因與停在哪一步
  const failure = [row.failureReason ?? '', row.activity].filter(part => part !== '').join(SEPARATOR)
  return {
    lines: [title, fitLine([{ text: INDENT }, { text: failure, color: 'error' }], columns), modelLine(row, [toolsText(row)], columns)],
    bar: [],
  }
}

function runningCard(row: AgentRow, options: LineOptions, title: Span[]): Card {
  const { columns, now, frame } = options
  const stalled = isStalled(row, now)
  const percent = row.model !== null && row.lastUsage !== null ? contextPercent(row.model, row.lastUsage) : null
  const usage = [...(percent === null ? [] : [`ctx ${percent}%`]), formatTokens(agentTokens(row))].join(SEPARATOR)
  return {
    lines: [
      title,
      modelLine(row, [...effortParts(row), toolsText(row)], columns),
      activityLine(row, now, columns, stalled),
      fitLine([{ text: INDENT }, { text: usage, isDim: true }], columns),
    ],
    bar: runningBar(Math.max(0, columns - INDENT.length), frame, stalled),
  }
}

// 完整模式的卡片要不要在左邊畫小人，以及卡片文字剩多寬
export function mascotLayout(bodyColumns: number): { withMascot: boolean; textColumns: number } {
  const textColumns = bodyColumns - MASCOT_COLUMNS - MASCOT_GAP
  return textColumns >= MIN_TEXT_COLUMNS_WITH_MASCOT ? { withMascot: true, textColumns } : { withMascot: false, textColumns: bodyColumns }
}

// 執行中的卡片 5 列畫 4 列高的大小人；完成 2 列、失敗 3 列只放得下 2 列高的小小人，小人才不會把卡片撐高
export function agentMascot(row: AgentRow, options: { now: number; frame: number }): { columns: number; rows: number; cells: string } {
  return mascotRaster({
    look: agentLook(row),
    size: mascotSize(row),
    state: mascotState(row, options.now),
    frame: options.frame,
  })
}

function mascotSize(row: AgentRow): MascotSize {
  return row.status === 'running' ? 'large' : 'small'
}

// 跟卡片用同一個卡住判斷：卡住時進度條變黃，小人也停下變黃
function mascotState(row: AgentRow, now: number): MascotState {
  if (row.status !== 'running') return row.status
  return isStalled(row, now) ? 'stalled' : 'running'
}

// 精簡模式：一個子代理一列，放不下先截描述、再截動作，耗時最後才截
export function compactLine(row: AgentRow, options: LineOptions): Span[] {
  const title = titleSpans(row, options.frame)
  const descriptionIndex = title.length - 1
  const action = compactAction(row, options.now)
  if (action === null) return justify(title, [elapsedSpan(row, options.now)], options.columns, [descriptionIndex])
  const line = [...title, { text: ACTION_GAP }, action]
  return justify(line, [elapsedSpan(row, options.now)], options.columns, [descriptionIndex, line.length - 1])
}

// 執行中寫正在做什麼（卡住變黃）、失敗寫原因、完成不寫
function compactAction(row: AgentRow, now: number): Span | null {
  if (row.status === 'done') return null
  if (row.status === 'failed') return { text: row.failureReason ?? '', color: 'error' }
  return { text: activityText(row), ...activityStyle(isStalled(row, now)) }
}

function titleLine(row: AgentRow, options: LineOptions): Span[] {
  const title = titleSpans(row, options.frame)
  return justify(title, [elapsedSpan(row, options.now)], options.columns, [title.length - 1])
}

// 狀態符號、巢狀箭頭、類型（有 name 用 name）· 描述；描述一定在最後一段，放不下時先截它
function titleSpans(row: AgentRow, frame: number): Span[] {
  const label = row.agentName ?? row.agentType
  return [
    statusMark(row.status, frame),
    ...(row.isNested ? [{ text: '↳ ', isDim: true }] : []),
    ...(label ? [{ text: label, isDim: true }, { text: SEPARATOR, isDim: true }] : []),
    { text: row.description, isBold: row.status === 'running' },
  ]
}

function statusMark(status: AgentStatus, frame: number): Span {
  if (status === 'running') return { text: '● ', color: cometColor(frame), isBold: true }
  if (status === 'done') return { text: '✓ ', color: 'success' }
  return { text: '✗ ', color: 'error' }
}

function elapsedSpan(row: AgentRow, now: number): Span {
  return { text: formatElapsed((row.endedAt ?? now) - row.startedAt), isDim: true }
}

// 縮排、模型名（系列色），後面接暗色的細節，例如「 · xhigh · 12 tools」
function modelLine(row: AgentRow, details: string[], columns: number): Span[] {
  const model = row.model === null ? null : modelInfo(row.model)
  const name: Span = model === null ? { text: 'starting', isDim: true } : { text: model.name, color: FAMILY_COLORS[model.family] }
  return fitLine([{ text: INDENT }, name, { text: details.map(detail => `${SEPARATOR}${detail}`).join(''), isDim: true }], columns)
}

function effortParts(row: AgentRow): string[] {
  return row.effort === null ? [] : [String(row.effort)]
}

function toolsText(row: AgentRow): string {
  return `${row.toolCount} tools`
}

// 正在做什麼與這一步的耗時；卡住時整列變 warning
function activityLine(row: AgentRow, now: number, columns: number, stalled: boolean): Span[] {
  const style = activityStyle(stalled)
  const left = [{ text: INDENT, ...style }, { text: activityText(row), ...style }]
  return justify(left, [{ text: formatElapsed(now - row.activityStartedAt), ...style }], columns, [1])
}

function activityText(row: AgentRow): string {
  return row.activity || THINKING
}

function activityStyle(stalled: boolean): Pick<Span, 'color' | 'isDim'> {
  return stalled ? { color: 'warning' } : { isDim: true }
}

// 這一步做太久：思考超過 5 分鐘、工具超過 3 分鐘。還沒用過工具（activity 空）畫面上寫思考中，也照思考算
function isStalled(row: AgentRow, now: number): boolean {
  const limit = activityText(row) === THINKING ? STALL_THINKING_MS : STALL_TOOL_MS
  return now - row.activityStartedAt > limit
}

function runningBar(width: number, frame: number, stalled: boolean): string[] {
  const positions = Array.from({ length: width }, (_, index) => index)
  // 卡住：整條靜止的黃色，不畫彗星
  if (stalled) return positions.map(() => YELLOW)
  // 一顆彗星從左往右走，尾巴也離開右邊後再從左邊進來，frame 每拍加一
  const head = frame % (width + COMET_FADE.length)
  const headColor = cometColor(frame)
  return positions.map(index => {
    const intensity = COMET_FADE[head - index]
    return intensity === undefined ? TRACK_COLOR : mixColor(TRACK_COLOR, headColor, intensity)
  })
}

function joinSpans(spans: Span[], separator: string): Span[] {
  return spans.flatMap((span, index) => (index === 0 ? [span] : [{ text: separator }, span]))
}

function lineWidth(spans: Span[]): number {
  return spans.reduce((sum, span) => sum + displayWidth(span.text), 0)
}

// 左右兩段排成剛好 columns 寬的一列：右段靠右、中間補空白。
// 放不下時先依 shrinkOrder 縮短左段指定的段落（例如描述），都縮完還不夠再從左段尾端截；右段最後才截
function justify(left: Span[], right: Span[], columns: number, shrinkOrder: number[] = []): Span[] {
  const fittedRight = fitLine(right, columns)
  const rightWidth = lineWidth(fittedRight)
  const fittedLeft = shrinkToFit(left, Math.max(0, columns - rightWidth - MIN_GAP), shrinkOrder)
  const padding = columns - lineWidth(fittedLeft) - rightWidth
  return [...fittedLeft, ...(padding > 0 ? [{ text: ' '.repeat(padding) }] : []), ...fittedRight]
}

// 依序縮短指定的段落直到放得下，縮成空字串就換下一段；全部縮完還放不下，從尾端截
function shrinkToFit(spans: Span[], columns: number, shrinkOrder: number[]): Span[] {
  const shrunk = spans.slice()
  for (const index of shrinkOrder) {
    const overflow = lineWidth(shrunk) - columns
    if (overflow <= 0) break
    const span = shrunk[index]!
    shrunk[index] = { ...span, text: fitToWidth(span.text, displayWidth(span.text) - overflow) }
  }
  return fitLine(shrunk.filter(span => span.text !== ''), columns)
}

// 一列超過寬度時從尾端截斷：模型與用量列在很窄的面板也可能放不下
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
