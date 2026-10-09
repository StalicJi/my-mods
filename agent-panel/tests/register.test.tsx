import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }

type SpawnReply = { model?: string; agentId?: string; deny?: string; teammateId?: string }

// 測試的 $ 沒有 state 名詞：代替 host 保存 agent-panel 的 state，照 ifVersion 檢查版本，update 衝突時才會重試
function stateStore(on: any) {
  const held = new Map<string, { value: unknown; version: number }>()
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

// 代替 mod 底下的 engine：記下開窗格與提示，agent.spawn 依序回 a1、a2…（spawnReplies 有排定的就先用）
function engine(on: any) {
  const control = { opens: [] as any[], toasts: [] as unknown[], isPlaced: true, spawnReplies: [] as SpawnReply[], spawned: 0, state: stateStore(on) }
  mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => control.spawnReplies.shift() ?? { model: 'claude-opus-5-5', agentId: `a${++control.spawned}` })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } }
  })
  on('tool.call', (_$: any, e: any) =>
    e.tool === 'Agent' ? { result: { agentId: 'a1', totalTokens: 26_000, totalToolUseCount: 12 }, text: '' } : { result: {}, text: 'ok' },
  )
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    control.opens.push(e)
    return { value: { isPlaced: control.isPlaced } }
  })
  on('ui.toast', (_$: any, e: any) => {
    control.toasts.push(e)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  return control
}

async function start($: any, turnId = 't1') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await $.turn.start({ text: '開始', turnId })
}

const spawnAgent = ($: any, patch: object = {}) =>
  $.agent.spawn({
    tool_use_id: 'u1', prompt: '做事', description: '任務', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, ...patch,
  })


// 跑完一次請求的串流，回傳結果
async function step($: any, agentId?: string) {
  const stream = $.turn.step({ turnId: 'x', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // 只是把串流讀完
  }
  return stream.result
}

test('派出第一個子代理時開窗格，同一批第二個不重開', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await spawnAgent($)
  expect(control.opens).toHaveLength(1)
  expect(control.opens[0]).toMatchObject({ id: 'agent-panel', title: 'Agents', columns: 42 })
  expect(control.opens[0].focus).toBeUndefined()
  expect((control.state.get('batch')).agents.map((agent: any) => agent.id)).toEqual(['a1', 'a2'])
})

test('被擋下、沒有 agentId、teammate 不加入', async ($, on) => {
  const control = engine(on)
  control.spawnReplies.push({ deny: '不行' }, { model: 'claude-opus-5-5' }, { model: 'claude-opus-5-5', agentId: 't9', teammateId: 'bob@team' })
  await start($)
  await spawnAgent($)
  await spawnAgent($)
  await spawnAgent($)
  expect(control.state.get('batch')).toBeNull()
  expect(control.opens).toHaveLength(0)
})

test('使用者手動關掉後同一回合再派，不再自動跳出', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  // 使用者按 ✕ 關掉面板：不經過 mod，mod 也不會因此重開
  await spawnAgent($)
  expect(control.opens).toHaveLength(1)
})

test('子代理的請求記到對的列，主迴圈的請求不記', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  const before = control.state.get('batch')
  await step($)
  expect(control.state.get('batch')).toEqual(before)
  await step($, 'a1')
  const [row] = (control.state.get('batch')).agents
  expect(row).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', lastUsage: USAGE })
})

test('子代理的工具呼叫累加次數並更新正在做什麼', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: 'a1' } as any)
  expect((control.state.get('batch')).agents[0]).toMatchObject({ toolCount: 1, activity: '讀取 src/app.ts' })
})

test('前景子代理完成時以 Agent 結果的總計為準', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as any)
  expect((control.state.get('batch')).agents[0]).toMatchObject({ reportedTokens: 26_000, toolCount: 12 })
})

test('子代理結束標成完成或失敗', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await spawnAgent($)
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, agentId: 'a1', turnId: 'x' } as any)
  await $.turn.complete({ reason: 'answer', answer: '好了', durationMs: 1, agentId: 'a2', turnId: 'y' } as any)
  const [first, second] = (control.state.get('batch')).agents
  expect(first).toMatchObject({ status: 'failed', failureReason: '已中斷' })
  expect(second).toMatchObject({ status: 'done', failureReason: null })
})

test('窗格放不下時只提示一次', async ($, on) => {
  const control = engine(on)
  control.isPlaced = false
  await start($, 't1')
  await spawnAgent($)
  await $.turn.start({ text: '再來', turnId: 't2' })
  await spawnAgent($)
  expect(control.opens).toHaveLength(2)
  expect(control.toasts).toHaveLength(1)
  expect(JSON.stringify(control.toasts[0])).toContain('子代理面板放不下：打 /agents 開啟')
})

test('平行派出 8 個子代理全部記下', async ($, on) => {
  const control = engine(on)
  await start($)
  await Promise.all(Array.from({ length: 8 }, () => spawnAgent($)))
  expect((control.state.get('batch')).agents).toHaveLength(8)
  expect(control.opens).toHaveLength(1)
})
