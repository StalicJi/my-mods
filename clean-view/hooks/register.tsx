// Clean View：工具呼叫收成一行淡色摘要，Claude 回報的計畫清單顯示在 prompt 上方；/clean 切換
import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, ThemeKey, Timer } from 'claude-code'

import type { CombinedBoxMode, PlanStatus, PlanStep, TurnClock } from '../types'

const PLAN_TOOL_NAME = 'update_plan'
// 外掛註冊的工具，模型看到的全名固定是 mcp__<plugin>__<name>；寫成字串常值，matcher 才讀得出來。
// where-am-i/hooks/register.tsx 也用這個名稱略過計畫工具，改名要兩邊一起改
const PLAN_TOOL = 'mcp__clean-view__update_plan'
const MAX_GROUP_LINES = 5

// 計畫清單的排版
const BAR_WIDTH = 12
const BAR_COLUMNS = BAR_WIDTH + 2 // 進度條後面空兩格再接狀態字
// 影片 1:53～1:56 的 Working 條是一顆彗星：頭最亮，後面四格一格比一格淡，融進灰色底
const COMET_FADE = [1, 0.7, 0.45, 0.25, 0.1]
// 影片的主色：橘、粉紅、紫、藍。彗星顏色隨時間在這幾個顏色之間來回變化
const ORANGE = '#f79a4f'
const PINK = '#ec4f8f'
const ACCENT_COLORS = [ORANGE, PINK, '#b45ce6', '#6f7df2']
const TITLE_MARK = '✳ '
const TITLE_COLOR = ORANGE
const ELAPSED_COLUMNS = 8 // 「59m 59s」寬 7，再空一格
const COMET_COLOR_HALF_PERIOD_FRAMES = 15 // 從橘變到藍約 3 秒
const MARK_COLUMNS = 4 // 「  ✓ 」
const STATUS_COLUMNS = 8 // 「Working」寬 7
const MIN_TITLE_COLUMNS = 12
const BOX_CHROME_COLUMNS = 4 // 外框左右各一格線、一格內距
const BOX_BORDER_ROWS = 2
const PLAN_HEADER_ROWS = 2 // 整體進度列與「Plan:」標題列
const PERCENT_COLUMNS = 5 // 「 100%」
const MIN_OVERALL_BAR_WIDTH = 6
// 影片 1:53～1:56：整體長條填滿的那段有一道較亮的光，約兩格寬，往右掃到填滿處尾端後停一下再從頭來。
// 影片約 0.4 秒一格，長條一長要掃很久，依使用者要求加快成每拍（0.2 秒）一格
const OVERALL_SHIMMER_WIDTH = 2
const OVERALL_SHIMMER_PAUSE_CELLS = 4
const OVERALL_SHIMMER_LIGHTEN = 0.35
const MIN_STEP_ROWS = 3
const MAX_STEP_ROWS = 7
// 有彗星或亮光要動時每 0.2 秒一拍；只剩標題列的經過秒數要更新時，每秒一拍就夠
const ANIMATION_MS = 200
const CLOCK_ONLY_MS = 1000

// ▆ 只佔格子下方四分之三：Ghostty 自己畫方塊字元並填滿整格高度，用滿格的方塊上下列會黏在一起，
// ▆ 上方留空，列與列之間才分得開。完成的步驟是綠漸層，進行中的步驟是彗星（見 stepBar）
const BAR_CELL = '▆'
const DONE_GRADIENT = { from: '#2c9a52', to: '#9ee6b4' }
// 整體長條已完成那段的填色：左邊橘、填滿處的尾端粉紅
const OVERALL_FILL_GRADIENT = { from: ORANGE, to: PINK }
// Working 狀態字與整體百分比的顏色
const WORKING_COLOR = PINK
// 空的部分是灰色底；暫停時彗星停住、改成淺灰
const PAUSED_COLOR = '#8a8a94'
const TRACK_COLOR = '#4a4a52'

// 狀態由 host 保存，熱重載後仍在；每個 session 預設開啟
const isEnabled = atom({ plugin: 'clean-view', key: 'isEnabled' } as const, true)
const plan = atom({ plugin: 'clean-view', key: 'plan' } as const, [] as PlanStep[])
// 只有 band 讀它，所以動畫只會讓 band 重畫；用 $.ui.invalidate 會連 transcript 每一列都重跑
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)
// 主迴圈回合的起訖時間：動畫計時器看它判斷回合是否進行中，標題列用它算經過秒數；
// 畫面要不要顯示一律看 band 自己的 e.props.isWorking
const turnClock = atom({ plugin: 'clean-view', key: 'turnClock' } as const, null as TurnClock | null)
// where-am-i 讀這個值決定要不要讓出位置（where-am-i/hooks/register.tsx 的 cleanViewCombinedBox），改名要兩邊一起改
const combinedBox = atom({ plugin: 'clean-view', key: 'combinedBox' } as const, 'hidden' as CombinedBoxMode)
// where-am-i 擁有的摘要，合併框讀來顯示 Goal／Now／Wait
const whereAmIRecap = { plugin: 'where-am-i', key: 'recap' } as const
const whereAmILive = { plugin: 'where-am-i', key: 'live' } as const

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: 'The whole plan, in order. It replaces the previous list.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short phrase, in the language you reply in.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['title', 'status'],
      },
    },
  },
  required: ['steps'],
}

const PLAN_TOOL_DESCRIPTION =
  'Show the person a checklist of your plan above their prompt; they see it instead of your tool calls. ' +
  'Send the whole list every time: it replaces the previous one. Keep exactly one step in_progress while you work. ' +
  'Step titles are short phrases (about 20 CJK or 40 Latin characters at most) in the language you reply in.'

// 看畫面的人讀的語言；主對話的計畫指示與子代理的語言要求共用，換語言只改這裡
const READER_LANGUAGE = 'Traditional Chinese (Taiwan usage)'

// 這個環境的主對話沒有 TodoWrite／TaskCreate，計畫清單只能靠模型主動回報，所以要在 system prompt 交代。
// 最後一行的語言要求：工具呼叫收成一行後，畫面上最顯眼的是工具之間的進度說明，
// 而查對話紀錄發現英文幾乎都出在這裡（思考是英文或剛收到英文的系統提醒時特別容易）
const PLAN_INSTRUCTIONS = [
  '# Plan checklist',
  `The person uses Clean View: each tool call shows as one short line, and a checklist from the ${PLAN_TOOL} tool shows above the prompt.`,
  `For a task of three or more steps, call ${PLAN_TOOL} before starting, the first step in_progress and the rest pending.`,
  'Call it again as each step finishes, moving in_progress to the next one, and mark every step completed when the work is done.',
  'Skip it for questions you answer directly and for tasks of one or two steps.',
  `Write the progress notes between tool calls, and any status update you give in reply to a system reminder, in ${READER_LANGUAGE} even when your thinking or the reminder is in English; keep code identifiers, commands and paths as they are.`,
].join('\n')

// 附在每個子代理任務尾端的語言要求；內容固定，同一句不論附幾次都一樣
const SUBAGENT_LANGUAGE_NOTE = [
  '# Language',
  `The person watches this run on screen and reads ${READER_LANGUAGE}.`,
  `Write your progress notes between tool calls, the description you give each tool call, and your final report in ${READER_LANGUAGE}.`,
  'Keep code identifiers, commands, file names and paths as they are.',
  'If the task above explicitly asks for another language or an exact output format, follow the task.',
].join('\n')

// 畫面上的步驟狀態：in_progress 依回合是否進行中分成 running 與 paused（例如 Esc 中斷後）
type StepDisplay = 'completed' | 'running' | 'paused' | 'pending'

type RowStyle = {
  mark: string
  markColor?: Color
  isMarkDim: boolean
  isTextBold: boolean
  isTextDim: boolean
  label: string
  labelColor?: Color
  isLabelBold: boolean
}

const ROW_STYLE: Record<StepDisplay, RowStyle> = {
  completed: { mark: '✓', markColor: 'success', isMarkDim: false, isTextBold: false, isTextDim: true, label: 'Done', isLabelBold: false },
  running: { mark: '▸', isMarkDim: false, isTextBold: true, isTextDim: false, label: 'Working', labelColor: WORKING_COLOR, isLabelBold: true },
  paused: { mark: '▸', isMarkDim: true, isTextBold: false, isTextDim: false, label: 'Paused', isLabelBold: false },
  pending: { mark: '○', isMarkDim: true, isTextBold: false, isTextDim: true, label: '—', isLabelBold: false },
}

type PlanRow = { text: string; display: StepDisplay }
type RecapSummary = { goal: string; now: string; waiting: string }

// 模組重新載入時 engine 會丟掉舊的 timer，這個變數也跟著重來
let animation: { timer: Timer; intervalMs: number } | undefined

// 計畫、開關或回合狀態變動後都呼叫這裡：決定合併框的顯示模式，以及計時器要不要跑、跑多快
async function refreshPlanBand($: EngineInterface) {
  const [enabled, steps, clock, currentMode] = await Promise.all([read($, isEnabled), read($, plan), read($, turnClock), read($, combinedBox)])
  const mode = combinedBoxMode(enabled, steps)
  // 沒變就不寫：寫入會讓讀它的 band（含 where-am-i）重畫
  if (mode !== currentMode) await update($, combinedBox, () => mode)
  const turnRunning = clock !== null && clock.endedAt === null
  syncAnimation($, enabled && turnRunning ? animationIntervalMs(steps) : null)
}

function syncAnimation($: EngineInterface, intervalMs: number | null) {
  if (animation?.intervalMs === intervalMs) return
  stopAnimation()
  if (intervalMs === null) return
  animation = { intervalMs, timer: $.clock.every(intervalMs, () => void update($, tick, frame => frame + 1).catch(() => {})) }
}

function stopAnimation() {
  animation?.timer.cancel()
  animation = undefined
}

// 回合中有計畫才需要計時器：有進行中的步驟（彗星）或整體長條有亮光可掃時每 0.2 秒一拍，
// 只剩標題列的經過秒數要更新時每秒一拍；沒有計畫就不跑
export function animationIntervalMs(steps: readonly PlanStep[]): number | null {
  if (steps.length === 0) return null
  const hasComet = steps.some(step => step.status === 'in_progress')
  const hasShimmer = countCompleted(steps) > 0 && !isPlanFinished(steps)
  return hasComet || hasShimmer ? ANIMATION_MS : CLOCK_ONLY_MS
}

// where-am-i 沒裝或還沒有摘要時回傳 null，合併框就只畫計畫
async function readRecapSummary($: EngineInterface): Promise<RecapSummary | null> {
  const { value: recap } = await $.state.get(whereAmIRecap)
  if (!recap) return null
  const { value: live } = await $.state.get(whereAmILive)
  return { goal: recap.goal, now: live || recap.now, waiting: recap.waiting }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 名稱已被 Claude Code 佔用時會被拒絕，不影響其他功能
    await $.command
      .register({ name: 'clean', description: '切換 Clean View：收起工具呼叫細節，只看計畫清單' })
      .catch(() => {})
    await $.tool.register({ name: PLAN_TOOL_NAME, description: PLAN_TOOL_DESCRIPTION, inputSchema: PLAN_SCHEMA })
    await refreshPlanBand($) // 熱重載也會走到這裡，回合中重載時把動畫接回來
    return started
  })

  on('command.run', { command: 'clean' }, async $ => {
    const enabled = await update($, isEnabled, value => !value)
    await refreshPlanBand($)
    return { text: enabled ? 'Clean View 已開啟：工具呼叫收成一行摘要。' : 'Clean View 已關閉：恢復完整顯示。' }
  })

  // 內容固定的 session 區段，不會讓 prompt cache 每次失效；沒有這個工具的請求（例如部分 subagent）不加
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(PLAN_TOOL)) return composed
    return { sections: [...composed.sections, { id: 'clean-view:plan', text: PLAN_INSTRUCTIONS, scope: 'session' }] }
  })

  // 子代理的 system prompt 由 agent 定義自己組成，不經過 prompt.compose，所以語言要求只能附在交給它的任務尾端。
  // workflow 啟動的 agent 內容不能改寫（改了會被忽略並記一行失敗），原樣放行
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow) return next(e)
    return next({ ...e, prompt: withSubagentLanguageNote(e.prompt) })
  })

  // 自己回答，不呼叫 next：這個工具沒有實際執行的東西，也就不會跳權限確認
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'Ignored: only the main conversation updates the plan.' }
    const steps = parseSteps((e as { steps?: unknown }).steps)
    if (steps === null) return { deny: 'steps must be an array of { title, status } with status pending, in_progress or completed.' }
    await update($, plan, () => steps)
    await refreshPlanBand($)
    return { result: `Plan shown: ${countCompleted(steps)}/${steps.length} completed.` }
  })

  // 上一份計畫已全部完成才清掉；還沒做完的留著，Claude 可能下一輪接著做。
  // prompt 被擋下也無妨：做完的計畫在閒置時本來就不顯示
  on('prompt.submit', async ($, e, next) => {
    await update($, plan, current => (isPlanFinished(current) ? [] : current))
    await refreshPlanBand($)
    return next(e)
  })

  // subagent 的執行不會發 turn.start，只有主迴圈會
  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    await update($, turnClock, () => ({ startedAt, endedAt: null }))
    await refreshPlanBand($)
    return next(e)
  })

  // 中斷（reason 為 aborted）也會發 turn.complete
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const endedAt = await $.clock.now()
      await update($, turnClock, clock => (clock ? { ...clock, endedAt } : clock))
      await refreshPlanBand($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopAnimation()
    if (e.reason === 'clear') {
      await update($, plan, () => [])
      await refreshPlanBand($)
    }
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, isEnabled))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (e.props.tool === PLAN_TOOL) return <Box />
    const line = toolLine(e.props)
    return (
      <Text color={line.color} dimColor={line.color === undefined} wrap="truncate-end">
        {line.text}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, isEnabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // 連續的讀檔、搜尋會被折成一組；照樣一個動作一行，太多時只留最後幾個
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, isEnabled))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const calls = e.props.calls.filter(call => call.tool !== PLAN_TOOL)
    const shown = calls.slice(-MAX_GROUP_LINES)
    const hiddenCount = calls.length - shown.length
    return (
      <Box flexDirection="column">
        {hiddenCount > 0 && <Text dimColor>{`  · 前面還有 ${hiddenCount} 個動作`}</Text>}
        {shown.map(call => {
          const line = toolLine(call)
          return (
            <Text color={line.color} dimColor={line.color === undefined} wrap="truncate-end">
              {line.text}
            </Text>
          )
        })}
      </Box>
    )
  })

  // 計畫顯示時畫合併框：where-am-i 的 Goal／Now／Wait 加上計畫清單（Next 跟計畫重複所以不放）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // 其他 mod 與 Claude Code 自己畫的內容保留在下面
    const mode = await read($, combinedBox)
    if (e.props.hasSurvey || !isCombinedBoxShown(mode, e.props.isWorking)) return rest

    const { Box, Text } = $.ui.resolve(e)
    const innerColumns = e.props.bodyColumns - BOX_CHROME_COLUMNS
    const [summary, clock, steps, frame] = await Promise.all([readRecapSummary($), read($, turnClock), read($, plan), read($, tick)])
    const title = titleRow(summary?.goal ?? '', steps, await elapsedLabel($, clock), innerColumns)
    const view = planView(steps, {
      frame,
      isWorking: e.props.isWorking,
      columns: innerColumns,
      rows: e.props.maxRows - BOX_BORDER_ROWS - rowsAbovePlan(title, summary),
    })
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="suggestion">
          {/* 標題列（照影片）：左邊是目標，右邊是這個回合經過的時間 */}
          {title && (
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold color={TITLE_COLOR} wrap="truncate-end">
                {title.text}
              </Text>
              {title.elapsed !== null && <Text dimColor>{title.elapsed}</Text>}
            </Box>
          )}
          {summary?.now && (
            <Text wrap="truncate-end">
              <Text dimColor>{'  Now: '}</Text>
              <Text>{summary.now}</Text>
            </Text>
          )}
          {/* 整體進度列：進度條跟各步驟的進度條從同一欄開始，一路延伸到框的右邊 */}
          <Box flexDirection="row">
            <Box width={view.titleColumns}>
              <Text dimColor wrap="truncate-end">{`  ${view.overall.label}`}</Text>
            </Box>
            <Box width={view.overall.cells.length + 1}>
              <Text>
                {colorRuns(view.overall.cells).map(run => (
                  <Text color={run.color}>{BAR_CELL.repeat(run.count)}</Text>
                ))}
              </Text>
            </Box>
            <Text bold color={view.overall.isFinished ? 'success' : WORKING_COLOR}>
              {view.overall.percent}
            </Text>
          </Box>
          {/* 標籤跟 Now／Wait 一樣縮排；完成幾步看上面的 Step x of y，這裡不重複 */}
          <Text dimColor>{'  Plan:'}</Text>
          {view.rows.map(row => (
            <Box flexDirection="row">
              <Box width={view.titleColumns}>
                <Text wrap="truncate-end">
                  <Text color={row.style.markColor} dimColor={row.style.isMarkDim}>{`  ${row.style.mark} `}</Text>
                  <Text bold={row.style.isTextBold} dimColor={row.style.isTextDim}>
                    {row.text}
                  </Text>
                </Text>
              </Box>
              <Box width={BAR_COLUMNS}>
                <Text>
                  {colorRuns(row.cells).map(run => (
                    <Text color={run.color}>{BAR_CELL.repeat(run.count)}</Text>
                  ))}
                </Text>
              </Box>
              {view.isStatusShown && (
                <Text bold={row.style.isLabelBold} color={row.style.labelColor} dimColor={row.style.labelColor === undefined}>
                  {row.style.label}
                </Text>
              )}
            </Box>
          ))}
          {summary?.waiting && <Text color="yellow" wrap="truncate-end">{`  Wait: ${summary.waiting}`}</Text>}
        </Box>
        {rest}
      </Box>
    )
  })
}

// 已經附過（例如上層子代理把整段任務轉交下去）就不再重複
function withSubagentLanguageNote(prompt: string) {
  if (prompt.includes(SUBAGENT_LANGUAGE_NOTE)) return prompt
  return `${prompt.trimEnd()}\n\n${SUBAGENT_LANGUAGE_NOTE}`
}

export function combinedBoxMode(enabled: boolean, steps: readonly PlanStep[]): CombinedBoxMode {
  if (!enabled || steps.length === 0) return 'hidden'
  return isPlanFinished(steps) ? 'whileWorking' : 'always'
}

// where-am-i/hooks/register.tsx 有同一行判斷（兩個 mod 不能共用程式碼），改規則要兩邊一起改
export function isCombinedBoxShown(mode: CombinedBoxMode, isWorking: boolean) {
  return mode === 'always' || (mode === 'whileWorking' && isWorking)
}

// 計畫區塊上方、框線以外的列數：標題列、Now、Wait；跟 JSX 裡畫哪些列要一致
function rowsAbovePlan(title: TitleRow | null, summary: RecapSummary | null) {
  return (title ? 1 : 0) + (summary?.now ? 1 : 0) + (summary?.waiting ? 1 : 0)
}

// 回合進行中算到現在（只有這時才需要讀時鐘），結束了就停在結束那一刻；還沒有回合就不顯示
async function elapsedLabel($: EngineInterface, clock: TurnClock | null) {
  if (!clock) return null
  const end = clock.endedAt ?? (await $.clock.now())
  return formatElapsed(end - clock.startedAt)
}

type TitleRow = { text: string; elapsed: string | null }

// 標題列：左邊「✳ 目標」，where-am-i 還沒有摘要時改用目前步驟的標題；右邊是經過時間。兩邊都沒有就不畫
export function titleRow(goal: string, steps: readonly PlanStep[], elapsed: string | null, innerColumns: number): TitleRow | null {
  const subject = goal || (steps[currentStepIndex(steps)]?.title ?? '')
  const fitted = fitToWidth(subject, innerColumns - displayWidth(TITLE_MARK) - ELAPSED_COLUMNS)
  const text = fitted ? TITLE_MARK + fitted : ''
  if (!text && elapsed === null) return null
  return { text, elapsed }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

// 超過寬度時依顯示寬度截斷，補「…」；中文一個字算兩格
export function fitToWidth(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return ''
  if (displayWidth(text) <= maxColumns) return text
  let kept = ''
  let width = 0
  for (const char of text) {
    if (width + charWidth(char) > maxColumns - 1) break
    kept += char
    width += charWidth(char)
  }
  return `${kept}…`
}

type PlanViewOptions = { frame: number; isWorking: boolean; columns: number; rows: number }

// 合併框裡計畫區塊要畫的一切：進度字樣、欄寬、要不要顯示狀態字，以及每一列的樣式與方格顏色
export function planView(steps: readonly PlanStep[], options: PlanViewOptions) {
  const stepRows = Math.min(MAX_STEP_ROWS, Math.max(MIN_STEP_ROWS, options.rows - PLAN_HEADER_ROWS))
  const rows = planRows(steps, stepRows, options.isWorking)
  const layout = planLayout(rows, options.columns)
  // 標籤欄也要放得下整體進度列的「  Step x of y」，不然標籤會換行、多出一列
  const titleColumns = Math.max(layout.titleColumns, displayWidth(`  ${overallLabel(steps)}`) + 1)
  return {
    ...layout,
    titleColumns,
    overall: overallProgress(steps, {
      barWidth: Math.max(MIN_OVERALL_BAR_WIDTH, options.columns - titleColumns - PERCENT_COLUMNS),
      frame: options.frame,
      isAnimated: options.isWorking, // 閒置時計時器已停，亮光停在半路很怪，乾脆不畫
    }),
    rows: rows.map(row => ({ ...row, style: ROW_STYLE[row.display], cells: stepBar(row.display, options.frame) })),
  }
}

// 影片的整體進度列：Step x of y、一條長進度條、百分比。x 是進行中的那一步，沒有進行中時是第一個還沒完成的步驟。
// 百分比只算已完成的步驟（步驟內部沒有進度可量）；全部完成時整條變綠
type OverallBarOptions = { barWidth: number; frame: number; isAnimated: boolean }

export function overallProgress(steps: readonly PlanStep[], options: OverallBarOptions) {
  const { barWidth } = options
  const completedCount = countCompleted(steps)
  const ratio = steps.length === 0 ? 0 : completedCount / steps.length
  const filledCells = Math.round(ratio * barWidth)
  const isFinished = isPlanFinished(steps)
  const positions = Array.from({ length: barWidth }, (_, index) => index)
  if (isFinished) {
    const cells = positions.map(index => gradientAt(DONE_GRADIENT, index, barWidth))
    return { label: overallLabel(steps), percent: '100%', cells, isFinished }
  }
  // 漸層只鋪在已填滿的那段，左邊橘、填滿處的尾端粉紅，跟影片一樣；再疊上掃過的亮光
  const isShimmer = options.isAnimated ? shimmerBand(options.frame, filledCells) : () => false
  const cells = positions.map(index => {
    if (index >= filledCells) return TRACK_COLOR
    const color = gradientAt(OVERALL_FILL_GRADIENT, index, filledCells)
    return isShimmer(index) ? lighten(color, OVERALL_SHIMMER_LIGHTEN) : color
  })
  return { label: overallLabel(steps), percent: `${Math.round(ratio * 100)}%`, cells, isFinished }
}

export function overallLabel(steps: readonly PlanStep[]) {
  const current = currentStepIndex(steps)
  return `Step ${(current >= 0 ? current : steps.length - 1) + 1} of ${steps.length}`
}

// 目前的步驟：進行中的那一步，沒有的話是第一個還沒完成的步驟；全部完成時是 -1
function currentStepIndex(steps: readonly PlanStep[]) {
  const runningIndex = steps.findIndex(step => step.status === 'in_progress')
  return runningIndex >= 0 ? runningIndex : steps.findIndex(step => step.status !== 'completed')
}

// 連續同色的格子合併成一段，少畫很多元素（整體長條在寬螢幕上可能有一百多格）
export function colorRuns(cells: readonly string[]): { color: string; count: number }[] {
  const runs: { color: string; count: number }[] = []
  for (const color of cells) {
    const last = runs[runs.length - 1]
    if (last?.color === color) last.count += 1
    else runs.push({ color, count: 1 })
  }
  return runs
}

function shimmerBand(frame: number, filledCells: number) {
  const head = frame % (filledCells + OVERALL_SHIMMER_PAUSE_CELLS)
  return (index: number) => index <= head && index > head - OVERALL_SHIMMER_WIDTH
}

// band 的高度有限，還要跟其他 mod 共用：超過列數時先把已完成的收成一列，還放不下就把後段收成「還有 N 項」
export function planRows(steps: readonly PlanStep[], maxRows: number, isWorking: boolean): PlanRow[] {
  const rows = steps.map(step => ({ text: step.title, display: displayOf(step.status, isWorking) }))
  if (rows.length <= maxRows) return rows

  const completedCount = countCompleted(steps)
  const folded: PlanRow[] = completedCount > 0 ? [{ text: `已完成 ${completedCount} 項`, display: 'completed' }] : []
  const compact = [...folded, ...rows.filter(row => row.display !== 'completed')]
  if (compact.length <= maxRows) return compact

  const kept = compact.slice(0, maxRows - 1)
  return [...kept, { text: `還有 ${compact.length - kept.length} 項`, display: 'pending' }]
}

function displayOf(status: PlanStatus, isWorking: boolean): StepDisplay {
  if (status === 'in_progress') return isWorking ? 'running' : 'paused'
  return status
}

// 標題欄寬取最長的標題，讓進度條對齊成一欄；太窄時先拿掉狀態字，再縮標題，進度條維持原寬
export function planLayout(rows: readonly PlanRow[], columns: number) {
  const longest = Math.max(0, ...rows.map(row => displayWidth(row.text)))
  const wantedTitleColumns = MARK_COLUMNS + longest + 2
  const roomWithStatus = columns - BAR_COLUMNS - STATUS_COLUMNS
  if (roomWithStatus >= MIN_TITLE_COLUMNS) {
    return { titleColumns: Math.min(wantedTitleColumns, roomWithStatus), isStatusShown: true }
  }
  const roomWithoutStatus = columns - BAR_COLUMNS
  return { titleColumns: Math.max(MIN_TITLE_COLUMNS, Math.min(wantedTitleColumns, roomWithoutStatus)), isStatusShown: false }
}

// 每一格的顏色，由左到右：完成是綠漸層，未開始只有灰色底；進行中是一顆彗星從左往右走，
// 尾巴也離開右邊後再從左邊進來，frame 每拍加一。暫停時停在左邊、整顆看得見的位置並改成淺灰，
// 不沿用最後一拍的位置：那一拍可能剛好出界，看起來就跟未開始一樣
const PAUSED_HEAD = COMET_FADE.length - 1

export function stepBar(display: StepDisplay, frame: number): string[] {
  const positions = Array.from({ length: BAR_WIDTH }, (_, index) => index)
  if (display === 'completed') return positions.map(index => gradientAt(DONE_GRADIENT, index))
  if (display === 'pending') return positions.map(() => TRACK_COLOR)
  const head = display === 'paused' ? PAUSED_HEAD : frame % (BAR_WIDTH + COMET_FADE.length)
  const headColor = display === 'running' ? cometColor(frame) : PAUSED_COLOR
  return positions.map(index => {
    const intensity = COMET_FADE[head - index]
    return intensity === undefined ? TRACK_COLOR : mixColor(TRACK_COLOR, headColor, intensity)
  })
}

// 彗星此刻的顏色：沿著 ACCENT_COLORS 來回走，一個來回是兩個半週期
export function cometColor(frame: number): string {
  const phase = frame % (COMET_COLOR_HALF_PERIOD_FRAMES * 2)
  const progress = (phase <= COMET_COLOR_HALF_PERIOD_FRAMES ? phase : COMET_COLOR_HALF_PERIOD_FRAMES * 2 - phase) / COMET_COLOR_HALF_PERIOD_FRAMES
  return paletteAt(ACCENT_COLORS, progress)
}

// 沿著一串顏色取色：progress 0 是第一個、1 是最後一個，中間在相鄰兩色之間內插
function paletteAt(colors: readonly string[], progress: number) {
  const position = progress * (colors.length - 1)
  const lower = Math.min(Math.floor(position), colors.length - 2)
  return mixColor(colors[lower]!, colors[lower + 1]!, position - lower)
}

function gradientAt(gradient: { from: string; to: string }, index: number, length = BAR_WIDTH) {
  return mixColor(gradient.from, gradient.to, length > 1 ? index / (length - 1) : 0)
}

// 兩個顏色之間取比例：0 是 from、1 是 to
function mixColor(from: string, to: string, ratio: number) {
  const target = hexChannels(to)
  const mixed = hexChannels(from).map((channel, i) => Math.round(channel + (target[i]! - channel) * ratio))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function hexChannels(hex: string) {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16))
}

function lighten(hex: string, ratio: number) {
  return mixColor(hex, '#ffffff', ratio)
}

// 東亞寬字元、全形符號與 emoji 在終端機佔兩格；範圍用 \u 跳脫，避免存檔時字元被正規化成別的碼位
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

function charWidth(char: string) {
  return WIDE_CHAR.test(char) ? 2 : 1
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

type ToolCallView = { tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean }

export function toolLine(call: ToolCallView): { text: string; color?: ThemeKey } {
  const label = `  · ${describe(call.tool, call.input)}`
  if (call.isInterrupted) return { text: `${label}（已中斷）`, color: 'warning' }
  if (call.isErrored) return { text: `${label}（失敗）`, color: 'error' }
  if (call.isRunning) return { text: `${label} …` }
  return { text: label }
}

// 一句話說出 Claude 在做什麼，取代原本的工具名稱與參數；where-am-i 的 describe 用同一套用字
export function describe(tool: string, input: unknown): string {
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
  if (tool === 'WebFetch') return `讀取網頁 ${hostOf(text('url'))}`
  if (tool === 'Agent') return `委派 agent：${text('description')}`
  if (tool === 'Skill') return `使用 skill：${text('skill')}`
  if (tool === 'AskUserQuestion') return '詢問你問題'
  if (tool === 'ToolSearch') return '載入工具'
  if (tool.startsWith('mcp__')) return `使用 ${tool.split('__').slice(1).join(' ')}`
  return `使用 ${tool}`
}

function hostOf(url: string) {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)
  return match?.[1] ?? url.slice(0, 40)
}

const PLAN_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'] satisfies PlanStatus[]

export function parseSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null
  const steps = value.flatMap(item => (isPlanStep(item) ? [{ title: item.title.trim(), status: item.status }] : []))
  return steps.length === value.length ? steps : null
}

function isPlanStep(item: unknown): item is PlanStep {
  if (typeof item !== 'object' || item === null) return false
  const { title, status } = item as Record<string, unknown>
  return typeof title === 'string' && typeof status === 'string' && PLAN_STATUSES.includes(status)
}

function countCompleted(steps: readonly PlanStep[]) {
  return steps.filter(step => step.status === 'completed').length
}

function isPlanFinished(steps: readonly PlanStep[]) {
  return steps.length > 0 && countCompleted(steps) === steps.length
}
