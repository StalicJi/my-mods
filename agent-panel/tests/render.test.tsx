import { expect, mock, test } from 'claude-code/testing'

import type { AgentRow } from '../types'
import { stateStore } from './state-store'

const PANE = {
  plugin: 'agent-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: 'Agents', isFocused: false, bodyColumns: 42, placement: 'dock' },
} as const

const row = (id: string, patch: Partial<AgentRow> = {}): AgentRow => ({
  id, description: `任務 ${id}`, isNested: false, status: 'running', startedAt: 0, endedAt: null, failureReason: null,
  model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 3, activity: '讀取 src/app.ts',
  lastUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 },
  reportedTokens: null, costUsd: 0.01, hasUnpricedUsage: false, ...patch,
})

function mountWith($: any, on: any, agents: AgentRow[] | null, bodyColumns = 42) {
  mock.clock(on)
  stateStore(on, agents === null ? {} : { batch: { turnId: 't1', agents } })
  return $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns } } as any)
}

function countNodes(node: any, matches: (node: any) => boolean): number {
  if (!node || typeof node !== 'object') return 0
  const children = (node.children ?? []) as unknown[]
  return (matches(node) ? 1 : 0) + children.reduce((sum: number, child) => sum + countNodes(child, matches), 0)
}

test('沒有批次時顯示提示', async ($, on) => {
  const ui = await mountWith($, on, null)
  expect(await ui.find({ type: 'Text', text: '這個 session 還沒有派出子代理' })).toBeDefined()
  await ui.unmount()
})

test('三格統計、Running 與 Finished 分組', async ($, on) => {
  const ui = await mountWith($, on, [row('a'), row('b', { status: 'done', endedAt: 5000 }), row('c', { status: 'done', endedAt: 7000 })])
  for (const label of [/^Agents$/, /^Cost$/, /^Tokens$/, /^Time$/, /^Running · 1$/, /^Finished · 2$/])
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
  const drawn = await ui.drawn()
  expect(countNodes(drawn, node => node.type === 'Box' && node.props?.borderStyle === 'round')).toBe(3)
  expect(await ui.findAll({ type: 'Text', text: /^✓ \S/ })).toHaveLength(2)
  await ui.unmount()
})

test('窄面板改成一行統計', async ($, on) => {
  const ui = await mountWith($, on, [row('a')], 30)
  expect(await ui.find({ type: 'Text', text: /^Cost$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^≈\$\d+\.\d{2} · .+ · \d+:\d{2}$/ })).toBeDefined()
  await ui.unmount()
})

test('8 個子代理全部畫出來', async ($, on) => {
  const ui = await mountWith($, on, Array.from({ length: 8 }, (_, index) => row(`a${index}`)))
  expect(await ui.findAll({ type: 'Text', text: /^● \S/ })).toHaveLength(8)
  await ui.unmount()
})

test('統計三格的值放不下時截斷，不折行', async ($, on) => {
  // 36 欄：每格寬 12，扣掉框線與內距剩 8 格，放不下 9 格的 ≈$12.34+?
  const ui = await mountWith($, on, [row('a', { costUsd: 12.34, hasUnpricedUsage: true })], 36)
  // 要精確比對：卡片的用量列也包含完整費用
  expect(await ui.find({ type: 'Text', text: /^≈\$12\.34\+\?$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^≈\$12\.34…$/ })).toBeDefined()
  await ui.unmount()
})

test('單行統計放不下時截斷，不折行', async ($, on) => {
  // 20 欄：「≈$12.34+? · 27k · 0:00」寬 22
  const ui = await mountWith($, on, [row('a', { costUsd: 12.34, hasUnpricedUsage: true })], 20)
  expect(await ui.find({ type: 'Text', text: /^≈\$12\.34\+\? · 27k · 0…$/ })).toBeDefined()
  await ui.unmount()
})

test('狀態資料壞掉時畫出錯誤提示，不讓面板消失', async ($, on) => {
  mock.clock(on)
  // 例如升級後讀到舊版存下、形狀不對的資料
  stateStore(on, { batch: { turnId: 't1', agents: null } })
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /^面板暫時畫不出來/ })).toBeDefined()
  await ui.unmount()
})
