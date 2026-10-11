// 讓一個非同步步驟先停住：被停住的那端呼叫 wait()，測試端 await whenReached 得知它停住了，release() 讓它繼續
export function createHold() {
  let arrive = () => {}
  let release = () => {}
  const whenReached = new Promise<void>(resolve => (arrive = resolve))
  const released = new Promise<void>(resolve => (release = resolve))
  return {
    whenReached,
    release,
    async wait() {
      arrive()
      await released
    },
  }
}

export type Hold = ReturnType<typeof createHold>

// 測試的 $ 沒有 state 名詞：代替 host 保存 agent-panel 的 state，照 ifVersion 檢查版本，
// update 遇到版本衝突時才會重試，平行寫入的測試才有意義
export function stateStore(on: any, initial: Record<string, unknown> = {}) {
  const held = new Map<string, { value: unknown; version: number }>()
  // mod 經 state.set 寫入成功的次數；每次寫入都會讓讀這個值的面板重畫
  const writeCounts = new Map<string, number>()
  // mod 經 state.get 讀取的次數；用來確認清單畫面不讀 logs
  const readCounts = new Map<string, number>()
  // 讀寫的先後順序（get:key、set:key），用來確認哪些寫入是平行進行的
  const operations: string[] = []
  // 寫入一律被拒絕的 key，模擬 host 寫入失敗
  const failingKeys = new Set<string>()
  // 下一次讀或寫要先停住的 key（get:key、set:key）：用來把別的事件插進 mod 的讀寫之間
  const holds = new Map<string, Hold>()
  async function waitIfHeld(operation: string) {
    const hold = holds.get(operation)
    if (hold === undefined) return
    holds.delete(operation)
    await hold.wait()
  }
  for (const [key, value] of Object.entries(initial)) held.set(key, { value, version: 1 })
  for (const key of ['batch', 'tick', 'logs', 'selected']) {
    const ref = { plugin: 'agent-panel', key }
    on('state.get', ref, async () => {
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1)
      operations.push(`get:${key}`)
      await waitIfHeld(`get:${key}`)
      return { value: { value: held.get(key)?.value, version: held.get(key)?.version ?? 0 } }
    })
    on('state.set', ref, async (_$: any, e: any) => {
      operations.push(`set:${key}`)
      await waitIfHeld(`set:${key}`)
      if (failingKeys.has(key)) return { deny: 'test: 寫入被拒絕' }
      const version = held.get(key)?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      held.set(key, { value: e.value, version: version + 1 })
      writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1)
      await waitIfHeld(`after:set:${key}`)
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
    operations: () => [...operations],
    failWrites: (key: string) => failingKeys.add(key),
    // 讓下一次 get:key 或 set:key 停住（讀到的是放行當下的值）；after:set:key 是寫進去之後、回答 mod 之前停住
    holdNext(operation: string): Hold {
      const hold = createHold()
      holds.set(operation, hold)
      return hold
    },
  }
}
