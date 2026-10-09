// 模型 id 轉顯示名稱、單價與 context 上限，估算一次請求的費用與 ctx 百分比
import type { TokenUsage } from '../types'

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown'

export type ModelInfo = { key: string | null; name: string; family: ModelFamily; contextWindow: number | null }

// 每百萬 token 的美元單價
type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number }

type PriceEntry = { contextWindow: number; ratesFor: (promptTokenCount: number) => Rates }

const MILLION = 1_000_000

// Haiku 5.5 依提示長度有兩種價位：提示超過 100,000 token 改用高價
const HAIKU_5_5_SMALL_PROMPT_LIMIT = 100_000

const flat = (input: number, output: number, cacheWrite: number, cacheRead: number, contextWindow = MILLION): PriceEntry => ({
  contextWindow,
  ratesFor: () => ({ input, output, cacheWrite, cacheRead }),
})

// 單價來源：claude-api skill，資料日期 2026-10-06。
// usage 分不出 cache 存 5 分鐘還是 1 小時，cache 寫入一律用 5 分鐘的單價，所以畫面上的費用都標「≈」
const PRICES: Record<string, PriceEntry> = {
  'fable-5-1': flat(10, 50, 12.5, 0.25),
  'mythos-5-1': flat(10, 50, 12.5, 0.25),
  'fable-5': flat(10, 50, 12.5, 1),
  'mythos-5': flat(10, 50, 12.5, 1),
  'opus-5-5': flat(4, 20, 5, 0.2),
  'opus-5': flat(5, 25, 6.25, 0.5),
  'opus-4-8': flat(5, 25, 6.25, 0.5),
  'opus-4-7': flat(5, 25, 6.25, 0.5),
  'opus-4-6': flat(5, 25, 6.25, 0.5),
  'sonnet-5-5': flat(2, 10, 2.5, 0.2),
  'sonnet-5': flat(2, 10, 2.5, 0.2),
  'sonnet-4-6': flat(3, 15, 3.75, 0.3),
  'haiku-5-5': {
    contextWindow: MILLION,
    ratesFor: promptTokenCount =>
      promptTokenCount > HAIKU_5_5_SMALL_PROMPT_LIMIT
        ? { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 }
        : { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  },
  'haiku-4-5': flat(1, 5, 1.25, 0.1, 200_000),
}

// 系列、主版本、次版本（一到兩位數），後面可能接 8 位數的日期
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/

// 同一個模型有好幾種寫法：Bedrock 的 anthropic. 前綴、[1m] 這類後綴、Vertex 的 @ 日期後綴
function bareModelId(modelId: string) {
  return modelId.replace(/^anthropic\./, '').replace(/\[[^\]]*\]$/, '').replace(/@.*$/, '')
}

export function modelInfo(modelId: string): ModelInfo {
  const match = MODEL_ID.exec(bareModelId(modelId))
  if (!match) return { key: null, name: modelId, family: 'unknown', contextWindow: null }
  const [, series = '', major = '', minor] = match
  const version = minor === undefined ? major : `${major}.${minor}`
  const name = `${series.charAt(0).toUpperCase()}${series.slice(1)} ${version}`
  const family = (series === 'mythos' ? 'fable' : series) as ModelFamily
  const candidateKey = minor === undefined ? `${series}-${major}` : `${series}-${major}-${minor}`
  const entry = PRICES[candidateKey]
  return { key: entry ? candidateKey : null, name, family, contextWindow: entry?.contextWindow ?? null }
}

export function promptTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

export function totalTokens(usage: TokenUsage): number {
  return promptTokens(usage) + usage.output_tokens
}

export function requestCostUsd(modelId: string, usage: TokenUsage): number | null {
  const { key } = modelInfo(modelId)
  const entry = key === null ? undefined : PRICES[key]
  if (!entry) return null
  const rates = entry.ratesFor(promptTokens(usage))
  const dollarsPerMillion =
    usage.input_tokens * rates.input +
    usage.output_tokens * rates.output +
    usage.cache_creation_input_tokens * rates.cacheWrite +
    usage.cache_read_input_tokens * rates.cacheRead
  return dollarsPerMillion / MILLION
}

export function contextPercent(modelId: string, usage: TokenUsage): number | null {
  const { contextWindow } = modelInfo(modelId)
  if (contextWindow === null) return null
  return Math.round((promptTokens(usage) / contextWindow) * 100)
}
