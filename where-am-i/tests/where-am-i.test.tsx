import { describe, expect, mock, test } from 'claude-code/testing'

import { clip, describe as label, parseRecap } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } }

const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

// Stands for the engine beneath the mod.
function engine(on: any, reply: string) {
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.submit', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'sweep runner', type: 'general-purpose', status: 'running' }] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'build the mods', toolUses: [] }] }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'band below' }) // stands for Token Weather and the engine's own band
  })
}

// 代替 host 的工具清單：clean-view 載入時會列出它的計畫工具，停用後就沒有；listed 記下被列了幾次
function toolList(on: any) {
  const tools = { isCleanViewLoaded: true, listed: 0 }
  on('tool.list', () => {
    tools.listed += 1
    return { value: tools.isCleanViewLoaded ? [{ name: 'mcp__clean-view__update_plan', description: '', mcp: true }] : [] }
  })
  return tools
}

// 代替 clean-view 寫入的 combinedBox，並準備好一份摘要
async function withCombinedBox($: any, on: any, mode: 'hidden' | 'whileWorking' | 'always') {
  engine(on, '{"goal":"合併兩個框","now":"改好了","waiting":"","next":"測試"}')
  on('state.get', { plugin: 'clean-view', key: 'combinedBox' }, () => ({ value: { value: mode, version: 1 } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
  await wait()
}

async function mountBand($: any) {
  return $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
}

async function isRecapDrawn(ui: any) {
  return (await ui.find({ type: 'Text', text: /^合併兩個框$/ })) !== undefined
}

describe('where-am-i', () => {
  test('draws the recap above what was already there', async ($, on) => {
    engine(on, '```json\n{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"you to test it","next":"Rulebook Guard"}\n```')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'ship all 3' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/work/a/b.ts', content: 'x' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /^Ship 3 mods$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^built Where Am I$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Wait: you to test it/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await ui.unmount()
  })

  test('leaves out next while the next-steps mod shows it', async ($, on) => {
    engine(on, '{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"","next":"Rulebook Guard"}')
    let nextStepsOn = false // stands for the value next-steps sets when it starts
    on('state.get', { plugin: 'next-steps', key: 'active' }, () => ({ value: { value: nextStepsOn || undefined, version: nextStepsOn ? 1 : 0 } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    const shown = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await shown.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeDefined()
    await shown.unmount()

    nextStepsOn = true
    const hidden = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await hidden.find({ type: 'Text', text: /^Ship 3 mods$/ })).toBeDefined()
    expect(await hidden.find({ type: 'Text', text: /Next:/ })).toBeUndefined()
    expect(await hidden.find({ type: 'Text', text: /^Rulebook Guard$/ })).toBeUndefined()
    await hidden.unmount()
  })

  // Stands for glance: a mod that calls an MCP tool in the background, as `$.mcp.call` does.
  const glance = {
    name: 'glance',
    register(on: any) {
      on('command.run', { command: 'peek' }, async ($: any) => {
        await $.tool.call({ tool: 'mcp__claude_ai_Slack__slack_search_public_and_private', query: 'x' })
        return { text: 'peeked' }
      })
    },
  }

  test('a call another mod makes does not change now; one Claude makes does', { plugins: [glance] }, async ($, on) => {
    engine(on, '{"goal":"Ship 3 mods","now":"built Where Am I","waiting":"","next":"Rulebook Guard"}')
    on('command.run', () => ({ text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    // Idle: glance checks Slack in the background.
    await $.command.run({ command: 'peek', args: '' } as any)
    const idle = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await idle.find({ type: 'Text', text: /^built Where Am I$/ })).toBeDefined()
    expect(await idle.find({ type: 'Text', text: /slack/ })).toBeUndefined()
    await idle.unmount()

    // Claude's own call shows as now.
    await $.prompt.submit({ text: 'ship all 3' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/a/b.ts' } as any)
    const busy = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await busy.find({ type: 'Text', text: /^讀取 a\/b.ts$/ })).toBeDefined()
    await busy.unmount()
  })

  test('/recap answers with a summary', async ($, on) => {
    engine(on, '- Goal: ship 3 mods')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const r = await $.command.run({ command: 'where', args: '' } as any)
    expect(r.text).toBe('- Goal: ship 3 mods')
  })

  test('用繁體中文描述工具呼叫', () => {
    expect(label({ tool: 'Bash', description: '執行測試' })).toBe('執行：執行測試')
    expect(label({ tool: 'Bash', command: 'npm test' })).toBe('執行：npm test')
    expect(label({ tool: 'Edit', file_path: '/a/b/c.ts' })).toBe('編輯 b/c.ts')
    expect(label({ tool: 'Write', file_path: '/a/b/c.ts' })).toBe('寫入 b/c.ts')
    expect(label({ tool: 'Read', file_path: '/a/b/c.ts' })).toBe('讀取 b/c.ts')
    expect(label({ tool: 'Grep', pattern: 'clip' })).toBe('搜尋 "clip"')
    expect(label({ tool: 'WebFetch', url: 'https://example.com/a?b=1' })).toBe('讀取網頁 example.com')
    expect(label({ tool: 'Agent', description: '搜尋 hooks.json' })).toBe('委派 agent：搜尋 hooks.json')
    expect(label({ tool: 'AskUserQuestion' })).toBe('詢問你問題')
    expect(label({ tool: 'mcp__claude_ai_Slack__slack_send_message' })).toBe('使用 claude_ai_Slack slack_send_message')
  })

  test('送出訊息後 now 顯示「正在讀你的訊息」', async ($, on) => {
    engine(on, '{"goal":"改成中文","now":"改好了","waiting":"","next":"測試"}')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()
    await $.prompt.submit({ text: '下一步' } as any)
    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /^正在讀你的訊息$/ })).toBeDefined()
    await ui.unmount()
  })

  test('reads the JSON and drops em dashes', () => {
    expect(parseRecap('{"goal":"A — B","now":"","waiting":"","next":""}')?.goal).toBe('A, B')
    expect(parseRecap('no json here')).toBeNull()
    const long = parseRecap('{"goal":"g","now":"Part A of Merge Gate passed. Codex rules block without the luna model and codex exec too.","waiting":"","next":""}')
    expect(long?.now).toBe('Part A of Merge Gate passed')
  })

  test('中文：只取第一句，去掉句尾句號', () => {
    expect(clip('安裝並測試 where-am-i 外掛。接著改成繁體中文。')).toBe('安裝並測試 where-am-i 外掛')
    expect(clip('版本 v0.1.4 已安裝')).toBe('版本 v0.1.4 已安裝')
  })

  test('中文：依顯示寬度截斷，一個中文字算兩格', () => {
    const long = '這是一段很長的中文摘要內容用來測試截斷功能是否正確運作而且不會超出畫面寬度的限制範圍喔'
    const clipped = clip(long)
    const width = Array.from(clipped).reduce((sum, char) => sum + (char === '…' ? 1 : 2), 0)
    expect(clipped.endsWith('…')).toBe(true)
    expect(width).toBeLessThanOrEqual(70)
    expect(width).toBeGreaterThan(60)
  })

  test('中英混合：結尾是英文單字時退回空格，結尾是中文時直接斷', () => {
    // 40 格會切在 longRecap 中間，應退回前一個空格
    expect(clip('修改 register.tsx 裡的 summarize 與 longRecap 兩個 system prompt', 40)).toBe('修改 register.tsx 裡的 summarize 與…')
    expect(clip('正在讀取設定檔並比對兩個版本之間的差異', 20)).toBe('正在讀取設定檔並比…')
  })

  test('next 獨立一行，排在 now 下面', async ($, on) => {
    engine(on, '{"goal":"調整版面","now":"改好了","waiting":"等你確認","next":"跑測試"}')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    const [framed] = ((await ui.drawn()) as any).children
    const rows = framed.children.map((row: unknown) => JSON.stringify(row))
    expect(rows).toHaveLength(4)
    expect(rows[1]).toContain('Now: ')
    expect(rows[1]).not.toContain('Next')
    expect(rows[2]).toContain('Next: ')
    expect(rows[2]).toContain('跑測試')
    expect(rows[3]).toContain('Wait: 等你確認')
    await ui.unmount()
  })

  test('摘要區塊有圓角外框，其他 mod 的內容留在框外', async ($, on) => {
    engine(on, '{"goal":"加上外框","now":"改好了","waiting":"","next":"測試"}')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'where-am-i', surface, ...BAND } as any)
      const [framed, rest] = ((await ui.drawn()) as any).children
      expect(framed.props.borderStyle).toBe('round')
      expect(JSON.stringify(framed)).toContain('加上外框')
      expect(JSON.stringify(framed)).not.toContain('band below')
      expect(JSON.stringify(rest)).toContain('band below')
      await ui.unmount()
    }
  })

  test('clean-view 的合併框顯示時讓出位置：always 一律讓，whileWorking 只在回合中讓', async ($, on) => {
    engine(on, '{"goal":"合併兩個框","now":"改好了","waiting":"","next":"測試"}')
    let mode: 'hidden' | 'whileWorking' | 'always' = 'hidden' // 代替 clean-view 寫入的 combinedBox
    on('state.get', { plugin: 'clean-view', key: 'combinedBox' }, () => ({ value: { value: mode, version: 1 } }))
    mock.clock(on)
    toolList(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()

    const drawsOwnBox = async (isWorking: boolean) => {
      const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking } } as any)
      const isDrawn = (await ui.find({ type: 'Text', text: /^合併兩個框$/ })) !== undefined
      expect(await ui.find({ type: 'Text', text: /band below/ })).toBeDefined()
      await ui.unmount()
      return isDrawn
    }

    expect(await drawsOwnBox(false)).toBe(true)
    mode = 'always'
    expect(await drawsOwnBox(false)).toBe(false)
    mode = 'whileWorking'
    expect(await drawsOwnBox(false)).toBe(true)
    expect(await drawsOwnBox(true)).toBe(false)
  })

  test('clean-view 的計畫工具不算正在做的事，Now 不會變成它', async ($, on) => {
    engine(on, '{"goal":"合併兩個框","now":"改好了","waiting":"","next":"測試"}')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await wait()
    await $.prompt.submit({ text: '開始' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/a/b.ts' } as any)
    await $.tool.call({ tool: 'mcp__clean-view__update_plan', steps: [] } as any)
    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /^讀取 a\/b.ts$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /update_plan/ })).toBeUndefined()
    await ui.unmount()
  })

  test('clean-view 停用後 combinedBox 停在 always，摘要框照樣顯示', async ($, on) => {
    mock.clock(on)
    toolList(on).isCleanViewLoaded = false
    await withCombinedBox($, on, 'always')

    const ui = await mountBand($)
    expect(await isRecapDrawn(ui)).toBe(true)
    await ui.unmount()
  })

  test('列工具的結果留用 2 秒；期間 clean-view 停用，到期重新確認後自己重畫', async ($, on) => {
    const clock = mock.clock(on)
    const tools = toolList(on)
    await withCombinedBox($, on, 'always')

    const first = await mountBand($)
    expect(await isRecapDrawn(first)).toBe(false)
    await first.unmount()
    expect(tools.listed).toBe(1)

    // 停用 clean-view 後的那次重畫還在留用期間：先照舊讓位，並排好到期後的重新確認
    tools.isCleanViewLoaded = false
    const afterReload = await mountBand($)
    expect(await isRecapDrawn(afterReload)).toBe(false)
    expect(tools.listed).toBe(1)

    await clock.advance(2000)
    expect(tools.listed).toBe(2)
    expect(await isRecapDrawn(afterReload)).toBe(true)
    await afterReload.unmount()
  })

  test('列不出工具時照 combinedBox 讓位，不讓兩個框同時出現', async ($, on) => {
    mock.clock(on)
    on('tool.list', () => {
      throw new Error('列不出工具')
    })
    await withCombinedBox($, on, 'always')

    const ui = await mountBand($)
    expect(await isRecapDrawn(ui)).toBe(false)
    await ui.unmount()
  })
})
