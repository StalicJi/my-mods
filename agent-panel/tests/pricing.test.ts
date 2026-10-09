import { expect, test } from 'claude-code/testing'

import { contextPercent, modelInfo, promptTokens, totalTokens } from '../hooks/pricing'

test('模型 id 的各種寫法都對到同一個 key 與顯示名稱', () => {
  for (const id of ['claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5-5[1m]'])
    expect(modelInfo(id)).toEqual({ key: 'opus-5-5', name: 'Opus 5.5', family: 'opus', contextWindow: 1_000_000 })
  expect(modelInfo('claude-haiku-4-5-20251001')).toMatchObject({ key: 'haiku-4-5', name: 'Haiku 4.5', contextWindow: 200_000 })
  expect(modelInfo('claude-opus-4-5@20251101')).toMatchObject({ name: 'Opus 4.5', family: 'opus', key: null })
  expect(modelInfo('claude-fable-5-1')).toMatchObject({ name: 'Fable 5.1', family: 'fable' })
  expect(modelInfo('claude-mythos-5-1')).toMatchObject({ name: 'Mythos 5.1', family: 'fable' })
  expect(modelInfo('gpt-x')).toEqual({ key: null, name: 'gpt-x', family: 'unknown', contextWindow: null })
})

test('context 上限表：列在表上的才有 key；haiku-4-5 是 200,000，其餘 1,000,000', () => {
  const millionKeys = [
    'fable-5-1', 'mythos-5-1', 'fable-5', 'mythos-5',
    'opus-5-5', 'opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6',
    'sonnet-5-5', 'sonnet-5', 'sonnet-4-6', 'haiku-5-5',
  ]
  for (const key of millionKeys) expect(modelInfo(`claude-${key}`)).toMatchObject({ key, contextWindow: 1_000_000 })
  expect(modelInfo('claude-haiku-4-5')).toMatchObject({ key: 'haiku-4-5', contextWindow: 200_000 })
  // 認得系列與版本、但不在表上：有顯示名稱，沒有 key 與上限
  expect(modelInfo('claude-sonnet-4-5')).toEqual({ key: null, name: 'Sonnet 4.5', family: 'sonnet', contextWindow: null })
})

test('ctx % 以提示 token 除以 context 上限', () => {
  const usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 3000 }
  expect(promptTokens(usage)).toBe(30_000)
  expect(totalTokens(usage)).toBe(30_500)
  expect(contextPercent('claude-opus-5-5', usage)).toBe(3)
  expect(contextPercent('claude-haiku-4-5', { ...usage, cache_read_input_tokens: 45_000 })).toBe(25)
  expect(contextPercent('claude-opus-4-5', usage)).toBeNull()
  expect(contextPercent('gpt-x', usage)).toBeNull()
})

test('Bedrock 跨區域前綴與版本後綴的寫法也對到同一個 key', () => {
  expect(modelInfo('us.anthropic.claude-opus-4-6-v1:0')).toMatchObject({ key: 'opus-4-6', name: 'Opus 4.6', family: 'opus' })
  expect(modelInfo('global.anthropic.claude-sonnet-4-6-20251001-v1:0')).toMatchObject({ key: 'sonnet-4-6', name: 'Sonnet 4.6' })
  expect(modelInfo('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toMatchObject({ key: 'haiku-4-5', contextWindow: 200_000 })
  expect(modelInfo('apac.anthropic.claude-opus-5-5')).toMatchObject({ key: 'opus-5-5' })
})
