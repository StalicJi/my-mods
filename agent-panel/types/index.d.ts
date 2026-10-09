// 一次請求的 token 用量，形狀同 claude-code 的 ModelUsage。
// 合約檔不能 import 'claude-code' 的型別（scripts/check-contracts.sh 的替身模組只有 PluginState），所以自己定義
export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRow = {
  id: string
  description: string
  // 由子代理再派出的
  isNested: boolean
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  // 已中斷、API 錯誤、模型拒絕
  failureReason: string | null
  // 最後一次請求的模型 id 與 effort
  model: string | null
  effort: string | number | null
  toolCount: number
  // 正在做什麼，例如「讀取 src/app.ts」
  activity: string
  // 最後一次請求的 4 種 token 數
  lastUsage: TokenUsage | null
  // 前景子代理完成時 Agent 工具結果的 totalTokens；有值時以它為準
  reportedTokens: number | null
  // 已知單價的請求累計
  costUsd: number
  // 有請求的模型不在價目表
  hasUnpricedUsage: boolean
}

// 這一回合派出的子代理
export type Batch = { turnId: string; agents: AgentRow[] }

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      // 最近一批
      batch: Batch | null
      // 動畫計數器，只有面板讀
      tick: number
    }
  }
}
