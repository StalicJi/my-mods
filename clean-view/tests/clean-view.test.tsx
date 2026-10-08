import { describe, expect, mock, test } from 'claude-code/testing'

import {
  animationIntervalMs,
  colorRuns,
  cometColor,
  combinedBoxMode,
  formatElapsed,
  fitToWidth,
  overallLabel,
  overallProgress,
  isCombinedBoxShown,
  parseSteps,
  planLayout,
  planRows,
  planView,
  stepBar,
  titleRow,
  toolLine,
} from '../hooks/register'

const PLAN_TOOL = 'mcp__clean-view__update_plan'
const TRACK = '#4a4a52'
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 120 }
const READ_ROW = {
  component: 'ToolUse',
  props: { tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/src/config.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
}
const PLAN_ROW = {
  component: 'ToolUse',
  props: { tool_use_id: 't2', tool: PLAN_TOOL, input: { steps: [] }, isRunning: false, isErrored: false, isInterrupted: false },
}
const STEPS = [
  { title: '讀取現有設定', status: 'completed' },
  { title: '修改 config.ts', status: 'in_progress' },
  { title: '跑測試', status: 'pending' },
] as const
const DONE_STEPS = STEPS.map(step => ({ ...step, status: 'completed' as const }))

// 代替 mod 底下的 engine
function engine(on: any) {
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({}))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: PLAN_TOOL } }))
  on('prompt.submit', () => ({ text: '' }))
  on('turn.start', () => ({ turnId: 'turn-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine draws' })
  })
}

async function start($: any, on: any) {
  engine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
}

const reportPlan = ($: any, steps: readonly object[]) => $.tool.call({ tool: PLAN_TOOL, steps } as any)

function mountBand($: any, props: Partial<typeof BAND_PROPS> = {}, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...props } } as any)
}

async function isBoxDrawn($: any, props: Partial<typeof BAND_PROPS> = {}) {
  const ui = await mountBand($, props)
  const isDrawn = (await ui.find({ type: 'Text', text: /Plan:$/ })) !== undefined
  await ui.unmount()
  return isDrawn
}

// 從畫面讀出進行中那一列（第二個步驟）彗星頭的位置：前 12 拍它就等於動畫走到的拍數。
// 同色的格子會合併成一段 Text，所以先把每一段展開回一格一格的顏色；第一條是整體長條，接著才是各步驟
async function cometHead($: any) {
  const ui = await mountBand($)
  const bars: string[][] = []
  const isRun = (node: any) => node?.type === 'Text' && node.children?.length === 1 && /^▆+$/.test(node.children[0])
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Text' && node.children?.length > 0 && node.children.every(isRun)) {
      bars.push(node.children.flatMap((run: any) => Array(run.children[0].length).fill(run.props.color)))
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(await ui.drawn())
  await ui.unmount()
  return bars[2]!.findLastIndex(color => color !== TRACK)
}

// 把畫出來的樹按順序攤平成文字：巢狀的 Text 要串起來才比對得到整句
function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

describe('clean-view', () => {
  test('計畫畫在合併框裡，有方格進度條與狀態字，其他 mod 的內容留在框外', async ($, on) => {
    await start($, on)
    const answered = await reportPlan($, STEPS)
    expect((answered as any).deny).toBeUndefined()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountBand($, {}, surface)
      const [framed, rest] = ((await ui.drawn()) as any).children
      expect(framed.props.borderStyle).toBe('round')
      expect(await ui.find({ type: 'Text', text: /Step 2 of 3$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Plan:$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\d+\/\d+ Done/ })).toBeUndefined() // 跟 Step x of y 重複，已拿掉
      expect(await ui.find({ type: 'Text', text: /^33%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^修改 config\.ts$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^▆+$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBeDefined()
      expect(JSON.stringify(rest)).toContain('engine draws')
      await ui.unmount()
    }
  })

  test('合併框：where-am-i 的 Goal／Now／Wait 跟計畫畫在一起，不放 Next', async ($, on) => {
    on('state.get', { plugin: 'where-am-i', key: 'recap' }, () => ({
      value: { value: { goal: '合併兩個框', now: '改好了', waiting: '等你確認', next: '跑測試' }, version: 1 },
    }))
    on('state.get', { plugin: 'where-am-i', key: 'live' }, () => ({ value: { value: '執行：跑測試', version: 1 } }))
    await start($, on)
    await reportPlan($, STEPS)

    const ui = await mountBand($)
    const inside = textOf(((await ui.drawn()) as any).children[0])
    expect(inside).toContain('✳ 合併兩個框') // 目標改畫在標題列
    expect(await ui.find({ type: 'Text', text: /^✳ 合併兩個框$/ })).toBeDefined() // 單一顏色，整串在同一個 Text
    const findTitle = (node: any): any =>
      node?.type === 'Text' && node.children?.[0] === '✳ 合併兩個框' ? node : (node?.children ?? []).map(findTitle).find(Boolean)
    expect(findTitle(await ui.drawn()).props.color).toBe('#f79a4f') // 標題是橘色
    expect(inside).not.toContain('Goal:')
    expect(inside).toContain('執行：跑測試') // Now 用即時狀態，比摘要新
    expect(inside).toContain('Wait: 等你確認')
    expect(inside).not.toContain('Next')
    await ui.unmount()
  })

  test('標題列：右邊顯示這個回合經過的時間，回合結束就停住', async ($, on) => {
    on('state.get', { plugin: 'where-am-i', key: 'recap' }, () => ({
      value: { value: { goal: '合併兩個框', now: '', waiting: '', next: '' }, version: 1 },
    }))
    const clock = mock.clock(on)
    await start($, on)
    await $.turn.start({ text: '開始', turnId: 'turn-1' } as any)
    await reportPlan($, STEPS)
    await clock.advance(21_000)
    const working = await mountBand($)
    expect(await working.find({ type: 'Text', text: /^21s$/ })).toBeDefined()
    await working.unmount()

    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1 } as any)
    await clock.advance(5_000)
    const idle = await mountBand($, { isWorking: false })
    expect(await idle.find({ type: 'Text', text: /^21s$/ })).toBeDefined()
    await idle.unmount()
  })

  test('沒有 where-am-i 的摘要時，框裡只有計畫', async ($, on) => {
    await start($, on)
    await reportPlan($, STEPS)
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Text', text: /Goal/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Step 2 of 3$/ })).toBeDefined()
    await ui.unmount()
  })

  test('格式錯誤的計畫被拒絕，清單不變', async ($, on) => {
    await start($, on)
    const answered = await reportPlan($, [{ title: 'x', status: 'doing' }])
    // 外掛自己透過 $.tool.call 呼叫時，拒絕以 { deny } 回傳；模型呼叫時則收到錯誤結果
    expect((answered as any).deny).toMatch(/steps must be/)
    expect(await isBoxDrawn($)).toBe(false)
  })

  test('沒做完的計畫閒置時也顯示，進行中的步驟改成 Paused', async ($, on) => {
    await start($, on)
    await reportPlan($, STEPS)
    const ui = await mountBand($, { isWorking: false })
    expect(await ui.find({ type: 'Text', text: /^Paused$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('做完的計畫只在回合中顯示，下一個 prompt 送出時清掉', async ($, on) => {
    await start($, on)
    await reportPlan($, DONE_STEPS)
    expect(await isBoxDrawn($, { isWorking: true })).toBe(true)
    expect(await isBoxDrawn($, { isWorking: false })).toBe(false)
    await $.prompt.submit({ text: '下一件事' } as any)
    expect(await isBoxDrawn($, { isWorking: true })).toBe(false)
  })

  test('有問卷時讓出 band', async ($, on) => {
    await start($, on)
    await reportPlan($, STEPS)
    expect(await isBoxDrawn($, { hasSurvey: true })).toBe(false)
  })

  test('工具呼叫收成一行摘要，計畫工具那一列不畫', async ($, on) => {
    await start($, on)
    const row = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...READ_ROW } as any)
    expect(await row.find({ type: 'Text', text: /· 讀取 src\/config\.ts/ })).toBeDefined()
    expect(await row.find({ type: 'Text', text: /engine draws/ })).toBeUndefined()
    await row.unmount()

    const planRow = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...PLAN_ROW } as any)
    expect(await planRow.find({ type: 'Text' })).toBeUndefined()
    await planRow.unmount()
  })

  test('/clean 關閉後工具列與合併框都恢復原樣，再打一次又開回來', async ($, on) => {
    await start($, on)
    await reportPlan($, STEPS)
    await $.command.run({ command: 'clean', args: '' } as any)
    const off = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...READ_ROW } as any)
    expect(await off.find({ type: 'Text', text: /engine draws/ })).toBeDefined()
    await off.unmount()
    expect(await isBoxDrawn($)).toBe(false)

    await $.command.run({ command: 'clean', args: '' } as any)
    const on2 = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...READ_ROW } as any)
    expect(await on2.find({ type: 'Text', text: /· 讀取/ })).toBeDefined()
    await on2.unmount()
    expect(await isBoxDrawn($)).toBe(true)
  })

  test('窄終端機拿掉狀態字，步驟多時摺疊成有限列數', async ($, on) => {
    await start($, on)
    await reportPlan($, STEPS)
    const narrow = await mountBand($, { bodyColumns: 30 })
    expect(await narrow.find({ type: 'Text', text: /^Working$/ })).toBeUndefined()
    expect(await narrow.find({ type: 'Text', text: /^▆+$/ })).toBeDefined()
    await narrow.unmount()

    const many = Array.from({ length: 10 }, (_, i) => ({ title: `步驟 ${i + 1}`, status: i === 0 ? 'in_progress' : 'pending' }))
    await reportPlan($, many)
    const short = await mountBand($, { maxRows: 9 }) // 框線 2 列、標題列 1 列（沒有摘要時用目前步驟當標題）、整體進度與 Plan: 2 列，步驟剩 4 列
    expect(await short.find({ type: 'Text', text: /^還有 7 項$/ })).toBeDefined()
    expect(await short.find({ type: 'Text', text: /^步驟 1$/ })).toBeDefined()
    await short.unmount()
  })
})

describe('clean-view 進度條動畫', () => {
  test('回合開始才跑、結束就停，重複回報計畫不會多開計時器', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)

    await reportPlan($, STEPS) // 回合還沒開始，不跑
    await clock.advance(600)
    expect(await cometHead($)).toBe(0)

    await $.turn.start({ text: '開始', turnId: 'turn-1' } as any)
    await clock.advance(600)
    expect(await cometHead($)).toBe(3)

    await reportPlan($, STEPS)
    await clock.advance(600)
    expect(await cometHead($)).toBe(6) // 只有一個計時器，每 200ms 走一格

    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1 } as any)
    await clock.advance(600)
    expect(await cometHead($)).toBe(6)
  })

  test('熱重載（session.start 再跑一次）會接回動畫，但不會多開一個計時器', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)
    await $.turn.start({ text: '開始', turnId: 'turn-1' } as any)
    await reportPlan($, STEPS)
    await clock.advance(600)
    expect(await cometHead($)).toBe(3)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await clock.advance(600)
    expect(await cometHead($)).toBe(6) // 兩個計時器的話會是 9
  })

  test('經過時間：第二個回合從 0 重新算，subagent 的回合結束不會讓它停住', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)
    const elapsedShown = async (seconds: string) => {
      const ui = await mountBand($)
      const found = await ui.find({ type: 'Text', text: new RegExp(`^${seconds}$`) })
      await ui.unmount()
      return found !== undefined
    }
    await $.turn.start({ text: '第一回合', turnId: 'turn-1' } as any)
    await reportPlan($, STEPS)
    await clock.advance(5_000)
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1 } as any)
    await $.turn.start({ text: '第二回合', turnId: 'turn-2' } as any)
    await clock.advance(2_000)
    expect(await elapsedShown('2s')).toBe(true)
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, agentId: 'agent-1' } as any)
    await clock.advance(1_000)
    expect(await elapsedShown('3s')).toBe(true)
  })

  test('沒有 where-am-i 摘要時，標題改用目前步驟的標題，不會只剩一個「✳」', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)
    await $.turn.start({ text: '開始', turnId: 'turn-1' } as any)
    await reportPlan($, STEPS)
    await clock.advance(4_000)
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Text', text: /^✳ 修改 config\.ts$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4s$/ })).toBeDefined()
    await ui.unmount()
  })

  test('subagent 的回合結束不影響主迴圈的動畫', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)
    await $.turn.start({ text: '開始', turnId: 'turn-1' } as any)
    await reportPlan($, STEPS)
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, agentId: 'agent-1' } as any)
    await clock.advance(400)
    expect(await cometHead($)).toBe(2)
  })

  test('prompt 送出但回合沒開始（例如被擋下）時不跑', async ($, on) => {
    const clock = mock.clock(on)
    await start($, on)
    await reportPlan($, STEPS)
    await $.prompt.submit({ text: '會被擋下的訊息' } as any)
    await clock.advance(600)
    expect(await cometHead($)).toBe(0)
  })
})

describe('clean-view 子代理語言', () => {
  // 代替 engine 啟動子代理，記下子代理實際拿到的任務
  function recordSpawns(on: any) {
    const prompts: string[] = []
    on('agent.spawn', (_$: any, e: any) => {
      prompts.push(e.prompt)
      return { model: 'test-model', agentId: `agent-${prompts.length}` }
    })
    return prompts
  }
  const languageNote = (prompt: string) => prompt.slice(prompt.indexOf('# Language'))

  test('子代理的任務尾端附上繁體中文要求，每次內容都一樣', async ($, on) => {
    const prompts = recordSpawns(on)
    await start($, on)
    await $.agent.spawn({ prompt: 'Read README.md.', description: 'read' } as any)
    await $.agent.spawn({ prompt: 'Run the tests.  \n', description: 'test' } as any)

    const [first, second] = prompts as [string, string]
    expect(first.startsWith('Read README.md.\n\n# Language\n')).toBe(true)
    expect(first).toContain('Traditional Chinese (Taiwan usage)')
    expect(first).toContain('the description you give each tool call')
    expect(second.startsWith('Run the tests.\n\n# Language\n')).toBe(true) // 原任務尾端的空白收掉
    expect(languageNote(second)).toBe(languageNote(first))
  })

  test('任務裡已經有語言要求時不重複附加', async ($, on) => {
    const prompts = recordSpawns(on)
    await start($, on)
    await $.agent.spawn({ prompt: 'Read README.md.', description: 'read' } as any)
    await $.agent.spawn({ prompt: prompts[0]!, description: 'again' } as any)
    expect(prompts[1]).toBe(prompts[0])
    expect(prompts[1]!.split('# Language').length).toBe(2)
  })

  test('workflow 啟動的 agent 內容不能改寫，原樣放行', async ($, on) => {
    const prompts = recordSpawns(on)
    await start($, on)
    await $.agent.spawn({ prompt: 'Step one.', description: 'wf', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
    expect(prompts).toEqual(['Step one.'])
  })

  test('system prompt：有計畫工具才加計畫指示，子代理的 # Language 段落不放進來', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'core prompt', scope: 'shared' }] }))
    await start($, on)
    // 測試裡的 session 沒有模型，compose 要的事實自己補齊
    const facts = { model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
    const withPlan = await $.prompt.compose({ ...facts, tools: [PLAN_TOOL] })
    expect(withPlan.sections.map(section => section.id)).toEqual(['intro', 'clean-view:plan'])
    expect(withPlan.sections[1]!.scope).toBe('session')
    expect(withPlan.sections[1]!.text).toContain('# Plan checklist')
    expect(await $.prompt.compose({ ...facts, tools: [PLAN_TOOL] })).toEqual(withPlan) // 內容固定，prompt cache 不會失效

    const withoutPlan = await $.prompt.compose({ ...facts, tools: ['Read'] })
    expect(withoutPlan.sections.map(section => section.id)).toEqual(['intro'])
    expect(JSON.stringify([withPlan, withoutPlan])).not.toContain('# Language')
  })

  test('計畫指示最後一行要求進度說明與回應系統提醒的近況用繁體中文', async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    await start($, on)
    const facts = { model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
    const { sections } = await $.prompt.compose({ ...facts, tools: [PLAN_TOOL] })

    const languageLine = sections[0]!.text.split('\n').at(-1)!
    expect(languageLine).toContain('progress notes between tool calls')
    expect(languageLine).toContain('in reply to a system reminder')
    expect(languageLine).toContain('Traditional Chinese (Taiwan usage)')
    expect(languageLine).toContain('even when your thinking or the reminder is in English')
    expect(languageLine).toContain('keep code identifiers, commands and paths as they are')
  })
})

describe('clean-view 純函式', () => {
  test('合併框的顯示模式', () => {
    const steps = parseSteps(STEPS)!
    expect(combinedBoxMode(true, steps)).toBe('always')
    expect(combinedBoxMode(true, DONE_STEPS)).toBe('whileWorking')
    expect(combinedBoxMode(true, [])).toBe('hidden')
    expect(combinedBoxMode(false, steps)).toBe('hidden')
    expect(isCombinedBoxShown('always', false)).toBe(true)
    expect(isCombinedBoxShown('whileWorking', false)).toBe(false)
    expect(isCombinedBoxShown('whileWorking', true)).toBe(true)
    expect(isCombinedBoxShown('hidden', true)).toBe(false)
  })

  test('方格顏色：完成綠漸層、未開始只有灰色底、進行中是帶漸暗尾巴的彗星、暫停停住變淺灰', () => {
    const done = stepBar('completed', 0)
    expect(done.length).toBe(12)
    expect(done[0]).toBe('#2c9a52')
    expect(done[11]).toBe('#9ee6b4')
    expect(stepBar('pending', 3)).toEqual(Array(12).fill(TRACK))
    const lit = (display: 'running' | 'paused', frame: number) =>
      stepBar(display, frame)
        .map(color => (color === TRACK ? '.' : '#'))
        .join('')
    expect(lit('running', 0)).toBe('#...........') // 彗星頭從左邊進來
    expect(lit('running', 3)).toBe('####........')
    expect(lit('running', 8)).toBe('....#####...') // 頭加四格尾巴
    expect(lit('running', 14)).toBe('..........##') // 從右邊出去，只剩尾巴
    expect(lit('running', 16)).toBe('............') // 整顆離開
    expect(lit('running', 17)).toBe(lit('running', 0)) // 週期 12 + 5 拍
    // 頭最亮，尾巴越後面越淡（越接近灰色底）
    const comet = stepBar('running', 8)
    expect(comet[8]).toBe(cometColor(8))
    const distanceToTrack = (hex: string) => [1, 3, 5].reduce((sum, i) => sum + Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(TRACK.slice(i, i + 2), 16)), 0)
    expect(distanceToTrack(comet[8]!)).toBeGreaterThan(distanceToTrack(comet[7]!))
    expect(distanceToTrack(comet[5]!)).toBeGreaterThan(distanceToTrack(comet[4]!))
    // 暫停時不管停在哪一拍，彗星都固定在左邊、整顆看得見（之前可能停在出界的位置，看起來跟未開始一樣）
    expect(lit('paused', 8)).toBe('#####.......')
    expect(lit('paused', 16)).toBe('#####.......')
    expect(stepBar('paused', 8)[4]).toBe('#8a8a94')
  })

  test('彗星顏色隨時間：橘 → 粉紅 → 紫 → 藍，再反向變回橘', () => {
    expect(cometColor(0)).toBe('#f79a4f')
    expect(cometColor(5)).toBe('#ec4f8f')
    expect(cometColor(10)).toBe('#b45ce6')
    expect(cometColor(15)).toBe('#6f7df2')
    expect(cometColor(20)).toBe('#b45ce6') // 反向
    expect(cometColor(30)).toBe('#f79a4f')
  })

  test('整體進度：Step x of y、只算已完成的百分比、漸層鋪在填滿的那段，全部完成變綠', () => {
    const steps = parseSteps(STEPS)!
    const still = { frame: 0, isAnimated: false }
    const overall = overallProgress(steps, { barWidth: 91, ...still })
    expect(overall.label).toBe('Step 2 of 3')
    expect(overall.percent).toBe('33%')
    expect(overall.cells.length).toBe(91)
    expect(overall.cells[0]).toBe('#f79a4f') // 填滿那段的起點是橘色
    expect(overall.cells[29]).toBe('#ec4f8f') // 填滿那段的尾端是粉紅（91 格的 1/3 四捨五入是 30 格）
    expect(overall.cells[30]).toBe(TRACK)
    expect(overall.isFinished).toBe(false)

    const notStarted = overallProgress(parseSteps([{ title: 'a', status: 'completed' }, { title: 'b', status: 'pending' }])!, { barWidth: 10, ...still })
    expect(notStarted.label).toBe('Step 2 of 2') // 沒有進行中時指向下一步
    expect(notStarted.percent).toBe('50%')

    const finished = overallProgress(DONE_STEPS, { barWidth: 20, ...still })
    expect(finished.label).toBe('Step 3 of 3')
    expect(finished.percent).toBe('100%')
    expect(finished.isFinished).toBe(true)
    expect(finished.cells[0]).toBe('#2c9a52')
    expect(finished.cells[19]).toBe('#9ee6b4')

    // 整體進度條從步驟進度條那一欄開始，留 5 格給百分比
    const view = planView(steps, { frame: 0, isWorking: true, columns: 116, rows: 16 })
    expect(view.overall.cells.length).toBe(116 - view.titleColumns - 5)
  })

  test('整體長條的亮光：兩格寬、每拍（0.2 秒）往右一格，只在填滿的那段，閒置時不畫', () => {
    const steps = parseSteps(STEPS)!
    const plain = overallProgress(steps, { barWidth: 91, frame: 0, isAnimated: false }).cells
    const shimmerAt = (frame: number) =>
      overallProgress(steps, { barWidth: 91, frame, isAnimated: true })
        .cells.flatMap((color, index) => (color !== plain[index] ? [index] : []))
    expect(shimmerAt(0)).toEqual([0]) // 從第一格進來
    expect(shimmerAt(10)).toEqual([9, 10]) // 第 10 拍，亮光頭在第 10 格
    expect(shimmerAt(11)).toEqual([10, 11]) // 每拍走一格
    expect(shimmerAt(30)).toEqual([29]) // 填滿 30 格，走到尾端只剩一格
    expect(shimmerAt(32)).toEqual([]) // 掃完停頓
    expect(shimmerAt(34)).toEqual([0]) // 週期 30 格 + 停 4 格，再從頭來
    expect(overallProgress(steps, { barWidth: 91, frame: 0, isAnimated: true }).cells[0]).toBe('#fabd8d') // 橘色往白色混 35%
    expect(overallProgress(steps, { barWidth: 91, frame: 10, isAnimated: false }).cells).toEqual(plain)
  })

  test('經過時間的格式', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(21_400)).toBe('21s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
  })

  test('標題依顯示寬度截斷補「…」，中文一字兩格', () => {
    expect(fitToWidth('合併兩個框', 40)).toBe('合併兩個框')
    expect(fitToWidth('abcdefghij', 5)).toBe('abcd…')
    expect(fitToWidth('合併兩個框', 6)).toBe('合併…')
    expect(fitToWidth('', 10)).toBe('')
    expect(fitToWidth('abc', 0)).toBe('') // 沒有空間時不硬塞「…」
    expect(fitToWidth('abc', -3)).toBe('')
  })

  test('計時器間隔：有彗星或亮光每 0.2 秒，只剩經過秒數時每秒，沒有計畫不跑', () => {
    expect(animationIntervalMs([])).toBeNull()
    expect(animationIntervalMs(parseSteps(STEPS)!)).toBe(200) // 有進行中的步驟（彗星）
    expect(animationIntervalMs(parseSteps([{ title: 'a', status: 'completed' }, { title: 'b', status: 'pending' }])!)).toBe(200) // 整體長條有亮光
    expect(animationIntervalMs(DONE_STEPS)).toBe(1000) // 全部完成，只剩秒數
    expect(animationIntervalMs(parseSteps([{ title: 'a', status: 'pending' }])!)).toBe(1000)
  })

  test('同色格子合併成一段', () => {
    expect(colorRuns(['#a', '#a', '#b', '#a'])).toEqual([
      { color: '#a', count: 2 },
      { color: '#b', count: 1 },
      { color: '#a', count: 1 },
    ])
    expect(colorRuns([])).toEqual([])
    expect(colorRuns(stepBar('pending', 0))).toEqual([{ color: TRACK, count: 12 }])
  })

  test('Step x of y 指向進行中或第一個還沒完成的步驟', () => {
    expect(overallLabel(parseSteps(STEPS)!)).toBe('Step 2 of 3')
    expect(overallLabel(parseSteps([{ title: 'a', status: 'pending' }, { title: 'b', status: 'completed' }, { title: 'c', status: 'completed' }])!)).toBe('Step 1 of 3')
    expect(overallLabel(DONE_STEPS)).toBe('Step 3 of 3')
  })

  test('標籤欄至少放得下「  Step x of y」，步驟標題很短也不會換行', () => {
    const short = parseSteps([{ title: '讀檔', status: 'completed' }, { title: '修改', status: 'in_progress' }, { title: '測試', status: 'pending' }])!
    const view = planView(short, { frame: 0, isWorking: true, columns: 116, rows: 16 })
    expect(view.titleColumns).toBeGreaterThanOrEqual('  Step 2 of 3'.length + 1)
    expect(view.overall.cells.length).toBe(116 - view.titleColumns - 5)
  })

  test('標題列：有目標用目標，沒有用目前步驟，兩邊都沒有就不畫', () => {
    const steps = parseSteps(STEPS)!
    expect(titleRow('合併兩個框', steps, '3s', 116)).toEqual({ text: '✳ 合併兩個框', elapsed: '3s' })
    expect(titleRow('', steps, '3s', 116)).toEqual({ text: '✳ 修改 config.ts', elapsed: '3s' })
    expect(titleRow('', DONE_STEPS, '5s', 116)).toEqual({ text: '', elapsed: '5s' }) // 全部完成，沒有目前步驟
    expect(titleRow('', [], null, 116)).toBeNull()
    expect(titleRow('合併兩個框', steps, null, 10)).toBeNull() // 太窄放不下標題，也沒有時間
  })

  test('整體長條亮光在填滿 0、1 格時的行為', () => {
    const oneOfThree = parseSteps([{ title: 'a', status: 'completed' }, { title: 'b', status: 'in_progress' }, { title: 'c', status: 'pending' }])!
    const lit = (frame: number) => {
      const plain = overallProgress(oneOfThree, { barWidth: 3, frame, isAnimated: false }).cells
      return overallProgress(oneOfThree, { barWidth: 3, frame, isAnimated: true }).cells.flatMap((color, index) => (color !== plain[index] ? [index] : []))
    }
    expect(lit(0)).toEqual([0]) // 填滿 1 格，亮光只會出現在那一格
    expect(lit(1)).toEqual([0])
    expect(lit(2)).toEqual([])
    const none = parseSteps([{ title: 'a', status: 'in_progress' }, { title: 'b', status: 'pending' }])!
    for (const frame of [0, 1, 2, 3]) {
      expect(overallProgress(none, { barWidth: 10, frame, isAnimated: true }).cells).toEqual(Array(10).fill(TRACK)) // 沒有填滿的格子就沒有亮光
    }
  })

  test('列數預算：先摺疊已完成，再把後段收成「還有 N 項」', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ title: `步驟 ${i + 1}`, status: i < 4 ? 'completed' : i === 4 ? 'in_progress' : 'pending' }) as const)
    expect(planRows(steps, 9, true).length).toBe(9)
    const folded = planRows(steps, 6, true)
    expect(folded.map(row => row.text)).toEqual(['已完成 4 項', '步驟 5', '步驟 6', '步驟 7', '步驟 8', '步驟 9'])
    const squeezed = planRows(steps, 4, true)
    expect(squeezed.map(row => row.text)).toEqual(['已完成 4 項', '步驟 5', '步驟 6', '還有 3 項'])
    expect(squeezed[1]!.display).toBe('running')
    expect(planRows(steps, 4, false)[1]!.display).toBe('paused')
  })

  test('欄寬：對齊最長標題，太窄時先拿掉狀態字', () => {
    const rows = planRows(parseSteps(STEPS)!, 7, true)
    expect(planLayout(rows, 120)).toEqual({ titleColumns: 4 + 14 + 2, isStatusShown: true }) // 「修改 config.ts」寬 14
    expect(planLayout(rows, 30)).toEqual({ titleColumns: 16, isStatusShown: false })
  })

  test('輸入檢查與工具摘要字樣', () => {
    expect(parseSteps('nope')).toBeNull()
    expect(parseSteps([{ title: 'a' }])).toBeNull()
    const call = { tool: 'Bash', input: { command: 'npm test', description: '跑測試' }, isRunning: false, isInterrupted: false }
    expect(toolLine({ ...call, isErrored: true })).toEqual({ text: '  · 執行：跑測試（失敗）', color: 'error' })
    expect(toolLine({ ...call, isErrored: false, isRunning: true }).text).toBe('  · 執行：跑測試 …')
  })
})
