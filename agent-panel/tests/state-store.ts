// 測試的 $ 沒有 state 名詞：代替 host 保存 agent-panel 的 state，照 ifVersion 檢查版本，
// update 遇到版本衝突時才會重試，平行寫入的測試才有意義
export function stateStore(on: any, initial: Record<string, unknown> = {}) {
  const held = new Map<string, { value: unknown; version: number }>()
  for (const [key, value] of Object.entries(initial)) held.set(key, { value, version: 1 })
  for (const key of ['batch', 'tick']) {
    const ref = { plugin: 'agent-panel', key }
    on('state.get', ref, () => ({ value: { value: held.get(key)?.value, version: held.get(key)?.version ?? 0 } }))
    on('state.set', ref, (_$: any, e: any) => {
      const version = held.get(key)?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      held.set(key, { value: e.value, version: version + 1 })
      return { value: { isSet: true, version: version + 1 } }
    })
  }
  // 測試裡直接讀欄位，回傳 any 省去逐一轉型
  return { get: (key: string): any => held.get(key)?.value ?? null }
}
