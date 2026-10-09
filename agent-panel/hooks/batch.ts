// 這一回合派出的子代理：開新一批、記錄每次請求的用量、工具呼叫、完成與失敗。
// 全部是純函式，回傳新物件、不改傳入的 batch；找不到子代理時原樣回傳同一個物件
import type { AgentRow, Batch, TokenUsage } from '../types'
import { requestCostUsd, totalTokens } from './pricing'

type SpawnFacts = { id: string; description: string; isNested: boolean; startedAt: number }
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'
type ListedAgent = { id: string; description: string; status: string; parentId?: string }

const FAILURE_REASONS: Record<Exclude<FinishReason, 'answer'>, string> = {
  aborted: '已中斷',
  error: 'API 錯誤',
  refusal: '模型拒絕',
}

function newRow(spawn: SpawnFacts): AgentRow {
  return {
    ...spawn,
    status: 'running',
    endedAt: null,
    failureReason: null,
    model: null,
    effort: null,
    toolCount: 0,
    activity: '',
    lastUsage: null,
    reportedTokens: null,
    costUsd: 0,
    hasUnpricedUsage: false,
  }
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
  return { ...current, agents: [...current.agents, newRow(spawn)] }
}

export function recordStep(
  batch: Batch,
  agentId: string,
  step: { model: string; effort?: string | number; usage: TokenUsage | null },
): Batch {
  return updateAgent(batch, agentId, row => {
    const withModel = { ...row, model: step.model, effort: step.effort ?? row.effort }
    // 請求失敗或中斷時沒有 usage：不累加，也不當成 0
    if (step.usage === null) return withModel
    const cost = requestCostUsd(step.model, step.usage)
    return {
      ...withModel,
      lastUsage: step.usage,
      costUsd: row.costUsd + (cost ?? 0),
      hasUnpricedUsage: row.hasUnpricedUsage || cost === null,
    }
  })
}

export function recordToolCall(batch: Batch, agentId: string, activity: string): Batch {
  return updateAgent(batch, agentId, row => ({ ...row, toolCount: row.toolCount + 1, activity }))
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

export function finishAgent(batch: Batch, agentId: string, reason: FinishReason, endedAt: number): Batch {
  return updateAgent(batch, agentId, row =>
    reason === 'answer'
      ? { ...row, status: 'done', endedAt, failureReason: null }
      : { ...row, status: 'failed', endedAt, failureReason: FAILURE_REASONS[reason] },
  )
}

// 熱重載或面板開啟前就在跑的子代理：用 $.agent.list() 補上，用量從之後的請求開始累計
export function seedRunning(batch: Batch | null, listed: readonly ListedAgent[], now: number): Batch | null {
  if (batch === null) return null
  const known = new Set(batch.agents.map(agent => agent.id))
  const added = listed
    .filter(agent => agent.status === 'running' && !known.has(agent.id))
    .map(agent => newRow({ id: agent.id, description: agent.description, isNested: agent.parentId !== undefined, startedAt: now }))
  return added.length === 0 ? batch : { ...batch, agents: [...batch.agents, ...added] }
}

export function hasRunning(batch: Batch | null): boolean {
  return batch !== null && batch.agents.some(agent => agent.status === 'running')
}

export function agentTokens(row: AgentRow): number {
  if (row.reportedTokens !== null) return row.reportedTokens
  return row.lastUsage === null ? 0 : totalTokens(row.lastUsage)
}

// 時間從最早派出到最晚結束；還有在跑就算到現在
export function batchTotals(batch: Batch, now: number): { costUsd: number; hasUnpriced: boolean; tokens: number; elapsedMs: number } {
  const { agents } = batch
  const costUsd = agents.reduce((sum, agent) => sum + agent.costUsd, 0)
  const hasUnpriced = agents.some(agent => agent.hasUnpricedUsage)
  const tokens = agents.reduce((sum, agent) => sum + agentTokens(agent), 0)
  if (agents.length === 0) return { costUsd, hasUnpriced, tokens, elapsedMs: 0 }
  const startedAt = Math.min(...agents.map(agent => agent.startedAt))
  const endedAt = hasRunning(batch) ? now : Math.max(...agents.map(agent => agent.endedAt ?? now))
  return { costUsd, hasUnpriced, tokens, elapsedMs: Math.max(0, endedAt - startedAt) }
}
