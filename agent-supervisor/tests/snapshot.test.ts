import { describe, expect, test } from 'claude-code/testing'

import { buildSnapshot, snapshotPath, SNAPSHOT_VERSION } from '../hooks/snapshot'
import type { AgentRecord } from '../types'
import { callTool, engine, spawnAgent, start } from './harness'

const SNAPSHOT_FILE = '/home/test/.claude/agent-supervisor/sessions/sess-1.json'

function agent(patch: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1', name: null, agentType: 'general-purpose', description: '定義 API schema', parentId: null,
    phase: 'running', source: 'event', detail: null, failureReason: null, startedAt: 1_000, endedAt: null,
    activity: '讀取 schema.json', activityAt: 1_500, toolCount: 3, toolErrorStreak: 0, lastToolError: null,
    ...patch,
  }
}

describe('快照內容', () => {
  test('代理、任務、阻塞與建議跟面板一致；名稱換成顯示名稱', () => {
    const agents = [agent({}), agent({ id: 'a2', description: '做前端畫面', activity: '等待' })]
    const tasks = [
      { id: 'T1', title: '定義 API schema', status: 'in_progress' as const, owner: 'a1', blockedBy: [], source: 'report' as const, updatedAt: 1 },
      { id: 'T2', title: '做前端畫面', status: 'pending' as const, owner: 'a2', blockedBy: ['T1'], source: 'report' as const, updatedAt: 1 },
    ]
    const waiting = { a2: { text: '等 API schema', at: 2_000 }, main: { text: '等使用者決定', at: 3_000 } }
    const snapshot = buildSnapshot(
      { agents, mainLoop: { isRunning: true, activity: '委派', activityAt: 1 }, tasks, waiting, events: [] },
      { sessionId: 'sess-1', pid: 4242, cwd: '/w' }, 5_000)

    expect(snapshot).toMatchObject({ version: SNAPSHOT_VERSION, sessionId: 'sess-1', pid: 4242, cwd: '/w', updatedAt: 5_000, ended: false })
    expect(snapshot.agents.map(a => [a.name, a.status])).toEqual([['做前端畫面', 'BLOCKED'], ['定義 API schema', 'RUNNING']])
    expect(snapshot.main.activityAt).toBe(1)
    expect(snapshot.agents[1]?.activityAt).toBe(1_500)
    expect(snapshot.tasks[1]).toMatchObject({ id: 'T2', owner: '做前端畫面', blockedBy: ['T1'] })
    expect(snapshot.progress).toEqual({ completed: 0, total: 2, percent: 0 })
    expect(snapshot.waiting).toEqual([
      { reporter: '做前端畫面', isMain: false, text: '等 API schema', at: 2_000 },
      { reporter: 'Supervisor', isMain: true, text: '等使用者決定', at: 3_000 },
    ])
    expect(snapshot.attention.length).toBeGreaterThan(0)
    expect(snapshot.attention[0]?.subject).toBe('做前端畫面')
    expect(snapshot.suggestions.length).toBeGreaterThan(0)
  })

  test('session id 只收安全字元', () => {
    expect(snapshotPath('/h', 'abc-123_x')).toBe('/h/.claude/agent-supervisor/sessions/abc-123_x.json')
    expect(snapshotPath('/h', '../etc')).toBeNull()
  })
})

describe('寫出快照', () => {
  test('狀態改變後合併寫一次，內容沒變不重寫；帶 pid', async ($, on) => {
    const control = engine(on)
    await start($)
    await spawnAgent($, { description: '定義 API schema' })
    await callTool($, { tool: 'Read', file_path: '/w/schema.json', agentId: 'a1' })
    expect(control.writes).toHaveLength(0)
    await control.clock.advance(500)
    expect(control.writes).toHaveLength(1)
    const written = JSON.parse(control.writes[0]!.text)
    expect(control.writes[0]!.path).toBe(SNAPSHOT_FILE)
    expect(written).toMatchObject({ sessionId: 'sess-1', pid: 4242, ended: false })
    expect(written.agents[0]).toMatchObject({ name: '定義 API schema', status: 'RUNNING', toolCount: 1 })
    expect(written.agents[0].activity).toContain('schema.json')

    // 計時器跳了一拍（還沒到對帳的第 3 拍）、狀態沒變：不重寫
    await control.clock.advance(1_000)
    expect(control.writes).toHaveLength(1)
  })

  test('session 結束時一定寫一次 ended', async ($, on) => {
    const control = engine(on)
    await start($)
    await control.clock.advance(500)
    const before = control.writes.length
    await $.session.end({ reason: 'exit' } as any)
    expect(control.writes).toHaveLength(before + 1)
    expect(JSON.parse(control.writes.at(-1)!.text).ended).toBe(true)
  })

  test('取不到 pid 時照常寫，pid 是 null', async ($, on) => {
    const control = engine(on)
    control.pid = null
    await start($)
    await spawnAgent($)
    await control.clock.advance(500)
    expect(JSON.parse(control.writes.at(-1)!.text).pid).toBeNull()
  })
})
