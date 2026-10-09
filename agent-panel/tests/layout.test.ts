import { expect, test } from 'claude-code/testing'

import type { Span } from '../hooks/layout'
import { agentCard, displayWidth, fitToWidth, formatCost, formatElapsed, formatTokens, splitSections, summaryMode } from '../hooks/layout'
import type { AgentRow } from '../types'

const row = (patch: Partial<AgentRow> = {}): AgentRow => ({
  id: 'a', description: 'Review the whole kit', isNested: false, status: 'running', startedAt: 0, endedAt: null,
  failureReason: null, model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 12, activity: '讀取 src/app.ts',
  lastUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 },
  reportedTokens: null, costUsd: 0.004, hasUnpricedUsage: false, ...patch,
})
const text = (line: Span[]) => line.map(s => s.text).join('')

test('格式：時間、token、費用', () => {
  expect([formatElapsed(2000), formatElapsed(47_000), formatElapsed(3_723_000)]).toEqual(['0:02', '0:47', '1:02:03'])
  expect([formatTokens(950), formatTokens(26_400), formatTokens(150_000), formatTokens(1_240_000)]).toEqual(['950', '26k', '150k', '1.2M'])
  expect([formatCost(0.08, false), formatCost(0, true), formatCost(0.28, true)]).toEqual(['≈$0.08', '≈?', '≈$0.28+?'])
})

test('依顯示寬度截斷，中文一字兩格', () => {
  expect(fitToWidth('Review the whole kit', 10)).toBe('Review th…')
  expect(fitToWidth('檢查整份設計文件與實作計畫', 11)).toBe('檢查整份設…')
  expect(displayWidth(fitToWidth('檢查整份設計文件與實作計畫', 11))).toBeLessThanOrEqual(11)
})

test('執行中卡片 5 列：名稱、模型、正在做什麼、用量、進度條', () => {
  const card = agentCard(row(), { columns: 40, now: 2000, frame: 3 })
  expect(card.lines.map(text)).toEqual(['● Review the whole kit', '  Opus 5.5 · xhigh · 12 tools', '  讀取 src/app.ts', '  ctx 3% · 27k · ≈$0.00 · 0:02'])
  expect(card.bar).toHaveLength(38)
  expect(card.lines[1]![0]).toMatchObject({ text: '  ' })
  expect(card.lines[1]![1]).toMatchObject({ text: 'Opus 5.5', color: '#f79a4f' })
})

test('完成 4 列、失敗 5 列，巢狀加箭頭，沒有模型顯示 starting', () => {
  const done = agentCard(row({ status: 'done', endedAt: 44_000, model: 'claude-sonnet-5-5' }), { columns: 40, now: 50_000, frame: 0 })
  expect(done.lines.map(text)[0]).toBe('✓ Review the whole kit')
  expect(done.lines).toHaveLength(3)
  expect(new Set(done.bar)).toEqual(new Set(['#6f7df2']))
  const failed = agentCard(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 }), { columns: 40, now: 9000, frame: 0 })
  expect(failed.lines.map(text)[2]).toBe('  已中斷')
  expect(new Set(failed.bar)).toEqual(new Set(['#8a8a94']))
  expect(text(agentCard(row({ isNested: true, model: null, activity: '' }), { columns: 40, now: 0, frame: 0 }).lines[0]!)).toBe('● ↳ Review the whole kit')
  expect(agentCard(row({ model: null, activity: '' }), { columns: 40, now: 0, frame: 0 }).lines.map(text).slice(1, 3)).toEqual(['  starting · xhigh · 12 tools', '  思考中'])
})

test('窄面板：很長的中文描述截斷，不超過寬度', () => {
  const card = agentCard(row({ description: '把這週每一天的工作日報都補齊並且彙總成月報再寄出' }), { columns: 30, now: 0, frame: 0 })
  for (const line of card.lines) expect(displayWidth(text(line))).toBeLessThanOrEqual(30)
})

test('統計區塊模式與分組', () => {
  expect([summaryMode(36), summaryMode(35)]).toEqual(['tiles', 'line'])
  const b = { turnId: 't', agents: [row({ id: 'r' }), row({ id: 'd', status: 'done' }), row({ id: 'f', status: 'failed' })] }
  const { running, finished } = splitSections(b)
  expect([running.map(a => a.id), finished.map(a => a.id)]).toEqual([['r'], ['d', 'f']])
})
