// next-steps 只對外公開一個 state：清單是否顯示中
declare module 'claude-code' {
  interface PluginState {
    // where-am-i/types/index.d.ts 也宣告了同樣的形狀，改這裡要一起改；../scripts/check-contracts.sh 會抓出不一致
    'next-steps': { active: boolean }
  }
}
