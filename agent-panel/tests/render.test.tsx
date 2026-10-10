import { expect, mock, test } from 'claude-code/testing'

import { MASCOT_GAP, displayWidth, fullRowCount } from '../hooks/layout'
import type { FullModeOptions } from '../hooks/layout'
import { mascotRaster } from '../hooks/mascot'
import { mascotImage } from '../hooks/mascot-image'
import type { AgentRow, Logs } from '../types'
import { stateStore } from './state-store'

type PaneOptions = { bodyColumns?: number; placement?: 'dock' | 'inline'; bodyRows?: number; surface?: 'terminal' | 'desktop' }

const paneOf = ({ bodyColumns = 42, placement = 'dock', bodyRows = 40, surface = 'terminal' }: PaneOptions = {}) => ({
  plugin: 'agent-panel',
  surface,
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: 'Agents', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
})

const row = (id: string, patch: Partial<AgentRow> = {}): AgentRow => ({
  id, description: `任務 ${id}`, agentType: 'Explore', agentName: null, isNested: false, status: 'running', startedAt: 0,
  endedAt: null, failureReason: null, model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 3, activity: '讀取 src/app.ts',
  activityStartedAt: 0, lastUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 },
  reportedTokens: null, look: 0, ...patch,
})
const done = (id: string, patch: Partial<AgentRow> = {}) => row(id, { status: 'done', endedAt: 5000, ...patch })
const failed = (id: string, patch: Partial<AgentRow> = {}) => row(id, { status: 'failed', endedAt: 9000, failureReason: '已中斷', ...patch })

type SetupExtra = { logs?: Logs; selected?: string }

// 代替 host 的時鐘與 state；同一個測試可以掛載好幾次。回傳 state 替身
function setup(on: any, agents: AgentRow[] | null, extra: SetupExtra = {}) {
  mock.clock(on)
  const initial: Record<string, unknown> = agents === null ? {} : { batch: { turnId: 't1', agents } }
  if (extra.logs !== undefined) initial.logs = extra.logs
  if (extra.selected !== undefined) initial.selected = extra.selected
  return { store: stateStore(on, initial) }
}

const mount = ($: any, options: PaneOptions = {}) => $.ui.mount(paneOf(options) as any)

function mountWith($: any, on: any, agents: AgentRow[] | null, options: PaneOptions = {}) {
  setup(on, agents)
  return mount($, options)
}

const FORCE_IMAGES = 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES'

// 代替 host 回答 session.start 與環境變數（$ 呼叫的 stub 包成 { value }）；variables 可以在測試中途改。
// 回傳 mod 讀過的變數名稱，讀一次記一筆
function environment(on: any, variables: Record<string, string>) {
  const reads: string[] = []
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('env.get', (_$: any, e: any) => {
    reads.push(e.name)
    return { value: variables[e.name] }
  })
  return reads
}

const startSession = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })

// session 開始時環境變數是 variables，之後才掛載面板
async function setupSession($: any, on: any, agents: AgentRow[] | null, variables: Record<string, string>) {
  setup(on, agents)
  environment(on, variables)
  await startSession($)
}

// 有設 CLAUDE_CODE_FORCE_TERMINAL_IMAGES 的 session（例如 cmux 裡）
async function mountWithImages($: any, on: any, agents: AgentRow[], options: PaneOptions = {}) {
  await setupSession($, on, agents, { [FORCE_IMAGES]: '1' })
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

// 小人是 Raster（方塊版）或 Image（圖片版）
const isMascot = (node: any) => node?.type === 'Raster' || node?.type === 'Image'

// 畫了小人的卡片：一個橫向 Box，直接的子元素裡有小人
function mascotCards(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  const children = (node.children ?? []) as any[]
  const own = node.type === 'Box' && children.some(isMascot) ? [node] : []
  return [...own, ...children.flatMap(mascotCards)]
}

// 每隻小人佔畫面的哪幾列（含頭不含尾）：小人從卡片的第一列畫起
function mascotSpans(drawn: any): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = []
  let rowIndex = 0
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Text') {
      rowIndex += 1
      return
    }
    const children = (node.children ?? []) as any[]
    const mascot = node.type === 'Box' ? children.find(isMascot) : undefined
    if (mascot !== undefined) {
      spans.push({ from: rowIndex, to: rowIndex + mascot.props.rows })
      rowIndex += drawnRows(node).length
      return
    }
    children.forEach(walk)
  }
  walk(drawn)
  return spans
}

const rowCountOf = (agents: AgentRow[], options: FullModeOptions) => fullRowCount({ turnId: 't1', agents }, options)

const GROUP_LABEL = /^(Running|Failed|Done)/
const CARD_TITLE = /^[●✗✓] /
const isBlank = (line: string) => line.trim() === ''
const rastersOf = async (ui: any) => (await ui.findAll({ type: 'Raster' })) as any[]
const imagesOf = async (ui: any) => (await ui.findAll({ type: 'Image' })) as any[]
const blankIndexes = (rows: string[]) => rows.flatMap((line, index) => (isBlank(line) ? [index] : []))

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

test('模型列：失敗卡片跟完成卡片一樣有 effort 與 token；工具 1 次寫 1 tool，三種卡片都一樣', async ($, on) => {
  const ui = await mountWith($, on, [row('a', { toolCount: 1 }), failed('f', { toolCount: 1 }), done('d', { toolCount: 1 })])
  const modelRows = drawnRows(await ui.drawn()).filter(line => line.includes('Opus 5.5'))
  expect(modelRows).toEqual(['  Opus 5.5 · xhigh · 1 tool', '  Opus 5.5 · xhigh · 1 tool · 27k', '  Opus 5.5 · xhigh · 1 tool · 27k'])
  await ui.unmount()
})

test('完整模式：列數等於 fullRowCount，組與組之間空一列，頭尾不空', async ($, on) => {
  const agents = [row('a'), failed('f'), done('d')]
  const ui = await mountWith($, on, agents)
  const rows = drawnRows(await ui.drawn())
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'raster' }))
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
  const fullRows = rowCountOf(agents, { mascot: 'raster' })
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

// 子代理卡片左邊的像素小人

test('寬面板的完整模式：每張卡片左邊一隻小人，執行中大的、完成與失敗小的，造型取 look', async ($, on) => {
  const ui = await mountWith($, on, [done('d', { look: 2 }), row('a', { look: 0 }), failed('f', { look: 1 })])
  const rasters = await rastersOf(ui)
  expect(rasters.map(raster => [raster.key, raster.props.columns, raster.props.rows])).toEqual([
    ['mascot-a', 5, 3],
    ['mascot-f', 5, 2],
    ['mascot-d', 5, 2],
  ])
  expect(rasters.map(raster => raster.props.cells)).toEqual([
    mascotRaster({ look: 0, size: 'large', state: 'running', frame: 0 }).cells,
    mascotRaster({ look: 1, size: 'small', state: 'failed', frame: 0 }).cells,
    mascotRaster({ look: 2, size: 'small', state: 'done', frame: 0 }).cells,
  ])
  await ui.unmount()
})

test('畫上小人後：卡片文字少 6 欄、狀態列仍是整個寬度，小人跟文字隔 1 欄、不比卡片高，列數仍等於 fullRowCount', async ($, on) => {
  const agents = [row('a'), failed('f'), done('d')]
  const ui = await mountWith($, on, agents)
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'raster' }))
  expect(displayWidth(rows[0]!)).toBe(42)
  expect(rows.filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([36, 36, 36])
  expect(rows.filter(line => line.includes('▆')).map(displayWidth)).toEqual([36])
  const cards = mascotCards(drawn)
  expect(cards).toHaveLength(3)
  for (const card of cards) {
    expect(card.props).toMatchObject({ flexDirection: 'row', columnGap: MASCOT_GAP })
    const raster = card.children.find((child: any) => child?.type === 'Raster')
    expect(raster.props.rows).toBeLessThanOrEqual(drawnRows(card).length)
  }
  await ui.unmount()
})

test('精簡模式不畫小人：放在輸入框上方，或完整模式放不下', async ($, on) => {
  const agents = [row('a'), row('b'), done('d')]
  setup(on, agents)
  const inline = await mount($, { placement: 'inline', bodyColumns: 100 })
  expect(await rastersOf(inline)).toEqual([])
  await inline.unmount()
  const overflows = await mount($, { bodyRows: rowCountOf(agents, { mascot: 'raster' }) - 1 })
  expect(drawnRows(await overflows.drawn())).toHaveLength(1 + agents.length)
  expect(await rastersOf(overflows)).toEqual([])
  await overflows.unmount()
})

test('面板太窄（文字剩不到 24 欄）不畫小人，卡片照舊用整個寬度', async ($, on) => {
  setup(on, [row('a'), done('d')])
  const narrow = await mount($, { bodyColumns: 29 })
  expect(await rastersOf(narrow)).toEqual([])
  expect(drawnRows(await narrow.drawn()).filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([29, 29])
  await narrow.unmount()
  const enough = await mount($, { bodyColumns: 30 })
  expect(await rastersOf(enough)).toHaveLength(2)
  expect(drawnRows(await enough.drawn()).filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([24, 24])
  await enough.unmount()
})

test('終端機以外的介面（desktop 的 Raster 畫成空的 fragment）不畫小人，卡片照舊用整個寬度', async ($, on) => {
  const agents = [row('a'), done('d')]
  const ui = await mountWith($, on, agents, { surface: 'desktop' })
  const drawn = await ui.drawn()
  expect(mascotCards(drawn)).toEqual([])
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: null }))
  expect(rows.filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([42, 42])
  await ui.unmount()
})

test('畫小人時，相鄰兩張完成卡片之間空一列，兩隻小小人隔一列、不黏成一隻；列數等於 fullRowCount', async ($, on) => {
  const agents = [done('d1'), done('d2')]
  const ui = await mountWith($, on, agents)
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'raster' }))
  // 狀態列、Done、第一張卡片 2 列，接著空一列，再接第二張卡片
  expect(rows.flatMap((line, index) => (isBlank(line) ? [index] : []))).toEqual([4])
  expect(rows[5]).toMatch(CARD_TITLE)
  const [upper, lower] = mascotSpans(drawn)
  expect(lower!.from - upper!.to).toBe(1)
  await ui.unmount()
})

test('畫小人時，三張完成卡片之間各空一列，最後一張後面不空', async ($, on) => {
  const agents = [done('d1'), done('d2'), done('d3')]
  const ui = await mountWith($, on, agents)
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'raster' }))
  expect(rows.flatMap((line, index) => (isBlank(line) ? [index] : []))).toEqual([4, 7])
  const spans = mascotSpans(drawn)
  expect(spans.slice(1).map((span, index) => span.from - spans[index]!.to)).toEqual([1, 1])
  await ui.unmount()
})

test('畫小人時，執行中與失敗卡片之間不多空列，空行只在組與組之間', async ($, on) => {
  const agents = [row('a'), row('b'), failed('f1'), failed('f2'), done('d')]
  const ui = await mountWith($, on, agents)
  const rows = drawnRows(await ui.drawn())
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'raster' }))
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: null }))
  expect(rows.flatMap((line, index) => (isBlank(line) ? [rows[index + 1]] : []))).toEqual(['Failed', 'Done'])
  await ui.unmount()
})

test('不畫小人時（面板太窄、終端機以外的介面、精簡模式）完成卡片之間不空列', async ($, on) => {
  const agents = [done('d1'), done('d2')]
  setup(on, agents)
  for (const options of [{ bodyColumns: 29 }, { surface: 'desktop' as const }]) {
    const ui = await mount($, options)
    const rows = drawnRows(await ui.drawn())
    expect(rows).toHaveLength(rowCountOf(agents, { mascot: null }))
    expect(rows.filter(isBlank)).toEqual([])
    await ui.unmount()
  }
  const inline = await mount($, { placement: 'inline', bodyColumns: 100 })
  const rows = drawnRows(await inline.drawn())
  expect(rows).toHaveLength(1 + agents.length)
  expect(rows.filter(isBlank)).toEqual([])
  await inline.unmount()
})

test('判斷精簡模式時，列數依實際會不會畫小人計算', async ($, on) => {
  const agents = [done('d1'), done('d2'), done('d3')]
  setup(on, agents)
  // 會畫小人：空列也算進去，剛好放得下才維持完整模式
  const withMascotRows = rowCountOf(agents, { mascot: 'raster' })
  const fits = await mount($, { bodyRows: withMascotRows })
  expect(drawnRows(await fits.drawn())).toHaveLength(withMascotRows)
  await fits.unmount()
  const overflows = await mount($, { bodyRows: withMascotRows - 1 })
  expect(drawnRows(await overflows.drawn())).toHaveLength(1 + agents.length)
  await overflows.unmount()
  // 不畫小人（終端機以外的介面）：不多算空列，放得下就維持完整模式
  const plainRows = rowCountOf(agents, { mascot: null })
  const desktop = await mount($, { surface: 'desktop', bodyRows: plainRows })
  expect(drawnRows(await desktop.drawn())).toHaveLength(plainRows)
  await desktop.unmount()
})

test('舊版存下、沒有 look 的列照常畫，小人是第一種造型', async ($, on) => {
  const { look: _look, ...legacy } = row('a', { look: 3 })
  const ui = await mountWith($, on, [legacy as AgentRow])
  expect(await ui.find({ type: 'Text', text: /^面板暫時畫不出來/ })).toBeUndefined()
  const rasters = await rastersOf(ui)
  expect(rasters.map(raster => raster.props.cells)).toEqual([mascotRaster({ look: 0, size: 'large', state: 'running', frame: 0 }).cells])
  await ui.unmount()
})

// 圖片版小人：有設 CLAUDE_CODE_FORCE_TERMINAL_IMAGES 的終端機畫 Image（細像素），不然畫上面的方塊版

test('有設 CLAUDE_CODE_FORCE_TERMINAL_IMAGES 時，每張卡片左邊畫圖片版小人：4×2、source 是 mascotImage、alt 有值，不畫方塊版', async ($, on) => {
  const ui = await mountWithImages($, on, [done('d', { look: 2 }), row('a', { look: 0 }), failed('f', { look: 1 })])
  const images = await imagesOf(ui)
  expect(images.map(image => [image.key, image.props.columns, image.props.rows])).toEqual([
    ['mascot-a', 4, 2],
    ['mascot-f', 4, 2],
    ['mascot-d', 4, 2],
  ])
  expect(images.map(image => image.props.source)).toEqual([
    mascotImage({ look: 0, state: 'running', frame: 0 }),
    mascotImage({ look: 1, state: 'failed', frame: 0 }),
    mascotImage({ look: 2, state: 'done', frame: 0 }),
  ])
  for (const image of images) {
    expect(typeof image.props.alt).toBe('string')
    expect(image.props.alt.length).toBeGreaterThan(0)
  }
  expect(await rastersOf(ui)).toEqual([])
  await ui.unmount()
})

test('沒設 CLAUDE_CODE_FORCE_TERMINAL_IMAGES 時畫方塊版小人', async ($, on) => {
  await setupSession($, on, [row('a'), done('d')], {})
  const ui = await mount($)
  expect(await imagesOf(ui)).toEqual([])
  expect((await rastersOf(ui)).map(raster => raster.key)).toEqual(['mascot-a', 'mascot-d'])
  await ui.unmount()
})

test('CLAUDE_CODE_FORCE_TERMINAL_IMAGES 是空字串時當成沒設（跟 Claude Code 一樣非空才算開），畫方塊版', async ($, on) => {
  await setupSession($, on, [row('a'), done('d')], { [FORCE_IMAGES]: '' })
  const ui = await mount($)
  expect(await imagesOf(ui)).toEqual([])
  expect(await rastersOf(ui)).toHaveLength(2)
  await ui.unmount()
})

test('終端機以外的介面就算設了 CLAUDE_CODE_FORCE_TERMINAL_IMAGES 也不畫小人，卡片照舊用整個寬度', async ($, on) => {
  const agents = [row('a'), done('d')]
  const ui = await mountWithImages($, on, agents, { surface: 'desktop' })
  const drawn = await ui.drawn()
  expect(mascotCards(drawn)).toEqual([])
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: null }))
  expect(rows.filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([42, 42])
  await ui.unmount()
})

test('圖片版：卡片文字少 5 欄（方塊版少 6 欄）、狀態列仍是整個寬度，小人跟文字隔 1 欄、不比卡片高，列數等於 fullRowCount', async ($, on) => {
  const agents = [row('a'), failed('f'), done('d')]
  const ui = await mountWithImages($, on, agents)
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'image' }))
  expect(displayWidth(rows[0]!)).toBe(42)
  expect(rows.filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([37, 37, 37])
  expect(rows.filter(line => line.includes('▆')).map(displayWidth)).toEqual([37])
  const cards = mascotCards(drawn)
  expect(cards).toHaveLength(3)
  for (const card of cards) {
    expect(card.props).toMatchObject({ flexDirection: 'row', columnGap: MASCOT_GAP })
    const image = card.children.find((child: any) => child?.type === 'Image')
    expect(image.props.rows).toBeLessThanOrEqual(drawnRows(card).length)
  }
  await ui.unmount()
})

test('圖片版：相鄰兩張完成卡片之間空一列，兩隻小人隔一列、不黏成一隻；列數等於 fullRowCount', async ($, on) => {
  const agents = [done('d1'), done('d2'), done('d3')]
  const ui = await mountWithImages($, on, agents)
  const drawn = await ui.drawn()
  const rows = drawnRows(drawn)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'image' }))
  // 狀態列、Done、第一張卡片 2 列，接著空一列，再接第二張卡片
  expect(blankIndexes(rows)).toEqual([4, 7])
  const spans = mascotSpans(drawn)
  expect(spans.slice(1).map((span, index) => span.from - spans[index]!.to)).toEqual([1, 1])
  await ui.unmount()
})

test('圖片版：執行中與失敗卡片之間不多空列，空行只在組與組之間', async ($, on) => {
  const agents = [row('a'), row('b'), failed('f1'), failed('f2'), done('d')]
  const ui = await mountWithImages($, on, agents)
  const rows = drawnRows(await ui.drawn())
  expect(await imagesOf(ui)).toHaveLength(5)
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: 'image' }))
  expect(rows).toHaveLength(rowCountOf(agents, { mascot: null }))
  expect(rows.flatMap((line, index) => (isBlank(line) ? [rows[index + 1]] : []))).toEqual(['Failed', 'Done'])
  await ui.unmount()
})

test('圖片版：判斷精簡模式時用圖片版的列數；精簡模式不畫小人', async ($, on) => {
  const agents = [done('d1'), done('d2'), done('d3')]
  await setupSession($, on, agents, { [FORCE_IMAGES]: '1' })
  const imageRows = rowCountOf(agents, { mascot: 'image' })
  const fits = await mount($, { bodyRows: imageRows })
  expect(drawnRows(await fits.drawn())).toHaveLength(imageRows)
  expect(await imagesOf(fits)).toHaveLength(3)
  await fits.unmount()
  const overflows = await mount($, { bodyRows: imageRows - 1 })
  expect(drawnRows(await overflows.drawn())).toHaveLength(1 + agents.length)
  expect(await imagesOf(overflows)).toEqual([])
  await overflows.unmount()
  const inline = await mount($, { placement: 'inline', bodyColumns: 100 })
  expect(await imagesOf(inline)).toEqual([])
  await inline.unmount()
})

test('圖片版：面板太窄（文字剩不到 24 欄）不畫小人，卡片照舊用整個寬度', async ($, on) => {
  await setupSession($, on, [row('a'), done('d')], { [FORCE_IMAGES]: '1' })
  const narrow = await mount($, { bodyColumns: 28 })
  expect(mascotCards(await narrow.drawn())).toEqual([])
  expect(drawnRows(await narrow.drawn()).filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([28, 28])
  await narrow.unmount()
  const enough = await mount($, { bodyColumns: 29 })
  expect(await imagesOf(enough)).toHaveLength(2)
  expect(drawnRows(await enough.drawn()).filter(line => CARD_TITLE.test(line)).map(displayWidth)).toEqual([24, 24])
  await enough.unmount()
})

test('圖片版：舊版存下、沒有 look 的列照常畫，小人是第一種造型', async ($, on) => {
  const { look: _look, ...legacy } = row('a', { look: 3 })
  const ui = await mountWithImages($, on, [legacy as AgentRow])
  expect(await ui.find({ type: 'Text', text: /^面板暫時畫不出來/ })).toBeUndefined()
  expect((await imagesOf(ui)).map(image => image.props.source)).toEqual([mascotImage({ look: 0, state: 'running', frame: 0 })])
  await ui.unmount()
})

test('CLAUDE_CODE_FORCE_TERMINAL_IMAGES 只在 session.start 讀一次：重畫不再讀，還沒讀到之前當成沒設', async ($, on) => {
  setup(on, [row('a')])
  const reads = environment(on, { [FORCE_IMAGES]: '1' })
  const before = await mount($)
  expect(await imagesOf(before)).toEqual([])
  expect(await rastersOf(before)).toHaveLength(1)
  await before.unmount()
  expect(reads).toEqual([])
  await startSession($)
  expect(reads).toEqual([FORCE_IMAGES])
  for (let redraw = 0; redraw < 3; redraw++) {
    const ui = await mount($)
    expect(await imagesOf(ui)).toHaveLength(1)
    await ui.unmount()
  }
  expect(reads).toEqual([FORCE_IMAGES])
})

test('熱重載重跑 session.start 時重新讀 CLAUDE_CODE_FORCE_TERMINAL_IMAGES：拿掉之後改畫方塊版', async ($, on) => {
  setup(on, [row('a')])
  const variables: Record<string, string> = { [FORCE_IMAGES]: '1' }
  environment(on, variables)
  await startSession($)
  const withImages = await mount($)
  expect(await imagesOf(withImages)).toHaveLength(1)
  await withImages.unmount()
  delete variables[FORCE_IMAGES]
  await startSession($)
  const withoutImages = await mount($)
  expect(await imagesOf(withoutImages)).toEqual([])
  expect(await rastersOf(withoutImages)).toHaveLength(1)
  await withoutImages.unmount()
})

test('停靠時卡片標題列與精簡列是 plain 按鈕；放在輸入框上方時沒有按鈕', async ($, on) => {
  const ui = await mountWith($, on, [row('a'), done('d')])
  expect((await ui.find({ key: 'open-a' }))?.props).toMatchObject({ plain: true })
  await ui.unmount()
  const compact = await mount($, { bodyRows: 3 })
  expect(await compact.find({ key: 'open-d' })).toBeDefined()
  await compact.unmount()
  const inline = await mount($, { placement: 'inline' })
  expect(countNodes(await inline.drawn(), node => node.type === 'Button')).toBe(0)
  await inline.unmount()
})

// 測試的 state 是替身，寫入不會讓畫面自己重畫（host 才會），所以按下之後手動 redraw。
// 點開時捲到最底下：測試套件在按鈕的處理函式裡沒有實作 ui.scroll，改在 cmux 實機驗證
test('按標題切到詳細頁：返回列、卡片、分隔線、紀錄依序出現；詳細頁的卡片標題不是按鈕', async ($, on) => {
  const { store } = setup(on, [row('a', { startedAt: 0 })], { logs: { byAgent: { a: { entries: [{ kind: 'tool', id: 'r1', at: 4000, summary: '讀取 config.ghostty', outcome: 'ok', errorLine: null }], dropped: 0 } } } })
  const ui = await mount($)
  await ui.press({ key: 'open-a' })
  expect(store.get('selected')).toBe('a')
  await ui.redraw()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'open-a' })).toBeUndefined()
  const rows = drawnRows(await ui.drawn())
  const title = rows.findIndex(line => line.startsWith('● Explore · 任務 a'))
  const separator = rows.findIndex(line => /^─+$/.test(line))
  expect(rows[0]).toMatch(/^Agents/)
  expect(title).toBeGreaterThan(0)
  expect(separator).toBeGreaterThan(title)
  expect(rows[separator + 1]).toBe('+0:04 ✓ 讀取 config.ghostty')
  await ui.unmount()
})

test('按返回回到清單，selected 清空', async ($, on) => {
  const { store } = setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($)
  await ui.press({ key: 'back' })
  expect(store.get('selected')).toBeNull()
  await ui.redraw()
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await ui.find({ key: 'open-a' })).toBeDefined()
  await ui.unmount()
})

test('沒有紀錄的子代理點開時顯示提示', async ($, on) => {
  setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($)
  expect(drawnRows(await ui.drawn())).toContain('mod 載入前的紀錄沒有保留')
  await ui.unmount()
})

// 測試套件在按鈕的處理函式裡沒有實作 ui.scroll，按下時捲動一定失敗：正好驗證捲動失敗也照樣切換
test('捲動失敗時仍切到詳細頁', async ($, on) => {
  const { store } = setup(on, [row('a')])
  const ui = await mount($)
  await ui.press({ key: 'open-a' })
  expect(store.get('selected')).toBe('a')
  await ui.redraw()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('selected 不在這一批時畫清單', async ($, on) => {
  setup(on, [row('a')], { selected: 'gone' })
  const ui = await mount($)
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('放在輸入框上方時畫清單，但不清掉 selected', async ($, on) => {
  const { store } = setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($, { placement: 'inline' })
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(store.get('selected')).toBe('a')
  await ui.unmount()
})

test('清單畫面不讀 logs', async ($, on) => {
  const { store } = setup(on, [row('a')])
  const ui = await mount($)
  await ui.drawn()
  expect(store.reads('logs')).toBe(0)
  await ui.unmount()
})
