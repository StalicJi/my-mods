import { expect, mock, test } from 'claude-code/testing'

import { stateStore } from './state-store'

const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }

type SpawnReply = { model?: string; agentId?: string; deny?: string; teammateId?: string }

// 代替 mod 底下的 engine：記下開窗格與提示，agent.spawn 依序回 a1、a2…（spawnReplies 有排定的就先用）
function engine(on: any, initialState: Record<string, unknown> = {}) {
  const control = {
    opens: [] as any[], closes: [] as any[], toasts: [] as unknown[], isPlaced: true,
    spawnReplies: [] as SpawnReply[], spawned: 0, state: stateStore(on, initialState),
    // 代替 host 的窗格清單：開了就列出，關了就移除
    panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[],
    clock: mock.clock(on),
  }
  on('prompt.submit', () => ({ text: '' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('ui.panes', () => ({ value: control.panes }))
  on('ui.close', (_$: any, e: any) => {
    control.closes.push(e)
    control.panes = control.panes.filter(pane => pane.id !== e.id)
    return { value: undefined }
  })
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
    control.panes = [...control.panes.filter(pane => pane.id !== e.id), { id: e.id, title: e.title, isShown: true, isFocused: false, isPlaced: control.isPlaced }]
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

test('使用者按 ✕ 關掉面板：計時器停止，同一回合再派也不重開', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await control.clock.advance(400)
  expect(control.state.get('tick')).toBeGreaterThan(0)
  // 使用者按 ✕：host 把窗格關掉、從清單移除（測試工具無法觸發 ui.close，直接模擬 host 的狀態）
  control.panes = []
  const stopped = control.state.get('tick')
  await control.clock.advance(600)
  expect(control.state.get('tick')).toBe(stopped)
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

test('不在這一批的 agentId（例如 Claude Code 的內部 fork）不寫 state', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  const writesBefore = control.state.writes('batch')
  expect(writesBefore).toBeGreaterThan(0)
  await step($, 'internal-fork')
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: 'internal-fork' } as any)
  expect(control.state.writes('batch')).toBe(writesBefore)
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

const submit = ($: any, text: string, kind: string) => $.prompt.submit({ text, origin: { kind }, wait: false })

test('你送出訊息時關閉面板，/ 開頭、背景通知與外掛送的不關', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  // 先讓子代理完成：還在跑時送訊息不關面板（另一個測試涵蓋）
  await $.turn.complete({ reason: 'answer', answer: '好了', durationMs: 1, agentId: 'a1', turnId: 'x' } as any)
  await submit($, '繼續', 'composer')
  expect(control.closes).toHaveLength(1)
  expect(control.closes[0]).toMatchObject({ id: 'agent-panel' })
  await submit($, '/agents', 'composer')
  await submit($, '背景任務完成', 'task-notification')
  await submit($, '外掛送的', 'plugin')
  expect(control.closes).toHaveLength(1)
})

test('子代理還在跑時你送出訊息不關面板，全部完成後下一則才關', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await submit($, '順便看一下測試', 'composer')
  expect(control.closes).toHaveLength(0)
  await $.turn.complete({ reason: 'answer', answer: '好了', durationMs: 1, agentId: 'a1', turnId: 'x' } as any)
  await submit($, '繼續', 'composer')
  expect(control.closes).toHaveLength(1)
  expect(control.closes[0]).toMatchObject({ id: 'agent-panel' })
})

test('/agents 開著就關、關著就開', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  const closed = await $.command.run({ command: 'agents', args: '' } as any)
  expect(control.closes).toHaveLength(1)
  expect(closed.text).toBe('已關閉子代理面板。')
  const opened = await $.command.run({ command: 'agents', args: '' } as any)
  expect(control.opens).toHaveLength(2)
  expect(opened.text).toBe('已開啟子代理面板。')
})

test('有子代理在跑而且面板開著才跑計時器', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await control.clock.advance(600)
  const ticking = control.state.get('tick')
  expect(ticking).toBeGreaterThan(0)
  await $.turn.complete({ reason: 'answer', answer: '好了', durationMs: 1, agentId: 'a1', turnId: 'x' } as any)
  const stopped = control.state.get('tick')
  await control.clock.advance(600)
  expect(control.state.get('tick')).toBe(stopped)
})

test('熱重載後 session.start 接回計時器', async ($, on) => {
  const running = {
    id: 'a1', description: '任務', isNested: false, status: 'running', startedAt: 0, endedAt: null, failureReason: null,
    model: null, effort: null, toolCount: 0, activity: '', lastUsage: null, reportedTokens: null, costUsd: 0, hasUnpricedUsage: false,
  }
  const control = engine(on, { batch: { turnId: 't1', agents: [running] } })
  control.panes = [{ id: 'agent-panel', title: 'Agents', isShown: true, isFocused: false, isPlaced: true }]
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
  await control.clock.advance(600)
  expect(control.state.get('tick')).toBeGreaterThan(0)
})

test('/clear 清空批次', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await $.session.end({ reason: 'clear' } as any)
  expect(control.state.get('batch')).toBeNull()
})

test('沒有子代理在跑時計時器自己停下，即使錯過了停止的時機', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await control.clock.advance(400)
  expect(control.state.get('tick')).toBeGreaterThan(0)
  // 模擬讀取競態：子代理已經完成，但 mod 沒在完成時停掉計時器
  const batch = control.state.get('batch')
  control.state.set('batch', { ...batch, agents: batch.agents.map((agent: any) => ({ ...agent, status: 'done', endedAt: 1 })) })
  const stopped = control.state.get('tick')
  await control.clock.advance(600)
  expect(control.state.get('tick')).toBe(stopped)
})

test('面板先在背景等待、之後被放上畫面時，下一次工具呼叫就開始動畫', async ($, on) => {
  const control = engine(on)
  control.isPlaced = false
  await start($)
  await spawnAgent($)
  await control.clock.advance(400)
  expect(control.state.get('tick') ?? 0).toBe(0)
  // 終端機拉寬後，host 把等待中的窗格放上畫面
  control.panes = control.panes.map(pane => ({ ...pane, isPlaced: true }))
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: 'a1' } as any)
  await control.clock.advance(400)
  expect(control.state.get('tick')).toBeGreaterThan(0)
})
