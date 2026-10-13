// 面板的版面：把狀態組成一列一列的文字片段（Span），register.tsx 只負責畫出來。
// 每一列都依顯示寬度截斷在面板寬度內，窄的 cmux 分割窗格也不會折行
import type { AgentPhase, AgentRecord, MainLoop, SupervisorEvent, SupervisorView, TaskRecord, TaskStatus, WaitingReports } from '../types'
import { blockedSubjects, detectBlockers, suggestActions } from './blockers'
import type { Blocker } from './blockers'
import { agentName, ownerName } from './names'
import { taskProgress } from './tasks'
import { displayWidth, fitToWidth, formatClock, formatDuration, padToWidth } from './text'

export type Span = { text: string; color?: string; isDim?: boolean; isBold?: boolean }
export type Row = Span[]
export type StatusLabel = 'RUNNING' | 'IDLE' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'UNKNOWN'
// isInferred：推測的狀態（不是事件或 Claude Code 確認的），畫面上加「?」
export type DisplayStatus = { label: StatusLabel; isInferred: boolean }
export type OverviewModel = {
  agents: readonly AgentRecord[]
  mainLoop: MainLoop
  tasks: readonly TaskRecord[]
  waiting: WaitingReports
  events: readonly SupervisorEvent[]
}
// eventCount：總覽列最近幾筆事件，0 是不畫事件區（放在輸入框上方的精簡版）
// compact：放在輸入框上方的精簡版，每個代理一列、區塊之間不空行、阻塞一條一列
export type ViewOptions = { columns: number; now: number; maxAgents?: number; maxTasks?: number; eventCount?: number; compact?: boolean }

type StatusStyle = { mark: string; color?: string; isDim?: boolean }

const STATUS_STYLES: Record<StatusLabel, StatusStyle> = {
  RUNNING: { mark: '●', color: 'suggestion' },
  IDLE: { mark: '○', isDim: true },
  BLOCKED: { mark: '◐', color: 'warning' },
  COMPLETED: { mark: '✓', color: 'success' },
  FAILED: { mark: '✗', color: 'error' },
  UNKNOWN: { mark: '?', isDim: true },
}
const PHASE_LABELS: Record<AgentPhase, StatusLabel> = {
  running: 'RUNNING',
  idle: 'IDLE',
  completed: 'COMPLETED',
  failed: 'FAILED',
  unknown: 'UNKNOWN',
}
// 需要注意的排前面，已結束的排後面
const DISPLAY_ORDER: Record<StatusLabel, number> = { BLOCKED: 0, RUNNING: 1, IDLE: 2, UNKNOWN: 3, FAILED: 4, COMPLETED: 5 }
const INFERRED_MARK = '?'
const INDENT = '  '
const UNKNOWN_TEXT = 'Unknown'
const DEFAULT_MAX_AGENTS = 6
const DEFAULT_MAX_TASKS = 6
const TASK_MARKS: Record<TaskStatus, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }
const STUCK_MARK = '[!]'
// 進行中的排前面，已完成的排後面
const TASK_ORDER: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 }
const NO_TASKS = 'Unknown：還沒有代理回報任務'
// 第二列放得下說明的最少欄數；更窄時不放經過時間
const MIN_DETAIL_COLUMNS = 6
const EMPTY_HINT = '這個 session 還沒有派出子代理'
const INFERRED_LEGEND = '? 表示推測，其他狀態由事件或 Claude Code 確認'

export function agentStatus(agent: AgentRecord, isBlocked = false): DisplayStatus {
  if (isBlocked && (agent.phase === 'running' || agent.phase === 'idle')) return { label: 'BLOCKED', isInferred: false }
  return { label: PHASE_LABELS[agent.phase], isInferred: agent.source === 'inferred' }
}

export function overviewRows(model: OverviewModel, options: ViewOptions): Row[] {
  const blockers = detectBlockers(model)
  const blocked = blockedSubjects(blockers)
  const isCompact = options.compact === true
  // 區塊之間空一列；精簡版不空
  const gap = (): Row[] => (isCompact ? [] : [blankRow()])
  const main = mainRows(model.mainLoop, blocked.has('main'), options.columns)
  const rows: Row[] = isCompact ? main.slice(0, 1) : [...main]
  // 什麼都還沒有：只寫一行說明，不畫空的區塊
  if (model.agents.length === 0 && model.tasks.length === 0) {
    rows.push(...gap(), [{ text: EMPTY_HINT, isDim: true }])
    return fitRows(rows, options.columns)
  }
  const sorted = sortAgents(model.agents, blocked)
  const shown = sorted.slice(0, options.maxAgents ?? DEFAULT_MAX_AGENTS)
  rows.push(...gap(), sectionRow('AGENTS'))
  if (shown.length === 0) rows.push([{ text: INDENT + EMPTY_HINT, isDim: true }])
  for (const agent of shown) {
    const agentLines = agentRows(agent, agentStatus(agent, blocked.has(agent.id)), options)
    rows.push(...(isCompact ? agentLines.slice(0, 1) : agentLines))
  }
  const hiddenCount = sorted.length - shown.length
  if (hiddenCount > 0) rows.push([{ text: `${INDENT}還有 ${hiddenCount} 個代理`, isDim: true }])
  rows.push(...gap(), ...tasksRows(model, blockers, options))
  if (blockers.length > 0) rows.push(...gap(), ...attentionRows(blockers, model, isCompact))
  const suggestions = suggestActions(model, blockers)
  if (suggestions.length > 0) rows.push(...gap(), sectionRow('SUGGESTED ACTION'), ...suggestions.map(text => [{ text: `→ ${text}` }]))
  const eventCount = options.eventCount ?? 0
  if (eventCount > 0 && model.events.length > 0) {
    rows.push(...gap(), sectionRow('EVENTS'), ...model.events.slice(-eventCount).map(event => eventRow(event, model.agents)))
  }
  if (shown.some(agent => agentStatus(agent).isInferred)) rows.push(...gap(), [{ text: INFERRED_LEGEND, isDim: true }])
  return fitRows(rows, options.columns)
}

// 任務區：完成數與百分比只算回報過的任務；每項寫狀態、id、標題、負責人，等別的任務的註明
export function tasksRows(model: OverviewModel, blockers: readonly Blocker[], options: ViewOptions): Row[] {
  const progress = taskProgress(model.tasks)
  if (progress === null) return [sectionRow('TASKS'), [{ text: INDENT + NO_TASKS, isDim: true }]]
  const sorted = model.tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => TASK_ORDER[left.task.status] - TASK_ORDER[right.task.status] || left.index - right.index)
    .map(entry => entry.task)
  const shown = sorted.slice(0, options.maxTasks ?? DEFAULT_MAX_TASKS)
  // 確認卡住的任務標 [!]
  const stuckTaskIds = new Set(blockers.filter(blocker => blocker.certainty === 'confirmed' && blocker.taskId !== null).map(blocker => blocker.taskId))
  const rows: Row[] = [
    sectionRow('TASKS'),
    [{ text: `${INDENT}Completed: ${progress.completed} / ${progress.total} · Progress: ${progress.percent}%`, isDim: true }],
    ...shown.map(task => taskRow(task, model, stuckTaskIds.has(task.id))),
  ]
  const hiddenCount = sorted.length - shown.length
  if (hiddenCount > 0) rows.push([{ text: `${INDENT}還有 ${hiddenCount} 項任務`, isDim: true }])
  return rows
}

function taskRow(task: TaskRecord, model: OverviewModel, isStuck: boolean): Row {
  const pending = task.blockedBy.filter(id => model.tasks.find(other => other.id === id)?.status !== 'completed')
  const waitingNote = task.status !== 'completed' && pending.length > 0 ? `（等 ${pending.join('、')}）` : ''
  return [
    isStuck ? { text: `${INDENT}${STUCK_MARK} `, color: 'warning' } : { text: `${INDENT}${TASK_MARKS[task.status]} `, isDim: task.status === 'completed' },
    { text: `${task.id} ${task.title}`, isDim: task.status === 'completed', isBold: task.status === 'in_progress' },
    { text: ` · ${ownerName(task.owner, model.agents)}${waitingNote}`, isDim: true },
  ]
}

function mainRows(mainLoop: MainLoop, isBlocked: boolean, columns: number): Row[] {
  const status: DisplayStatus = { label: isBlocked ? 'BLOCKED' : mainLoop.isRunning ? 'RUNNING' : 'IDLE', isInferred: false }
  const detail = mainLoop.isRunning ? mainLoop.activity || '處理中' : '等你下指令'
  return [titleRow('Supervisor', status, columns), detailRow(detail, null, columns)]
}

function agentRows(agent: AgentRecord, status: DisplayStatus, options: ViewOptions): Row[] {
  return [titleRow(agentName(agent), status, options.columns), detailRow(agentDetail(agent), elapsedText(agent, options.now), options.columns)]
}

// 第二列：有名字時寫任務說明（標題已經是名字）；沒名字時標題就是任務，改寫最近的活動，還沒有活動寫類型。
// 失敗的先寫原因
function agentDetail(agent: AgentRecord): string {
  const detail = agent.name !== null ? agent.description || UNKNOWN_TEXT : agent.activity || agent.agentType
  return agent.phase === 'failed' ? `${agent.failureReason ?? '失敗'}：${detail}` : detail
}

function elapsedText(agent: AgentRecord, now: number): string {
  if (agent.startedAt === null) return UNKNOWN_TEXT
  const isLive = agent.phase === 'running' || agent.phase === 'idle'
  const end = isLive ? now : agent.endedAt
  return end === null ? UNKNOWN_TEXT : formatDuration(end - agent.startedAt)
}

export function sortAgents(agents: readonly AgentRecord[], blocked: ReadonlySet<string> = new Set()): AgentRecord[] {
  const order = (agent: AgentRecord) => DISPLAY_ORDER[agentStatus(agent, blocked.has(agent.id)).label]
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => order(left.agent) - order(right.agent) || left.index - right.index)
    .map(entry => entry.agent)
}

// 依目前的分頁畫：總覽，或只看代理、任務、事件
export function viewRows(view: SupervisorView, model: OverviewModel, options: ViewOptions): Row[] {
  if (view === 'agents') return agentsViewRows(model, options)
  if (view === 'tasks') return tasksViewRows(model, options)
  if (view === 'events') return eventsViewRows(model, options)
  return overviewRows(model, options)
}

// 代理頁：全部代理，每個多寫 id、派出者、工具次數與最近活動，失敗的寫原因
function agentsViewRows(model: OverviewModel, options: ViewOptions): Row[] {
  const blockers = detectBlockers(model)
  const blocked = blockedSubjects(blockers)
  const rows: Row[] = [...mainRows(model.mainLoop, blocked.has('main'), options.columns), blankRow(), sectionRow(`AGENTS（${model.agents.length}）`)]
  if (model.agents.length === 0) rows.push([{ text: INDENT + EMPTY_HINT, isDim: true }])
  for (const agent of sortAgents(model.agents, blocked)) {
    const status = agentStatus(agent, blocked.has(agent.id))
    const parent = agent.parentId === null ? '主對話派出' : `由 ${ownerName(agent.parentId, model.agents)} 派出`
    const activity = agent.activity === '' ? '' : ` · 最近：${agent.activity}`
    rows.push(
      titleRow(agentName(agent), status, options.columns),
      [{ text: `${INDENT}任務：${agent.description || UNKNOWN_TEXT}`, isDim: true }],
      detailRow(`id ${agent.id} · ${parent} · ${agent.toolCount} 次工具${activity}`, elapsedText(agent, options.now), options.columns),
    )
    if (agent.detail !== null) rows.push([{ text: `${INDENT}${agent.detail}`, isDim: true }])
    if (agent.phase === 'failed') rows.push([{ text: `${INDENT}原因：${agent.failureReason ?? '失敗'}`, color: 'error' }])
  }
  if (model.agents.some(agent => agentStatus(agent).isInferred)) rows.push(blankRow(), [{ text: INFERRED_LEGEND, isDim: true }])
  return fitRows(rows, options.columns)
}

// 任務頁：全部任務與阻塞
function tasksViewRows(model: OverviewModel, options: ViewOptions): Row[] {
  const blockers = detectBlockers(model)
  const rows: Row[] = [...tasksRows(model, blockers, { ...options, maxTasks: Number.POSITIVE_INFINITY })]
  if (blockers.length > 0) rows.push(blankRow(), ...attentionRows(blockers, model))
  return fitRows(rows, options.columns)
}

// 事件頁：全部事件（最多 50 筆），新的在上
function eventsViewRows(model: OverviewModel, options: ViewOptions): Row[] {
  const rows: Row[] = [sectionRow(`EVENTS（${model.events.length}）`)]
  if (model.events.length === 0) rows.push([{ text: `${INDENT}${UNKNOWN_TEXT}：還沒有事件`, isDim: true }])
  rows.push(...[...model.events].reverse().map(event => eventRow(event, model.agents)))
  return fitRows(rows, options.columns)
}

const EVENT_COLORS: Partial<Record<SupervisorEvent['kind'], string>> = { fail: 'error', 'tool-error': 'error', waiting: 'warning', complete: 'success' }

function eventRow(event: SupervisorEvent, agents: readonly AgentRecord[]): Row {
  return [
    { text: `${formatClock(event.at)} `, isDim: true },
    { text: `${ownerName(event.agentId ?? 'main', agents)} `, isBold: true },
    { text: event.text, color: EVENT_COLORS[event.kind] },
  ]
}

// 阻塞區：每一條兩列，第一列誰被誰擋住（可能的標 POSSIBLE BLOCKER），第二列原因；精簡版併成一列
function attentionRows(blockers: readonly Blocker[], model: OverviewModel, isCompact = false): Row[] {
  const name = (subject: string) => ownerName(subject, model.agents)
  return [
    sectionRow('ATTENTION'),
    ...blockers.flatMap((blocker): Row[] => {
      const title =
        blocker.certainty === 'possible'
          ? { text: `? POSSIBLE BLOCKER：${name(blocker.subject)}`, color: 'warning', isDim: true }
          : { text: `⚠ ${name(blocker.subject)}${blocker.dependsOn === null ? '' : ` 被 ${name(blocker.dependsOn)} 擋住`}`, color: 'warning', isBold: true }
      if (isCompact) return [[title, { text: `：${blocker.reason}`, isDim: true }]]
      return [[title], [{ text: INDENT + blocker.reason, isDim: true }]]
    }),
  ]
}

// 第一列：狀態符號、名稱，狀態字靠右
function titleRow(name: string, status: DisplayStatus, columns: number): Row {
  const style = STATUS_STYLES[status.label]
  const statusText = status.label + (status.isInferred ? INFERRED_MARK : '')
  // 符號一格、空一格、名稱、至少空一格、狀態字
  const nameColumns = Math.max(1, columns - displayWidth(statusText) - 3)
  return [
    { text: `${style.mark} `, color: style.color, isDim: style.isDim },
    { text: padToWidth(fitToWidth(name, nameColumns), nameColumns + 1), isBold: true },
    { text: statusText, color: style.color, isDim: style.isDim === true || status.isInferred },
  ]
}

// 第二列：縮排的說明，後面接經過時間；太窄時只留說明
function detailRow(text: string, trailing: string | null, columns: number): Row {
  const suffix = trailing === null ? '' : ` · ${trailing}`
  const room = columns - INDENT.length - displayWidth(suffix)
  if (room < MIN_DETAIL_COLUMNS) return [{ text: INDENT + fitToWidth(text, columns - INDENT.length), isDim: true }]
  return [{ text: INDENT + fitToWidth(text, room) + suffix, isDim: true }]
}

export function sectionRow(title: string): Row {
  return [{ text: title, isBold: true, isDim: true }]
}

// 空一列放一個空白字元：空字串的 Text 可能畫不出高度
export function blankRow(): Row {
  return [{ text: ' ' }]
}

// 最後一道保險：整列超過寬度時，從超過的那一段截斷，後面的片段丟掉
export function fitRows(rows: Row[], columns: number): Row[] {
  return rows.map(row => fitRow(row, columns))
}

function fitRow(row: Row, columns: number): Row {
  const fitted: Row = []
  let used = 0
  for (const span of row) {
    const width = displayWidth(span.text)
    if (used + width <= columns) {
      fitted.push(span)
      used += width
      continue
    }
    const text = fitToWidth(span.text, columns - used)
    if (text !== '') fitted.push({ ...span, text })
    break
  }
  return fitted
}
