import { expect, test } from 'claude-code/testing'

import { detailLayout, detailRows, formatOffset, wrapCached, wrapToWidth } from '../hooks/detail'
import { MAX_ENTRIES } from '../hooks/log'
import { displayWidth } from '../hooks/layout'
import type { Span } from '../hooks/layout'
import type { LogEntry } from '../types'

const options = { columns: 40, now: 122_000, startedAt: 0 }
const texts = (rows: Span[][]) => rows.map(row => row.map(span => span.text).join(''))
const tool = (at: number, summary: string, outcome: string, errorLine: string | null = null) =>
  ({ kind: 'tool', id: `${at}`, at, summary, outcome, errorLine }) as LogEntry

test('formatOffset', () => {
  expect(formatOffset(4000)).toBe('+0:04')
  expect(formatOffset(3_723_000)).toBe('+1:02:03')
  expect(formatOffset(-5)).toBe('+0:00')
})

test('工具五種狀態的圖示、顏色與錯誤列', () => {
  const rows = detailRows({ entries: [
    tool(4000, '讀取 config.ghostty', 'ok'),
    tool(12_000, '讀取 GhosttyConfig.swift', 'error', 'File does not exist'),
    tool(13_000, '執行：rm -rf /', 'denied', '不允許'),
    tool(14_000, '讀取 a.ts', 'unfinished'),
    tool(118_000, '搜尋 ConfigPaths', 'running'),
  ], dropped: 0 }, options)
  expect(texts(rows).slice(0, 6)).toEqual([
    '+0:04 ✓ 讀取 config.ghostty',
    '+0:12 ✗ 讀取 GhosttyConfig.swift',
    '        File does not exist',
    '+0:13 ⊘ 執行：rm -rf /',
    '        不允許',
    '+0:14 · 讀取 a.ts',
  ])
  // 右邊是已經跑了多久（跟卡片的耗時一樣，不加 +）
  expect(texts(rows)[6]).toMatch(/^\+1:58 … 搜尋 ConfigPaths +0:04$/)
  expect(displayWidth(texts(rows)[6]!)).toBe(40)
  expect(rows[0]!.find(span => span.text === '✓')).toMatchObject({ color: 'success' })
  expect(rows[1]!.find(span => span.text === '✗')).toMatchObject({ color: 'error' })
  expect(rows[2]!.at(-1)).toMatchObject({ color: 'error' })
  expect(rows[3]!.find(span => span.text === '⊘')).toMatchObject({ color: 'warning' })
  expect(rows[5]!.every(span => span.isDim)).toBe(true)
  expect(rows[0]![0]).toMatchObject({ isDim: true })
})

test('時間欄依最寬的對齊', () => {
  const rows = detailRows({ entries: [tool(4000, '讀取 a', 'ok'), tool(754_000, '讀取 b', 'ok')], dropped: 0 }, { ...options, now: 760_000 })
  expect(texts(rows)).toEqual(['+0:04  ✓ 讀取 a', '+12:34 ✓ 讀取 b'])
})

test('中途訊息最多 3 列、結尾 …」，續行對齊；短訊息一列；換行合成空白', () => {
  const long = detailRows({ entries: [{ kind: 'message', at: 10_000, text: '找到 4 個 cmux 自有鍵，'.repeat(10) }], dropped: 0 }, { ...options, columns: 30 })
  const lines = texts(long)
  expect(lines).toHaveLength(3)
  expect(lines[0]!.startsWith('+0:10 「')).toBe(true)
  expect(lines[1]!.startsWith('      ')).toBe(true)
  expect(lines[2]!.endsWith('…」')).toBe(true)
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30)
  expect(texts(detailRows({ entries: [{ kind: 'message', at: 10_000, text: '找到\n4 個鍵' }], dropped: 0 }, options))).toEqual(['+0:10 「找到 4 個鍵」'])
})

test('回報：標題列加粗，全文完整換行並保留空行', () => {
  const report = '第一段' + '很長'.repeat(30) + '\n\n第二段'
  const rows = detailRows({ entries: [{ kind: 'report', at: 123_000, text: report }], dropped: 0 }, options)
  expect(texts(rows)[0]).toBe('+2:03 回報')
  expect(rows[0]!.find(span => span.text === '回報')).toMatchObject({ isBold: true })
  const body = texts(rows).slice(1)
  expect(body.every(line => line === '' || line.startsWith('      '))).toBe(true)
  expect(body.map(line => line.trim()).join('')).toBe(report.replace(/\n/g, ''))
  expect(body.some(line => line.trim() === '')).toBe(true)
})

test('沒有空白的長字串依寬度硬切，不超出面板', () => {
  const url = 'https://example.com/' + 'a'.repeat(280)
  const rows = detailRows({ entries: [{ kind: 'report', at: 0, text: url }, { kind: 'message', at: 0, text: url }], dropped: 0 }, { ...options, columns: 30 })
  for (const line of texts(rows)) expect(displayWidth(line)).toBeLessThanOrEqual(30)
})

test('換行快取不影響結果：同一段紀錄換寬度再換回來，結果一致', () => {
  const log = { entries: [{ kind: 'report', at: 0, text: '很長的回報'.repeat(40) }] as LogEntry[], dropped: 0 }
  const first = detailRows(log, { ...options, columns: 30 })
  expect(detailRows(log, options)).not.toEqual(first)
  expect(detailRows(log, { ...options, columns: 30 })).toEqual(first)
})

test('已省略提示與沒有紀錄的提示', () => {
  expect(texts(detailRows({ entries: [tool(0, '讀取 a', 'ok')], dropped: 3 }, options))[0]).toBe('更早的 3 筆已省略')
  expect(detailRows({ entries: [], dropped: 0 }, options)).toEqual([[{ text: 'mod 載入前的紀錄沒有保留', isDim: true }]])
})

test('wrapToWidth：中文 2 欄、分段', () => {
  expect(wrapToWidth('中文字', 4)).toEqual(['中文', '字'])
  expect(wrapToWidth('ab\n\ncd', 10)).toEqual(['ab', '', 'cd'])
})

test('detailLayout 的 newestRow 指向最新一筆的第一列（算進已省略列與多列的紀錄）；沒有紀錄是 -1', () => {
  const log = { entries: [tool(4000, '讀取 a', 'ok'), { kind: 'message', at: 10_000, text: '很長的一句話'.repeat(8) }, tool(12_000, '讀取 b', 'error', '找不到')] as LogEntry[], dropped: 2 }
  const layout = detailLayout(log, options)
  expect(layout.rows).toEqual(detailRows(log, options))
  expect(texts(layout.rows)[layout.newestRow]).toBe('+0:12 ✗ 讀取 b')
  expect(layout.newestRow).toBe(layout.rows.length - 2)
  expect(detailLayout({ entries: [], dropped: 0 }, options).newestRow).toBe(-1)
})

test('錯誤與被拒絕的原因列是淡色（淡紅、淡黃）', () => {
  const rows = detailRows({ entries: [tool(1000, '讀取 a', 'error', 'File does not exist'), tool(2000, '執行：rm', 'denied', '不允許')], dropped: 0 }, options)
  expect(rows[1]!.at(-1)).toMatchObject({ text: 'File does not exist', color: 'error', isDim: true })
  expect(rows[3]!.at(-1)).toMatchObject({ text: '不允許', color: 'warning', isDim: true })
})

test('wrapToWidth：英數字詞不在中間切開，放不下就整個換到下一列，續行開頭不留空白', () => {
  expect(wrapToWidth('File does not exist. Note: your current working directory', 20)).toEqual([
    'File does not exist.',
    'Note: your current',
    'working directory',
  ])
  expect(wrapToWidth('說明這是個人使用的 Claude Code mod marketplace，只放通用程式碼', 20)).toEqual([
    '說明這是個人使用的',
    'Claude Code mod',
    'marketplace，只放通',
    '用程式碼',
  ])
  expect(wrapToWidth('aaaa bbbb', 4)).toEqual(['aaaa', 'bbbb'])
})

test('wrapToWidth：比一列還長的詞才硬切；段落本身開頭的縮排保留', () => {
  expect(wrapToWidth('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
  expect(wrapToWidth('  - 項目', 20)).toEqual(['  - 項目'])
})

test('換行快取放得下一整頁：紀錄滾動（丟掉最舊一筆、加一筆新的）時，其他筆都用快取，只算新的那一筆', () => {
  const wrapPage = (start: number) => Array.from({ length: MAX_ENTRIES }, (_, offset) => wrapCached(`第 ${start + offset} 則快取訊息`, 30))
  let previous = wrapPage(0)
  // 滾動超過兩頁：滿了就整個清空的快取，就算上限放大也會在某一次重畫時全部重算
  for (let start = 1; start <= 2 * MAX_ENTRIES; start++) {
    const current = wrapPage(start)
    // 命中快取時回傳同一個陣列
    current.slice(0, -1).forEach((lines, index) => expect(lines).toBe(previous[index + 1]))
    previous = current
  }
})

test('換行快取放得下兩種寬度的一整頁：兩種寬度輪流重畫時都用快取', () => {
  const wrapPage = (width: number) => Array.from({ length: MAX_ENTRIES }, (_, index) => wrapCached(`第 ${index} 則雙寬度訊息`, width))
  const narrow = wrapPage(30)
  const wide = wrapPage(40)
  wrapPage(30).forEach((lines, index) => expect(lines).toBe(narrow[index]))
  wrapPage(40).forEach((lines, index) => expect(lines).toBe(wide[index]))
})

test('wrapCached 回傳唯讀陣列，呼叫端改不到快取裡的換行結果', () => {
  const lines = wrapCached('唯讀檢查', 30)
  // 只檢查型別、不執行：回傳型別是 readonly string[]，push 是型別錯誤
  // @ts-expect-error
  const mutate = () => lines.push('x')
  expect(typeof mutate).toBe('function')
  expect(lines).toEqual(['唯讀檢查'])
})
