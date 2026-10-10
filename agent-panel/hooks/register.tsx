// Agent Panel：派出子代理時跳出面板，顯示這一回合每個子代理在做什麼、模型、用量與時間；
// 面板沒放上畫面時在輸入框下方釘一行狀態列；/agents 開關
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput, UiScrollArgs } from 'claude-code'

import type { AgentRow, Batch, Logs, TokenUsage } from '../types'
import { addAgent, finishAgent, hasRunning, recordReported, recordStep, recordThinking, recordToolCall, seedRunning } from './batch'
import { BACK_LABEL, detailLayout } from './detail'
import { addAnswer, addReport, addToolStart, agentLog, finishTool, forgetAgents, markUnfinished, toolEndOf } from './log'
import {
  MASCOT_GAP,
  agentCard,
  agentMascot,
  colorRuns,
  compactLine,
  describeTool,
  displayWidth,
  fullRowCount,
  groupEntries,
  mascotLayout,
  splitSections,
  statusLine,
  statusText,
} from './layout'
import type { MascotKind, MascotPicture, Span } from './layout'

const PANE_ID = 'agent-panel'
// 詳細頁最新一筆的第一列；點開時捲到這裡
const NEWEST_KEY = 'newest'
// 寫入 selected 後詳細頁要等下一次重畫才出現：最新一筆還沒畫出來時捲動會被拒絕，每 50 毫秒再試，最多 5 次
const SCROLL_RETRY_MS = 50
const SCROLL_ATTEMPTS = 5
const PANE_TITLE = 'Agents'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 42
const NARROW_HINT = '子代理面板放不下：打 /agents 開啟'
const AGENTS_USAGE = '用法：/agents 開關子代理面板；/agents focus 把鍵盤交給面板。'
// 焦點只是請求（輸入框有字、正在對話框裡就不給），$.ui.open 也不回報有沒有給，所以說「要求」
const FOCUS_REPLY = '已要求把鍵盤交給子代理面板：Tab 移動、Enter 按下、Esc 回到輸入框。'
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
// 詳細頁的紀錄；清單不讀它，新增紀錄不會讓清單重畫
const logsAtom = atom({ plugin: 'agent-panel', key: 'logs' } as const, null as Logs | null)
// 目前打開詳細頁的 agentId
const selectedAtom = atom({ plugin: 'agent-panel', key: 'selected' } as const, null as string | null)

// 子代理交回報告用的工具；報告文字在參數 message
const HANDBACK_TOOL = 'SubagentHandback'
// 找報告文字時略過的 tool.call 欄位（不是工具參數）
const CALL_FIELDS = new Set(['tool', 'agentId', 'tool_use_id', 'consent'])

// 下面幾個是模組自己的變數，熱重載後重來
// 目前主回合的 turnId；歸零時沿用現有批次
let currentTurnId: string | null = null
// 窗格放不下的提示每個 session 最多一次
let hasWarnedNarrow = false
let timer: Timer | undefined
// 上一次送給 $.ui.status 的文字；相同就不再送，每送一次輸入框下方就重畫一次
let shownStatus: string | undefined | typeof STATUS_UNKNOWN = STATUS_UNKNOWN
// 有沒有設 CLAUDE_CODE_FORCE_TERMINAL_IMAGES：session.start 讀一次（熱重載也會重跑），不在每次重畫時讀；還沒讀到之前當成沒設
let forcesTerminalImages = false
// 工具呼叫沒有 tool_use_id 時，用它產生紀錄 id
let toolSequence = 0

type SpawnFacts = { id: string; description: string; agentType: string; agentName: string | null; isNested: boolean }
type FinishReason = 'answer' | 'aborted' | 'error' | 'refusal'
// 一次工具呼叫的摘要與開始時間：卡片和詳細頁的紀錄共用同一份
type ToolStart = { summary: string; at: number }

// mod 自己開的窗格要終端機夠寬才放得下（使用者親手開過後門檻較低）；放不下時窗格在背景等，提示一次怎麼開
export async function openPanel($: EngineInterface): Promise<void> {
  // 每次打開面板都從清單開始
  await showList($)
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

// 更新函式回傳原物件代表沒有變化：先用目前的值算一次，沒變就不寫，免得面板白白重畫；
// 有變才交給 update，讀完到寫入之間被改過的話它會用最新的值重算。
// atom 只能直接放在 read／update 的第一個參數（host 靠它掃出讀寫哪些 state），所以 logs 與 batch 各一個
async function updateLogsIfChanged($: EngineInterface, change: (logs: Logs | null) => Logs | null) {
  const current = await read($, logsAtom)
  if (change(current) === current) return
  await update($, logsAtom, change)
}

async function updateBatchIfChanged($: EngineInterface, change: (batch: Batch | null) => Batch | null) {
  const current = await read($, batchAtom)
  if (change(current) === current) return
  await update($, batchAtom, change)
}

// 下面的記錄都只觀察：出錯就略過這次，不影響子代理本身
async function recordSpawn($: EngineInterface, spawn: SpawnFacts) {
  try {
    const startedAt = await $.clock.now()
    // 開了新的一批才跳出面板；同一批再派不重開，使用者手動關掉後也不會一直彈回來。
    // 在更新函式裡判斷：平行派出時 update 會在版本衝突後重試，最後一次看到的才是真正寫入當下的批次
    let isNewBatch = false
    // 換批次時沒被帶過去（已結束）的子代理；它們的詳細頁紀錄跟著刪掉，被帶過去的保留
    let leftBehind: string[] = []
    await update($, batchAtom, batch => {
      const next = addAgent(batch, currentTurnId, { ...spawn, startedAt })
      isNewBatch = batch === null || batch.turnId !== next.turnId
      const kept = new Set(next.agents.map(agent => agent.id))
      leftBehind = isNewBatch && batch !== null ? batch.agents.filter(agent => !kept.has(agent.id)).map(agent => agent.id) : []
      return next
    })
    if (leftBehind.length > 0) {
      const forgotten = leftBehind
      await updateLogsIfChanged($, logs => forgetAgents(logs, forgotten)).catch(() => {})
    }
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

// 卡片顯示子代理目前在做什麼。回傳這次的摘要與時間，詳細頁的紀錄直接沿用，不再讀一次批次、算一次摘要；
// 不在這一批（Claude Code 的內部 fork）或記錄失敗時回傳 null，詳細頁也不記
async function recordTool($: EngineInterface, agentId: string, call: ToolCallInput): Promise<ToolStart | null> {
  try {
    if (!(await isInBatch($, agentId))) return null
    const start: ToolStart = { summary: describeTool(call.tool, call), at: await $.clock.now() }
    await update($, batchAtom, batch => (batch === null ? batch : recordToolCall(batch, agentId, start.summary, start.at)))
    // 面板可能先在背景等待、終端機拉寬後才放上畫面，或被使用者按 ✕ 關掉，這些都沒有事件通知；
    // 趁工具呼叫補啟動動畫，或補上輸入框下方的狀態列
    if (timer === undefined) await syncTimerAndStatus($)
    return start
  } catch {
    return null
  }
}

// 前景子代理完成時，主迴圈 Agent 工具的結果帶有 Claude Code 自己算的總計
async function recordAgentResult($: EngineInterface, record: unknown) {
  if (typeof record !== 'object' || record === null) return
  const reported = record as { agentId?: unknown; totalTokens?: unknown; totalToolUseCount?: unknown }
  if (typeof reported.agentId !== 'string') return
  const agentId = reported.agentId
  try {
    // 不在這一批、或結果沒有總計（背景子代理）時 recordReported 回傳原物件，就不寫
    await updateBatchIfChanged($, batch => (batch === null ? batch : recordReported(batch, agentId, reported)))
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

// 詳細頁的紀錄：只記這一批裡的子代理（Claude Code 的內部 fork 也帶 agentId，但不在這一批）。
// 用在可能沒有變化的更新：子代理結束時常常沒有執行中的工具、最後的回覆常跟已交回的報告相同
async function updateLog($: EngineInterface, agentId: string, change: (logs: Logs | null) => Logs | null) {
  if (!(await isInBatch($, agentId))) return
  await updateLogsIfChanged($, change)
}

// 下面三個只在 recordTool 確認過子代理在這一批之後呼叫，所以不再讀批次。
// 執行中的子代理換批次時會被帶到新的一批，紀錄不會在工具跑到一半時被刪掉

// 工具開始時加一筆執行中的紀錄；回傳紀錄 id，結果回來時用它找回同一筆
async function recordToolStart($: EngineInterface, agentId: string, call: ToolCallInput, start: ToolStart): Promise<string | null> {
  try {
    const id = call.tool_use_id ?? `${agentId}-${++toolSequence}`
    await update($, logsAtom, logs => addToolStart(logs, agentId, { id, ...start }))
    return id
  } catch {
    return null
  }
}

// 結果回來時那一筆幾乎一定還在（只有工具執行期間又多出 100 筆、或被 /clear 清掉才找不到），所以不先讀 logs 確認有沒有變
async function recordToolEnd($: EngineInterface, agentId: string, toolId: string, result: unknown) {
  try {
    await update($, logsAtom, logs => finishTool(logs, agentId, toolId, toolEndOf(result)))
  } catch {
    // 略過
  }
}

async function recordReport($: EngineInterface, agentId: string, report: { at: number; text: string }) {
  try {
    await update($, logsAtom, logs => addReport(logs, agentId, report))
  } catch {
    // 略過
  }
}

// answer.at 是這一步開始的時間：工具可能在回應串流時就先執行，訊息要排在它們前面
async function recordAnswer($: EngineInterface, agentId: string, answer: { at: number; text: string; isFinal: boolean }) {
  try {
    await updateLog($, agentId, logs => addAnswer(logs, agentId, answer))
  } catch {
    // 略過
  }
}

// 子代理結束時結果還沒回來的工具（中斷、失敗、熱重載）不會再更新，標成未完成
async function recordUnfinished($: EngineInterface, agentId: string) {
  try {
    await updateLog($, agentId, logs => markUnfinished(logs, agentId))
  } catch {
    // 略過
  }
}

// /agents focus：ctrl+x tab 遇到輸入框上方有按鈕（例如 next-steps）時會先聚焦那一排，這裡直接把鍵盤交給面板。
// 面板關著時跟 /agents 一樣從清單開始；開著時保留目前的畫面（例如詳細頁），只要求焦點
async function focusPanel($: EngineInterface): Promise<{ text: string }> {
  const panes = await $.ui.panes().catch(() => [])
  if (!isPanePlaced(panes)) await showList($)
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS, focus: true })
  await syncTimerAndStatus($)
  return { text: FOCUS_REPLY }
}

// 回到清單。update 就算拿回同一個值也會寫一次、讓面板重畫，所以已經是清單就不寫
export async function showList($: EngineInterface): Promise<void> {
  try {
    if ((await read($, selectedAtom)) === null) return
    await update($, selectedAtom, () => null)
  } catch {
    // 略過
  }
}

// 打開某個子代理的詳細頁並捲到最新一筆；捲動失敗（例如被拒絕）也照樣切換
export async function selectAgent($: EngineInterface, agentId: string): Promise<void> {
  try {
    await update($, selectedAtom, () => agentId)
    await scrollToNewest({ scroll: args => $.ui.scroll(args), sleep: ms => $.clock.sleep(ms) })
  } catch {
    // 略過
  }
}

// 捲動與等待從外面傳進來，重試的規則才能單獨測試（測試的 $ 沒有 clock）
export type ScrollPort = { scroll: (args: UiScrollArgs) => Promise<{ deny?: string }>; sleep: (ms: number) => Promise<void> }

// 把最新一筆捲到面板頂端：執行中的看得到最新進度，回報從標題開始讀。
// 被拒絕或拋錯都重試：不確定詳細頁還沒畫出來時 host 回的是哪一種
export async function scrollToNewest(port: ScrollPort): Promise<void> {
  for (let attempt = 0; attempt < SCROLL_ATTEMPTS; attempt++) {
    const result = await port.scroll({ in: PANE_ID, to: { key: NEWEST_KEY }, block: 'start' }).catch(() => ({ deny: '捲動失敗' }))
    if (result.deny === undefined) return
    await port.sleep(SCROLL_RETRY_MS)
  }
}

// 報告文字在 message；欄位名稱改了時退回取第一個字串參數，不讓回報整個消失
function handbackText(call: ToolCallInput): string | null {
  const fields = call as unknown as Record<string, unknown>
  if (typeof fields.message === 'string') return fields.message
  for (const [key, value] of Object.entries(fields)) {
    if (!CALL_FIELDS.has(key) && typeof value === 'string') return value
  }
  return null
}

// 小人畫圖片版要終端機開了圖片，但 mod 問不到終端機最後有沒有開：Claude Code 認不出 cmux，背景 session 也預設不開，
// 使用者只在 cmux 裡設這個變數強制開啟，所以跟著它走。跟 Claude Code 的判斷一致，非空就算開；讀不到當成沒設
async function readForcesTerminalImages($: EngineInterface): Promise<boolean> {
  try {
    const value = await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
    return value !== undefined && value !== ''
  } catch {
    return false
  }
}

// 熱重載或面板開啟前就在跑的子代理：從 $.agent.list() 補上
async function seedFromAgentList($: EngineInterface) {
  try {
    const listed = await $.agent.list()
    const now = await $.clock.now()
    // 每次啟動（含熱重載）都會跑：大多沒有要補的，seedRunning 回傳原物件就不寫
    await updateBatchIfChanged($, batch => seedRunning(batch, listed, now))
  } catch {
    // 略過
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    forcesTerminalImages = await readForcesTerminalImages($)
    // 名稱已被佔用時會被拒絕，不影響其他功能
    // immediate：主代理還在工作時打 /agents 也立刻執行，不用等這一輪結束；處理時只開關窗格、讀 state，不依賴這一輪的狀態
    await $.command
      .register({ name: 'agents', description: '開關子代理面板；/agents focus 把鍵盤交給面板', argumentHint: '[focus]', immediate: true })
      .catch(() => {})
    // 快捷鍵的 command: 綁定不能帶參數，所以另外給一個不帶參數的版本，例如 keybindings.json 的 "ctrl+x a": "command:agents-focus"
    await $.command.register({ name: 'agents-focus', description: '把鍵盤交給子代理面板（同 /agents focus）', immediate: true }).catch(() => {})
    await seedFromAgentList($)
    await syncTimerAndStatus($) // 熱重載時把動畫與狀態列接回來
    return started
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    clearStatus($)
    if (e.reason === 'clear') {
      await updateBatchIfChanged($, () => null).catch(() => {})
      await updateLogsIfChanged($, () => null).catch(() => {})
      await showList($)
    }
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

  on('command.run', { command: 'agents-focus' }, async $ => focusPanel($))

  on('command.run', { command: 'agents' }, async ($, e) => {
    const action = e.args.trim().toLowerCase()
    if (action === 'focus') return focusPanel($)
    if (action !== '') return { text: AGENTS_USAGE }
    const panes = await $.ui.panes().catch(() => [])
    if (isPanePlaced(panes)) {
      await closePanel($)
      return { text: '已關閉子代理面板。' }
    }
    // 每次打開面板都從清單開始
    await showList($)
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
    const stepStartedAt = e.agentId !== undefined ? await $.clock.now().catch(() => 0) : 0
    if (e.agentId !== undefined) await recordThinkingStart($, e.agentId)
    const result = yield* next(e)
    if (e.agentId !== undefined) {
      await recordStepUsage($, e.agentId, { model: e.model, effort: e.effort, usage: result.usage })
      // 沒有要求工具、正常結束的那一步是直接回覆的最後答案
      const isFinal = result.toolUses.length === 0 && result.stopReason === 'end_turn'
      if (result.answer.trim() !== '') await recordAnswer($, e.agentId, { at: stepStartedAt, text: result.answer, isFinal })
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const start = await recordTool($, e.agentId, e)
      // 交回報告：記成回報，不另外記成一筆工具。這個工具不在型別的內建工具清單裡，所以當成一般字串比較
      const toolName: string = e.tool
      if (toolName === HANDBACK_TOOL) {
        const text = handbackText(e)
        if (start !== null && text !== null) await recordReport($, e.agentId, { at: start.at, text })
        return next(e)
      }
      const toolId = start === null ? null : await recordToolStart($, e.agentId, e, start)
      let result: Awaited<ReturnType<typeof next>>
      try {
        result = await next(e)
      } catch (error) {
        // 工具執行時拋例外：不記結束的話這一筆會一直停在執行中，直到子代理結束。記成出錯後照樣往外丟
        const message = error instanceof Error ? error.message : String(error)
        if (toolId !== null) await recordToolEnd($, e.agentId, toolId, { isError: true, text: message })
        throw error
      }
      if (toolId !== null) await recordToolEnd($, e.agentId, toolId, result)
      return result
    }
    if (e.tool !== 'Agent') return next(e)
    const result = await next(e)
    await recordAgentResult($, (result as { result?: unknown }).result)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await recordFinish($, e.agentId, e.reason)
      await recordUnfinished($, e.agentId)
    }
    return next(e)
  })

  // 面板：第一列是狀態列，下面依 Running → Failed → Done 分組畫卡片，或精簡模式一個子代理一列；版面規則都在 layout.ts。
  // 停靠在右邊時標題列可以點，點了切到那個子代理的詳細頁（紀錄區的組版在 detail.ts）
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Raster、Image 只有終端機畫得出來：其他介面的 resolve 照樣給，但畫成空的 fragment，所以看 surface，不畫小人、寬度留給文字
    const Raster = e.surface === 'terminal' && 'Raster' in elements ? elements.Raster : undefined
    const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : undefined
    // 開了圖片就畫細像素的圖片版，不然畫方塊版
    const mascotKind: MascotKind | null = forcesTerminalImages && Image !== undefined ? 'image' : Raster !== undefined ? 'raster' : null
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
    // 空一列放一個空白字元：跟其他列一樣是一個 Text，不用 margin，列數才跟 fullRowCount 對得上
    const blankRow = () => <Text> </Text>
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
      const [batch, frame, selected] = await Promise.all([read($, batchAtom), read($, tickAtom), read($, selectedAtom)])
      if (batch === null) return <Text dimColor>{EMPTY_HINT}</Text>

      // 只有停靠時能點、能看詳細頁；放在輸入框上方時照舊畫清單，selected 留著，回到停靠時繼續顯示
      const isDocked = e.props.placement === 'dock'
      const selectedAgent = isDocked && selected !== null ? batch.agents.find(agent => agent.id === selected) : undefined
      const openable = (agentId: string, row: JSX.Element) =>
        isDocked ? (
          <Button key={`open-${agentId}`} plain onPress={() => selectAgent($, agentId)}>
            {row}
          </Button>
        ) : (
          row
        )

      const columns = e.props.bodyColumns
      const now = await $.clock.now()
      const options = { columns, now, frame }
      const { running, failed, done } = splitSections(batch)
      // 小人只畫在完整模式（精簡模式不用 cardView），而且面板要夠寬、拿得到 Image 或 Raster；不畫時卡片照舊用整個寬度。
      // 畫小人時卡片之間可能多空幾列，fullRowCount 與 groupEntries 都照實際畫的小人種類算
      const layout = mascotLayout(columns, mascotKind)
      // 放在輸入框上方時會擠掉對話的空間；完整模式要捲動才看得完時，也改成一個子代理一列
      const isCompact = e.props.placement === 'inline' || fullRowCount(batch, layout) > e.props.scroll.bodyRows
      const cardOptions = { ...options, columns: layout.textColumns }
      // canOpen：標題列要不要包成按鈕（清單要、詳細頁裡那張卡片不要）
      const cardRows = (agent: AgentRow, canOpen: boolean) => {
        const card = agentCard(agent, cardOptions)
        const lines = card.lines.map((line, index) => (index === 0 && canOpen ? openable(agent.id, spanRow(line)) : spanRow(line)))
        return [...lines, ...(card.bar.length > 0 ? [barRow(card.bar)] : [])]
      }
      // 種類是照拿得到的元件選的，這裡判斷 undefined 只為了讓型別收窄
      const mascotView = (agentId: string, mascot: MascotPicture) => {
        const key = `mascot-${agentId}`
        if (mascot.kind === 'image') {
          return Image && <Image key={key} source={mascot.source} columns={mascot.columns} rows={mascot.rows} alt=" " />
        }
        return Raster && <Raster key={key} columns={mascot.columns} rows={mascot.rows} cells={mascot.cells} />
      }
      // 小人在左、隔一欄接卡片；小人不比卡片高（見 agentMascot），畫面列數仍跟 fullRowCount 一致
      const cardView = (agent: AgentRow, canOpen: boolean) => {
        if (layout.mascot === null) return cardRows(agent, canOpen)
        const mascot = agentMascot(agent, { now, frame, kind: layout.mascot })
        return [
          <Box flexDirection="row" columnGap={MASCOT_GAP}>
            {mascotView(agent.id, mascot)}
            <Box flexDirection="column">{cardRows(agent, canOpen)}</Box>
          </Box>,
        ]
      }

      // 詳細頁：返回列（右邊淡色的整批狀態）、那個子代理的卡片、分隔線、紀錄。只有這裡讀 logs，清單不會因新增紀錄重畫
      if (selectedAgent !== undefined) {
        const logs = await read($, logsAtom)
        const detail = detailLayout(agentLog(logs, selectedAgent.id), { columns, now, startedAt: selectedAgent.startedAt })
        const header = statusLine(batch, now, columns - displayWidth(BACK_LABEL) - 1).map(span => ({ ...span, isDim: true }))
        // 返回列、卡片（文字列＋進度條；小人不比卡片高）、分隔線、紀錄。超過面板可見列數時最上面的返回會被捲出去，
        // 才在最下面再放一個；一頁放得下時兩個返回會同時出現，看起來重複
        const card = agentCard(selectedAgent, cardOptions)
        const contentRows = 1 + card.lines.length + (card.bar.length > 0 ? 1 : 0) + 1 + detail.rows.length
        const bottomBack =
          contentRows > e.props.scroll.bodyRows
            ? [blankRow(), <Button key="back-bottom" plain label={BACK_LABEL} onPress={() => showList($)} />]
            : []
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Button key="back" plain label={BACK_LABEL} onPress={() => showList($)} />
              {spanRow(header)}
            </Box>
            {cardView(selectedAgent, false)}
            {spanRow([{ text: '─'.repeat(columns), isDim: true }])}
            {/* 最新一筆的第一列包在有 key 的 Box 裡（Text 沒有 key），點開時捲到這裡 */}
            {detail.rows.map((spans, index) =>
              index === detail.newestRow ? (
                <Box key={NEWEST_KEY} flexDirection="column">
                  {spanRow(spans)}
                </Box>
              ) : (
                spanRow(spans)
              ),
            )}
            {bottomBack}
          </Box>
        )
      }

      const groups = [
        { label: 'Running', agents: running },
        { label: 'Failed', agents: failed },
        { label: 'Done', agents: done },
      ].filter(group => group.agents.length > 0)
      const body = isCompact
        ? [...running, ...failed, ...done].map(agent => openable(agent.id, spanRow(compactLine(agent, options))))
        : groups.flatMap((group, index) => [
            // 組與組之間空一列
            ...(index > 0 ? [blankRow()] : []),
            <Text dimColor>{group.label}</Text>,
            // 同組卡片之間要不要空一列（小人跟卡片一樣高時）由 groupEntries 決定，fullRowCount 也照它算
            ...groupEntries(group.agents, layout).flatMap(entry => (entry.kind === 'blank' ? [blankRow()] : cardView(entry.agent, true))),
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
