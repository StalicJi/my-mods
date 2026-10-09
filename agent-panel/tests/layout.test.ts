import { expect, test } from 'claude-code/testing'

import type { MascotKind, Span } from '../hooks/layout'
import {
  MASCOT_GAP,
  MIN_TEXT_COLUMNS_WITH_MASCOT,
  STALL_THINKING_MS,
  STALL_TOOL_MS,
  agentCard,
  agentMascot,
  cometColor,
  compactLine,
  displayWidth,
  fitToWidth,
  formatElapsed,
  formatTokens,
  fullRowCount,
  mascotLayout,
  splitSections,
  statusLine,
  statusText,
} from '../hooks/layout'
import type { MascotSize, MascotState } from '../hooks/mascot'
import { mascotRaster } from '../hooks/mascot'
import { MASCOT_IMAGE_COLUMNS, MASCOT_IMAGE_ROWS, mascotImage } from '../hooks/mascot-image'
import type { AgentRow, Batch } from '../types'

// 27k tokens、ctx 3%（Opus 5.5 的 context 上限是 1,000,000）
const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 }
const row = (patch: Partial<AgentRow> = {}): AgentRow => ({
  id: 'a', description: 'Review the whole kit', isNested: false, status: 'running', startedAt: 0, endedAt: null,
  failureReason: null, model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 12, activity: '讀取 src/app.ts',
  activityStartedAt: 0, lastUsage: USAGE, reportedTokens: null, agentType: 'Explore', agentName: null, look: 0, ...patch,
})
const batchOf = (...agents: AgentRow[]): Batch => ({ turnId: 't', agents })
const text = (line: Span[]) => line.map(s => s.text).join('')
// 左段靠左、右段靠右，中間補空白到剛好 columns 寬
const spread = (left: string, right: string, columns: number) => left + ' '.repeat(columns - displayWidth(left) - displayWidth(right)) + right
const spanOf = (line: Span[], spanText: string) => line.find(s => s.text === spanText)
// 有字的段落全是 warning 色
const isAllWarning = (line: Span[]) => line.filter(s => s.text.trim() !== '').every(s => s.color === 'warning')
const hasWarning = (line: Span[]) => line.some(s => s.color === 'warning')
const STALL_BAR_COLOR = '#e5c07b'

test('格式：時間、token', () => {
  expect([formatElapsed(2000), formatElapsed(47_000), formatElapsed(3_723_000)]).toEqual(['0:02', '0:47', '1:02:03'])
  expect([formatTokens(950), formatTokens(26_400), formatTokens(150_000), formatTokens(1_240_000)]).toEqual(['950', '26k', '150k', '1.2M'])
})

test('依顯示寬度截斷，中文一字兩格', () => {
  expect(fitToWidth('Review the whole kit', 10)).toBe('Review th…')
  expect(fitToWidth('檢查整份設計文件與實作計畫', 11)).toBe('檢查整份設…')
  expect(displayWidth(fitToWidth('檢查整份設計文件與實作計畫', 11))).toBeLessThanOrEqual(11)
})

test('狀態列：Agents 與各狀態數量，數量 0 的不顯示，整批耗時靠右，寬度剛好 columns', () => {
  const batch = batchOf(row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'd', status: 'done', endedAt: 5000 }))
  const line = statusLine(batch, 65_000, 30)
  expect(text(line)).toBe(spread('Agents  ●2 ✓1', '1:05', 30))
  expect(displayWidth(text(line))).toBe(30)
  expect(line[0]).toMatchObject({ text: 'Agents', isBold: true })
  expect(spanOf(line, '●2')).toMatchObject({ color: '#ec4f8f' })
  expect(spanOf(line, '✓1')).toMatchObject({ color: 'success' })
  expect(text(line)).not.toContain('✗')

  const onlyFailed = statusLine(batchOf(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 })), 20_000, 20)
  expect(text(onlyFailed)).toBe(spread('Agents  ✗1', '0:09', 20))
  expect(spanOf(onlyFailed, '✗1')).toMatchObject({ color: 'error' })
})

test('狀態列放不下時先截左邊，耗時保留', () => {
  const line = statusLine(batchOf(row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'd', status: 'done', endedAt: 5000 })), 65_000, 10)
  expect(text(line)).toBe('Agen… 1:05')
})

test('狀態文字：給 $.ui.status 用，數量 0 的不列', () => {
  const batch = batchOf(row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'd', status: 'done' }), row({ id: 'f', status: 'failed' }))
  expect(statusText(batch)).toBe('Agents ●2 ✓1 ✗1')
  expect(statusText(batchOf(row({ status: 'done' })))).toBe('Agents ✓1')
})

test('執行中卡片 4 列＋進度條：標題與耗時、模型、正在做什麼與這一步耗時、用量', () => {
  const card = agentCard(row({ activityStartedAt: 500 }), { columns: 40, now: 2000, frame: 3 })
  expect(card.lines.map(text)).toEqual([
    spread('● Explore · Review the whole kit', '0:02', 40),
    '  Opus 5.5 · xhigh · 12 tools',
    spread('  讀取 src/app.ts', '0:01', 40),
    '  ctx 3% · 27k',
  ])
  expect(card.bar).toHaveLength(38)
  expect(card.bar).toContain('#4a4a52')
  const title = card.lines[0]!
  expect(title[0]).toMatchObject({ text: '● ', color: cometColor(3) })
  expect(spanOf(title, 'Explore')).toMatchObject({ isDim: true })
  expect(spanOf(title, 'Review the whole kit')).toMatchObject({ isBold: true })
  expect(card.lines[1]![1]).toMatchObject({ text: 'Opus 5.5', color: '#f79a4f' })
  // 還沒有 usage 時算不出 ctx，只寫 token 數
  const withoutContext = agentCard(row({ lastUsage: null, reportedTokens: 26_400 }), { columns: 40, now: 2000, frame: 3 })
  expect(text(withoutContext.lines.at(-1)!)).toBe('  26k')
})

test('標題：agentName 優先於 agentType，巢狀加箭頭；沒有模型顯示 starting，沒有動作顯示思考中', () => {
  const named = agentCard(row({ agentName: 'reviewer' }), { columns: 40, now: 2000, frame: 0 })
  expect(text(named.lines[0]!)).toBe(spread('● reviewer · Review the whole kit', '0:02', 40))
  const nested = agentCard(row({ isNested: true, model: null, activity: '' }), { columns: 40, now: 2000, frame: 0 })
  expect(text(nested.lines[0]!)).toBe(spread('● ↳ Explore · Review the whole kit', '0:02', 40))
  expect(nested.lines.slice(1, 3).map(text)).toEqual(['  starting · xhigh · 12 tools', spread('  思考中', '0:02', 40)])
})

test('窄面板：標題先截描述、耗時保留，每列不超過寬度', () => {
  const card = agentCard(row({ description: '把這週每一天的工作日報都補齊並且彙總成月報再寄出' }), { columns: 30, now: 65_000, frame: 0 })
  expect(text(card.lines[0]!)).toBe('● Explore · 把這週每一天… 1:05')
  for (const line of card.lines) expect(displayWidth(text(line))).toBeLessThanOrEqual(30)
  expect(displayWidth(text(card.lines[2]!))).toBe(30)
})

test('卡住提醒：工具這一步超過 180 秒，正在做什麼整列變 warning、進度條整條靜止黃色', () => {
  expect(STALL_TOOL_MS).toBe(180_000)
  const toolCard = (stepMs: number) => agentCard(row({ activityStartedAt: 10_000 }), { columns: 40, now: 10_000 + stepMs, frame: 3 })
  const fine = toolCard(179_999)
  expect(hasWarning(fine.lines[2]!)).toBe(false)
  expect(fine.bar).not.toContain(STALL_BAR_COLOR)
  const stalled = toolCard(180_001)
  expect(isAllWarning(stalled.lines[2]!)).toBe(true)
  expect(text(stalled.lines[2]!)).toBe(spread('  讀取 src/app.ts', '3:00', 40))
  expect(hasWarning(stalled.lines[0]!)).toBe(false)
  expect(stalled.bar).toHaveLength(38)
  expect(new Set(stalled.bar)).toEqual(new Set([STALL_BAR_COLOR]))
})

test('卡住提醒：思考這一步超過 300 秒才算，沒有動作也當成思考中', () => {
  expect(STALL_THINKING_MS).toBe(300_000)
  const thinkingCard = (stepMs: number, activity = '思考中') =>
    agentCard(row({ activity, activityStartedAt: 0 }), { columns: 40, now: stepMs, frame: 3 })
  expect(hasWarning(thinkingCard(299_999).lines[2]!)).toBe(false)
  expect(isAllWarning(thinkingCard(300_001).lines[2]!)).toBe(true)
  expect(new Set(thinkingCard(300_001).bar)).toEqual(new Set([STALL_BAR_COLOR]))
  expect(hasWarning(thinkingCard(200_000, '').lines[2]!)).toBe(false)
  expect(isAllWarning(thinkingCard(300_001, '').lines[2]!)).toBe(true)
})

test('完成卡片 2 列、沒有進度條：模型 · effort · tools · tokens', () => {
  const done = agentCard(row({ status: 'done', endedAt: 44_000, model: 'claude-sonnet-5-5' }), { columns: 40, now: 50_000, frame: 0 })
  expect(done.lines.map(text)).toEqual([spread('✓ Explore · Review the whole kit', '0:44', 40), '  Sonnet 5.5 · xhigh · 12 tools · 27k'])
  expect(done.bar).toEqual([])
  expect(done.lines[0]![0]).toMatchObject({ text: '✓ ', color: 'success' })
  expect(spanOf(done.lines[0]!, 'Review the whole kit')?.isBold ?? false).toBe(false)
  expect(done.lines[1]![1]).toMatchObject({ text: 'Sonnet 5.5', color: '#6f7df2' })
})

test('失敗卡片 3 列、沒有進度條：失敗原因 · 停在哪一步（紅色）、模型 · tools', () => {
  const failed = agentCard(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 }), { columns: 40, now: 20_000, frame: 0 })
  expect(failed.lines.map(text)).toEqual([
    spread('✗ Explore · Review the whole kit', '0:09', 40),
    '  已中斷 · 讀取 src/app.ts',
    '  Opus 5.5 · 12 tools',
  ])
  expect(failed.bar).toEqual([])
  expect(failed.lines[0]![0]).toMatchObject({ text: '✗ ', color: 'error' })
  expect(failed.lines[1]!.filter(s => s.text.trim() !== '').every(s => s.color === 'error')).toBe(true)
  // 還沒用過工具就失敗：只寫失敗原因
  const early = agentCard(row({ status: 'failed', failureReason: 'API 錯誤', endedAt: 9000, activity: '' }), { columns: 40, now: 20_000, frame: 0 })
  expect(text(early.lines[1]!)).toBe('  API 錯誤')
})

test('分組：Running、Failed、Done 三組，各組維持派出順序', () => {
  const batch = batchOf(
    row({ id: 'r1' }),
    row({ id: 'd1', status: 'done' }),
    row({ id: 'f1', status: 'failed' }),
    row({ id: 'r2' }),
    row({ id: 'd2', status: 'done' }),
  )
  const { running, failed, done } = splitSections(batch)
  expect([running.map(a => a.id), failed.map(a => a.id), done.map(a => a.id)]).toEqual([['r1', 'r2'], ['f1'], ['d1', 'd2']])
})

test('精簡模式一列：狀態、標籤 · 描述、正在做什麼（失敗寫原因、完成不寫）、耗時靠右', () => {
  const running = compactLine(row(), { columns: 60, now: 65_000, frame: 3 })
  expect(text(running)).toBe(spread('● Explore · Review the whole kit  讀取 src/app.ts', '1:05', 60))
  expect(running[0]).toMatchObject({ text: '● ', color: cometColor(3) })
  const done = compactLine(row({ status: 'done', endedAt: 44_000 }), { columns: 60, now: 50_000, frame: 0 })
  expect(text(done)).toBe(spread('✓ Explore · Review the whole kit', '0:44', 60))
  const failed = compactLine(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 }), { columns: 60, now: 20_000, frame: 0 })
  expect(text(failed)).toBe(spread('✗ Explore · Review the whole kit  已中斷', '0:09', 60))
  expect(spanOf(failed, '已中斷')).toMatchObject({ color: 'error' })
  const nested = compactLine(row({ isNested: true, agentName: 'reviewer' }), { columns: 60, now: 65_000, frame: 0 })
  expect(text(nested).startsWith('● ↳ reviewer · Review the whole kit  讀取')).toBe(true)
})

test('精簡模式放不下：先截描述、再截動作，耗時保留，寬度剛好 columns', () => {
  const medium = compactLine(row(), { columns: 40, now: 65_000, frame: 0 })
  expect(text(medium)).toBe('● Explore · Revie…  讀取 src/app.ts 1:05')
  const narrow = compactLine(row(), { columns: 30, now: 65_000, frame: 0 })
  expect(displayWidth(text(narrow))).toBe(30)
  expect(text(narrow)).not.toContain('Revie')
  expect(text(narrow)).toContain('讀取 src/a…')
  expect(text(narrow).endsWith('1:05')).toBe(true)
})

test('完整模式需要的列數：狀態列、各組標題與卡片（執行中 5、失敗 3、完成 2）、組間空行', () => {
  const plain = { mascot: null }
  expect(fullRowCount(batchOf(), plain)).toBe(1)
  expect(fullRowCount(batchOf(row({ id: 'd', status: 'done' })), plain)).toBe(1 + 1 + 2)
  expect(fullRowCount(batchOf(row({ id: 'r1' }), row({ id: 'r2' })), plain)).toBe(1 + 1 + 5 * 2)
  const mixed = batchOf(row({ id: 'r' }), row({ id: 'f', status: 'failed' }), row({ id: 'd1', status: 'done' }), row({ id: 'd2', status: 'done' }))
  expect(fullRowCount(mixed, plain)).toBe(1 + (1 + 5) + 1 + (1 + 3) + 1 + (1 + 2 * 2))
})

const doneRow = (id: string) => row({ id, status: 'done', endedAt: 5000 })
const failedRow = (id: string) => row({ id, status: 'failed', failureReason: '已中斷', endedAt: 9000 })

const MASCOT_KINDS: MascotKind[] = ['raster', 'image']

test('畫小人時（方塊版、圖片版都一樣），同組相鄰的完成卡片之間空一列：2 張多 1 列、3 張多 2 列；不畫小人時不加', () => {
  const twoDone = batchOf(doneRow('d1'), doneRow('d2'))
  const threeDone = batchOf(doneRow('d1'), doneRow('d2'), doneRow('d3'))
  expect(fullRowCount(twoDone, { mascot: null })).toBe(1 + 1 + 2 * 2)
  expect(fullRowCount(threeDone, { mascot: null })).toBe(1 + 1 + 2 * 3)
  for (const mascot of MASCOT_KINDS) {
    expect(fullRowCount(twoDone, { mascot })).toBe(1 + 1 + 2 * 2 + 1)
    expect(fullRowCount(threeDone, { mascot })).toBe(1 + 1 + 2 * 3 + 2)
    // 只有一張完成卡片：前後都不加
    expect(fullRowCount(batchOf(doneRow('d')), { mascot })).toBe(1 + 1 + 2)
  }
})

test('畫小人時（方塊版、圖片版都一樣），執行中與失敗卡片比小人高，相鄰之間不加空列；組與組之間照舊只空一列', () => {
  const batch = batchOf(row({ id: 'r1' }), row({ id: 'r2' }), failedRow('f1'), failedRow('f2'), doneRow('d'))
  const expected = 1 + (1 + 5 * 2) + 1 + (1 + 3 * 2) + 1 + (1 + 2)
  expect(fullRowCount(batch, { mascot: null })).toBe(expected)
  for (const mascot of MASCOT_KINDS) expect(fullRowCount(batch, { mascot })).toBe(expected)
})

test('要不要空列看卡片與小人實際畫出來的列數：卡片不比小人高才空，方塊版、圖片版各自照實際的小人算', () => {
  const options = { columns: 40, now: 20_000, frame: 0 }
  const rowsOf = (card: { lines: Span[][]; bar: string[] }) => card.lines.length + (card.bar.length > 0 ? 1 : 0)
  for (const kind of MASCOT_KINDS) {
    for (const agent of [row(), failedRow('f'), doneRow('d')]) {
      const pair = batchOf({ ...agent, id: 'x1' }, { ...agent, id: 'x2' })
      const added = fullRowCount(pair, { mascot: kind }) - fullRowCount(pair, { mascot: null })
      expect(added).toBe(rowsOf(agentCard(agent, options)) <= agentMascot(agent, { ...options, kind }).rows ? 1 : 0)
    }
  }
})

test('卡片實際列數與 fullRowCount 用的一致', () => {
  const rowsOf = (card: { lines: Span[][]; bar: string[] }) => card.lines.length + (card.bar.length > 0 ? 1 : 0)
  const options = { columns: 40, now: 20_000, frame: 0 }
  expect(rowsOf(agentCard(row(), options))).toBe(5)
  expect(rowsOf(agentCard(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 }), options))).toBe(3)
  expect(rowsOf(agentCard(row({ status: 'done', endedAt: 9000 }), options))).toBe(2)
})

test('方塊版小人的版面：扣掉小人 7 欄與間隔 1 欄，文字還有 24 欄才畫，不然寬度全留給文字', () => {
  expect([MASCOT_GAP, MIN_TEXT_COLUMNS_WITH_MASCOT]).toEqual([1, 24])
  expect(mascotLayout(42, 'raster')).toEqual({ mascot: 'raster', textColumns: 34 })
  expect(mascotLayout(32, 'raster')).toEqual({ mascot: 'raster', textColumns: 24 })
  expect(mascotLayout(31, 'raster')).toEqual({ mascot: null, textColumns: 31 })
  expect(mascotLayout(20, 'raster')).toEqual({ mascot: null, textColumns: 20 })
})

test('圖片版小人的版面：扣掉小人 4 欄與間隔 1 欄，文字還有 24 欄才畫，不然寬度全留給文字', () => {
  expect(MASCOT_IMAGE_COLUMNS).toBe(4)
  expect(mascotLayout(42, 'image')).toEqual({ mascot: 'image', textColumns: 37 })
  expect(mascotLayout(29, 'image')).toEqual({ mascot: 'image', textColumns: 24 })
  expect(mascotLayout(28, 'image')).toEqual({ mascot: null, textColumns: 28 })
  expect(mascotLayout(20, 'image')).toEqual({ mascot: null, textColumns: 20 })
})

test('拿不到小人（例如桌面版）時不畫，寬度全留給文字', () => {
  expect(mascotLayout(42, null)).toEqual({ mascot: null, textColumns: 42 })
  expect(mascotLayout(20, null)).toEqual({ mascot: null, textColumns: 20 })
})

test('方塊版小人：執行中畫大的（7×4）、完成與失敗畫小的（7×2），造型取 look，動畫拍數照傳', () => {
  const picture = (look: number, size: MascotSize, state: MascotState, frame: number) => ({ kind: 'raster', ...mascotRaster({ look, size, state, frame }) })
  const options = { now: 2000, frame: 3, kind: 'raster' } as const
  const running = agentMascot(row({ look: 2 }), options)
  expect([running.columns, running.rows]).toEqual([7, 4])
  expect(running).toEqual(picture(2, 'large', 'running', 3))
  const done = agentMascot(row({ look: 5, status: 'done', endedAt: 1000 }), options)
  expect([done.columns, done.rows]).toEqual([7, 2])
  expect(done).toEqual(picture(5, 'small', 'done', 3))
  const failed = agentMascot(row({ look: 1, status: 'failed', failureReason: '已中斷', endedAt: 1000 }), options)
  expect([failed.columns, failed.rows]).toEqual([7, 2])
  expect(failed).toEqual(picture(1, 'small', 'failed', 3))
})

test('圖片版小人：各狀態都是 4×2、沒有大小之分，造型取 look，動畫拍數照傳', () => {
  const picture = (look: number, state: MascotState, frame: number) => ({
    kind: 'image',
    source: mascotImage({ look, state, frame }),
    columns: MASCOT_IMAGE_COLUMNS,
    rows: MASCOT_IMAGE_ROWS,
  })
  const options = { now: 2000, frame: 3, kind: 'image' } as const
  const running = agentMascot(row({ look: 2 }), options)
  expect([running.columns, running.rows]).toEqual([4, 2])
  expect(running).toEqual(picture(2, 'running', 3))
  expect(agentMascot(row({ look: 5, status: 'done', endedAt: 1000 }), options)).toEqual(picture(5, 'done', 3))
  expect(agentMascot(row({ look: 1, status: 'failed', failureReason: '已中斷', endedAt: 1000 }), options)).toEqual(picture(1, 'failed', 3))
})

test('方塊版小人：卡住（沿用卡片的卡住判斷）時停下變黃，還沒卡住照常走路', () => {
  const raster = (options: Parameters<typeof mascotRaster>[0]) => ({ kind: 'raster', ...mascotRaster(options) })
  const toolStep = (stepMs: number) => agentMascot(row({ look: 3, activityStartedAt: 10_000 }), { now: 10_000 + stepMs, frame: 3, kind: 'raster' })
  expect(toolStep(179_999)).toEqual(raster({ look: 3, size: 'large', state: 'running', frame: 3 }))
  expect(toolStep(180_001)).toEqual(raster({ look: 3, size: 'large', state: 'stalled', frame: 3 }))
  const thinking = (stepMs: number) => agentMascot(row({ activity: '思考中', activityStartedAt: 0 }), { now: stepMs, frame: 0, kind: 'raster' })
  expect(thinking(200_000)).toEqual(raster({ look: 0, size: 'large', state: 'running', frame: 0 }))
  expect(thinking(300_001)).toEqual(raster({ look: 0, size: 'large', state: 'stalled', frame: 0 }))
})

test('圖片版小人：卡住時也停下變黃，還沒卡住照常走路', () => {
  const sourceOf = (stepMs: number) => {
    const mascot = agentMascot(row({ look: 3, activityStartedAt: 10_000 }), { now: 10_000 + stepMs, frame: 3, kind: 'image' })
    return mascot.kind === 'image' ? mascot.source : null
  }
  expect(sourceOf(179_999)).toEqual(mascotImage({ look: 3, state: 'running', frame: 3 }))
  expect(sourceOf(180_001)).toEqual(mascotImage({ look: 3, state: 'stalled', frame: 3 }))
})

test('小人：舊版存下、沒有 look 的列不丟例外，方塊版、圖片版都畫成第一種造型', () => {
  const patches: Partial<AgentRow>[] = [{}, { status: 'done', endedAt: 1000 }, { status: 'failed', failureReason: '已中斷', endedAt: 1000 }]
  for (const kind of MASCOT_KINDS) {
    const options = { now: 2000, frame: 3, kind }
    for (const patch of patches) {
      const { look: _look, ...legacy } = row({ ...patch, look: 4 })
      expect(() => agentMascot(legacy as AgentRow, options)).not.toThrow()
      expect(agentMascot(legacy as AgentRow, options)).toEqual(agentMascot(row({ ...patch, look: 0 }), options))
    }
  }
})
