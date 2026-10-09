import { expect, test } from 'claude-code/testing'

import {
  addAgent,
  agentTokens,
  batchTotals,
  finishAgent,
  hasRunning,
  recordReported,
  recordStep,
  recordThinking,
  recordToolCall,
  seedRunning,
} from '../hooks/batch'
import type { AgentRow } from '../types'

const spawn = (id: string, startedAt = 0, isNested = false) => ({
  id,
  description: `任務 ${id}`,
  agentType: 'general-purpose',
  agentName: null,
  isNested,
  startedAt,
})
const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }

test('同一回合加進同一批，重複 id 不重複加', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = addAgent(b, 't1', spawn('b'))
  b = addAgent(b, 't1', spawn('b'))
  expect(b.turnId).toBe('t1')
  expect(b.agents.map(a => a.id)).toEqual(['a', 'b'])
  expect(b.agents[0]).toMatchObject({ status: 'running', toolCount: 0, activity: '', model: null, reportedTokens: null })
})

test('新的一列帶上派出時的類型與名字，目前動作從派出時算起，沒有費用欄位', () => {
  const b = addAgent(null, 't1', { id: 'a', description: '找出呼叫端', agentType: 'Explore', agentName: 'scout', isNested: true, startedAt: 100 })
  expect(b.agents[0]).toEqual({
    id: 'a',
    description: '找出呼叫端',
    agentType: 'Explore',
    agentName: 'scout',
    isNested: true,
    status: 'running',
    startedAt: 100,
    endedAt: null,
    failureReason: null,
    model: null,
    effort: null,
    toolCount: 0,
    activity: '',
    activityStartedAt: 100,
    lastUsage: null,
    reportedTokens: null,
    look: 0,
  })
})

test('造型編號：同一批依派出順序拿到 0、1、2', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = addAgent(b, 't1', spawn('b'))
  b = addAgent(b, 't1', spawn('c'))
  expect(b.agents.map(a => a.look)).toEqual([0, 1, 2])
})

test('造型編號：新回合帶過來的保留原本的，新派的拿這一批還沒用掉的最小號碼，被清掉的號碼可以再用', () => {
  let b = addAgent(addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b')), 't1', spawn('c'))
  b = finishAgent(finishAgent(b, 'a', 'answer', 10), 'c', 'answer', 10)
  // 新回合只帶過還在跑的 b（1）；a 的 0、c 的 2 跟著被清掉，可以再用
  b = addAgent(b, 't2', spawn('d'))
  b = addAgent(b, 't2', spawn('e'))
  b = addAgent(b, 't2', spawn('f'))
  expect(b.agents.map(a => [a.id, a.look])).toEqual([['b', 1], ['d', 0], ['e', 2], ['f', 3]])
})

test('造型編號：seedRunning 補上的列依清單順序，拿這一批還沒用掉的號碼', () => {
  let b = addAgent(addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b')), 't1', spawn('c'))
  b = finishAgent(finishAgent(b, 'a', 'answer', 10), 'b', 'answer', 10)
  b = addAgent(b, 't2', spawn('d'))
  const seeded = seedRunning(b, [
    { id: 'x', description: '補上的', status: 'running', type: 'general-purpose' },
    { id: 'y', description: '補上的', status: 'pending', type: 'general-purpose' },
  ], 50)
  expect(seeded!.agents.map(a => [a.id, a.look])).toEqual([['c', 2], ['d', 0], ['x', 1], ['y', 3]])
})

test('造型編號：舊版存下、沒有 look 的列當成造型 0，新派與補上的都不跟它撞', () => {
  const { look: _look, ...legacy } = addAgent(null, 't1', spawn('old')).agents[0]!
  const b = addAgent({ turnId: 't1', agents: [legacy as AgentRow] }, 't1', spawn('a'))
  expect(b.agents.map(a => a.look)).toEqual([undefined, 1])
  const seeded = seedRunning({ turnId: 't1', agents: [legacy as AgentRow] }, [
    { id: 'x', description: '補上的', status: 'running', type: 'general-purpose' },
  ], 50)
  expect(seeded!.agents.map(a => a.look)).toEqual([undefined, 1])
})

test('新回合開新一批：帶過跑到一半的，清掉已完成的；turnId 不明時沿用', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = finishAgent(b, 'a', 'answer', 10)
  b = addAgent(b, 't2', spawn('c', 20))
  expect(b.turnId).toBe('t2')
  expect(b.agents.map(a => a.id)).toEqual(['b', 'c'])
  expect(addAgent(b, null, spawn('d')).agents.map(a => a.id)).toEqual(['b', 'c', 'd'])
})

test('記錄請求：模型、有值才覆寫的 effort、最後一次用量；不算費用；不在這一批的忽略', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', effort: 'xhigh', usage })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage: null })
  expect(b.agents[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', lastUsage: usage })
  expect(b.agents[0]).not.toHaveProperty('costUsd')
  expect(b.agents[0]).not.toHaveProperty('hasUnpricedUsage')
  expect(recordStep(b, 'zzz', { model: 'claude-opus-5-5', usage })).toBe(b)
})

test('思考中：更新正在做什麼與開始時間，不加工具次數；不在這一批的原樣回傳', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = recordToolCall(b, 'a', '讀取 src/app.ts', 200)
  b = recordThinking(b, 'a', 300)
  expect(b.agents[0]).toMatchObject({ activity: '思考中', activityStartedAt: 300, toolCount: 1 })
  expect(recordThinking(b, 'zzz', 400)).toBe(b)
})

test('工具呼叫：次數加一、更新正在做什麼與開始時間；不在這一批的原樣回傳', () => {
  let b = addAgent(null, 't1', spawn('a', 100))
  b = recordToolCall(b, 'a', '讀取 src/app.ts', 200)
  expect(b.agents[0]).toMatchObject({ toolCount: 1, activity: '讀取 src/app.ts', activityStartedAt: 200 })
  b = recordToolCall(b, 'a', '執行 npm test', 250)
  expect(b.agents[0]).toMatchObject({ toolCount: 2, activity: '執行 npm test', activityStartedAt: 250 })
  expect(recordToolCall(b, 'zzz', '讀取 x', 300)).toBe(b)
})

test('Agent 結果的總計、完成與三種失敗原因；結束後保留最後的動作', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = recordToolCall(b, 'a', '讀取 src/app.ts', 200)
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  expect(agentTokens(b.agents[0]!)).toBe(18_000)
  b = recordReported(b, 'a', { totalTokens: 26_000, totalToolUseCount: 12 })
  expect(agentTokens(b.agents[0]!)).toBe(26_000)
  expect(b.agents[0]!.toolCount).toBe(12)
  expect(recordReported(b, 'b', { totalTokens: 'x' }).agents[1]!.reportedTokens).toBeNull()
  expect(finishAgent(b, 'a', 'answer', 5).agents[0]).toMatchObject({ status: 'done', endedAt: 5, failureReason: null })
  expect(finishAgent(b, 'a', 'aborted', 5).agents[0]).toMatchObject({
    status: 'failed',
    failureReason: '已中斷',
    activity: '讀取 src/app.ts',
    activityStartedAt: 200,
  })
  expect(finishAgent(b, 'a', 'error', 5).agents[0]!.failureReason).toBe('API 錯誤')
  expect(finishAgent(b, 'a', 'refusal', 5).agents[0]!.failureReason).toBe('模型拒絕')
})

test('總計只有 token 加總與時間，時間從最早開始到最晚結束或現在', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a', 1000)), 't1', spawn('b', 3000))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  b = finishAgent(b, 'a', 'answer', 5000)
  expect(batchTotals(b, 9000)).toEqual({ tokens: 18_000, elapsedMs: 8000 })
  b = finishAgent(b, 'b', 'answer', 7000)
  expect(batchTotals(b, 9000)).toEqual({ tokens: 18_000, elapsedMs: 6000 })
  expect(hasRunning(b)).toBe(false)
  expect(batchTotals({ turnId: 't1', agents: [] }, 9000)).toEqual({ tokens: 0, elapsedMs: 0 })
})

test('seedRunning 補上清單裡還在跑、這一批沒有的子代理', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'a', description: 'x', status: 'running', type: 'general-purpose' },
    { id: 'n', description: '巢狀', status: 'running', type: 'Explore', parentId: 'a' },
    { id: 'old', description: '舊的', status: 'completed', type: 'general-purpose' },
  ], 50)
  expect(b!.agents.map(a => [a.id, a.isNested, a.startedAt])).toEqual([['a', false, 0], ['n', true, 50]])
  expect(seedRunning(null, [], 0)).toBeNull()
})

test('seedRunning 補上的列：類型取自清單的 type，沒有名字，目前動作從補上時算起', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'n', description: '巢狀', status: 'running', type: 'Explore', parentId: 'a' },
  ], 50)
  expect(b!.agents[1]).toMatchObject({ agentType: 'Explore', agentName: null, activity: '', activityStartedAt: 50, startedAt: 50 })
})

test('seedRunning 也補上還沒開始、等待中的子代理（列為 running）；閒置與已結束的不補', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'p', description: '還沒開始', status: 'pending', type: 'general-purpose' },
    { id: 'w', description: '等待中', status: 'waiting', type: 'general-purpose' },
    { id: 'i', description: '閒置', status: 'idle', type: 'general-purpose' },
    { id: 'c', description: '完成', status: 'completed', type: 'general-purpose' },
    { id: 'f', description: '失敗', status: 'failed', type: 'general-purpose' },
    { id: 'k', description: '已停止', status: 'killed', type: 'general-purpose' },
  ], 50)
  expect(b!.agents.map(a => [a.id, a.status])).toEqual([['a', 'running'], ['p', 'running'], ['w', 'running']])
})

test('seedRunning 不補 teammate，跟派出時一致', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'bob', description: '隊友', status: 'running', type: 'general-purpose', teammateId: 'bob@team' },
    { id: 'n', description: '子代理', status: 'running', type: 'general-purpose' },
  ], 50)
  expect(b!.agents.map(a => a.id)).toEqual(['a', 'n'])
})
