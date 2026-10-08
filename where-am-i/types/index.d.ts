export type Recap = { goal: string; now: string; waiting: string; next: string }

declare module 'claude-code' {
  interface PluginState {
    'where-am-i': { recap: Recap | null; live: string }
    // next-steps 擁有，這裡只讀 active：清單顯示時讓出摘要框裡的「Next:」。
    // 形狀要跟 next-steps/types/index.d.ts 一致，../scripts/check-contracts.sh 會抓出不一致
    'next-steps': { active: boolean }
    // clean-view 擁有，這裡只讀 combinedBox。形狀要跟 clean-view/types/index.d.ts 一致，
    // ../scripts/check-contracts.sh 會抓出不一致
    'clean-view': {
      isEnabled: boolean
      plan: { title: string; status: 'pending' | 'in_progress' | 'completed' }[]
      tick: number
      turnClock: { startedAt: number; endedAt: number | null } | null
      combinedBox: 'hidden' | 'whileWorking' | 'always'
    }
  }
}
