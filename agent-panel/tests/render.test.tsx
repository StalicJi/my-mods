import { expect, mock, test } from 'claude-code/testing'

import { displayWidth, fullRowCount } from '../hooks/layout'
import type { AgentRow } from '../types'
import { stateStore } from './state-store'

type PaneOptions = { bodyColumns?: number; placement?: 'dock' | 'inline'; bodyRows?: number }

const paneOf = ({ bodyColumns = 42, placement = 'dock', bodyRows = 40 }: PaneOptions = {}) => ({
  plugin: 'agent-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: 'Agents', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
})

const row = (id: string, patch: Partial<AgentRow> = {}): AgentRow => ({
  id, description: `任務 ${id}`, agentType: 'Explore', agentName: null, isNested: false, status: 'running', startedAt: 0,
  endedAt: null, failureReason: null, model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 3, activity: '讀取 src/app.ts',
  activityStartedAt: 0, lastUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 },
  reportedTokens: null, ...patch,
})
const done = (id: string, patch: Partial<AgentRow> = {}) => row(id, { status: 'done', endedAt: 5000, ...patch })
const failed = (id: string, patch: Partial<AgentRow> = {}) => row(id, { status: 'failed', endedAt: 9000, failureReason: '已中斷', ...patch })

// 代替 host 的時鐘與 state；同一個測試可以掛載好幾次
function setup(on: any, agents: AgentRow[] | null) {
  mock.clock(on)
  stateStore(on, agents === null ? {} : { batch: { turnId: 't1', agents } })
}

const mount = ($: any, options: PaneOptions = {}) => $.ui.mount(paneOf(options) as any)

function mountWith($: any, on: any, agents: AgentRow[] | null, options: PaneOptions = {}) {
  setup(on, agents)
  return mount($, options)
}

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return ((node.children ?? []) as unknown[]).map(textOf).join('')
}

// 畫面上的每一列：面板每一列都是一個 Text（裡面的各段顏色是巢狀的 Text），所以沒包在其他 Text 裡的 Text 各算一列
function drawnRows(node: any): string[] {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'Text') return [textOf(node)]
  return ((node.children ?? []) as unknown[]).flatMap(drawnRows)
}

function countNodes(node: any, matches: (node: any) => boolean): number {
  if (!node || typeof node !== 'object') return 0
  const children = (node.children ?? []) as unknown[]
  return (matches(node) ? 1 : 0) + children.reduce((sum: number, child) => sum + countNodes(child, matches), 0)
}

const GROUP_LABEL = /^(Running|Failed|Done)/
const isBlank = (line: string) => line.trim() === ''

test('沒有批次時顯示提示', async ($, on) => {
  const ui = await mountWith($, on, null)
  expect(await ui.find({ type: 'Text', text: '這個 session 還沒有派出子代理' })).toBeDefined()
  await ui.unmount()
})

test('第一列是狀態列：Agents、各狀態數量與整批耗時；沒有費用、Tokens 方框與分隔線', async ($, on) => {
  const ui = await mountWith($, on, [row('a'), done('d'), failed('f')])
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows[0]).toMatch(/^Agents  ●1 ✓1 ✗1 +0:00$/)
  expect(displayWidth(rows[0]!)).toBe(42)
  for (const gone of [/Cost/, /≈\$/, /^Tokens$/, /^Time$/, /─/]) expect(rows.filter(line => gone.test(line))).toEqual([])
  expect(countNodes(drawn, node => node.type === 'Box' && node.props?.borderStyle !== undefined)).toBe(0)
  await ui.unmount()
})

test('卡片標題是「類型 · 描述」，有 name 時用 name；組依 Running → Failed → Done，組名暗色、不接數量', async ($, on) => {
  // 故意打亂派出順序：畫面要依狀態分組
  const ui = await mountWith($, on, [done('d'), row('a', { agentName: 'reviewer' }), failed('f', { agentType: 'general-purpose' }), row('b')])
  const rows = drawnRows(await ui.drawn())
  expect(rows.filter(line => GROUP_LABEL.test(line))).toEqual(['Running', 'Failed', 'Done'])
  expect((await ui.find({ type: 'Text', text: /^Running$/ }))?.props).toMatchObject({ dimColor: true })
  const titles = rows.filter(line => /^[●✗✓] /.test(line)).map(line => line.replace(/ +\d+:\d{2}$/, ''))
  expect(titles).toEqual(['● reviewer · 任務 a', '● Explore · 任務 b', '✗ general-purpose · 任務 f', '✓ Explore · 任務 d'])
  await ui.unmount()
})

test('完成與失敗的卡片沒有進度條，執行中的有', async ($, on) => {
  const ui = await mountWith($, on, [row('a'), row('b'), done('d'), failed('f')])
  const bars = drawnRows(await ui.drawn()).filter(line => line.includes('▆'))
  expect(bars).toHaveLength(2)
  await ui.unmount()
})

test('完整模式：列數等於 fullRowCount，組與組之間空一列，頭尾不空', async ($, on) => {
  const agents = [row('a'), failed('f'), done('d')]
  const ui = await mountWith($, on, agents)
  const rows = drawnRows(await ui.drawn())
  expect(rows).toHaveLength(fullRowCount({ turnId: 't1', agents }))
  expect(rows[1]).toBe('Running')
  // 空行後面接的一定是下一組的組名
  const afterBlank = rows.flatMap((line, index) => (isBlank(line) ? [rows[index + 1]] : []))
  expect(afterBlank).toEqual(['Failed', 'Done'])
  expect(isBlank(rows.at(-1)!)).toBe(false)
  await ui.unmount()
})

test('面板放在輸入框上方時用精簡模式：每個子代理一列，依 running → failed → done，沒有組名與空行', async ($, on) => {
  const ui = await mountWith($, on, [done('d'), row('a'), failed('f')], { placement: 'inline', bodyColumns: 100 })
  const rows = drawnRows(await ui.drawn())
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatch(/^Agents  ●1 ✓1 ✗1 +0:00$/)
  expect(rows.slice(1).map(line => line.slice(0, 2))).toEqual(['● ', '✗ ', '✓ '])
  expect(rows.filter(line => GROUP_LABEL.test(line) || isBlank(line))).toEqual([])
  expect(rows[1]).toContain('讀取 src/app.ts')
  expect(rows[2]).toContain('已中斷')
  await ui.unmount()
})

test('完整模式超過面板可見列數時改精簡模式，剛好放得下時維持完整模式', async ($, on) => {
  const agents = [row('a'), row('b'), done('d')]
  const fullRows = fullRowCount({ turnId: 't1', agents })
  setup(on, agents)
  const fits = await mount($, { bodyRows: fullRows })
  expect(drawnRows(await fits.drawn())).toHaveLength(fullRows)
  await fits.unmount()
  const overflows = await mount($, { bodyRows: fullRows - 1 })
  expect(drawnRows(await overflows.drawn())).toHaveLength(1 + agents.length)
  await overflows.unmount()
})

test('8 個子代理放不下完整模式時，每個一列全部畫出來', async ($, on) => {
  const ui = await mountWith($, on, Array.from({ length: 8 }, (_, index) => row(`a${index}`)))
  expect(await ui.findAll({ type: 'Text', text: /^● \S/ })).toHaveLength(8)
  await ui.unmount()
})

test('窄面板時每一列都截斷在面板寬度內，不折行', async ($, on) => {
  // 很長的描述與誇張的 token 數，逼出狀態列、標題與用量列的截斷
  setup(on, [row('a', { description: '檢查整份設計文件與實作計畫是否一致', reportedTokens: 1e17 }), done('d'), failed('f')])
  for (const placement of ['dock', 'inline'] as const) {
    const ui = await mount($, { bodyColumns: 20, placement })
    const rows = drawnRows(await ui.drawn())
    expect(rows.filter(line => displayWidth(line) > 20)).toEqual([])
    expect(rows[0]).toMatch(/^Agents/)
    await ui.unmount()
  }
})

test('狀態資料壞掉時畫出錯誤提示，不讓面板消失', async ($, on) => {
  mock.clock(on)
  // 例如升級後讀到舊版存下、形狀不對的資料
  stateStore(on, { batch: { turnId: 't1', agents: null } })
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /^面板暫時畫不出來/ })).toBeDefined()
  await ui.unmount()
})
