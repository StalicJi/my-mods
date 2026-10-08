// Where Am I: a live recap above the prompt (goal, now, waiting on you, next), plus /where.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Recap } from '../types'

const MODEL = 'haiku'
const MAX_LOG = 20

// 摘要區塊的外框，讓它在 band 裡一眼就能認出來；只框自己畫的部分，
// 其他 mod 的內容（rest）留在框外，因為串接順序無法保證這個 mod 在最外層
const BORDER_STYLE = 'round'
const BORDER_COLOR = 'suggestion'

// Held by the host, so the recap survives a hot reload of this file.
const recap = atom({ plugin: 'where-am-i', key: 'recap' } as const, null as Recap | null)
const live = atom({ plugin: 'where-am-i', key: 'live' } as const, '')
// True while the next-steps mod shows its list of next prompts: this band leaves out its own next meanwhile.
const nextStepsActive = { plugin: 'next-steps', key: 'active' } as const
// clean-view 的合併框模式（clean-view/hooks/register.tsx 的 combinedBox）：
// 合併框顯示時，Goal／Now／Wait 會跟計畫畫在同一個框裡，這裡就讓出位置。改名要兩邊一起改
const cleanViewCombinedBox = { plugin: 'clean-view', key: 'combinedBox' } as const
// clean-view 的計畫工具（clean-view/hooks/register.tsx 的 PLAN_TOOL）：只是在回報計畫，不算正在做的事；
// 也拿來判斷 clean-view 是否還載入著（見 isCleanViewLoaded）
const CLEAN_VIEW_PLAN_TOOL = 'mcp__clean-view__update_plan'
// 確認 clean-view 是否載入的結果留用多久
const CLEAN_VIEW_RECHECK_MS = 2000

// lastCheck 是最近一次確認的結果；isRecheckScheduled 表示已排了一次到期後的重新確認
type CleanViewProbe = {
  lastCheck: { isLoaded: boolean; checkedAt: number } | null
  isRecheckScheduled: boolean
}

export const register: Register = on => {
  let prompt = ''
  let log: string[] = []
  const cleanViewProbe: CleanViewProbe = { lastCheck: null, isRecheckScheduled: false }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'where', description: 'Recap the session so far in a few bullets' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    prompt = e.text.slice(0, 1500)
    log = []
    await update($, live, () => '正在讀你的訊息')
    return next(e)
  })

  // Observe only: note what is happening, then let the call run untouched.
  // Only Claude's own calls count: one another mod makes in the background (`$.tool.call`,
  // `$.mcp.call`) is raised by that plugin, and `next.origin` names it instead of the engine.
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine' || e.tool === CLEAN_VIEW_PLAN_TOOL) return next(e)
    const line = describe(e as unknown as Record<string, unknown>)
    log = [...log, e.agentId ? `(agent) ${line}` : line].slice(-MAX_LOG)
    if (!e.agentId) await update($, live, () => line)
    const r = await next(e)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await update($, live, () => '')
      void summarize($, prompt, log, e.answer).catch(() => {}) // in the background, so the turn ends at once
    }
    return r
  })

  on('command.run', { command: 'where' }, async $ => ({ text: await longRecap($, prompt, log) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const r = await read($, recap)
    if (e.props.hasSurvey || !r) return rest
    const { value: combinedBoxMode = 'hidden' } = await $.state.get(cleanViewCombinedBox)
    // 跟 clean-view 的 isCombinedBoxShown 同一個規則（兩個 mod 不能共用程式碼），改規則要兩邊一起改
    const isCombinedBoxShown = combinedBoxMode === 'always' || (combinedBoxMode === 'whileWorking' && e.props.isWorking)
    if (isCombinedBoxShown && (await isCleanViewLoaded($, cleanViewProbe))) return rest

    const { Box, Text } = $.ui.resolve(e)
    const now = clip((await read($, live)) || r.now)
    const { value: hasNextSteps = false } = await $.state.get(nextStepsActive)
    const nextStep = hasNextSteps ? '' : r.next

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1} borderStyle={BORDER_STYLE} borderColor={BORDER_COLOR}>
          <Text wrap="truncate-end">
            <Text color="cyan" bold>{'◆ Goal: '}</Text>
            <Text>{clip(r.goal)}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>{'  Now: '}</Text>
            <Text>{now}</Text>
          </Text>
          {nextStep !== '' && (
            <Text wrap="truncate-end">
              <Text dimColor>{'  Next: '}</Text>
              <Text>{clip(nextStep)}</Text>
            </Text>
          )}
          {r.waiting !== '' && (
            <Text color="yellow" wrap="truncate-end">{`  Wait: ${clip(r.waiting)}`}</Text>
          )}
        </Box>
        {rest}
      </Box>
    )
  })
}

// clean-view 停用或載入失敗時，host 不會清掉它寫過的 state（只在 session 結束時整批清），
// combinedBox 可能一直停在 always，摘要框就永遠讓位。host 卸載 plugin 時會一併移除它註冊的工具，
// 所以改看計畫工具還在不在。列工具要算每個工具的描述，不適合每次重畫都做：結果留用一段時間，
// 期間的重畫改排一次到期後的重新確認，結果變了就重畫，停用後不必等別的事件來觸發重畫
async function isCleanViewLoaded($: EngineInterface, probe: CleanViewProbe): Promise<boolean> {
  const now = await $.clock.now()
  const last = probe.lastCheck
  if (last === null || now - last.checkedAt >= CLEAN_VIEW_RECHECK_MS) {
    const isLoaded = await listsCleanViewTool($)
    probe.lastCheck = { isLoaded, checkedAt: now }
    return isLoaded
  }
  if (!probe.isRecheckScheduled) {
    probe.isRecheckScheduled = true
    $.clock.after(last.checkedAt + CLEAN_VIEW_RECHECK_MS - now, async () => {
      probe.isRecheckScheduled = false
      const isLoaded = await listsCleanViewTool($)
      const hasChanged = isLoaded !== probe.lastCheck?.isLoaded
      probe.lastCheck = { isLoaded, checkedAt: await $.clock.now() }
      if (hasChanged) $.ui.invalidate('ui.render')
    })
  }
  return last.isLoaded
}

// 列不出工具時當作還載入著，維持照 combinedBox 讓位的原行為，避免兩個框同時出現
async function listsCleanViewTool($: EngineInterface): Promise<boolean> {
  const tools = await $.tool.list().catch(() => null)
  return tools === null || tools.some(tool => tool.name === CLEAN_VIEW_PLAN_TOOL)
}

// A short label for one tool call: what a person would say Claude is doing.
// 用字跟 clean-view 的 describe 一致，同一個畫面上 transcript 與 Now 才不會兩套說法
export function describe(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split('/').slice(-2).join('/')
  if (tool === 'Bash') return `執行：${s('description') || s('command').slice(0, 60)}`
  if (tool === 'Read') return `讀取 ${file(s('file_path'))}`
  if (tool === 'Write') return `寫入 ${file(s('file_path'))}`
  if (tool === 'Edit') return `編輯 ${file(s('file_path'))}`
  if (tool === 'NotebookEdit') return `編輯 ${file(s('notebook_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `搜尋 "${s('pattern').slice(0, 40)}"`
  if (tool === 'WebSearch') return `搜尋網路「${s('query').slice(0, 40)}」`
  if (tool === 'WebFetch') return `讀取網頁 ${s('url').replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]}`
  if (tool === 'Agent') return `委派 agent：${s('description')}`
  if (tool === 'Skill') return `使用 skill：${s('skill')}`
  if (tool === 'AskUserQuestion') return '詢問你問題'
  if (tool === 'ToolSearch') return '載入工具'
  if (tool.startsWith('mcp__')) return `使用 ${tool.split('__').slice(1).join(' ')}`
  return `使用 ${tool}`
}

async function summarize($: EngineInterface, prompt: string, log: string[], answer: string) {
  const before = await read($, recap)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 300,
    system:
      'You keep a one-glance recap of a coding session for someone with ADHD. ' +
      'Write every field in Traditional Chinese as used in Taiwan (繁體中文，台灣用語); keep code identifiers, ' +
      'file names and commands as they are. Plain words, no em dashes, ' +
      'each field at most 30 Chinese characters. Reply with JSON only: {"goal","now","waiting","next"}. ' +
      '"goal": the overall aim of the session (keep the previous goal unless it clearly changed). ' +
      '"now": what was just done. "waiting": what the assistant is waiting on from the person, or "". ' +
      '"next": the next step.',
    prompt: [
      `Previous recap: ${before ? JSON.stringify(before) : 'none'}`,
      `The person's latest message: ${prompt}`,
      `Tools used this turn: ${log.join('; ') || 'none'}`,
      `The assistant's reply: ${answer.slice(0, 2500)}`,
    ].join('\n\n'),
  })
  if (!r.isAnswered) return
  const parsed = parseRecap(r.text)
  if (parsed) await update($, recap, () => parsed)
}

async function longRecap($: EngineInterface, prompt: string, log: string[]) {
  const messages = (await $.session.messages()).slice(-12)
  const r = await $.model.complete({
    model: MODEL,
    // 中文每個字耗用的 token 比英文多，原本的 500 寫 6 點條列可能被截斷
    maxTokens: 700,
    system:
      'Write a recap of this coding session for someone who lost track, in Traditional Chinese as used in Taiwan ' +
      '(繁體中文，台灣用語); keep code identifiers, file names and commands as they are. Plain words, no em dashes. ' +
      'At most 6 short bullets: the goal, what is done, what is happening now, what is waiting on them, the next step.',
    prompt: [
      `<transcript>\n${messages.filter(m => m.text.trim() !== '').map(m => `[${m.role === 'user' ? 'person' : 'assistant'}] ${m.text.slice(0, 800)}`).join('\n')}\n</transcript>`,
      `Latest message: ${prompt}`,
      `Recent tool calls: ${log.join('; ') || 'none'}`,
      'Write the recap of the transcript above now: the bullets only, not a reply to it.',
    ].join('\n\n'),
  })
  return r.isAnswered ? r.text : '目前無法產生摘要。'
}

// 英文句點後要接空白才算句尾（避免切到 v0.1.4），中文句號後面直接就是下一句
const SENTENCE_END = /(?<=[.!?])\s|(?<=[。！？])/
// 東亞寬字元、全形符號與 emoji 在終端機佔兩格；範圍用 \u 跳脫，避免存檔時字元被正規化成別的碼位
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// 只取第一句，並以顯示寬度截到 max 格以內：模型不一定遵守字數限制。
// 原版用空格找斷點，中文沒有空格會切錯位置，所以改成依顯示寬度計算
export function clip(text: string, max = 70) {
  const first = text.split(SENTENCE_END)[0] ?? text
  if (displayWidth(first) <= max) return first.replace(/[.。]$/, '')
  return `${trimToWordBoundary(takeWidth(first, max - 1))}…`
}

function charWidth(char: string) {
  return WIDE_CHAR.test(char) ? 2 : 1
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

function takeWidth(text: string, maxWidth: number) {
  let width = 0
  let kept = ''
  for (const char of text) {
    width += charWidth(char)
    if (width > maxWidth) break
    kept += char
  }
  return kept
}

// 結尾是英文單字時退回最後一個空格，避免切在單字中間；中文字與字之間本來就能斷
function trimToWordBoundary(kept: string) {
  const lastSpace = kept.lastIndexOf(' ')
  const tail = kept.slice(lastSpace + 1)
  return lastSpace > 0 && !WIDE_CHAR.test(tail) ? kept.slice(0, lastSpace) : kept
}

// The model's JSON, tolerating a code fence around it.
export function parseRecap(text: string): Recap | null {
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const o = JSON.parse(body) as Record<string, unknown>
    const field = (k: string) => (typeof o[k] === 'string' ? clip((o[k] as string).replace(/\s*—\s*/g, ', ').trim()) : '')
    if (!field('goal')) return null
    return { goal: field('goal'), now: field('now'), waiting: field('waiting'), next: field('next') }
  } catch {
    return null
  }
}
