// 模型 id 轉顯示名稱與 context 上限，算出 token 數與 ctx 百分比
import type { TokenUsage } from '../types'

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown'

export type ModelInfo = { key: string | null; name: string; family: ModelFamily; contextWindow: number | null }

const MILLION = 1_000_000

// 已知模型的 context 上限（token）；不在表上的模型沒有 key，也不算 ctx %
const CONTEXT_WINDOWS: Record<string, number> = {
  'fable-5-1': MILLION,
  'mythos-5-1': MILLION,
  'fable-5': MILLION,
  'mythos-5': MILLION,
  'opus-5-5': MILLION,
  'opus-5': MILLION,
  'opus-4-8': MILLION,
  'opus-4-7': MILLION,
  'opus-4-6': MILLION,
  'sonnet-5-5': MILLION,
  'sonnet-5': MILLION,
  'sonnet-4-6': MILLION,
  'haiku-5-5': MILLION,
  'haiku-4-5': 200_000,
}

// 系列、主版本、次版本（一到兩位數），後面可能接 8 位數的日期
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/

// 同一個模型有好幾種寫法：Bedrock 的 anthropic. 前綴（跨區域時前面還有 us.、eu.、apac.、global.）
// 與 -v1:0 版本後綴、[1m] 這類後綴、Vertex 的 @ 日期後綴
function bareModelId(modelId: string) {
  return modelId
    .replace(/^(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@.*$/, '')
}

export function modelInfo(modelId: string): ModelInfo {
  const match = MODEL_ID.exec(bareModelId(modelId))
  if (!match) return { key: null, name: modelId, family: 'unknown', contextWindow: null }
  const [, series = '', major = '', minor] = match
  const version = minor === undefined ? major : `${major}.${minor}`
  const name = `${series.charAt(0).toUpperCase()}${series.slice(1)} ${version}`
  const family = (series === 'mythos' ? 'fable' : series) as ModelFamily
  const candidateKey = minor === undefined ? `${series}-${major}` : `${series}-${major}-${minor}`
  const contextWindow = CONTEXT_WINDOWS[candidateKey]
  return contextWindow === undefined
    ? { key: null, name, family, contextWindow: null }
    : { key: candidateKey, name, family, contextWindow }
}

export function promptTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

export function totalTokens(usage: TokenUsage): number {
  return promptTokens(usage) + usage.output_tokens
}

export function contextPercent(modelId: string, usage: TokenUsage): number | null {
  const { contextWindow } = modelInfo(modelId)
  if (contextWindow === null) return null
  return Math.round((promptTokens(usage) / contextWindow) * 100)
}
