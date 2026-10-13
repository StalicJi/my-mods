import { describe, expect, test } from 'claude-code/testing'

import { addSpawn, adoptListed, capAgents, describeTool, finishAgent, hasLive, reconcile, recordActivity, recordToolOutcome } from '../hooks/agents'
import type { AgentRecord } from '../types'

const spawn = (id: string, patch: object = {}) => ({
  id, name: null, agentType: 'general-purpose', description: `任務 ${id}`, parentId: null, startedAt: 1000, ...patch,
})

const listed = (id: string, status: string, patch: object = {}) => ({ id, description: `清單 ${id}`, type: 'Explore', status, ...patch })

describe('派出與重複事件', () => {
  test('派出時記下名稱、類型、任務說明與開始時間，狀態由事件確認為 running', () => {
    const [agent] = addSpawn([], spawn('a1', { name: 'backend' }))
    expect(agent).toMatchObject({ id: 'a1', name: 'backend', agentType: 'general-purpose', description: '任務 a1', phase: 'running', source: 'event', startedAt: 1000, endedAt: null })
  })

  test('同一個 id 再派一次不重複加', () => {
    const once = addSpawn([], spawn('a1'))
    expect(addSpawn(once, spawn('a1'))).toBe(once)
  })

  test('結束事件比派出先到（先從清單補上並記下結束）時，派出事件只補上名稱與說明，不把狀態改回 running', () => {
    const adopted = adoptListed([], listed('a1', 'running'))
    const finished = finishAgent(adopted, 'a1', 'answer', 5000)
    const merged = addSpawn(finished, spawn('a1', { name: 'backend', description: '寫 API' }))
    expect(merged[0]).toMatchObject({ phase: 'completed', name: 'backend', description: '寫 API', endedAt: 5000 })
  })
})

describe('活動與工具結果', () => {
  test('工具呼叫記下最近活動、時間與次數', () => {
    const agents = recordActivity(addSpawn([], spawn('a1')), 'a1', { activity: '讀取 src/app.ts', at: 2000, isToolCall: true })
    expect(agents[0]).toMatchObject({ activity: '讀取 src/app.ts', activityAt: 2000, toolCount: 1 })
  })

  test('不認得的 agentId（例如 Claude Code 內部的 fork）不建立紀錄，原樣回傳', () => {
    const agents = addSpawn([], spawn('a1'))
    expect(recordActivity(agents, 'fork-x', { activity: '思考中', at: 2000, isToolCall: false })).toBe(agents)
  })

  test('連續失敗或被拒絕的工具呼叫累計次數並記下第一行錯誤，成功一次就歸零', () => {
    let agents = addSpawn([], spawn('a1'))
    agents = recordToolOutcome(agents, 'a1', { outcome: 'error', errorLine: 'Exit code 1' })
    agents = recordToolOutcome(agents, 'a1', { outcome: 'denied', errorLine: '權限被拒' })
    expect(agents[0]).toMatchObject({ toolErrorStreak: 2, lastToolError: '權限被拒' })
    agents = recordToolOutcome(agents, 'a1', { outcome: 'ok', errorLine: null })
    expect(agents[0]).toMatchObject({ toolErrorStreak: 0, lastToolError: null })
  })

  test('從清單看到 idle 的代理又有新活動時，改回事件確認的 running', () => {
    const idle = reconcile(addSpawn([], spawn('a1')), [listed('a1', 'idle')])
    expect(idle[0]).toMatchObject({ phase: 'idle', source: 'engine' })
    const active = recordActivity(idle, 'a1', { activity: '思考中', at: 3000, isToolCall: false })
    expect(active[0]).toMatchObject({ phase: 'running', source: 'event' })
  })
})

describe('結束與失敗', () => {
  test('正常回答是 completed，中斷、API 錯誤、拒絕是 failed 並寫原因', () => {
    const agents = ['a1', 'a2', 'a3', 'a4'].reduce((rows, id) => addSpawn(rows, spawn(id)), [] as AgentRecord[])
    let done = finishAgent(agents, 'a1', 'answer', 9000)
    done = finishAgent(done, 'a2', 'aborted', 9000)
    done = finishAgent(done, 'a3', 'error', 9000)
    done = finishAgent(done, 'a4', 'refusal', 9000)
    expect(done.map(agent => [agent.phase, agent.failureReason])).toEqual([
      ['completed', null], ['failed', '已中斷'], ['failed', 'API 錯誤'], ['failed', '模型拒絕'],
    ])
    expect(done.every(agent => agent.endedAt === 9000 && agent.source === 'event')).toBe(true)
  })

  test('重複的結束事件以第一次為準', () => {
    const once = finishAgent(addSpawn([], spawn('a1')), 'a1', 'answer', 9000)
    expect(finishAgent(once, 'a1', 'error', 12_000)).toBe(once)
  })

  test('結束後才到的工具活動不會把狀態改回 running', () => {
    const done = finishAgent(addSpawn([], spawn('a1')), 'a1', 'answer', 9000)
    expect(recordActivity(done, 'a1', { activity: '讀取 x', at: 9500, isToolCall: true })[0]).toMatchObject({ phase: 'completed' })
  })
})

describe('跟 Claude Code 的代理清單對帳', () => {
  test('清單上的狀態對應：running／pending 是 running，idle 與 waiting 是 idle（waiting 加註），completed、failed、killed 是結束', () => {
    const agents = ['r', 'p', 'i', 'w', 'c', 'f', 'k'].reduce((rows, id) => addSpawn(rows, spawn(id)), [] as AgentRecord[])
    const result = reconcile(agents, [
      listed('r', 'running'), listed('p', 'pending'), listed('i', 'idle'), listed('w', 'waiting'),
      listed('c', 'completed'), listed('f', 'failed'), listed('k', 'killed'),
    ])
    expect(result.map(agent => [agent.id, agent.phase, agent.detail, agent.failureReason])).toEqual([
      ['r', 'running', null, null],
      ['p', 'running', null, null],
      ['i', 'idle', null, null],
      ['w', 'idle', '等待背景工作或核准', null],
      ['c', 'completed', null, null],
      ['f', 'failed', null, '失敗'],
      ['k', 'failed', null, '已停止'],
    ])
  })

  test('事件已確認的結束不被清單蓋掉', () => {
    const done = finishAgent(addSpawn([], spawn('a1')), 'a1', 'error', 9000)
    expect(reconcile(done, [listed('a1', 'completed')])[0]).toMatchObject({ phase: 'failed', failureReason: 'API 錯誤', source: 'event' })
  })

  test('還沒結束、清單上卻找不到：標成推測的 unknown，不當成失敗', () => {
    const result = reconcile(addSpawn([], spawn('a1')), [])
    expect(result[0]).toMatchObject({ phase: 'unknown', source: 'inferred' })
  })

  test('清單上有、還沒記錄的代理（開面板前就在跑）補上：開始時間不知道，狀態取清單', () => {
    const result = reconcile([], [listed('x1', 'running', { parentId: 'a0' }), listed('x2', 'completed'), listed('t1', 'running', { teammateId: 'bob@team' })])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'x1', description: '清單 x1', agentType: 'Explore', parentId: 'a0', phase: 'running', source: 'engine', startedAt: null })
  })

  test('沒有任何變化時回傳同一個陣列，不必寫入', () => {
    const agents = reconcile(addSpawn([], spawn('a1')), [listed('a1', 'running')])
    expect(reconcile(agents, [listed('a1', 'running')])).toBe(agents)
  })
})

describe('其他', () => {
  test('最多留 30 個：先丟最舊的已結束代理，還在跑的保留', () => {
    let agents: AgentRecord[] = []
    for (let index = 0; index < 32; index++) agents = addSpawn(agents, spawn(`a${index}`, { startedAt: index }))
    agents = finishAgent(agents, 'a0', 'answer', 100)
    agents = finishAgent(agents, 'a1', 'answer', 100)
    const capped = capAgents(agents)
    expect(capped).toHaveLength(30)
    expect(capped.some(agent => agent.id === 'a0' || agent.id === 'a1')).toBe(false)
  })

  test('hasLive：還有沒結束的代理才是 true', () => {
    expect(hasLive([])).toBe(false)
    const agents = addSpawn([], spawn('a1'))
    expect(hasLive(agents)).toBe(true)
    expect(hasLive(finishAgent(agents, 'a1', 'answer', 9))).toBe(false)
  })

  test('工具呼叫的一行說明', () => {
    expect(describeTool('Read', { file_path: '/w/src/app.ts' })).toBe('讀取 src/app.ts')
    expect(describeTool('Bash', { command: 'npm test', description: '跑測試' })).toBe('執行：跑測試')
    expect(describeTool('mcp__github__create_issue', {})).toBe('使用 github create_issue')
  })
})
