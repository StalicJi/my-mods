// 測試的 $ 沒有 state 名詞：代替 host 保存 agent-panel 的 state，照 ifVersion 檢查版本，
// update 遇到版本衝突時才會重試，平行寫入的測試才有意義
export function stateStore(on: any, initial: Record<string, unknown> = {}) {
  const held = new Map<string, { value: unknown; version: number }>()
  // mod 經 state.set 寫入成功的次數；每次寫入都會讓讀這個值的面板重畫
  const writeCounts = new Map<string, number>()
  // mod 經 state.get 讀取的次數；用來確認清單畫面不讀 logs
  const readCounts = new Map<string, number>()
  for (const [key, value] of Object.entries(initial)) held.set(key, { value, version: 1 })
  for (const key of ['batch', 'tick', 'logs', 'selected']) {
    const ref = { plugin: 'agent-panel', key }
    on('state.get', ref, () => {
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1)
      return { value: { value: held.get(key)?.value, version: held.get(key)?.version ?? 0 } }
    })
    on('state.set', ref, (_$: any, e: any) => {
      const version = held.get(key)?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      held.set(key, { value: e.value, version: version + 1 })
      writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1)
      return { value: { isSet: true, version: version + 1 } }
    })
  }
  return {
    // 測試裡直接讀欄位，回傳 any 省去逐一轉型
    get: (key: string): any => held.get(key)?.value ?? null,
    // 模擬狀態被直接改掉（不經過 mod 的事件），版本照樣往上加
    set: (key: string, value: unknown) => held.set(key, { value, version: (held.get(key)?.version ?? 0) + 1 }),
    writes: (key: string) => writeCounts.get(key) ?? 0,
    reads: (key: string) => readCounts.get(key) ?? 0,
  }
}
