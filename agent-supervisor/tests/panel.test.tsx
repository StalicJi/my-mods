import { expect, test } from 'claude-code/testing'

import { stateStore } from './state-store'

// 代替 mod 底下的 engine：記下開關窗格與註冊的指令，窗格清單照開關維護
export function engine(on: any, initialState: Record<string, unknown> = {}) {
  const control = {
    opens: [] as any[],
    closes: [] as any[],
    commands: [] as any[],
    statuses: [] as (string | undefined)[],
    panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[],
    state: stateStore(on, initialState),
  }
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('command.register', (_$: any, e: any) => {
    control.commands.push(e)
    return { value: undefined }
  })
  on('ui.open', (_$: any, e: any) => {
    control.opens.push(e)
    control.panes = [...control.panes.filter(pane => pane.id !== e.id), { id: e.id, title: e.title, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: any, e: any) => {
    control.closes.push(e)
    control.panes = control.panes.filter(pane => pane.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: control.panes }))
  on('ui.status', (_$: any, e: any) => {
    control.statuses.push(e.text)
    return { value: undefined }
  })
  return control
}

export const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
export const runSupervisor = ($: any, args = '') => $.command.run({ command: 'supervisor', args } as any)

export function paneOf(options: { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline' } = {}) {
  const { bodyColumns = 44, bodyRows = 40, placement = 'dock' } = options
  return {
    plugin: 'agent-supervisor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-supervisor',
    props: { title: 'Agent Supervisor', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
  }
}

// 畫出來的每一列文字（每個 Text 一列，內層的 Text 併進同一列）
export function drawnRows(node: any): string[] {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'Text') return [textOf(node)]
  return ((node.children ?? []) as unknown[]).flatMap(drawnRows)
}

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return ((node.children ?? []) as unknown[]).map(textOf).join('')
}

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
