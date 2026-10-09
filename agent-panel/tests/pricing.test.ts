import { expect, test } from 'claude-code/testing'

import { contextPercent, modelInfo, promptTokens, requestCostUsd, totalTokens } from '../hooks/pricing'

// 測試工具沒有 toBeCloseTo：金額四捨五入到小數 6 位再比對
const dollars = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6)

test('模型 id 的各種寫法都對到同一個 key 與顯示名稱', () => {
  for (const id of ['claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5-5[1m]'])
    expect(modelInfo(id)).toEqual({ key: 'opus-5-5', name: 'Opus 5.5', family: 'opus', contextWindow: 1_000_000 })
  expect(modelInfo('claude-haiku-4-5-20251001')).toMatchObject({ key: 'haiku-4-5', name: 'Haiku 4.5', contextWindow: 200_000 })
  expect(modelInfo('claude-opus-4-5@20251101')).toMatchObject({ name: 'Opus 4.5', family: 'opus', key: null })
  expect(modelInfo('claude-fable-5-1')).toMatchObject({ name: 'Fable 5.1', family: 'fable' })
  expect(modelInfo('claude-mythos-5-1')).toMatchObject({ name: 'Mythos 5.1', family: 'fable' })
  expect(modelInfo('gpt-x')).toEqual({ key: null, name: 'gpt-x', family: 'unknown', contextWindow: null })
})

test('單次請求的費用依四種 token 各自的單價', () => {
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }
  expect(dollars(requestCostUsd('claude-opus-5-5', usage))).toBe(0.071)
  expect(requestCostUsd('claude-opus-4-5', usage)).toBeNull()
})

test('Haiku 5.5 提示超過 100,000 token 改用高價', () => {
  const small = { input_tokens: 50_000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const large = { ...small, input_tokens: 150_000 }
  expect(dollars(requestCostUsd('claude-haiku-5-5', small))).toBe(0.0055)
  expect(dollars(requestCostUsd('claude-haiku-5-5', large))).toBe(0.0775)
})

test('ctx % 以提示 token 除以 context 上限', () => {
  const usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 3000 }
  expect(promptTokens(usage)).toBe(30_000)
  expect(totalTokens(usage)).toBe(30_500)
  expect(contextPercent('claude-opus-5-5', usage)).toBe(3)
  expect(contextPercent('claude-haiku-4-5', { ...usage, cache_read_input_tokens: 45_000 })).toBe(25)
  expect(contextPercent('gpt-x', usage)).toBeNull()
})
