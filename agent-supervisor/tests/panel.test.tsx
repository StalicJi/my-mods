import { expect, test } from 'claude-code/testing'

import { drawnRows, engine, paneOf, runSupervisor, start } from './harness'

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
