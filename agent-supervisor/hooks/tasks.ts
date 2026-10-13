// 任務：代理用 report 工具回報的，以及 Claude Code 原生任務工具（TaskCreate／TaskUpdate／TodoWrite）留下的。
// 只記錄回報過的，不自行編造任務或完成狀態。全部是純函式，沒有變化時回傳同一個陣列
import type { AgentRecord, TaskRecord, TaskStatus, WaitingReports } from '../types'

export type ReportedTask = { id: string; title?: string; status?: TaskStatus; blockedBy?: string[]; owner?: string }
// waitingFor：null 是這次沒回報；空字串是不再等待
export type Report = { tasks: ReportedTask[]; waitingFor: string | null }
// reporter：回報者，主對話是 'main'，代理是 agentId
export type ReportContext = { reporter: string; agents: readonly AgentRecord[]; at: number }
export type NativeToolCall = { tool: string; input: unknown; result: unknown }

const MAX_TASKS = 50
const MAX_TITLE_LENGTH = 80
const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']
const MAIN_OWNER = 'main'
const MAIN_ALIASES = new Set(['main', 'supervisor'])
const NATIVE_PREFIX = '#'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

// 工具輸入的格式檢查；錯誤訊息回給呼叫的模型，用繁體中文
export function parseReport(input: unknown): { report: Report } | { error: string } {
  if (!isRecord(input)) return { error: '參數必須是物件。' }
  const { tasks = [], waitingFor } = input
  if (!Array.isArray(tasks)) return { error: 'tasks 必須是陣列。' }
  if (waitingFor !== undefined && typeof waitingFor !== 'string') return { error: 'waitingFor 必須是字串；不再等待時傳空字串。' }
  if (tasks.length === 0 && waitingFor === undefined) return { error: '至少要回報 tasks 或 waitingFor 其中一項。' }
  const parsed: ReportedTask[] = []
  for (const item of tasks) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '') return { error: '每個任務都要有 id（字串）。' }
    if (item.title !== undefined && typeof item.title !== 'string') return { error: `任務 ${item.id} 的 title 必須是字串。` }
    if (item.status !== undefined && !STATUSES.includes(item.status as TaskStatus)) {
      return { error: `任務 ${item.id} 的 status 只能是 pending、in_progress 或 completed。` }
    }
    if (item.blockedBy !== undefined && !isStringArray(item.blockedBy)) return { error: `任務 ${item.id} 的 blockedBy 必須是任務 id 的陣列。` }
    if (item.owner !== undefined && typeof item.owner !== 'string') return { error: `任務 ${item.id} 的 owner 必須是字串。` }
    parsed.push({
      id: item.id.trim(),
      ...(item.title !== undefined && { title: item.title }),
      ...(item.status !== undefined && { status: item.status as TaskStatus }),
      ...(item.blockedBy !== undefined && { blockedBy: item.blockedBy }),
      ...(item.owner !== undefined && { owner: item.owner }),
    })
  }
  return { report: { tasks: parsed, waitingFor: waitingFor ?? null } }
}

// 負責人：main、supervisor 是主對話；代理的 id、名字、任務說明（不分大小寫）對到那個代理；對不到的原樣保留
export function resolveOwner(owner: string, agents: readonly AgentRecord[]): string {
  const wanted = owner.trim().toLowerCase()
  if (MAIN_ALIASES.has(wanted)) return MAIN_OWNER
  const matched = agents.find(agent => [agent.id, agent.name ?? '', agent.description].some(key => key.toLowerCase() === wanted))
  return matched?.id ?? owner.trim()
}

export function applyReport(tasks: TaskRecord[], report: Report, context: ReportContext): { tasks: TaskRecord[] } | { error: string } {
  let next = tasks
  for (const reported of report.tasks) {
    if (reported.blockedBy?.includes(reported.id)) return { error: `任務 ${reported.id} 不能依賴自己。` }
    const existing = next.find(task => task.id === reported.id)
    if (existing === undefined && (reported.title === undefined || reported.title.trim() === '')) {
      return { error: `新任務 ${reported.id} 要有 title。` }
    }
    const owner = reported.owner === undefined ? existing?.owner ?? context.reporter : resolveOwner(reported.owner, context.agents)
    const record: TaskRecord = {
      id: reported.id,
      title: (reported.title?.trim() || existing?.title || '').slice(0, MAX_TITLE_LENGTH),
      status: reported.status ?? existing?.status ?? 'pending',
      owner,
      blockedBy: reported.blockedBy ?? existing?.blockedBy ?? [],
      source: existing?.source ?? 'report',
      updatedAt: context.at,
    }
    next = existing === undefined ? [...next, record] : next.map(task => (task.id === record.id ? record : task))
  }
  return { tasks: capTasks(next) }
}

// Claude Code 原生任務工具的呼叫（使用者開了 CLAUDE_CODE_ENABLE_TASKS 才會有）：從輸入與結果還原任務。
// 結果失敗或不是任務工具時原樣回傳
export function applyNativeTool(tasks: TaskRecord[], call: NativeToolCall, context: ReportContext): TaskRecord[] {
  if (!isRecord(call.input) || (isRecord(call.result) && call.result.deny !== undefined)) return tasks
  const input = call.input
  if (call.tool === 'TaskCreate') {
    const created = isRecord(call.result) && isRecord(call.result.task) ? call.result.task : null
    if (created === null || typeof created.id !== 'string') return tasks
    const title = typeof created.subject === 'string' ? created.subject : typeof input.subject === 'string' ? input.subject : ''
    const record: TaskRecord = { id: NATIVE_PREFIX + created.id, title, status: 'pending', owner: context.reporter, blockedBy: [], source: 'native', updatedAt: context.at }
    return capTasks([...tasks.filter(task => task.id !== record.id), record])
  }
  if (call.tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = NATIVE_PREFIX + input.taskId
    if (input.status === 'deleted') return tasks.filter(task => task.id !== id)
    return tasks.map(task => {
      if (task.id !== id) return task
      const addBlockedBy = isStringArray(input.addBlockedBy) ? input.addBlockedBy.map(blocker => NATIVE_PREFIX + blocker) : []
      return {
        ...task,
        title: typeof input.subject === 'string' ? input.subject : task.title,
        status: STATUSES.includes(input.status as TaskStatus) ? (input.status as TaskStatus) : task.status,
        owner: typeof input.owner === 'string' ? resolveOwner(input.owner, context.agents) : task.owner,
        blockedBy: [...new Set([...task.blockedBy, ...addBlockedBy])],
        updatedAt: context.at,
      }
    })
  }
  if (call.tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const prefix = `${context.reporter}:todo:`
    const todos = input.todos.filter(isRecord).map((todo, index): TaskRecord => ({
      id: `${prefix}${index + 1}`,
      title: typeof todo.content === 'string' ? todo.content.slice(0, MAX_TITLE_LENGTH) : '',
      status: STATUSES.includes(todo.status as TaskStatus) ? (todo.status as TaskStatus) : 'pending',
      owner: context.reporter,
      blockedBy: [],
      source: 'native',
      updatedAt: context.at,
    }))
    return capTasks([...tasks.filter(task => !task.id.startsWith(prefix)), ...todos])
  }
  return tasks
}

// 完成幾項、總共幾項、百分比；沒有任何回報的任務時是 null（畫面寫 Unknown）
export function taskProgress(tasks: readonly TaskRecord[]): { completed: number; total: number; percent: number } | null {
  if (tasks.length === 0) return null
  const completed = tasks.filter(task => task.status === 'completed').length
  return { completed, total: tasks.length, percent: Math.round((completed / tasks.length) * 100) }
}

// 最多留 MAX_TASKS 項：先丟最早更新的已完成任務
export function capTasks(tasks: TaskRecord[]): TaskRecord[] {
  if (tasks.length <= MAX_TASKS) return tasks
  const completed = tasks.filter(task => task.status === 'completed').sort((left, right) => left.updatedAt - right.updatedAt)
  const dropped = new Set(completed.slice(0, tasks.length - MAX_TASKS).map(task => task.id))
  return tasks.filter(task => !dropped.has(task.id))
}

// 回報者在等什麼：空字串是不再等待；內容一樣時回傳同一個物件
export function setWaiting(waiting: WaitingReports, reporter: string, text: string, at: number): WaitingReports {
  const trimmed = text.trim()
  if (trimmed === '') {
    if (!(reporter in waiting)) return waiting
    const { [reporter]: _cleared, ...rest } = waiting
    return rest
  }
  if (waiting[reporter]?.text === trimmed) return waiting
  return { ...waiting, [reporter]: { text: trimmed, at } }
}

// 主對話常在派出子代理前就登記計畫，那時負責人只能用名字或任務說明寫；派出後再對一次，換成代理的 id，
// 阻塞偵測才連得到那個代理。主對話與已對上的不動；沒有變化時回傳同一個陣列
export function resolvePendingOwners(tasks: TaskRecord[], agents: readonly AgentRecord[]): TaskRecord[] {
  let changed = false
  const next = tasks.map(task => {
    if (task.owner === MAIN_OWNER || agents.some(agent => agent.id === task.owner)) return task
    const owner = resolveOwner(task.owner, agents)
    if (owner === task.owner) return task
    changed = true
    return { ...task, owner }
  })
  return changed ? next : tasks
}
