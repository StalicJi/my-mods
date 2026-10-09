// Agent Panel：派出子代理時跳出面板，顯示這一回合每個子代理的模型、用量與時間；/agents 開關
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput } from 'claude-code'

import type { AgentRow, Batch, TokenUsage } from '../types'
import { addAgent, batchTotals, finishAgent, hasRunning, recordReported, recordStep, recordToolCall, seedRunning } from './batch'
import { agentCard, colorRuns, describeTool, fitToWidth, formatElapsed, formatTokens, splitSections, summaryMode } from './layout'

const PANE_ID = 'agent-panel'
const PANE_TITLE = 'Agents'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 42
const NARROW_HINT = '子代理面板放不下：打 /agents 開啟'
const EMPTY_HINT = '這個 session 還沒有派出子代理'
// 彗星移動與時間跳動：每 0.2 秒一拍
const ANIMATION_MS = 200
const BAR_CELL = '▆'
const SEPARATOR = '─'
// 統計方框左右各一格框線、一格內距
const TILE_CHROME_COLUMNS = 4

// 狀態由 host 保存，熱重載後仍在
const batchAtom = atom({ plugin: 'agent-panel', key: 'batch' } as const, null as Batch | null)
// 動畫計數器，只有面板讀，所以動畫只會讓面板重畫；不用 $.ui.invalidate，那會讓整個對話紀錄重跑
const tickAtom = atom({ plugin: 'agent-panel', key: 'tick' } as const, 0)

// 下面三個是模組自己的變數，熱重載後重來
// 目前主回合的 turnId；歸零時沿用現有批次
let currentTurnId: string | null = null
// 窗格放不下的提示每個 session 最多一次
let hasWarnedNarrow = false
let timer: Timer | undefined

type SpawnFacts = { id: string; description: string; isNested: boolean }
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'

// mod 自己開的窗格要終端機夠寬才放得下（使用者親手開過後門檻較低）；放不下時窗格在背景等，提示一次怎麼開
export async function openPanel($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced && !hasWarnedNarrow) {
    hasWarnedNarrow = true
    $.ui.toast(NARROW_HINT)
  }
  await syncTimer($)
}

// 由 mod 關閉，不會清掉「使用者親手開過」的紀錄（使用者按 ✕ 才會）
async function closePanel($: EngineInterface) {
  await $.ui.close({ id: PANE_ID }).catch(() => {})
  await syncTimer($)
}

// 只在面板已放上畫面、而且有子代理在跑時計時；全部完成或面板關掉就停，不在背景空轉
export async function syncTimer($: EngineInterface): Promise<void> {
  try {
    if (!(await shouldAnimate($))) {
      stopTimer()
      return
    }
    if (timer === undefined) timer = $.clock.every(ANIMATION_MS, () => void advanceFrame($))
  } catch {
    // 略過：下一次寫入時再同步
  }
}

async function shouldAnimate($: EngineInterface) {
  const [batch, panes] = await Promise.all([read($, batchAtom), $.ui.panes()])
  return hasRunning(batch) && panes.some(pane => pane.id === PANE_ID && pane.isPlaced)
}

// 每一拍先確認面板還在畫面上、而且還有子代理在跑，不是就停下：
// 使用者按 ✕ 關掉面板，或 syncTimer 的讀取競態讓計時器在全部完成後才建立，都會在下一拍自己停下
async function advanceFrame($: EngineInterface) {
  try {
    if (!(await shouldAnimate($))) {
      stopTimer()
      return
    }
    await update($, tickAtom, frame => frame + 1)
  } catch {
    // 略過這一拍
  }
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

// 只有使用者本人送出的一般訊息才關面板：/ 開頭的指令、背景任務的通知、其他 session 或外掛送的都不算
function isOwnMessage(originKind: string, text: string) {
  return (originKind === 'composer' || originKind === 'bridge') && !text.trimStart().startsWith('/')
}

// Claude Code 自己的內部 fork（例如 compaction）也帶 agentId，但不在這一批。
// update 就算拿回同一個值也會寫一次、讓面板重畫，所以先讀過確認；更新函式裡照樣會再檢查，讀完到寫入之間批次換了也不會寫錯
async function isInBatch($: EngineInterface, agentId: string) {
  const batch = await read($, batchAtom)
  return batch !== null && batch.agents.some(agent => agent.id === agentId)
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
    else await syncTimer($)
  } catch {
    // 略過
  }
}

async function recordStepUsage($: EngineInterface, agentId: string, step: { model: string; effort?: string | number; usage: TokenUsage | null }) {
  try {
    if (!(await isInBatch($, agentId))) return
    await update($, batchAtom, batch => (batch === null ? batch : recordStep(batch, agentId, step)))
  } catch {
    // 略過
  }
}

async function recordTool($: EngineInterface, agentId: string, call: ToolCallInput) {
  try {
    if (!(await isInBatch($, agentId))) return
    const activity = describeTool(call.tool, call)
    await update($, batchAtom, batch => (batch === null ? batch : recordToolCall(batch, agentId, activity)))
    // 面板可能先在背景等待、終端機拉寬後才放上畫面，這時沒有事件通知；趁工具呼叫補啟動動畫
    if (timer === undefined) await syncTimer($)
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
    if (!(await isInBatch($, agentId))) return
    await update($, batchAtom, batch => (batch === null ? batch : recordReported(batch, agentId, reported)))
  } catch {
    // 略過
  }
}

async function recordFinish($: EngineInterface, agentId: string, reason: FinishReason) {
  try {
    if (!(await isInBatch($, agentId))) return
    const endedAt = await $.clock.now()
    await update($, batchAtom, batch => (batch === null ? batch : finishAgent(batch, agentId, reason, endedAt)))
    await syncTimer($)
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
    await syncTimer($) // 熱重載時把動畫接回來
    return started
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    if (e.reason === 'clear') await update($, batchAtom, () => null).catch(() => {})
    return next(e)
  })

  // subagent 的執行不會發 turn.start，只有主迴圈會
  on('turn.start', async ($, e, next) => {
    currentTurnId = e.turnId
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOwnMessage(e.origin.kind, e.text)) await closePanel($)
    return next(e)
  })

  on('command.run', { command: 'agents' }, async $ => {
    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(pane => pane.id === PANE_ID && pane.isPlaced)) {
      await closePanel($)
      return { text: '已關閉子代理面板。' }
    }
    // 使用者打指令開的窗格任何寬度都放得下，也讓之後 mod 自己開時門檻降到 110 欄
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
    await syncTimer($)
    return { text: '已開啟子代理面板。' }
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
      await recordTool($, e.agentId, e)
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

  // 面板：上方是這一批的總計，下面 Running、Finished 兩組卡片；版面規則都在 layout.ts
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // 畫面丟例外時 Claude Code 會卸載窗格、要再打 /agents 才回來；這裡接住，畫一行提示
    try {
      const [batch, frame] = await Promise.all([read($, batchAtom), read($, tickAtom)])
      if (batch === null) return <Text dimColor>{EMPTY_HINT}</Text>

      const columns = e.props.bodyColumns
      const now = await $.clock.now()
      const totals = batchTotals(batch, now)
      const tokens = formatTokens(totals.tokens)
      const time = formatElapsed(totals.elapsedMs)
      const { running, finished } = splitSections(batch)
      const lastId = [...running, ...finished].at(-1)?.id
      const tileWidth = Math.floor(columns / 2)
      // 值放不下時截斷，不讓格子折行變高
      const tileValue = (value: string) => fitToWidth(value, tileWidth - TILE_CHROME_COLUMNS)

      const section = (title: string, agents: AgentRow[]) =>
        agents.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{`${title} · ${agents.length}`}</Text>
            {agents.map(agent => {
              const card = agentCard(agent, { columns, now, frame })
              return (
                <Box flexDirection="column">
                  {card.lines.map(line => (
                    <Text wrap="truncate-end">
                      {line.map(span => (
                        <Text color={span.color} dimColor={span.isDim} bold={span.isBold}>
                          {span.text}
                        </Text>
                      ))}
                    </Text>
                  ))}
                  <Text>
                    {'  '}
                    {colorRuns(card.bar).map(run => (
                      <Text color={run.color}>{BAR_CELL.repeat(run.count)}</Text>
                    ))}
                  </Text>
                  {agent.id !== lastId && <Text dimColor>{SEPARATOR.repeat(columns)}</Text>}
                </Box>
              )
            })}
          </Box>
        )

      return (
        <Box flexDirection="column">
          <Text bold>{PANE_TITLE}</Text>
          {summaryMode(columns) === 'tiles' ? (
            <Box flexDirection="row">
              {[
                ['Tokens', tokens],
                ['Time', time],
              ].map(([label, value]) => (
                <Box flexDirection="column" borderStyle="round" width={tileWidth} paddingX={1}>
                  <Text dimColor>{label}</Text>
                  <Text bold>{tileValue(value!)}</Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Text>{fitToWidth(`${tokens} · ${time}`, columns)}</Text>
          )}
          {section('Running', running)}
          {section('Finished', finished)}
        </Box>
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return (
        <Text color="error" wrap="truncate-end">
          {`面板暫時畫不出來：${reason}`}
        </Text>
      )
    }
  })
}
