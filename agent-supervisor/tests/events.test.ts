import { describe, expect, test } from 'claude-code/testing'

import { appendEvents, taskEvents, waitingEvents } from '../hooks/events'
import type { SupervisorEvent, TaskRecord } from '../types'

const event = (at: number): SupervisorEvent => ({ at, agentId: 'a1', kind: 'spawn', text: `事件 ${at}` })
const task = (id: string, status: string, patch: object = {}): TaskRecord =>
  ({ id, title: `標題 ${id}`, status, owner: 'a1', blockedBy: [], source: 'report', updatedAt: 0, ...patch }) as TaskRecord

describe('事件串', () => {
  test('最多留最近 50 筆，舊的先丟', () => {
    let events: SupervisorEvent[] = []
    for (let at = 0; at < 55; at++) events = appendEvents(events, [event(at)])
    expect(events).toHaveLength(50)
    expect(events[0]!.at).toBe(5)
    expect(events.at(-1)!.at).toBe(54)
  })

  test('沒有新事件時回傳同一個陣列', () => {
    const events = [event(1)]
    expect(appendEvents(events, [])).toBe(events)
  })
})

describe('任務變化變成事件', () => {
  test('新增任務、狀態改變各一筆；沒變的不記；事件記在負責人底下', () => {
    const before = [task('T1', 'pending'), task('T2', 'in_progress')]
    const after = [task('T1', 'in_progress'), task('T2', 'in_progress'), task('T3', 'pending', { owner: 'main' })]
    expect(taskEvents(before, after, 9)).toEqual([
      { at: 9, agentId: 'a1', kind: 'task', text: 'T1 標題 T1 開始進行' },
      { at: 9, agentId: 'main', kind: 'task', text: '新增任務 T3 標題 T3' },
    ])
  })

  test('完成的任務寫「完成」；刪掉的任務寫「移除」', () => {
    expect(taskEvents([task('T1', 'in_progress')], [task('T1', 'completed')], 9)).toEqual([
      { at: 9, agentId: 'a1', kind: 'task', text: 'T1 標題 T1 完成' },
    ])
    expect(taskEvents([task('T1', 'pending')], [], 9)).toEqual([{ at: 9, agentId: 'a1', kind: 'task', text: '移除任務 T1 標題 T1' }])
  })
})

describe('等待回報變成事件', () => {
  test('回報在等、改了等待原因、不再等待各一筆；沒變不記', () => {
    expect(waitingEvents({}, { a1: { text: '等 API', at: 1 } }, 9)).toEqual([{ at: 9, agentId: 'a1', kind: 'waiting', text: '回報在等：等 API' }])
    expect(waitingEvents({ a1: { text: '等 API', at: 1 } }, { a1: { text: '等 API', at: 1 } }, 9)).toEqual([])
    expect(waitingEvents({ a1: { text: '等 API', at: 1 } }, {}, 9)).toEqual([{ at: 9, agentId: 'a1', kind: 'resolved', text: '不再等待' }])
  })
})
