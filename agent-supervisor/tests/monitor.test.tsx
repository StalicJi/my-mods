import { describe, expect, test } from 'claude-code/testing'

import { callTool, drawnRows, engine, finishTurn, paneOf, runSupervisor, spawnAgent, start, step } from './harness'

describe('子代理事件', () => {
  test('派出時記下名稱、類型與任務；被擋下、沒有 agentId、teammate 不記', async ($, on) => {
    const control = engine(on)
    control.spawnReplies.push({ deny: '不行' }, { model: 'claude-opus-5-5' }, { model: 'claude-opus-5-5', agentId: 't9', teammateId: 'bob@team' })
    await start($)
    await spawnAgent($)
    await spawnAgent($)
    await spawnAgent($)
    expect(control.state.get('agents') ?? []).toHaveLength(0)
    await spawnAgent($, { name: 'backend', description: '實作 API', subagentType: 'general-purpose' })
    expect(control.state.get('agents')[0]).toMatchObject({ id: 'a1', name: 'backend', description: '實作 API', phase: 'running', source: 'event' })
  })

  test('子代理的工具呼叫記下最近活動；連續失敗累計次數', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await callTool($, { tool: 'Read', file_path: '/w/src/api.ts', agentId: 'a1' })
    expect(control.state.get('agents')[0]).toMatchObject({ activity: '讀取 src/api.ts', toolCount: 1 })
    control.toolReplies.push({ result: {}, text: 'Exit code 1\nboom', isError: true }, { deny: '權限被拒' })
    await callTool($, { tool: 'Bash', command: 'npm test', agentId: 'a1' })
    await callTool($, { tool: 'Bash', command: 'npm test', agentId: 'a1' })
    expect(control.state.get('agents')[0]).toMatchObject({ toolErrorStreak: 2, lastToolError: '權限被拒' })
  })

  test('子代理送出請求時活動改成思考中', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await step($, 'a1')
    expect(control.state.get('agents')[0]).toMatchObject({ activity: '思考中' })
  })

  test('結束事件：正常回答 completed，中斷 failed 並寫原因', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await spawnAgent($)
    await finishTurn($, { agentId: 'a1' })
    await finishTurn($, { agentId: 'a2', reason: 'aborted' })
    const [first, second] = control.state.get('agents')
    expect(first).toMatchObject({ phase: 'completed', source: 'event' })
    expect(second).toMatchObject({ phase: 'failed', failureReason: '已中斷' })
  })

  test('不認得的 agentId 結束：清單上有就補上並結束，清單上沒有（Claude Code 內部的 fork）不記', async ($, on) => {
    const control = engine(on)
    await start($)
    control.listed = [{ id: 'x1', description: '補上的', type: 'Explore', status: 'running' }]
    await finishTurn($, { agentId: 'x1' })
    await finishTurn($, { agentId: 'fork-1' })
    await callTool($, { tool: 'Read', file_path: '/a', agentId: 'fork-1' })
    const agents = control.state.get('agents')
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ id: 'x1', phase: 'completed', startedAt: null })
  })
})

describe('主對話', () => {
  test('回合開始是 RUNNING、工具活動記在主對話、回合結束回到閒置', async ($, on) => {
    const control = engine(on)
    await start($)
    await $.turn.start({ text: '開始', turnId: 't1' })
    expect(control.state.get('mainLoop')).toMatchObject({ isRunning: true })
    await callTool($, { tool: 'Grep', pattern: 'api' })
    expect(control.state.get('mainLoop')).toMatchObject({ activity: '搜尋 "api"' })
    await finishTurn($)
    expect(control.state.get('mainLoop')).toMatchObject({ isRunning: false })
  })
})

describe('跟代理清單對帳與計時器', () => {
  test('有還沒結束的代理時每 3 秒對帳一次；全部結束後計時器停下', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    control.listed = [{ id: 'a1', description: '任務', type: 'general-purpose', status: 'idle' }]
    await control.clock.advance(3000)
    expect(control.state.get('agents')[0]).toMatchObject({ phase: 'idle', source: 'engine' })
    await finishTurn($, { agentId: 'a1' })
    await control.clock.advance(1000)
    const calls = control.listCalls
    await control.clock.advance(9000)
    expect(control.listCalls).toBe(calls)
  })

  test('session 開始時（含熱重載）從清單補上還在跑的代理', async ($, on) => {
    const control = engine(on)
    control.listed = [{ id: 'x1', description: '重載前就在跑', type: 'Explore', status: 'running' }]
    await start($)
    expect(control.state.get('agents')[0]).toMatchObject({ id: 'x1', description: '重載前就在跑', phase: 'running', startedAt: null })
  })
})

describe('狀態列與面板', () => {
  test('有代理在跑而面板沒開時，輸入框下方釘一行狀態；開了面板就清掉；都結束了也清掉', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    expect(control.statuses.at(-1)).toBe('Supervisor ●1 · /supervisor')
    await runSupervisor($)
    await control.clock.advance(1000)
    expect(control.statuses.at(-1)).toBeUndefined()
    await runSupervisor($)
    await control.clock.advance(1000)
    expect(control.statuses.at(-1)).toBe('Supervisor ●1 · /supervisor')
    await finishTurn($, { agentId: 'a1' })
    expect(control.statuses.at(-1)).toBeUndefined()
  })

  test('session 結束時停計時器、清狀態列', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await $.session.end({ reason: 'exit' } as any)
    expect(control.statuses.at(-1)).toBeUndefined()
    const calls = control.listCalls
    await control.clock.advance(9000)
    expect(control.listCalls).toBe(calls)
  })

  test('/clear 時清掉代理紀錄', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    await $.session.end({ reason: 'clear' } as any)
    expect(control.state.get('agents')).toEqual([])
  })

  test('面板畫出 Supervisor 與每個代理', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { name: 'backend', description: '實作 Modbus API' })
    const ui = await $.ui.mount(paneOf() as any)
    const rows = drawnRows(await ui.drawn())
    expect(rows[0]).toMatch(/Supervisor/)
    expect(rows.some(row => /backend.*RUNNING$/.test(row))).toBe(true)
    expect(rows.some(row => row.includes('實作 Modbus API'))).toBe(true)
    expect(control.state.get('agents')).toHaveLength(1)
    await ui.unmount()
  })
})
