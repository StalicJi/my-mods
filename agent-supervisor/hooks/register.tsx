// Agent Supervisor：監控這個 session 的子代理、回報的任務與依賴、可能的阻塞與下一步建議。
// 只用 /supervisor 手動開關面板（使用者選的，不自動跳出）；面板沒開而有代理在跑時，輸入框下方釘一行狀態
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRecord, MainLoop, SupervisorEvent, SupervisorView, TaskRecord, WaitingReports } from '../types'
import { addSpawn, adoptListed, capAgents, describeTool, finishAgent, hasLive, reconcile, recordActivity, recordToolOutcome, toolOutcomeOf } from './agents'
import type { FinishReason, ListedAgent, ToolOutcome } from './agents'
import { appendEvents, taskEvents, waitingEvents } from './events'
import { buildSnapshot, snapshotPath, snapshotSignature } from './snapshot'
import type { SnapshotIdentity } from './snapshot'
import { applyNativeTool, applyReport, parseReport, resolvePendingOwners, setWaiting } from './tasks'
import { viewRows } from './view'
import type { Span } from './view'

const PANE_ID = 'agent-supervisor'
const PANE_TITLE = 'Agent Supervisor'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 44
// 計時器每秒一拍：面板開著時更新經過時間；每 3 拍跟 Claude Code 的代理清單對帳一次（不呼叫模型）
const TICK_MS = 1000
const POLL_EVERY_TICKS = 3
const THINKING = '思考中'
const USAGE = '用法：/supervisor 開關面板；/supervisor agents、tasks、logs 直接開那一頁；/supervisor focus 把鍵盤交給面板（之後按 A、T、L、O 切頁，R 更新，Q 關閉）。'
// /supervisor 的參數對到分頁；logs 跟面板上的 L 一致
const VIEW_ARGUMENTS: Record<string, SupervisorView> = { overview: 'overview', agents: 'agents', tasks: 'tasks', logs: 'events', events: 'events' }
// 工具列：鍵盤要先把焦點交給面板才按得到；Claude Code 會在按鈕前面畫出快捷鍵（a: 代理），標籤不再寫字母；目前這一頁的按鈕不畫
const VIEW_BUTTONS: { view: SupervisorView; hotkey: string; label: string }[] = [
  { view: 'overview', hotkey: 'o', label: '總覽' },
  { view: 'agents', hotkey: 'a', label: '代理' },
  { view: 'tasks', hotkey: 't', label: '任務' },
  { view: 'events', hotkey: 'l', label: '事件' },
]
// 停靠在右邊時總覽多列最近事件；放在輸入框上方時精簡，免得把 band 擠掉
const DOCKED_LAYOUT = { maxAgents: 6, maxTasks: 6, eventCount: 3 }
const INLINE_LAYOUT = { maxAgents: 3, maxTasks: 3, eventCount: 0, compact: true }
// 回報工具：代理與主對話回報任務、依賴與在等什麼（使用者選的「最小回報工具」）
const REPORT_TOOL_NAME = 'report'
const REPORT_TOOL = 'mcp__agent-supervisor__report'
const REPORT_ACTIVITY = '回報任務'
// Claude Code 原生的任務工具；使用者開了 CLAUDE_CODE_ENABLE_TASKS 才會出現，有呼叫就一併記下
const NATIVE_TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])
// 看面板的人讀的語言；任務標題用它
const READER_LANGUAGE = 'Traditional Chinese (Taiwan usage)'
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'Tasks to create or update, matched by id. Only the fields you pass change.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short stable id, e.g. "T1".' },
          title: { type: 'string', description: `Required for a new task: a short phrase in ${READER_LANGUAGE}.` },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must finish first.' },
          owner: { type: 'string', description: 'Who does it: "main", or the subagent\'s description or name. Defaults to you.' },
        },
        required: ['id'],
      },
    },
    waitingFor: { type: 'string', description: `What you cannot continue without, in ${READER_LANGUAGE}; an empty string when you can continue again.` },
  },
}
const REPORT_TOOL_DESCRIPTION =
  'Report tasks, their dependencies and what you are waiting on to the Agent Supervisor panel the person watches. ' +
  'Report only real progress: never invent tasks or completion. ' +
  `Task titles and waitingFor are short phrases in ${READER_LANGUAGE}; keep code identifiers as they are.`
// 主對話：分派子代理時先登記計畫，面板才看得到依賴
const MAIN_INSTRUCTIONS = [
  '# Agent Supervisor',
  `When you split work across subagents, first register the plan with the ${REPORT_TOOL} tool: one task per piece of work with a short id, a title in ${READER_LANGUAGE}, the owner (the description you will give the subagent in the Agent call) and blockedBy for tasks that need another task's result.`,
  'Mark tasks completed as results come back. Skip it for a single subagent or trivial work.',
].join('\n')
// 子代理：只在有多個步驟或卡住時回報，不要每個工具呼叫都回報
const SUBAGENT_NOTE = [
  '# Agent Supervisor',
  `The person follows your progress in a supervisor panel. Use the ${REPORT_TOOL} tool only when it helps them:`,
  `- if your task has several distinct steps, report them once as tasks (short ids, titles in ${READER_LANGUAGE}) and update their status as you go;`,
  '- if you cannot continue until something else is done (another agent\'s output, a decision), report waitingFor with what you need, and blockedBy with the task id if you know it; report an empty waitingFor when you can continue.',
  'Do not report every tool call.',
].join('\n')
const IDLE_MAIN: MainLoop = { isRunning: false, activity: '', activityAt: null }
// 剛載入時不知道輸入框下方是什麼（熱重載前可能留著舊的狀態列），用它讓第一次同步一定送出
const STATUS_UNKNOWN = Symbol('status-unknown')
// 狀態改變後等這麼久才寫快照，連續的改變合併成一次寫入
const SNAPSHOT_DELAY_MS = 500
// 版本衝突時最多重試幾次，跟 claude-code 的 update 一樣
const WRITE_ATTEMPTS = 64

// 狀態由 host 保存，熱重載後仍在
const viewAtom = atom({ plugin: 'agent-supervisor', key: 'view' } as const, 'overview' as SupervisorView)
const agentsAtom = atom({ plugin: 'agent-supervisor', key: 'agents' } as const, [] as AgentRecord[])
const mainAtom = atom({ plugin: 'agent-supervisor', key: 'mainLoop' } as const, IDLE_MAIN)
const tasksAtom = atom({ plugin: 'agent-supervisor', key: 'tasks' } as const, [] as TaskRecord[])
const waitingAtom = atom({ plugin: 'agent-supervisor', key: 'waiting' } as const, {} as WaitingReports)
const eventsAtom = atom({ plugin: 'agent-supervisor', key: 'events' } as const, [] as SupervisorEvent[])
// 只有面板讀，所以每秒的更新只讓面板重畫
const tickAtom = atom({ plugin: 'agent-supervisor', key: 'tick' } as const, 0)
// 沒有變化就不寫的寫入直接用 $.state.get／set：plugin 與 key 要是字面值，host 才掃得到
const AGENTS_REF = { plugin: 'agent-supervisor', key: 'agents' } as const

// 下面是模組自己的變數，熱重載後重來
let timer: Timer | undefined
let tickCount = 0
// 上一次送給 $.ui.status 的文字；相同就不再送，每送一次輸入框下方就重畫一次
let shownStatus: string | undefined | typeof STATUS_UNKNOWN = STATUS_UNKNOWN
// 快照：排定中的寫入、上一次寫出的內容（相同就不寫）、這個 session 的身分與檔案路徑（session 開始時重取）
let snapshotTimer: Timer | undefined
let lastSnapshotSignature: string | undefined
let snapshotTarget: { identity: SnapshotIdentity; path: string } | null | undefined

// 更新代理清單；沒有變化就不寫（每次寫入都讓面板重畫），版本衝突時重讀再試
async function changeAgents($: EngineInterface, change: (agents: AgentRecord[]) => AgentRecord[]): Promise<AgentRecord[]> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(AGENTS_REF)
    const current = held.value ?? []
    const next = capAgents(change(current))
    if (next === current) return current
    if ((await $.state.set(AGENTS_REF, next, { ifVersion: held.version })).isSet) {
      markSnapshotDirty($)
      return next
    }
  }
  throw new Error('changeAgents: 每次讀到之後都被別人搶先寫入，試到上限仍沒寫進去')
}

async function isPanelOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE_ID)
}

async function togglePanel($: EngineInterface): Promise<{ text: string }> {
  if (await isPanelOpen($)) {
    await closePanel($)
    return { text: '已關閉 Agent Supervisor 面板。' }
  }
  await openPanel($, false)
  return { text: '已開啟 Agent Supervisor 面板。' }
}

// 使用者打指令開的窗格任何寬度都放得下：夠寬時停靠右邊，不然放在輸入框上方。
// focus 只是請求：輸入框有字、正在對話框裡時不會給
async function openPanel($: EngineInterface, focus: boolean): Promise<void> {
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS, ...(focus && { focus: true }) })
  await syncTimerAndStatus($)
}

async function closePanel($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE_ID }).catch(() => {})
  await syncTimerAndStatus($)
}

async function runSupervisorCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const action = args.trim().toLowerCase()
  if (action === '') return togglePanel($)
  if (action === 'focus') {
    await openPanel($, true)
    return { text: '已要求把鍵盤交給 Agent Supervisor 面板：A、T、L、O 切頁，R 更新，Q 關閉，Esc 回到輸入框。' }
  }
  const view = VIEW_ARGUMENTS[action]
  if (view === undefined) return { text: USAGE }
  await showView($, view)
  await openPanel($, false)
  return { text: '已開啟 Agent Supervisor 面板。' }
}

async function showView($: EngineInterface, view: SupervisorView): Promise<void> {
  if ((await read($, viewAtom)) !== view) await update($, viewAtom, () => view)
}

// R：立刻跟 Claude Code 的代理清單對帳並重畫
async function refreshNow($: EngineInterface): Promise<void> {
  await pollAgentList($).catch(() => {})
  await update($, tickAtom, frame => frame + 1)
  await syncTimerAndStatus($)
}

async function recordEvents($: EngineInterface, added: readonly SupervisorEvent[]): Promise<void> {
  // 任務與等待原因改變時一定伴隨事件，從這裡標記快照要更新
  markSnapshotDirty($)
  if (added.length === 0) return
  await update($, eventsAtom, events => appendEvents(events, added))
}

// 有還沒結束的代理時跑計時器、沒有就停；面板沒開時在輸入框下方釘一行狀態，開了或都結束了就清掉
async function syncTimerAndStatus($: EngineInterface): Promise<void> {
  markSnapshotDirty($)
  try {
    const [agents, isOpen] = await Promise.all([read($, agentsAtom), isPanelOpen($)])
    const liveCount = agents.filter(agent => agent.phase === 'running' || agent.phase === 'idle').length
    showStatus($, liveCount > 0 && !isOpen ? `Supervisor ●${liveCount} · /supervisor` : undefined)
    if (liveCount === 0) stopTimer()
    else if (timer === undefined) timer = $.clock.every(TICK_MS, () => void onTick($))
  } catch {
    // 略過，下一個事件或下一拍再同步
  }
}

async function onTick($: EngineInterface): Promise<void> {
  tickCount += 1
  try {
    if (tickCount % POLL_EVERY_TICKS === 0) await pollAgentList($)
    if (await isPanelOpen($)) await update($, tickAtom, frame => frame + 1)
    await syncTimerAndStatus($)
  } catch {
    // 略過這一拍
  }
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
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

async function pollAgentList($: EngineInterface): Promise<void> {
  const listed = (await $.agent.list()) as ListedAgent[]
  await changeAgents($, agents => reconcile(agents, listed))
}

// 結束事件：不認得的 agentId 先確認清單上有沒有，有才補上（Claude Code 自己的 fork 也帶 agentId，但不在清單上）
async function recordFinish($: EngineInterface, agentId: string, reason: FinishReason) {
  const endedAt = await $.clock.now()
  const known = (await read($, agentsAtom)).some(agent => agent.id === agentId)
  const listed = known ? [] : ((await $.agent.list().catch(() => [])) as ListedAgent[])
  const entry = listed.find(agent => agent.id === agentId && agent.teammateId === undefined)
  if (!known && entry === undefined) return
  const before = (await read($, agentsAtom)).find(agent => agent.id === agentId)
  const agents = await changeAgents($, current => finishAgent(entry === undefined ? current : adoptListed(current, entry), agentId, reason, endedAt))
  const after = agents.find(agent => agent.id === agentId)
  // 重複的結束事件不再記一筆
  if (after !== undefined && after.phase !== before?.phase) {
    const event: SupervisorEvent =
      after.phase === 'completed'
        ? { at: endedAt, agentId, kind: 'complete', text: '完成' }
        : { at: endedAt, agentId, kind: 'fail', text: `失敗：${after.failureReason ?? '失敗'}` }
    await recordEvents($, [event])
  }
  // 結束了就不再等什麼，免得留著舊的等待被當成阻塞
  await update($, waitingAtom, waiting => setWaiting(waiting, agentId, '', endedAt))
  await syncTimerAndStatus($)
}

async function recordAgentActivity($: EngineInterface, agentId: string, activity: string, isToolCall: boolean) {
  const at = await $.clock.now()
  await changeAgents($, agents => recordActivity(agents, agentId, { activity, at, isToolCall }))
}

async function recordMainActivity($: EngineInterface, activity: string) {
  const at = await $.clock.now()
  await update($, mainAtom, main => ({ ...main, activity, activityAt: at }))
  markSnapshotDirty($)
}

// MARK: 快照（給外部 App 讀，見 snapshot.ts）

function markSnapshotDirty($: EngineInterface) {
  if (snapshotTimer !== undefined) return
  snapshotTimer = $.clock.after(SNAPSHOT_DELAY_MS, () => {
    snapshotTimer = undefined
    void writeSnapshot($)
  })
}

// session 的身分只取一次：id、目錄、HOME，以及 Claude Code 的 pid（shell 的父程序就是 Claude Code）
async function resolveSnapshotTarget($: EngineInterface): Promise<{ identity: SnapshotIdentity; path: string } | null> {
  if (snapshotTarget !== undefined) return snapshotTarget
  const [sessionId, cwd, home] = await Promise.all([$.session.id(), $.session.cwd(), $.env.get('HOME')])
  const path = home === undefined ? null : snapshotPath(home, sessionId)
  if (path === null) {
    snapshotTarget = null
    return null
  }
  let pid: number | null = null
  try {
    const parent = Number.parseInt((await $.process.run(['/bin/sh', '-c', 'echo $PPID'], { timeoutMs: 5_000 })).stdout.trim(), 10)
    if (Number.isInteger(parent) && parent > 1) pid = parent
  } catch {
    // 取不到 pid 時外部 App 改用目錄比對
  }
  snapshotTarget = { identity: { sessionId, pid, cwd }, path }
  return snapshotTarget
}

// ended：session 結束時一定要寫（內容沒變也寫），讓外部 App 知道這份快照不會再更新
async function writeSnapshot($: EngineInterface, ended = false): Promise<void> {
  try {
    const target = await resolveSnapshotTarget($)
    if (target === null) return
    const [agents, mainLoop, tasks, waiting, events, now] = await Promise.all([
      read($, agentsAtom), read($, mainAtom), read($, tasksAtom), read($, waitingAtom), read($, eventsAtom), $.clock.now(),
    ])
    const snapshot = buildSnapshot({ agents, mainLoop, tasks, waiting, events }, target.identity, now, ended)
    const signature = snapshotSignature(snapshot)
    if (!ended && signature === lastSnapshotSignature) return
    await $.fs.write(target.path, JSON.stringify(snapshot))
    lastSnapshotSignature = signature
  } catch {
    // 寫不進去就略過，下一次狀態改變再試；面板不受影響
  }
}

// 工具結果：累計連續失敗；失敗或被拒絕的記一筆事件，成功的不記（太多）
async function recordToolResult($: EngineInterface, agentId: string, toolName: string, outcome: ToolOutcome): Promise<void> {
  await changeAgents($, agents => recordToolOutcome(agents, agentId, outcome))
  if (outcome.outcome === 'ok') return
  const at = await $.clock.now()
  const text = `${outcome.outcome === 'denied' ? '工具被拒絕' : '工具失敗'}：${outcome.errorLine ?? toolName}`
  await recordEvents($, [{ at, agentId, kind: 'tool-error', text }])
}

function activityOf(tool: string, input: unknown): string {
  if (tool === 'SubagentHandback') return '交回報告'
  if (tool === REPORT_TOOL) return REPORT_ACTIVITY
  return describeTool(tool, input)
}

// 回報工具：檢查格式、更新任務與等待原因，回覆用繁體中文。自己回答、不呼叫 next，這個工具沒有實際執行的東西
async function answerReport($: EngineInterface, input: unknown, reporter: string): Promise<{ result: string } | { deny: string }> {
  const parsed = parseReport(input)
  if ('error' in parsed) return { deny: parsed.error }
  const { report } = parsed
  const [agents, at] = await Promise.all([read($, agentsAtom), $.clock.now()])
  const context = { reporter, agents, at }
  const added: SupervisorEvent[] = []
  if (report.tasks.length > 0) {
    const checked = applyReport(await read($, tasksAtom), report, context)
    if ('error' in checked) return { deny: checked.error }
    // 再套用一次：讀到之後若有別人寫入，update 會重讀再算；事件取最後真正寫入的那次
    let changes: SupervisorEvent[] = []
    await update($, tasksAtom, tasks => {
      const applied = applyReport(tasks, report, context)
      if ('error' in applied) return tasks
      changes = taskEvents(tasks, applied.tasks, at)
      return applied.tasks
    })
    added.push(...changes)
  }
  if (report.waitingFor !== null) {
    const waitingFor = report.waitingFor
    let changes: SupervisorEvent[] = []
    await update($, waitingAtom, waiting => {
      const next = setWaiting(waiting, reporter, waitingFor, at)
      changes = waitingEvents(waiting, next, at)
      return next
    })
    added.push(...changes)
  }
  await recordEvents($, added)
  return { result: reportReply(report.tasks.length, report.waitingFor !== null) }
}

function reportReply(taskCount: number, hasWaiting: boolean): string {
  if (taskCount > 0 && hasWaiting) return `已記錄 ${taskCount} 項任務與等待原因。`
  if (taskCount > 0) return `已記錄 ${taskCount} 項任務。`
  return '已記錄等待原因。'
}

// 原生任務工具的結果：被拒絕的不記；工具本身的輸出在 tool.call 結果的 result 欄位
async function recordNativeTask($: EngineInterface, tool: string, input: unknown, result: unknown, reporter: string) {
  const answered = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; result?: unknown }
  if (answered.deny !== undefined) return
  const [agents, at] = await Promise.all([read($, agentsAtom), $.clock.now()])
  let changes: SupervisorEvent[] = []
  await update($, tasksAtom, tasks => {
    const next = applyNativeTool(tasks, { tool, input, result: answered.result }, { reporter, agents, at })
    changes = taskEvents(tasks, next, at)
    return next
  })
  await recordEvents($, changes)
}

function withSubagentNote(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${SUBAGENT_NOTE}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 新的 session（含 /clear 之後）重新取身分，快照寫到新的檔案
    snapshotTarget = undefined
    lastSnapshotSignature = undefined
    // 名稱已被佔用時會被拒絕，不影響其他功能
    // immediate：主對話還在工作時打 /supervisor 也立刻執行；處理時只開關窗格、讀 state，不依賴這一輪的狀態
    await $.command
      .register({ name: 'supervisor', description: '開關 Agent Supervisor 面板：子代理、任務、阻塞與建議', argumentHint: '[agents|tasks|logs|focus]', immediate: true })
      .catch(() => {})
    // 不放在 ToolSearch 後面：子代理不用先搜尋就能回報
    await $.tool.register({ name: REPORT_TOOL_NAME, description: REPORT_TOOL_DESCRIPTION, inputSchema: REPORT_SCHEMA, isDeferred: false }).catch(() => {})
    // 熱重載或開 session 前就在跑的代理從清單補上，計時器與狀態列也接回來
    await pollAgentList($).catch(() => {})
    await syncTimerAndStatus($)
    return started
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    clearStatus($)
    snapshotTimer?.cancel()
    snapshotTimer = undefined
    await writeSnapshot($, true)
    if (e.reason === 'clear') {
      await update($, agentsAtom, () => []).catch(() => {})
      await update($, mainAtom, () => IDLE_MAIN).catch(() => {})
      await update($, tasksAtom, () => []).catch(() => {})
      await update($, waitingAtom, () => ({})).catch(() => {})
      await update($, eventsAtom, () => []).catch(() => {})
    }
    return next(e)
  })

  on('command.run', { command: 'supervisor' }, async ($, e) => runSupervisorCommand($, e.args))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(REPORT_TOOL)) return composed
    return { sections: [...composed.sections, { id: 'agent-supervisor:report', text: MAIN_INSTRUCTIONS, scope: 'session' }] }
  })

  // subagent 的執行不會發 turn.start，只有主對話會
  on('turn.start', async ($, e, next) => {
    await update($, mainAtom, () => ({ isRunning: true, activity: '', activityAt: null })).catch(() => {})
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // workflow 的代理照原樣：它們有自己的輸出格式
    const result = await next(e.workflow ? e : { ...e, prompt: withSubagentNote(e.prompt) })
    // 被擋下、沒有本機執行迴圈（workflow 的遠端子代理）、在其他窗格跑的 teammate：追蹤不到，不列入
    if (result.deny !== undefined || result.agentId === undefined || result.teammateId !== undefined) return result
    try {
      const startedAt = await $.clock.now()
      const facts = {
        id: result.agentId,
        name: e.name ?? null,
        agentType: e.subagentType,
        description: e.description,
        parentId: e.parentAgentId ?? null,
        startedAt,
      }
      const isNew = !(await read($, agentsAtom)).some(agent => agent.id === facts.id)
      const agents = await changeAgents($, current => addSpawn(current, facts))
      // 派出前就登記的計畫，負責人寫的是名字或任務說明，現在對得到這個代理了
      await update($, tasksAtom, tasks => resolvePendingOwners(tasks, agents))
      if (isNew) await recordEvents($, [{ at: startedAt, agentId: facts.id, kind: 'spawn', text: '開始' }])
      await syncTimerAndStatus($)
    } catch {
      // 只觀察：出錯就略過，不影響子代理本身
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    try {
      if (e.agentId !== undefined) await recordAgentActivity($, e.agentId, THINKING, false)
      else await recordMainActivity($, THINKING)
    } catch {
      // 略過
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const reporter = agentId ?? 'main'
    // 回報工具不在內建工具的型別清單裡，當成一般字串比較
    const toolName: string = e.tool
    try {
      const activity = activityOf(toolName, e)
      if (agentId !== undefined) await recordAgentActivity($, agentId, activity, true)
      else await recordMainActivity($, activity)
    } catch {
      // 略過
    }
    if (toolName === REPORT_TOOL) return answerReport($, e, reporter)
    if (agentId === undefined) {
      const result = await next(e)
      if (NATIVE_TASK_TOOLS.has(toolName)) await recordNativeTask($, toolName, e, result, reporter).catch(() => {})
      return result
    }
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (error) {
      // 工具執行時拋例外：記成失敗後照樣往外丟
      const message = error instanceof Error ? error.message : String(error)
      await recordToolResult($, agentId, toolName, { outcome: 'error', errorLine: message }).catch(() => {})
      throw error
    }
    await recordToolResult($, agentId, toolName, toolOutcomeOf(result)).catch(() => {})
    if (NATIVE_TASK_TOOLS.has(toolName)) await recordNativeTask($, toolName, e, result, reporter).catch(() => {})
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId !== undefined) await recordFinish($, e.agentId, e.reason)
      else await update($, mainAtom, main => ({ ...main, isRunning: false }))
    } catch {
      // 略過
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // 一列畫成一個 Text，各段顏色是裡面的 Text；放不下就截斷，不折行
    const spanRow = (spans: Span[]) => (
      <Text wrap="truncate-end">
        {spans.map(span => (
          <Text color={span.color} dimColor={span.isDim} bold={span.isBold}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
    // 畫面丟例外時 Claude Code 會卸載窗格、要再打 /supervisor 才回來；這裡接住，畫一行提示
    try {
      const [agents, mainLoop, tasks, waiting, events, view] = await Promise.all([
        read($, agentsAtom),
        read($, mainAtom),
        read($, tasksAtom),
        read($, waitingAtom),
        read($, eventsAtom),
        read($, viewAtom),
        read($, tickAtom),
      ])
      const layout = e.props.placement === 'inline' ? INLINE_LAYOUT : DOCKED_LAYOUT
      const rows = viewRows(view, { agents, mainLoop, tasks, waiting, events }, { ...layout, columns: e.props.bodyColumns, now: await $.clock.now() })
      // 工具列：每個按鈕一個字母快捷鍵（面板拿到鍵盤時才按得到）；目前這一頁的不畫
      const toolbar = (
        <Box flexDirection="row" columnGap={1}>
          {VIEW_BUTTONS.filter(button => button.view !== view).map(button => (
            <Button key={`view-${button.view}`} hotkey={button.hotkey} plain label={button.label} onPress={() => showView($, button.view)} />
          ))}
          <Button key="refresh" hotkey="r" plain label="更新" onPress={() => refreshNow($)} />
          <Button key="close" hotkey="q" plain label="關閉" onPress={() => closePanel($)} />
        </Box>
      )
      return (
        <Box flexDirection="column">
          {toolbar}
          {rows.map(spanRow)}
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
