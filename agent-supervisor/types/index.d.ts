// 面板目前顯示的頁面：總覽，或只看代理、任務、事件
export type SupervisorView = 'overview' | 'agents' | 'tasks' | 'events'

// running：正在跑一輪；idle：這一輪結束、等訊息喚醒或等背景工作；unknown：清單上找不到又沒收到結束事件
export type AgentPhase = 'running' | 'idle' | 'completed' | 'failed' | 'unknown'

// 狀態從哪裡來：event 是派出、工具呼叫、結束等事件直接確認；engine 是 Claude Code 的代理清單（$.agent.list()）回報；
// inferred 是推測，畫面上要跟確認的分開標示
export type StatusSource = 'event' | 'engine' | 'inferred'

export type AgentRecord = {
  id: string
  // Agent({ name }) 給的名字；沒給是 null
  name: string | null
  // 派出時的 subagentType（general-purpose、Explore…）
  agentType: string
  // 派出時 Agent 工具的 description：這個代理的任務
  description: string
  // 由哪個代理派出；主對話派的是 null
  parentId: string | null
  phase: AgentPhase
  source: StatusSource
  // Claude Code 細分的狀態說明，例如 waiting 時的「等待背景工作或核准」
  detail: string | null
  // 已中斷、API 錯誤、模型拒絕、已停止
  failureReason: string | null
  // 開面板前就在跑、從清單補上的不知道開始時間，是 null
  startedAt: number | null
  endedAt: number | null
  // 最近一次可觀察到的活動，例如「讀取 src/app.ts」「思考中」
  activity: string
  activityAt: number | null
  toolCount: number
  // 連續失敗或被拒絕的工具呼叫次數，成功一次就歸零
  toolErrorStreak: number
  lastToolError: string | null
}

// 主對話（畫面上的 Supervisor 那一列）
export type MainLoop = {
  isRunning: boolean
  activity: string
  activityAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-supervisor': {
      view: SupervisorView
      agents: AgentRecord[]
      mainLoop: MainLoop
      // 計時器每一拍加一，只有面板讀，用來更新經過時間
      tick: number
    }
  }
}
