// Agent Supervisor：監控這個 session 的子代理、回報的任務與依賴、可能的阻塞與下一步建議。
// 只用 /supervisor 手動開關面板（使用者選的，不自動跳出）；面板沒開而有代理在跑時，輸入框下方釘一行狀態
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRecord, MainLoop, SupervisorView, TaskRecord, WaitingReports } from '../types'
import { addSpawn, adoptListed, capAgents, describeTool, finishAgent, hasLive, reconcile, recordActivity, recordToolOutcome, toolOutcomeOf } from './agents'
import type { FinishReason, ListedAgent } from './agents'
import { applyNativeTool, applyReport, parseReport, setWaiting } from './tasks'
import { overviewRows } from './view'
import type { Span } from './view'

const PANE_ID = 'agent-supervisor'
const PANE_TITLE = 'Agent Supervisor'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 44
// 計時器每秒一拍：面板開著時更新經過時間；每 3 拍跟 Claude Code 的代理清單對帳一次（不呼叫模型）
const TICK_MS = 1000
const POLL_EVERY_TICKS = 3
const THINKING = '思考中'
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
// 版本衝突時最多重試幾次，跟 claude-code 的 update 一樣
const WRITE_ATTEMPTS = 64

// 狀態由 host 保存，熱重載後仍在
const viewAtom = atom({ plugin: 'agent-supervisor', key: 'view' } as const, 'overview' as SupervisorView)
const agentsAtom = atom({ plugin: 'agent-supervisor', key: 'agents' } as const, [] as AgentRecord[])
const mainAtom = atom({ plugin: 'agent-supervisor', key: 'mainLoop' } as const, IDLE_MAIN)
const tasksAtom = atom({ plugin: 'agent-supervisor', key: 'tasks' } as const, [] as TaskRecord[])
const waitingAtom = atom({ plugin: 'agent-supervisor', key: 'waiting' } as const, {} as WaitingReports)
// 只有面板讀，所以每秒的更新只讓面板重畫
const tickAtom = atom({ plugin: 'agent-supervisor', key: 'tick' } as const, 0)
// 沒有變化就不寫的寫入直接用 $.state.get／set：plugin 與 key 要是字面值，host 才掃得到
const AGENTS_REF = { plugin: 'agent-supervisor', key: 'agents' } as const

// 下面是模組自己的變數，熱重載後重來
let timer: Timer | undefined
let tickCount = 0
// 上一次送給 $.ui.status 的文字；相同就不再送，每送一次輸入框下方就重畫一次
let shownStatus: string | undefined | typeof STATUS_UNKNOWN = STATUS_UNKNOWN

// 更新代理清單；沒有變化就不寫（每次寫入都讓面板重畫），版本衝突時重讀再試
async function changeAgents($: EngineInterface, change: (agents: AgentRecord[]) => AgentRecord[]): Promise<AgentRecord[]> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(AGENTS_REF)
    const current = held.value ?? []
    const next = capAgents(change(current))
    if (next === current) return current
    if ((await $.state.set(AGENTS_REF, next, { ifVersion: held.version })).isSet) return next
  }
  throw new Error('changeAgents: 每次讀到之後都被別人搶先寫入，試到上限仍沒寫進去')
}

async function isPanelOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE_ID)
}

async function togglePanel($: EngineInterface): Promise<{ text: string }> {
  if (await isPanelOpen($)) {
    await $.ui.close({ id: PANE_ID }).catch(() => {})
    await syncTimerAndStatus($)
    return { text: '已關閉 Agent Supervisor 面板。' }
  }
  // 使用者打指令開的窗格任何寬度都放得下：夠寬時停靠右邊，不然放在輸入框上方
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  await syncTimerAndStatus($)
  return { text: '已開啟 Agent Supervisor 面板。' }
}

// 有還沒結束的代理時跑計時器、沒有就停；面板沒開時在輸入框下方釘一行狀態，開了或都結束了就清掉
async function syncTimerAndStatus($: EngineInterface): Promise<void> {
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
  await changeAgents($, agents => finishAgent(entry === undefined ? agents : adoptListed(agents, entry), agentId, reason, endedAt))
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
  if (report.tasks.length > 0) {
    const checked = applyReport(await read($, tasksAtom), report, context)
    if ('error' in checked) return { deny: checked.error }
    // 再套用一次：讀到之後若有別人寫入，update 會重讀再算
    await update($, tasksAtom, tasks => {
      const applied = applyReport(tasks, report, context)
      return 'error' in applied ? tasks : applied.tasks
    })
  }
  if (report.waitingFor !== null) {
    const waitingFor = report.waitingFor
    await update($, waitingAtom, waiting => setWaiting(waiting, reporter, waitingFor, at))
  }
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
  await update($, tasksAtom, tasks => applyNativeTool(tasks, { tool, input, result: answered.result }, { reporter, agents, at }))
}

function withSubagentNote(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${SUBAGENT_NOTE}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 名稱已被佔用時會被拒絕，不影響其他功能
    await $.command.register({ name: 'supervisor', description: '開關 Agent Supervisor 面板：子代理、任務、阻塞與建議' }).catch(() => {})
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
    if (e.reason === 'clear') {
      await update($, agentsAtom, () => []).catch(() => {})
      await update($, mainAtom, () => IDLE_MAIN).catch(() => {})
      await update($, tasksAtom, () => []).catch(() => {})
      await update($, waitingAtom, () => ({})).catch(() => {})
    }
    return next(e)
  })

  on('command.run', { command: 'supervisor' }, async $ => togglePanel($))

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
      await changeAgents($, agents => addSpawn(agents, facts))
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
      await changeAgents($, agents => recordToolOutcome(agents, agentId, { outcome: 'error', errorLine: message })).catch(() => {})
      throw error
    }
    await changeAgents($, agents => recordToolOutcome(agents, agentId, toolOutcomeOf(result))).catch(() => {})
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
    const { Box, Text } = $.ui.resolve(e)
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
      const [agents, mainLoop, tasks, waiting] = await Promise.all([
        read($, agentsAtom),
        read($, mainAtom),
        read($, tasksAtom),
        read($, waitingAtom),
        read($, tickAtom),
        read($, viewAtom),
      ])
      const rows = overviewRows({ agents, mainLoop, tasks, waiting }, { columns: e.props.bodyColumns, now: await $.clock.now() })
      return <Box flexDirection="column">{rows.map(spanRow)}</Box>
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
