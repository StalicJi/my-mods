import { expect, test } from 'claude-code/testing'

import { addAgent, agentTokens, batchTotals, finishAgent, hasRunning, recordReported, recordStep, recordToolCall, seedRunning } from '../hooks/batch'

const spawn = (id: string, startedAt = 0, isNested = false) => ({ id, description: `任務 ${id}`, isNested, startedAt })
const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }
// 測試工具沒有 toBeCloseTo：金額四捨五入到小數 6 位再比對
const dollars = (value: number) => Math.round(value * 1e6) / 1e6

test('同一回合加進同一批，重複 id 不重複加', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = addAgent(b, 't1', spawn('b'))
  b = addAgent(b, 't1', spawn('b'))
  expect(b.turnId).toBe('t1')
  expect(b.agents.map(a => a.id)).toEqual(['a', 'b'])
  expect(b.agents[0]).toMatchObject({ status: 'running', toolCount: 0, activity: '', model: null, costUsd: 0, hasUnpricedUsage: false, reportedTokens: null })
})

test('新回合開新一批：帶過跑到一半的，清掉已完成的；turnId 不明時沿用', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = finishAgent(b, 'a', 'answer', 10)
  b = addAgent(b, 't2', spawn('c', 20))
  expect(b.turnId).toBe('t2')
  expect(b.agents.map(a => a.id)).toEqual(['b', 'c'])
  expect(addAgent(b, null, spawn('d')).agents.map(a => a.id)).toEqual(['b', 'c', 'd'])
})

test('記錄請求：模型、effort、最後一次用量與累加費用；未知模型標記；不在這一批的忽略', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', effort: 'xhigh', usage })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', effort: 'xhigh', usage })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage: null })
  expect(b.agents[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', lastUsage: usage })
  expect(dollars(b.agents[0]!.costUsd)).toBe(0.142)
  expect(recordStep(b, 'a', { model: 'gpt-x', usage }).agents[0]!.hasUnpricedUsage).toBe(true)
  expect(recordStep(b, 'zzz', { model: 'claude-opus-5-5', usage })).toEqual(b)
})

test('工具呼叫、Agent 結果的總計、完成與三種失敗原因', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = recordToolCall(b, 'a', '讀取 src/app.ts')
  expect(b.agents[0]).toMatchObject({ toolCount: 1, activity: '讀取 src/app.ts' })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  expect(agentTokens(b.agents[0]!)).toBe(18_000)
  b = recordReported(b, 'a', { totalTokens: 26_000, totalToolUseCount: 12 })
  expect(agentTokens(b.agents[0]!)).toBe(26_000)
  expect(b.agents[0]!.toolCount).toBe(12)
  expect(recordReported(b, 'b', { totalTokens: 'x' }).agents[1]!.reportedTokens).toBeNull()
  expect(finishAgent(b, 'a', 'answer', 5).agents[0]).toMatchObject({ status: 'done', endedAt: 5, failureReason: null })
  expect(finishAgent(b, 'a', 'aborted', 5).agents[0]!.failureReason).toBe('已中斷')
  expect(finishAgent(b, 'a', 'error', 5).agents[0]!.failureReason).toBe('API 錯誤')
  expect(finishAgent(b, 'a', 'refusal', 5).agents[0]!.failureReason).toBe('模型拒絕')
})

test('總計：費用、未定價標記、token 加總，時間從最早開始到最晚結束或現在', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a', 1000)), 't1', spawn('b', 3000))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  b = finishAgent(b, 'a', 'answer', 5000)
  expect(batchTotals(b, 9000)).toMatchObject({ tokens: 18_000, hasUnpriced: false, elapsedMs: 8000 })
  b = finishAgent(b, 'b', 'answer', 7000)
  expect(batchTotals(b, 9000).elapsedMs).toBe(6000)
  expect(hasRunning(b)).toBe(false)
})

test('seedRunning 補上清單裡還在跑、這一批沒有的子代理', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'a', description: 'x', status: 'running' },
    { id: 'n', description: '巢狀', status: 'running', parentId: 'a' },
    { id: 'old', description: '舊的', status: 'completed' },
  ], 50)
  expect(b!.agents.map(a => [a.id, a.isNested, a.startedAt])).toEqual([['a', false, 0], ['n', true, 50]])
  expect(seedRunning(null, [], 0)).toBeNull()
})
