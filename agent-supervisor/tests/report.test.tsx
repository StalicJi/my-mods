import { describe, expect, test } from 'claude-code/testing'

import { callTool, drawnRows, engine, finishTurn, paneOf, spawnAgent, start } from './harness'

const REPORT_TOOL = 'mcp__agent-supervisor__report'
const report = ($: any, input: object, agentId?: string) => callTool($, { tool: REPORT_TOOL, ...input, ...(agentId ? { agentId } : {}) })

describe('回報工具', () => {
  test('session 開始時註冊，不必經 ToolSearch；說明要求任務標題用繁體中文', async ($, on) => {
    const control = engine(on)
    await start($)
    const tool = control.tools.find(registered => registered.name === 'report')
    expect(tool).toMatchObject({ isDeferred: false })
    expect(tool.description).toContain('Traditional Chinese (Taiwan usage)')
  })

  test('子代理回報的任務記在它名下；結果用繁體中文回覆', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { name: 'backend' })
    const answered = await report($, { tasks: [{ id: 'T1', title: '實作 API', status: 'in_progress' }] }, 'a1')
    expect(answered.result).toBe('已記錄 1 項任務。')
    expect(control.state.get('tasks')).toEqual([
      expect.objectContaining({ id: 'T1', title: '實作 API', status: 'in_progress', owner: 'a1', source: 'report' }),
    ])
  })

  test('主對話登記計畫：owner 寫子代理的名字或任務說明就對到那個代理', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { description: '做前端畫面' })
    await report($, { tasks: [{ id: 'F1', title: '前端畫面', status: 'pending', owner: '做前端畫面', blockedBy: ['B1'] }] })
    expect(control.state.get('tasks')[0]).toMatchObject({ owner: 'a1', blockedBy: ['B1'] })
  })

  test('格式錯誤或新任務沒有標題時拒絕，任務不變', async ($, on) => {
    const control = engine(on)
    await start($)
    const wrong = await report($, { tasks: [{ id: 'T1', status: 'doing' }] })
    expect(wrong.deny).toContain('status 只能是')
    const untitled = await report($, { tasks: [{ id: 'T2' }] })
    expect(untitled.deny).toContain('要有 title')
    expect(control.state.get('tasks') ?? []).toEqual([])
  })

  test('waitingFor 記下在等什麼，空字串清掉；代理結束時也清掉', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    const answered = await report($, { waitingFor: '等 API schema' }, 'a1')
    expect(answered.result).toBe('已記錄等待原因。')
    expect(control.state.get('waiting')).toMatchObject({ a1: { text: '等 API schema' } })
    await report($, { waitingFor: '' }, 'a1')
    expect(control.state.get('waiting')).toEqual({})
    await report($, { waitingFor: '等決定' }, 'a1')
    await finishTurn($, { agentId: 'a1' })
    expect(control.state.get('waiting')).toEqual({})
  })

  test('回報本身算代理的活動「回報任務」，不計成失敗的工具呼叫', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await report($, { tasks: [{ id: 'T1', status: 'pending' }] }, 'a1')
    expect(control.state.get('agents')[0]).toMatchObject({ activity: '回報任務', toolErrorStreak: 0 })
  })
})

describe('Claude Code 原生任務工具', () => {
  test('TaskCreate 的結果建立任務，負責人是呼叫的代理', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    control.toolReplies.push({ result: { task: { id: '7', subject: '寫整合測試' } }, text: '' })
    await callTool($, { tool: 'TaskCreate', subject: '寫整合測試', description: '', agentId: 'a1' })
    expect(control.state.get('tasks')[0]).toMatchObject({ id: '#7', title: '寫整合測試', owner: 'a1', source: 'native' })
  })
})

describe('給模型的說明', () => {
  test('主對話的 system prompt 在有回報工具時加一段 session 說明', async ($, on) => {
    engine(on)
    on('prompt.compose', () => ({ sections: [] }))
    await start($)
    // 測試裡的 session 沒有模型，compose 要的事實自己補齊（跟 clean-view 的測試一樣）
    const facts = { model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
    const composed = await $.prompt.compose({ ...facts, tools: [REPORT_TOOL] })
    const section = composed.sections.find((item: any) => item.id === 'agent-supervisor:report')
    expect(section).toMatchObject({ scope: 'session' })
    expect(section!.text).toContain(REPORT_TOOL)
    const without = await $.prompt.compose({ ...facts, tools: ['Read'] })
    expect(without.sections).toEqual([])
  })

  test('子代理的任務尾端附上何時回報的說明；workflow 的不附', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { prompt: '做事' })
    await spawnAgent($, { prompt: '做事', workflow: { runId: 'r', agentIndex: 0 } })
    const prompts = control.spawnPrompts
    expect(prompts[0]).toContain('做事')
    expect(prompts[0]).toContain(REPORT_TOOL)
    expect(prompts[1]).toBe('做事')
  })
})

describe('面板', () => {
  test('畫出任務區：完成數、百分比與每項任務', async ($, on) => {
    engine(on)
    await start($)
    await spawnAgent($, { name: 'backend' })
    await report($, { tasks: [{ id: 'T1', title: '定義 API', status: 'completed' }, { id: 'T2', title: '實作 API', status: 'in_progress' }] }, 'a1')
    const ui = await $.ui.mount(paneOf({ bodyColumns: 60 }) as any)
    const rows = drawnRows(await ui.drawn())
    expect(rows).toContain('  Completed: 1 / 2 · Progress: 50%')
    expect(rows).toContain('  [>] T2 實作 API · backend')
    await ui.unmount()
  })
})
