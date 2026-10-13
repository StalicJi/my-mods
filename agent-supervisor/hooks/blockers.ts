// 阻塞偵測與下一步建議，全部是規則，不呼叫模型。
// 確認的阻塞只來自明確的依賴與代理自己的回報；其他只能標成可能（POSSIBLE BLOCKER）。
// 跑很久、沒有新事件、Claude Code 清單上的 waiting、還沒開始的任務在等依賴，都不算阻塞
import type { AgentRecord, TaskRecord, WaitingReports } from '../types'
import { isFinished } from './agents'
import { agentName, ownerName } from './names'

export type BlockerSource = 'dependency' | 'report' | 'missing-task' | 'stale-owner' | 'tool-errors'
export type Blocker = {
  certainty: 'confirmed' | 'possible'
  source: BlockerSource
  // 被擋住的一方：主對話是 'main'，代理是 agentId（任務負責人對不到代理時是原樣的名字）
  subject: string
  // 擋路的一方（知道的話）
  dependsOn: string | null
  reason: string
  // 相關的任務：被擋的任務；stale-owner 是擋路的任務
  taskId: string | null
  // 擋路的任務（知道的話），建議用它寫「先完成哪一項」
  blockingTaskId: string | null
}
export type SupervisionModel = { agents: readonly AgentRecord[]; tasks: readonly TaskRecord[]; waiting: WaitingReports }

const TOOL_ERROR_THRESHOLD = 3
const MAX_SUGGESTIONS = 2

function isLive(subject: string, agents: readonly AgentRecord[]): boolean {
  if (subject === 'main') return true
  const agent = agents.find(candidate => candidate.id === subject)
  return agent !== undefined && (agent.phase === 'running' || agent.phase === 'idle')
}

export function detectBlockers(model: SupervisionModel): Blocker[] {
  const reported = waitingBlockers(model)
  const reportedSubjects = new Set(reported.map(blocker => blocker.subject))
  // 同一方自己回報了在等什麼，就不再列依賴推出來的那一條（回報的原因比較準）
  const dependencies = dependencyBlockers(model).filter(blocker => blocker.certainty === 'possible' || !reportedSubjects.has(blocker.subject))
  const all = [...reported, ...dependencies, ...toolErrorBlockers(model)]
  return [...all.filter(blocker => blocker.certainty === 'confirmed'), ...all.filter(blocker => blocker.certainty === 'possible')]
}

function dependencyBlockers({ agents, tasks }: SupervisionModel): Blocker[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const blockers: Blocker[] = []
  const seenStale = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'completed') continue
    for (const dependencyId of task.blockedBy) {
      const dependency = byId.get(dependencyId)
      if (dependency === undefined) {
        blockers.push({
          certainty: 'possible',
          source: 'missing-task',
          subject: task.owner,
          dependsOn: null,
          reason: `「${task.title}」依賴的任務 ${dependencyId} 沒有人回報過`,
          taskId: task.id,
          blockingTaskId: null,
        })
        continue
      }
      if (dependency.status === 'completed') continue
      const dependencyOwner = agents.find(agent => agent.id === dependency.owner)
      if (dependencyOwner !== undefined && isFinished(dependencyOwner)) {
        const key = `${task.owner}:${dependency.id}`
        if (seenStale.has(key)) continue
        seenStale.add(key)
        blockers.push({
          certainty: 'possible',
          source: 'stale-owner',
          subject: task.owner,
          dependsOn: dependency.owner,
          reason: `「${dependency.title}」的負責人已結束，但任務沒標成完成`,
          taskId: dependency.id,
          blockingTaskId: dependency.id,
        })
        continue
      }
      // 還沒開始的任務在等依賴是正常的先後順序；已經在做卻還有沒完成的依賴才是卡住
      if (task.status !== 'in_progress') continue
      blockers.push({
        certainty: 'confirmed',
        source: 'dependency',
        subject: task.owner,
        dependsOn: dependency.owner,
        reason: `「${task.title}」要等「${dependency.title}」`,
        taskId: task.id,
        blockingTaskId: dependency.id,
      })
    }
  }
  return blockers
}

// 還沒結束的代理（或主對話）自己回報在等什麼；它的任務有沒完成的依賴時，指向那個依賴的負責人
function waitingBlockers({ agents, tasks, waiting }: SupervisionModel): Blocker[] {
  return Object.entries(waiting)
    .filter(([reporter]) => isLive(reporter, agents))
    .map(([reporter, report]) => {
      const blockedTask = tasks.find(task => task.owner === reporter && task.status !== 'completed' && unmetDependency(task, tasks) !== undefined)
      const dependency = blockedTask === undefined ? undefined : unmetDependency(blockedTask, tasks)
      return {
        certainty: 'confirmed' as const,
        source: 'report' as const,
        subject: reporter,
        dependsOn: dependency === undefined || dependency.owner === reporter ? null : dependency.owner,
        reason: report.text,
        taskId: blockedTask?.id ?? null,
        blockingTaskId: dependency?.id ?? null,
      }
    })
}

function unmetDependency(task: TaskRecord, tasks: readonly TaskRecord[]): TaskRecord | undefined {
  return task.blockedBy.map(id => tasks.find(other => other.id === id)).find(other => other !== undefined && other.status !== 'completed')
}

function toolErrorBlockers({ agents }: SupervisionModel): Blocker[] {
  return agents
    .filter(agent => agent.phase === 'running' && agent.toolErrorStreak >= TOOL_ERROR_THRESHOLD)
    .map(agent => ({
      certainty: 'possible' as const,
      source: 'tool-errors' as const,
      subject: agent.id,
      dependsOn: null,
      reason: `連續 ${agent.toolErrorStreak} 次工具失敗${agent.lastToolError === null ? '' : `：${agent.lastToolError}`}`,
      taskId: null,
      blockingTaskId: null,
    }))
}

// 確認被擋住的一方：面板上這些代理（或主對話）顯示 BLOCKED；可能的阻塞不改狀態
export function blockedSubjects(blockers: readonly Blocker[]): Set<string> {
  return new Set(blockers.filter(blocker => blocker.certainty === 'confirmed').map(blocker => blocker.subject))
}

// 規則式的下一步建議，依重要性排，最多兩則；沒有足夠資訊時不給
export function suggestActions(model: SupervisionModel, blockers: readonly Blocker[]): string[] {
  const name = (subject: string) => ownerName(subject, model.agents)
  const taskOf = (id: string | null) => (id === null ? undefined : model.tasks.find(task => task.id === id))
  const suggestions: string[] = []
  for (const blocker of blockers) {
    const blocking = taskOf(blocker.blockingTaskId)
    if (blocker.source === 'stale-owner' && blocking !== undefined) {
      suggestions.push(`「${blocking.title}」的負責人 ${name(blocking.owner)} 已結束：確認是否完成，或改派`)
    } else if ((blocker.source === 'dependency' || blocker.source === 'report') && blocking !== undefined) {
      suggestions.push(`先完成「${blocking.title}」（${name(blocking.owner)}），${name(blocker.subject)} 才能繼續`)
    } else if (blocker.source === 'report') {
      suggestions.push(`處理 ${name(blocker.subject)} 在等的事：${blocker.reason}`)
    }
  }
  for (const agent of model.agents) {
    if (agent.phase === 'failed') suggestions.push(`查看 ${agentName(agent)} 失敗的原因（${agent.failureReason ?? '失敗'}），決定要不要重派`)
  }
  for (const blocker of blockers) {
    if (blocker.source === 'tool-errors') suggestions.push(`看一下 ${name(blocker.subject)} 的工具錯誤：${blocker.reason}`)
  }
  const isAllDone =
    model.tasks.length > 0 &&
    model.tasks.every(task => task.status === 'completed') &&
    !model.agents.some(agent => agent.phase === 'running' || agent.phase === 'idle')
  if (isAllDone) suggestions.push('全部任務完成：整理結果')
  return [...new Set(suggestions)].slice(0, MAX_SUGGESTIONS)
}
