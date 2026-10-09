// 這一回合派出的子代理：開新一批、記錄每次請求的模型與用量、思考與工具呼叫、完成與失敗。
// 全部是純函式，回傳新物件、不改傳入的 batch；找不到子代理時原樣回傳同一個物件
import type { AgentRow, Batch, TokenUsage } from '../types'
import { totalTokens } from './pricing'

type SpawnFacts = {
  id: string
  description: string
  agentType: string
  agentName: string | null
  isNested: boolean
  startedAt: number
}
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'
type ListedAgent = { id: string; description: string; status: string; type: string; parentId?: string; teammateId?: string }

const FAILURE_REASONS: Record<Exclude<FinishReason, 'answer'>, string> = {
  aborted: '已中斷',
  error: 'API 錯誤',
  refusal: '模型拒絕',
}

const THINKING_ACTIVITY = '思考中'

// $.agent.list() 裡這一輪還沒結束、之後會收到 turn.complete 的狀態：還沒開始、正在跑、等權限或背景工作。
// idle 是這一輪已結束、等訊息喚醒（teammate），補成 running 會一直收不到結束而卡住，所以不算
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

// 還沒有任何動作，目前動作的開始時間先用派出時間
function newRow(spawn: SpawnFacts, look: number): AgentRow {
  return {
    ...spawn,
    status: 'running',
    endedAt: null,
    failureReason: null,
    model: null,
    effort: null,
    toolCount: 0,
    activity: '',
    activityStartedAt: spawn.startedAt,
    lastUsage: null,
    reportedTokens: null,
    look,
  }
}

// host 保存的批次可能有舊版記下、沒有 look 的列：當成第一種造型，畫面不會壞，配號時也算 0 已被用掉
export function agentLook(row: AgentRow): number {
  return row.look ?? 0
}

// 造型依派出順序輪流：挑這一批還沒用掉的最小號碼。跨回合還在跑的保留原本的造型，新派的不會跟它撞；
// 完成後被新批次清掉的號碼可以再用，號碼才不會越跳越大（超過造型數時由 mascot.ts 取餘數）
function nextLook(agents: readonly AgentRow[]): number {
  const used = new Set(agents.map(agentLook))
  let look = 0
  while (used.has(look)) look += 1
  return look
}

// 新回合開新一批，帶過還在跑的（背景子代理可能跨回合）；turnId 不明（剛熱重載，模組變數歸零）時沿用現有批次
function batchForTurn(batch: Batch | null, currentTurnId: string | null): Batch {
  if (batch === null) return { turnId: currentTurnId ?? 'unknown', agents: [] }
  if (currentTurnId === null || batch.turnId === currentTurnId) return batch
  return { turnId: currentTurnId, agents: batch.agents.filter(agent => agent.status === 'running') }
}

function updateAgent(batch: Batch, agentId: string, change: (row: AgentRow) => AgentRow): Batch {
  const index = batch.agents.findIndex(agent => agent.id === agentId)
  if (index < 0) return batch
  const agents = batch.agents.slice()
  agents[index] = change(agents[index]!)
  return { ...batch, agents }
}

const finiteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function addAgent(batch: Batch | null, currentTurnId: string | null, spawn: SpawnFacts): Batch {
  const current = batchForTurn(batch, currentTurnId)
  if (current.agents.some(agent => agent.id === spawn.id)) return current
  return { ...current, agents: [...current.agents, newRow(spawn, nextLook(current.agents))] }
}

export function recordStep(
  batch: Batch,
  agentId: string,
  step: { model: string; effort?: string | number; usage: TokenUsage | null },
): Batch {
  return updateAgent(batch, agentId, row => {
    const withModel = { ...row, model: step.model, effort: step.effort ?? row.effort }
    // 請求失敗或中斷時沒有 usage：保留上一次的用量，不當成 0
    if (step.usage === null) return withModel
    return { ...withModel, lastUsage: step.usage }
  })
}

export function recordThinking(batch: Batch, agentId: string, at: number): Batch {
  return updateAgent(batch, agentId, row => ({ ...row, activity: THINKING_ACTIVITY, activityStartedAt: at }))
}

export function recordToolCall(batch: Batch, agentId: string, activity: string, at: number): Batch {
  return updateAgent(batch, agentId, row => ({ ...row, toolCount: row.toolCount + 1, activity, activityStartedAt: at }))
}

// 前景子代理完成時 Agent 工具結果帶的總計；背景子代理的結果沒有這兩個欄位，維持即時累計
export function recordReported(batch: Batch, agentId: string, reported: { totalTokens?: unknown; totalToolUseCount?: unknown }): Batch {
  const tokens = finiteNumber(reported.totalTokens)
  const toolUses = finiteNumber(reported.totalToolUseCount)
  if (tokens === null && toolUses === null) return batch
  return updateAgent(batch, agentId, row => ({
    ...row,
    reportedTokens: tokens ?? row.reportedTokens,
    toolCount: toolUses ?? row.toolCount,
  }))
}

// 不清掉 activity：失敗的卡片要用它顯示停在哪一步
export function finishAgent(batch: Batch, agentId: string, reason: FinishReason, endedAt: number): Batch {
  return updateAgent(batch, agentId, row =>
    reason === 'answer'
      ? { ...row, status: 'done', endedAt, failureReason: null }
      : { ...row, status: 'failed', endedAt, failureReason: FAILURE_REASONS[reason] },
  )
}

// 熱重載或面板開啟前就在跑的子代理：用 $.agent.list() 補上，用量從之後的請求開始累計。
// 清單沒有 Agent({ name }) 給的名字，所以 agentName 一律 null；teammate 跟派出時一樣不列入面板
export function seedRunning(batch: Batch | null, listed: readonly ListedAgent[], now: number): Batch | null {
  if (batch === null) return null
  const known = new Set(batch.agents.map(agent => agent.id))
  const missing = listed.filter(agent => agent.teammateId === undefined && LIVE_STATUSES.has(agent.status) && !known.has(agent.id))
  if (missing.length === 0) return batch
  // 一個一個加，後面的才看得到前面剛拿走的造型號碼
  const agents = missing.reduce<AgentRow[]>((rows, agent) => {
    const spawn = {
      id: agent.id,
      description: agent.description,
      agentType: agent.type,
      agentName: null,
      isNested: agent.parentId !== undefined,
      startedAt: now,
    }
    return [...rows, newRow(spawn, nextLook(rows))]
  }, batch.agents)
  return { ...batch, agents }
}

export function hasRunning(batch: Batch | null): boolean {
  return batch !== null && batch.agents.some(agent => agent.status === 'running')
}

export function agentTokens(row: AgentRow): number {
  if (row.reportedTokens !== null) return row.reportedTokens
  return row.lastUsage === null ? 0 : totalTokens(row.lastUsage)
}

// 時間從最早派出到最晚結束；還有在跑就算到現在
export function batchTotals(batch: Batch, now: number): { tokens: number; elapsedMs: number } {
  const { agents } = batch
  const tokens = agents.reduce((sum, agent) => sum + agentTokens(agent), 0)
  if (agents.length === 0) return { tokens, elapsedMs: 0 }
  const startedAt = Math.min(...agents.map(agent => agent.startedAt))
  const endedAt = hasRunning(batch) ? now : Math.max(...agents.map(agent => agent.endedAt ?? now))
  return { tokens, elapsedMs: Math.max(0, endedAt - startedAt) }
}
