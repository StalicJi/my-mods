export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { title: string; status: PlanStatus }

// 合併框何時顯示：hidden 不顯示、whileWorking 只在回合進行中（計畫已做完）、always 一直顯示（計畫還沒做完）
export type CombinedBoxMode = 'hidden' | 'whileWorking' | 'always'

// 主迴圈目前（或最近一次）回合的起訖時間；endedAt 是 null 表示回合還在跑
export type TurnClock = { startedAt: number; endedAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    // where-am-i/types/index.d.ts 也宣告了同樣的形狀，改這裡要一起改；../scripts/check-contracts.sh 會抓出不一致
    'clean-view': {
      isEnabled: boolean
      plan: PlanStep[]
      tick: number
      turnClock: TurnClock | null
      combinedBox: CombinedBoxMode
    }
    // where-am-i 擁有，這裡只讀來放進合併框；形狀要跟它自己的合約一致
    'where-am-i': { recap: { goal: string; now: string; waiting: string; next: string } | null; live: string }
  }
}
