// 子代理的狀態：派出、活動、工具結果、結束，以及跟 Claude Code 的代理清單（$.agent.list()）對帳。
// 全部是純函式，回傳新陣列、不改傳入的；沒有變化時回傳同一個陣列，呼叫端就不必寫入（改寫自已刪除的 agent-panel）
import type { AgentPhase, AgentRecord, StatusSource } from '../types'

export type SpawnFacts = {
  id: string
  name: string | null
  agentType: string
  description: string
  parentId: string | null
  startedAt: number
}
export type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'
export type ListedAgent = { id: string; description: string; type: string; status: string; parentId?: string; teammateId?: string; name?: string }
export type ToolOutcome = { outcome: 'ok' | 'error' | 'denied'; errorLine: string | null }
type Activity = { activity: string; at: number; isToolCall: boolean }

const MAX_AGENTS = 30

const FAILURE_REASONS: Record<Exclude<FinishReason, 'answer'>, string> = {
  aborted: '已中斷',
  error: 'API 錯誤',
  refusal: '模型拒絕',
}

// $.agent.list() 的狀態對到面板的狀態。waiting 是在等自己的背景工作、計畫核准或（背景子代理）等 Agent 呼叫，
// 不是異常，所以當成 idle 加註，不當成阻塞
const LISTED_PHASES: Record<string, { phase: AgentPhase; detail: string | null; failureReason: string | null }> = {
  pending: { phase: 'running', detail: null, failureReason: null },
  running: { phase: 'running', detail: null, failureReason: null },
  idle: { phase: 'idle', detail: null, failureReason: null },
  waiting: { phase: 'idle', detail: '等待背景工作或核准', failureReason: null },
  completed: { phase: 'completed', detail: null, failureReason: null },
  failed: { phase: 'failed', detail: null, failureReason: '失敗' },
  killed: { phase: 'failed', detail: null, failureReason: '已停止' },
}
// 清單上這些狀態的代理還沒結束，補進面板；已結束的不補（不知道它做了什麼）
const LIVE_LISTED = new Set(['pending', 'running', 'waiting', 'idle'])

export function isFinished(agent: AgentRecord): boolean {
  return agent.phase === 'completed' || agent.phase === 'failed'
}

export function hasLive(agents: readonly AgentRecord[]): boolean {
  return agents.some(agent => agent.phase === 'running' || agent.phase === 'idle')
}

// 開面板前就在跑、從清單補上的不知道開始時間
type RecordFacts = Omit<SpawnFacts, 'startedAt'> & { startedAt: number | null }

function newRecord(facts: RecordFacts, phase: AgentPhase, source: StatusSource): AgentRecord {
  return {
    ...facts,
    phase,
    source,
    detail: null,
    failureReason: null,
    endedAt: null,
    activity: '',
    activityAt: null,
    toolCount: 0,
    toolErrorStreak: 0,
    lastToolError: null,
  }
}

function updateAgent(agents: AgentRecord[], id: string, change: (agent: AgentRecord) => AgentRecord): AgentRecord[] {
  const index = agents.findIndex(agent => agent.id === id)
  if (index < 0) return agents
  const changed = change(agents[index]!)
  if (changed === agents[index]) return agents
  const next = agents.slice()
  next[index] = changed
  return next
}

// 派出事件。已經有紀錄（結束事件先到、先從清單補上）時只補上名稱與說明，不動狀態
export function addSpawn(agents: AgentRecord[], facts: SpawnFacts): AgentRecord[] {
  const existing = agents.find(agent => agent.id === facts.id)
  if (existing === undefined) return [...agents, newRecord(facts, 'running', 'event')]
  const isSame =
    existing.name === facts.name &&
    existing.agentType === facts.agentType &&
    existing.description === facts.description &&
    existing.parentId === facts.parentId &&
    existing.startedAt !== null
  if (isSame) return agents
  return updateAgent(agents, facts.id, agent => ({
    ...agent,
    name: facts.name,
    agentType: facts.agentType,
    description: facts.description,
    parentId: facts.parentId,
    startedAt: agent.startedAt ?? facts.startedAt,
  }))
}

// 從清單補上一個還沒記錄的代理（開面板前就在跑，或結束事件比派出先到）
export function adoptListed(agents: AgentRecord[], listed: ListedAgent): AgentRecord[] {
  if (agents.some(agent => agent.id === listed.id)) return agents
  const mapped = LISTED_PHASES[listed.status] ?? { phase: 'unknown' as const, detail: null, failureReason: null }
  const facts = { id: listed.id, name: listed.name ?? null, agentType: listed.type, description: listed.description, parentId: listed.parentId ?? null, startedAt: null }
  return [...agents, { ...newRecord(facts, mapped.phase, 'engine'), detail: mapped.detail, failureReason: mapped.failureReason }]
}

// 思考或工具呼叫：證明它正在跑。已結束的不動（結束後才到的事件）
export function recordActivity(agents: AgentRecord[], id: string, activity: Activity): AgentRecord[] {
  return updateAgent(agents, id, agent =>
    isFinished(agent)
      ? agent
      : {
          ...agent,
          phase: 'running',
          source: 'event',
          detail: null,
          activity: activity.activity,
          activityAt: activity.at,
          toolCount: agent.toolCount + (activity.isToolCall ? 1 : 0),
        },
  )
}

export function recordToolOutcome(agents: AgentRecord[], id: string, result: ToolOutcome): AgentRecord[] {
  return updateAgent(agents, id, agent => {
    if (result.outcome === 'ok') {
      return agent.toolErrorStreak === 0 && agent.lastToolError === null ? agent : { ...agent, toolErrorStreak: 0, lastToolError: null }
    }
    return { ...agent, toolErrorStreak: agent.toolErrorStreak + 1, lastToolError: result.errorLine }
  })
}

// 結束事件。重複的以第一次為準
export function finishAgent(agents: AgentRecord[], id: string, reason: FinishReason, endedAt: number): AgentRecord[] {
  return updateAgent(agents, id, agent => {
    if (isFinished(agent) && agent.source === 'event') return agent
    return reason === 'answer'
      ? { ...agent, phase: 'completed', source: 'event', detail: null, failureReason: null, endedAt }
      : { ...agent, phase: 'failed', source: 'event', detail: null, failureReason: FAILURE_REASONS[reason], endedAt }
  })
}

// 跟 Claude Code 的代理清單對帳：還沒結束的照清單更新狀態；清單上找不到的標成推測的 unknown；
// 清單上還沒記錄、還沒結束的補上。事件已確認的結束不被清單蓋掉
export function reconcile(agents: AgentRecord[], listed: readonly ListedAgent[]): AgentRecord[] {
  const byId = new Map(listed.map(agent => [agent.id, agent]))
  let next = agents
  for (const agent of agents) {
    if (isFinished(agent) && agent.source === 'event') continue
    const entry = byId.get(agent.id)
    const mapped = entry === undefined ? null : LISTED_PHASES[entry.status]
    next = updateAgent(next, agent.id, current => {
      if (mapped === null || mapped === undefined) {
        return current.phase === 'unknown' ? current : { ...current, phase: 'unknown', source: 'inferred', detail: null }
      }
      const isSame = current.phase === mapped.phase && current.detail === mapped.detail && current.failureReason === mapped.failureReason
      return isSame ? current : { ...current, ...mapped, source: 'engine' }
    })
  }
  for (const entry of listed) {
    if (entry.teammateId !== undefined || !LIVE_LISTED.has(entry.status)) continue
    next = adoptListed(next, entry)
  }
  return next
}

// 最多留 MAX_AGENTS 個：先丟最早結束的，還沒結束的保留
export function capAgents(agents: AgentRecord[]): AgentRecord[] {
  if (agents.length <= MAX_AGENTS) return agents
  const finished = agents
    .filter(isFinished)
    .sort((left, right) => (left.endedAt ?? left.startedAt ?? 0) - (right.endedAt ?? right.startedAt ?? 0))
  const dropped = new Set(finished.slice(0, agents.length - MAX_AGENTS).map(agent => agent.id))
  return agents.filter(agent => !dropped.has(agent.id))
}

// 工具結果：被拒絕、出錯或成功；錯誤取第一行有字的，去掉 <tool_use_error> 標籤
export function toolOutcomeOf(result: unknown): ToolOutcome {
  const record = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; isError?: unknown; text?: unknown }
  if (typeof record.deny === 'string') return { outcome: 'denied', errorLine: firstLine(record.deny) }
  if (record.isError === true) return { outcome: 'error', errorLine: typeof record.text === 'string' ? firstLine(record.text) : null }
  return { outcome: 'ok', errorLine: null }
}

function firstLine(text: string): string | null {
  const line = text.replace(/<\/?tool_use_error>/g, '').split('\n').map(part => part.trim()).find(part => part !== '')
  return line === undefined ? null : line.slice(0, 120)
}

// 一句話說出代理在做什麼（跟已刪除的 agent-panel、clean-view 用同一套說法）
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
  if (tool === 'WebFetch') return `讀取網頁 ${text('url').replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]}`
  if (tool === 'Agent') return `委派 agent：${text('description')}`
  if (tool === 'Skill') return `使用 skill：${text('skill')}`
  if (tool === 'AskUserQuestion') return '詢問你問題'
  if (tool === 'ToolSearch') return '載入工具'
  if (tool.startsWith('mcp__')) return `使用 ${tool.split('__').slice(1).join(' ')}`
  return `使用 ${tool}`
}
