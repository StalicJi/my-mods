// Agent Panel：派出子代理時跳出面板，顯示這一回合每個子代理在做什麼、模型、用量與時間；
// 面板沒放上畫面時在輸入框下方釘一行狀態列；/agents 開關
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput } from 'claude-code'

import type { Batch, TokenUsage } from '../types'
import { addAgent, finishAgent, hasRunning, recordReported, recordStep, recordThinking, recordToolCall, seedRunning } from './batch'
import { agentCard, colorRuns, compactLine, describeTool, fullRowCount, splitSections, statusLine, statusText } from './layout'
import type { Span } from './layout'

const PANE_ID = 'agent-panel'
const PANE_TITLE = 'Agents'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 42
const NARROW_HINT = '子代理面板放不下：打 /agents 開啟'
const EMPTY_HINT = '這個 session 還沒有派出子代理'
// 彗星移動與時間跳動：每 0.2 秒一拍
const ANIMATION_MS = 200
const BAR_CELL = '▆'
// 剛載入時不知道輸入框下方是什麼（熱重載前可能留著舊的狀態列），用它讓第一次同步一定送出
const STATUS_UNKNOWN = Symbol('status-unknown')

// 狀態由 host 保存，熱重載後仍在
const batchAtom = atom({ plugin: 'agent-panel', key: 'batch' } as const, null as Batch | null)
// 動畫計數器，只有面板讀，所以動畫只會讓面板重畫；不用 $.ui.invalidate，那會讓整個對話紀錄重跑
const tickAtom = atom({ plugin: 'agent-panel', key: 'tick' } as const, 0)

// 下面四個是模組自己的變數，熱重載後重來
// 目前主回合的 turnId；歸零時沿用現有批次
let currentTurnId: string | null = null
// 窗格放不下的提示每個 session 最多一次
let hasWarnedNarrow = false
let timer: Timer | undefined
// 上一次送給 $.ui.status 的文字；相同就不再送，每送一次輸入框下方就重畫一次
let shownStatus: string | undefined | typeof STATUS_UNKNOWN = STATUS_UNKNOWN

type SpawnFacts = { id: string; description: string; agentType: string; agentName: string | null; isNested: boolean }
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'

// mod 自己開的窗格要終端機夠寬才放得下（使用者親手開過後門檻較低）；放不下時窗格在背景等，提示一次怎麼開
export async function openPanel($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced && !hasWarnedNarrow) {
    hasWarnedNarrow = true
    $.ui.toast(NARROW_HINT)
  }
  await syncTimerAndStatus($)
}

// 由 mod 關閉，不會清掉「使用者親手開過」的紀錄（使用者按 ✕ 才會）
async function closePanel($: EngineInterface) {
  await $.ui.close({ id: PANE_ID }).catch(() => {})
  await syncTimerAndStatus($)
}

// 有子代理在跑時：面板放上畫面就跑動畫，沒放上就在輸入框下方釘一行狀態列；都沒在跑就停計時器、清狀態列。
// 不在動畫的每一拍呼叫，所以狀態列不放會一直跳的耗時
export async function syncTimerAndStatus($: EngineInterface): Promise<void> {
  try {
    const { batch, isPanelPlaced } = await readPanelState($)
    const isRunning = batch !== null && hasRunning(batch)
    showStatus($, isRunning && !isPanelPlaced ? statusText(batch) : undefined)
    if (!isRunning || !isPanelPlaced) {
      stopTimer()
      return
    }
    if (timer === undefined) timer = $.clock.every(ANIMATION_MS, () => void advanceFrame($))
  } catch {
    // 略過：下一次寫入時再同步
  }
}

async function readPanelState($: EngineInterface) {
  const [batch, panes] = await Promise.all([read($, batchAtom), $.ui.panes()])
  return { batch, isPanelPlaced: isPanePlaced(panes) }
}

function isPanePlaced(panes: readonly { id: string; isPlaced: boolean }[]) {
  return panes.some(pane => pane.id === PANE_ID && pane.isPlaced)
}

function showStatus($: EngineInterface, text: string | undefined) {
  if (text === shownStatus) return
  $.ui.status(text)
  shownStatus = text
}

// session 結束後畫面上是什麼不確定，記錄回到「不知道」，下一個 session 的第一次同步一定送出
function clearStatus($: EngineInterface) {
  try {
    $.ui.status(undefined)
  } catch {
    // 略過
  }
  shownStatus = STATUS_UNKNOWN
}

async function shouldAnimate($: EngineInterface) {
  const { batch, isPanelPlaced } = await readPanelState($)
  return isPanelPlaced && hasRunning(batch)
}

// 每一拍先確認面板還在畫面上、而且還有子代理在跑，不是就停下：
// 使用者按 ✕ 關掉面板，或 syncTimerAndStatus 的讀取競態讓計時器在全部完成後才建立，都會在下一拍自己停下。
// 這裡不同步狀態列：按 ✕ 之後的狀態列由下一次工具呼叫補上
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
    else await syncTimerAndStatus($)
  } catch {
    // 略過
  }
}

// 送出請求就是開始思考：在請求送出前記下，不等結果
async function recordThinkingStart($: EngineInterface, agentId: string) {
  try {
    if (!(await isInBatch($, agentId))) return
    const at = await $.clock.now()
    await update($, batchAtom, batch => (batch === null ? batch : recordThinking(batch, agentId, at)))
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
    const at = await $.clock.now()
    await update($, batchAtom, batch => (batch === null ? batch : recordToolCall(batch, agentId, activity, at)))
    // 面板可能先在背景等待、終端機拉寬後才放上畫面，或被使用者按 ✕ 關掉，這些都沒有事件通知；
    // 趁工具呼叫補啟動動畫，或補上輸入框下方的狀態列
    if (timer === undefined) await syncTimerAndStatus($)
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
    await syncTimerAndStatus($)
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
    await syncTimerAndStatus($) // 熱重載時把動畫與狀態列接回來
    return started
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    clearStatus($)
    if (e.reason === 'clear') await update($, batchAtom, () => null).catch(() => {})
    return next(e)
  })

  // subagent 的執行不會發 turn.start，只有主迴圈會
  on('turn.start', async ($, e, next) => {
    currentTurnId = e.turnId
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOwnMessage(e.origin.kind, e.text)) {
      // 這一批還有子代理在跑時不關：主管模式下常會邊等子代理邊補指令，面板要留著看進度；全部完成後的下一則訊息才關。
      // 讀不到批次時照舊關閉，不擋住使用者送出的訊息
      const batch = await read($, batchAtom).catch(() => null)
      if (!hasRunning(batch)) await closePanel($)
    }
    return next(e)
  })

  on('command.run', { command: 'agents' }, async $ => {
    const panes = await $.ui.panes().catch(() => [])
    if (isPanePlaced(panes)) {
      await closePanel($)
      return { text: '已關閉子代理面板。' }
    }
    // 使用者打指令開的窗格任何寬度都放得下，也讓之後 mod 自己開時門檻降到 110 欄
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
    await syncTimerAndStatus($)
    return { text: '已開啟子代理面板。' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // 被擋下、沒有本機執行迴圈（workflow 的遠端子代理）、在其他窗格跑的 teammate：追蹤不到，不列入
    if (result.deny !== undefined || result.agentId === undefined || result.teammateId !== undefined) return result
    await recordSpawn($, {
      id: result.agentId,
      description: e.description,
      agentType: e.subagentType,
      agentName: e.name ?? null,
      isNested: e.parentAgentId !== undefined,
    })
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) await recordThinkingStart($, e.agentId)
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

  // 面板：第一列是狀態列，下面依 Running → Failed → Done 分組畫卡片，或精簡模式一個子代理一列；版面規則都在 layout.ts
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // 一列畫成一個 Text，各段顏色是裡面的 Text；放不下就截斷，折行會讓列數跟 fullRowCount 對不上
    const spanRow = (spans: Span[]) => (
      <Text wrap="truncate-end">
        {spans.map(span => (
          <Text color={span.color} dimColor={span.isDim} bold={span.isBold}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
    const barRow = (cells: string[]) => (
      <Text>
        {'  '}
        {colorRuns(cells).map(run => (
          <Text color={run.color}>{BAR_CELL.repeat(run.count)}</Text>
        ))}
      </Text>
    )
    // 畫面丟例外時 Claude Code 會卸載窗格、要再打 /agents 才回來；這裡接住，畫一行提示
    try {
      const [batch, frame] = await Promise.all([read($, batchAtom), read($, tickAtom)])
      if (batch === null) return <Text dimColor>{EMPTY_HINT}</Text>

      const columns = e.props.bodyColumns
      const now = await $.clock.now()
      const options = { columns, now, frame }
      const { running, failed, done } = splitSections(batch)
      // 放在輸入框上方時會擠掉對話的空間；完整模式要捲動才看得完時，也改成一個子代理一列
      const isCompact = e.props.placement === 'inline' || fullRowCount(batch) > e.props.scroll.bodyRows

      const groups = [
        { label: 'Running', agents: running },
        { label: 'Failed', agents: failed },
        { label: 'Done', agents: done },
      ].filter(group => group.agents.length > 0)
      const body = isCompact
        ? [...running, ...failed, ...done].map(agent => spanRow(compactLine(agent, options)))
        : groups.flatMap((group, index) => [
            // 組與組之間空一列（放一個空白字元）
            ...(index > 0 ? [<Text> </Text>] : []),
            <Text dimColor>{group.label}</Text>,
            ...group.agents.flatMap(agent => {
              const card = agentCard(agent, options)
              return [...card.lines.map(spanRow), ...(card.bar.length > 0 ? [barRow(card.bar)] : [])]
            }),
          ])

      return (
        <Box flexDirection="column">
          {spanRow(statusLine(batch, now, columns))}
          {body}
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
