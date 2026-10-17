// 給外部 App（例如 Splex 終端機）讀的 session 快照：面板上的代理、任務、阻塞、建議與最近事件，寫成一份 JSON
// 純函式，不碰 engine；寫檔與節流在 register.tsx
import type { AgentRecord, MainLoop, SupervisorEvent, TaskRecord, WaitingReports } from '../types'
import { blockedSubjects, detectBlockers, suggestActions } from './blockers'
import { agentName, ownerName } from './names'
import { taskProgress } from './tasks'
import { agentStatus, sortAgents } from './view'
import type { StatusLabel } from './view'

// 格式有不相容的改動時加一；讀的一方看到不認得的版本就不顯示
export const SNAPSHOT_VERSION = 1
// 事件只帶最近幾筆，外部 App 只顯示最近 3 筆
const SNAPSHOT_EVENT_COUNT = 10

export type SnapshotIdentity = {
  sessionId: string
  // Claude Code 本身的 pid，外部 App 用它比對是哪個終端機窗格；取不到是 null
  pid: number | null
  cwd: string
}

export type SnapshotState = {
  agents: readonly AgentRecord[]
  mainLoop: MainLoop
  tasks: readonly TaskRecord[]
  waiting: WaitingReports
  events: readonly SupervisorEvent[]
}

export type SupervisorSnapshot = {
  version: number
  sessionId: string
  pid: number | null
  cwd: string
  // 毫秒；session 結束時 ended 為 true（沒有刪檔的 API，改用這個欄位表示）
  updatedAt: number
  ended: boolean
  // activityAt：最近一次活動的時間（毫秒），外部 App 用來算閒置多久；不知道是 null
  main: { isRunning: boolean; activity: string; activityAt: number | null }
  agents: {
    id: string
    name: string
    // 跟面板一樣的狀態字：RUNNING／IDLE／BLOCKED／COMPLETED／FAILED／UNKNOWN；isInferred 是推測的
    status: StatusLabel
    isInferred: boolean
    activity: string
    detail: string | null
    failureReason: string | null
    startedAt: number | null
    endedAt: number | null
    toolCount: number
    activityAt: number | null
  }[]
  tasks: { id: string; title: string; status: TaskRecord['status']; owner: string; blockedBy: string[] }[]
  progress: { completed: number; total: number; percent: number } | null
  // 代理或主對話回報「在等什麼」；reporter 已換成顯示名稱。isMain 是主對話回報的：
  // 子代理不能直接問使用者，只有主對話的等待代表在等使用者（Splex 依此決定要不要提醒）
  waiting: { reporter: string; isMain: boolean; text: string; at: number }[]
  // 面板 ATTENTION 區的阻塞：被擋住的一方、擋路的一方（顯示名稱）、原因；possible 是推測的
  attention: { subject: string; dependsOn: string | null; reason: string; source: string; certainty: 'confirmed' | 'possible'; taskId: string | null }[]
  suggestions: string[]
  events: { at: number; kind: SupervisorEvent['kind']; text: string }[]
}

// session id 只收英數、底線與 -，避免組出奇怪的路徑
export function snapshotPath(home: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  return `${home}/.claude/agent-supervisor/sessions/${sessionId}.json`
}

export function buildSnapshot(state: SnapshotState, identity: SnapshotIdentity, now: number, ended = false): SupervisorSnapshot {
  const model = { agents: state.agents, tasks: state.tasks, waiting: state.waiting }
  const blockers = detectBlockers(model)
  const blocked = blockedSubjects(blockers)
  return {
    version: SNAPSHOT_VERSION,
    sessionId: identity.sessionId,
    pid: identity.pid,
    cwd: identity.cwd,
    updatedAt: now,
    ended,
    main: { isRunning: state.mainLoop.isRunning, activity: state.mainLoop.activity, activityAt: state.mainLoop.activityAt },
    agents: sortAgents(state.agents, blocked).map(agent => {
      const status = agentStatus(agent, blocked.has(agent.id))
      return {
        id: agent.id,
        name: agentName(agent),
        status: status.label,
        isInferred: status.isInferred,
        activity: agent.activity,
        detail: agent.detail,
        failureReason: agent.failureReason,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        toolCount: agent.toolCount,
        activityAt: agent.activityAt,
      }
    }),
    tasks: state.tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      owner: ownerName(task.owner, state.agents),
      blockedBy: [...task.blockedBy],
    })),
    progress: taskProgress(state.tasks),
    waiting: Object.entries(state.waiting).map(([reporter, report]) => ({
      reporter: ownerName(reporter, state.agents),
      isMain: reporter === 'main',
      text: report.text,
      at: report.at,
    })),
    attention: blockers.map(blocker => ({
      subject: ownerName(blocker.subject, state.agents),
      dependsOn: blocker.dependsOn === null ? null : ownerName(blocker.dependsOn, state.agents),
      reason: blocker.reason,
      source: blocker.source,
      certainty: blocker.certainty,
      taskId: blocker.taskId,
    })),
    suggestions: suggestActions(model, blockers),
    events: state.events.slice(-SNAPSHOT_EVENT_COUNT).map(event => ({ at: event.at, kind: event.kind, text: event.text })),
  }
}

// 比較內容是否改變時不算 updatedAt，否則每次都算有變
export function snapshotSignature(snapshot: SupervisorSnapshot): string {
  return JSON.stringify({ ...snapshot, updatedAt: 0 })
}
