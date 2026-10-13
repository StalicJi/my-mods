import { describe, expect, test } from 'claude-code/testing'

import { callTool, drawnRows, engine, finishTurn, paneOf, runSupervisor, spawnAgent, start } from './harness'

test('session 開始時註冊 /supervisor', async ($, on) => {
  const control = engine(on)
  await start($)
  expect(control.commands.map(command => command.name)).toContain('supervisor')
})

test('/supervisor 關著就開、開著就關，不會自己跳出來', async ($, on) => {
  const control = engine(on)
  await start($)
  expect(control.opens).toHaveLength(0)
  const opened = await runSupervisor($)
  expect(control.opens).toHaveLength(1)
  expect(control.opens[0]).toMatchObject({ id: 'agent-supervisor', title: 'Agent Supervisor' })
  expect(opened.text).toBe('已開啟 Agent Supervisor 面板。')
  const closed = await runSupervisor($)
  expect(control.closes).toHaveLength(1)
  expect(closed.text).toBe('已關閉 Agent Supervisor 面板。')
})

test('還沒有子代理時，面板說明沒有資料，不畫假的進度', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(paneOf() as any)
  const rows = drawnRows(await ui.drawn())
  expect(rows.join('\n')).toContain('這個 session 還沒有派出子代理')
  expect(rows.join('\n')).not.toMatch(/\d+%/)
  await ui.unmount()
})

describe('指令與分頁', () => {
  test('/supervisor agents、tasks、logs 直接開那一頁；focus 把鍵盤交給面板；看不懂的參數回用法', async ($, on) => {
    const control = engine(on)
    await start($)
    await runSupervisor($, 'tasks')
    expect(control.state.get('view')).toBe('tasks')
    expect(control.opens).toHaveLength(1)
    await runSupervisor($, 'logs')
    expect(control.state.get('view')).toBe('events')
    await runSupervisor($, 'focus')
    expect(control.opens.at(-1)).toMatchObject({ focus: true })
    const usage = await runSupervisor($, 'xyz')
    expect(usage.text).toContain('用法')
  })

  test('/supervisor 註冊成 immediate：主對話忙著時也能立刻開關', async ($, on) => {
    const control = engine(on)
    await start($)
    expect(control.commands.find(command => command.name === 'supervisor')).toMatchObject({ immediate: true, argumentHint: '[agents|tasks|logs|focus]' })
  })

  test('工具列按 A／T／L 切換分頁、O 回總覽；目前這一頁的按鈕不畫', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($)
    const ui = await $.ui.mount(paneOf() as any)
    expect(await ui.find({ type: 'Button', key: 'view-overview' })).toBeUndefined()
    await ui.press({ key: 'view-agents' })
    expect(control.state.get('view')).toBe('agents')
    await ui.redraw()
    expect(drawnRows(await ui.drawn()).some(row => row.startsWith('AGENTS（'))).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'view-agents' })).toBeUndefined()
    await ui.press({ key: 'view-overview' })
    expect(control.state.get('view')).toBe('overview')
    await ui.unmount()
  })

  test('R 立刻跟代理清單對帳；Q 關掉面板', async ($, on) => {
    const control = engine(on)
    await start($)
    await runSupervisor($)
    const ui = await $.ui.mount(paneOf() as any)
    const calls = control.listCalls
    await ui.press({ key: 'refresh' })
    expect(control.listCalls).toBe(calls + 1)
    await ui.press({ key: 'close' })
    expect(control.closes).toHaveLength(1)
    await ui.unmount()
  })

  test('放在輸入框上方時總覽精簡：最多 3 個代理、不畫事件區', async ($, on) => {
    engine(on)
    await start($)
    for (let count = 0; count < 5; count++) await spawnAgent($)
    const inline = await $.ui.mount(paneOf({ placement: 'inline', bodyColumns: 70 }) as any)
    const rows = drawnRows(await inline.drawn())
    expect(rows.join('\n')).toContain('還有 2 個代理')
    expect(rows).not.toContain('EVENTS')
    await inline.unmount()
    const docked = await $.ui.mount(paneOf({ placement: 'dock' }) as any)
    expect(drawnRows(await docked.drawn())).toContain('EVENTS')
    await docked.unmount()
  })
})

describe('事件串', () => {
  test('派出、工具失敗、回報任務、結束都記一筆事件；成功的工具呼叫不記', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { name: 'backend' })
    await callTool($, { tool: 'Read', file_path: '/a', agentId: 'a1' })
    control.toolReplies.push({ result: {}, text: 'Exit code 1', isError: true })
    await callTool($, { tool: 'Bash', command: 'npm test', agentId: 'a1' })
    await callTool($, { tool: 'mcp__agent-supervisor__report', tasks: [{ id: 'T1', title: '實作 API', status: 'in_progress' }], agentId: 'a1' })
    await finishTurn($, { agentId: 'a1', reason: 'error' })
    const events = control.state.get('events')
    expect(events.map((event: any) => [event.agentId, event.kind, event.text])).toEqual([
      ['a1', 'spawn', '開始'],
      ['a1', 'tool-error', '工具失敗：Exit code 1'],
      ['a1', 'task', '新增任務 T1 實作 API'],
      ['a1', 'fail', '失敗：API 錯誤'],
    ])
  })
})
