// Agent Panel：派出子代理時跳出面板，顯示這一回合每個子代理的模型、用量、估算費用與時間；/agents 開關
import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, TokenUsage } from '../types'
import { addAgent, finishAgent, recordReported, recordStep, recordToolCall, seedRunning } from './batch'
import { describeTool } from './layout'

const PANE_ID = 'agent-panel'
const PANE_TITLE = 'Agents'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 42
const NARROW_HINT = '子代理面板放不下：打 /agents 開啟'

// 狀態由 host 保存，熱重載後仍在
const batchAtom = atom({ plugin: 'agent-panel', key: 'batch' } as const, null as Batch | null)
// 動畫計數器，只有面板讀，所以動畫只會讓面板重畫
const tickAtom = atom({ plugin: 'agent-panel', key: 'tick' } as const, 0)

// 目前主回合的 turnId；熱重載後歸零，這時沿用現有批次
let currentTurnId: string | null = null
// 窗格放不下的提示每個 session 最多一次
let hasWarnedNarrow = false

type SpawnFacts = { id: string; description: string; isNested: boolean }
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'

// mod 自己開的窗格要終端機夠寬才放得下（使用者親手開過後門檻較低）；放不下時窗格在背景等，提示一次怎麼開
export async function openPanel($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  if (opened.isPlaced || hasWarnedNarrow) return
  hasWarnedNarrow = true
  $.ui.toast(NARROW_HINT)
}

// 下面的記錄都只觀察：出錯就略過這次，不影響子代理本身
async function recordSpawn($: EngineInterface, spawn: SpawnFacts) {
  try {
    const startedAt = await $.clock.now()
    // 開了新的一批才跳出面板；同一批再派不重開，使用者手動關掉後也不會一直彈回來。
    // 在更新函式裡判斷：平行派出時 update 會在版本衝突後重試，最後一次看到的才是真正寫入當下的批次
    let isNewBatch = false
    await update($, batchAtom, batch => {
      const next = addAgent(batch, currentTurnId, { ...spawn, startedAt })
      isNewBatch = batch === null || batch.turnId !== next.turnId
      return next
    })
    if (isNewBatch) await openPanel($)
  } catch {
    // 略過
  }
}

async function recordStepUsage($: EngineInterface, agentId: string, step: { model: string; effort?: string | number; usage: TokenUsage | null }) {
  try {
    await update($, batchAtom, batch => (batch === null ? batch : recordStep(batch, agentId, step)))
  } catch {
    // 略過
  }
}

async function recordTool($: EngineInterface, agentId: string, activity: string) {
  try {
    await update($, batchAtom, batch => (batch === null ? batch : recordToolCall(batch, agentId, activity)))
  } catch {
    // 略過
  }
}

// 前景子代理完成時，主迴圈 Agent 工具的結果帶有 Claude Code 自己算的總計
async function recordAgentResult($: EngineInterface, record: unknown) {
  if (typeof record !== 'object' || record === null) return
  const reported = record as { agentId?: unknown; totalTokens?: unknown; totalToolUseCount?: unknown }
  if (typeof reported.agentId !== 'string') return
  const agentId = reported.agentId
  try {
    await update($, batchAtom, batch => (batch === null ? batch : recordReported(batch, agentId, reported)))
  } catch {
    // 略過
  }
}

async function recordFinish($: EngineInterface, agentId: string, reason: FinishReason) {
  try {
    const endedAt = await $.clock.now()
    await update($, batchAtom, batch => (batch === null ? batch : finishAgent(batch, agentId, reason, endedAt)))
  } catch {
    // 略過
  }
}

// 熱重載或面板開啟前就在跑的子代理：從 $.agent.list() 補上
async function seedFromAgentList($: EngineInterface) {
  try {
    const listed = await $.agent.list()
    const now = await $.clock.now()
    await update($, batchAtom, batch => seedRunning(batch, listed, now))
  } catch {
    // 略過
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 名稱已被佔用時會被拒絕，不影響其他功能
    await $.command.register({ name: 'agents', description: '開關子代理面板' }).catch(() => {})
    await seedFromAgentList($)
    return started
  })

  // subagent 的執行不會發 turn.start，只有主迴圈會
  on('turn.start', async ($, e, next) => {
    currentTurnId = e.turnId
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // 被擋下、沒有本機執行迴圈（workflow 的遠端子代理）、在其他窗格跑的 teammate：追蹤不到，不列入
    if (result.deny !== undefined || result.agentId === undefined || result.teammateId !== undefined) return result
    await recordSpawn($, { id: result.agentId, description: e.description, isNested: e.parentAgentId !== undefined })
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined) await recordStepUsage($, e.agentId, { model: e.model, effort: e.effort, usage: result.usage })
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await recordTool($, e.agentId, describeTool(e.tool, e))
      return next(e)
    }
    if (e.tool !== 'Agent') return next(e)
    const result = await next(e)
    await recordAgentResult($, (result as { result?: unknown }).result)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await recordFinish($, e.agentId, e.reason)
    return next(e)
  })
}

// 任務 5 的面板畫面與計時器會用到
void tickAtom
