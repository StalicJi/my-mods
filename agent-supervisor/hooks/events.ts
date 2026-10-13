// 事件串：代理開始、結束與失敗、工具失敗、任務新增與狀態改變、回報在等與不再等待。
// 成功的工具呼叫太多，不記。只留最近 MAX_EVENTS 筆，記憶體不會一直長
import type { SupervisorEvent, TaskRecord, TaskStatus, WaitingReports } from '../types'

const MAX_EVENTS = 50
const STATUS_TEXT: Record<TaskStatus, string> = { pending: '改回未開始', in_progress: '開始進行', completed: '完成' }

export function appendEvents(events: SupervisorEvent[], added: readonly SupervisorEvent[]): SupervisorEvent[] {
  if (added.length === 0) return events
  return [...events, ...added].slice(-MAX_EVENTS)
}

// 比對回報前後的任務：新增、狀態改變、移除各一筆，記在負責人底下
export function taskEvents(before: readonly TaskRecord[], after: readonly TaskRecord[], at: number): SupervisorEvent[] {
  const previous = new Map(before.map(task => [task.id, task]))
  const current = new Set(after.map(task => task.id))
  const changes: SupervisorEvent[] = []
  for (const task of after) {
    const old = previous.get(task.id)
    if (old === undefined) changes.push({ at, agentId: task.owner, kind: 'task', text: `新增任務 ${task.id} ${task.title}` })
    else if (old.status !== task.status) changes.push({ at, agentId: task.owner, kind: 'task', text: `${task.id} ${task.title} ${STATUS_TEXT[task.status]}` })
  }
  for (const task of before) {
    if (!current.has(task.id)) changes.push({ at, agentId: task.owner, kind: 'task', text: `移除任務 ${task.id} ${task.title}` })
  }
  return changes
}

// 比對前後的等待回報：回報在等（或改了原因）、不再等待
export function waitingEvents(before: WaitingReports, after: WaitingReports, at: number): SupervisorEvent[] {
  const changes: SupervisorEvent[] = []
  for (const [reporter, report] of Object.entries(after)) {
    if (before[reporter]?.text !== report.text) changes.push({ at, agentId: reporter, kind: 'waiting', text: `回報在等：${report.text}` })
  }
  for (const reporter of Object.keys(before)) {
    if (!(reporter in after)) changes.push({ at, agentId: reporter, kind: 'resolved', text: '不再等待' })
  }
  return changes
}
