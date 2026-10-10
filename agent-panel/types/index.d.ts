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
  // 派出時的 subagentType；熱重載補上的取 $.agent.list() 的 type
  agentType: string
  // Agent({ name }) 給的名字，沒給就是 null；熱重載補上的一律 null
  agentName: string | null
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
  // 正在做什麼，例如「讀取 src/app.ts」、「思考中」
  activity: string
  // 目前這個動作（思考或某個工具）開始的時間
  activityStartedAt: number
  // 最後一次請求的 4 種 token 數
  lastUsage: TokenUsage | null
  // 前景子代理完成時 Agent 工具結果的 totalTokens；有值時以它為準
  reportedTokens: number | null
  // 卡片左邊小人的造型編號（hooks/mascot.ts 取餘數）。舊版存下的列沒有這個欄位，讀的時候經過 agentLook
  look: number
}

// 這一回合派出的子代理
export type Batch = { turnId: string; agents: AgentRow[] }

// 工具呼叫的狀態；unfinished 是子代理結束時結果還沒回來（中斷、失敗、熱重載）
export type ToolOutcome = 'running' | 'ok' | 'error' | 'denied' | 'unfinished'

// 詳細頁的一筆紀錄
export type LogEntry =
  | {
      kind: 'tool'
      // tool_use_id，沒有就由 hook 產生
      id: string
      at: number
      // describeTool 產生的一行摘要，跟卡片上「正在做什麼」一致
      summary: string
      outcome: ToolOutcome
      // 出錯或被拒絕時的第一行，其他為 null
      errorLine: string | null
    }
  | { kind: 'message'; at: number; text: string }
  | { kind: 'report'; at: number; text: string }

// dropped：超過上限時從最舊的丟掉了幾筆
export type AgentLog = { entries: LogEntry[]; dropped: number }

// turnId 跟 batch 的不同就是舊資料，下一次寫入直接換掉
export type Logs = { turnId: string; byAgent: Record<string, AgentLog> }

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      // 最近一批
      batch: Batch | null
      // 動畫計數器，只有面板讀
      tick: number
      // 這一批每個子代理的紀錄，只有詳細頁讀
      logs: Logs | null
      // 目前打開詳細頁的 agentId
      selected: string | null
    }
  }
}
