import { describe, expect, test } from 'claude-code/testing'

import { addSpawn } from '../hooks/agents'
import { applyNativeTool, applyReport, capTasks, parseReport, resolveOwner, resolvePendingOwners, setWaiting, taskProgress } from '../hooks/tasks'
import type { AgentRecord, TaskRecord } from '../types'

const agents: AgentRecord[] = addSpawn(
  addSpawn([], { id: 'a1', name: 'backend', agentType: 'general-purpose', description: '實作 API', parentId: null, startedAt: 0 }),
  { id: 'a2', name: null, agentType: 'general-purpose', description: '做前端畫面', parentId: null, startedAt: 0 },
)

describe('解析回報', () => {
  test('tasks 與 waitingFor 都是選填；格式錯誤時回傳錯誤訊息', () => {
    expect(parseReport({ waitingFor: '等 API schema' })).toEqual({ report: { tasks: [], waitingFor: '等 API schema' } })
    expect(parseReport({ tasks: [{ id: 'T1', title: '定義 API', status: 'in_progress', blockedBy: ['T0'], owner: 'backend' }] })).toEqual({
      report: { tasks: [{ id: 'T1', title: '定義 API', status: 'in_progress', blockedBy: ['T0'], owner: 'backend' }], waitingFor: null },
    })
    expect(parseReport({})).toHaveProperty('error')
    expect(parseReport({ tasks: [{ title: '沒有 id' }] })).toHaveProperty('error')
    expect(parseReport({ tasks: [{ id: 'T1', status: 'doing' }] })).toHaveProperty('error')
    expect(parseReport({ tasks: 'T1' })).toHaveProperty('error')
  })
})

describe('負責人', () => {
  test('main、supervisor 對到主對話；代理的 id、名字、任務說明對到那個代理；對不到的原樣保留', () => {
    expect(resolveOwner('main', agents)).toBe('main')
    expect(resolveOwner('Supervisor', agents)).toBe('main')
    expect(resolveOwner('a2', agents)).toBe('a2')
    expect(resolveOwner('Backend', agents)).toBe('a1')
    expect(resolveOwner('做前端畫面', agents)).toBe('a2')
    expect(resolveOwner('qa', agents)).toBe('qa')
  })
})

describe('套用回報', () => {
  const at = 1000

  test('新任務要有標題；負責人預設是回報者', () => {
    const result = applyReport([], { tasks: [{ id: 'T1', title: '定義 API', status: 'pending' }], waitingFor: null }, { reporter: 'a1', agents, at })
    expect(result).toEqual({
      tasks: [{ id: 'T1', title: '定義 API', status: 'pending', owner: 'a1', blockedBy: [], source: 'report', updatedAt: at }],
    })
    const missingTitle = applyReport([], { tasks: [{ id: 'T2', status: 'pending' }], waitingFor: null }, { reporter: 'a1', agents, at })
    expect(missingTitle).toHaveProperty('error')
  })

  test('已有的任務只更新回報的欄位；負責人換成解析後的代理', () => {
    const [created] = (applyReport([], { tasks: [{ id: 'T1', title: '定義 API', status: 'pending', blockedBy: ['T0'] }], waitingFor: null }, { reporter: 'main', agents, at }) as { tasks: TaskRecord[] }).tasks
    const result = applyReport([created!], { tasks: [{ id: 'T1', status: 'completed', owner: 'backend' }], waitingFor: null }, { reporter: 'a2', agents, at: 2000 }) as { tasks: TaskRecord[] }
    expect(result.tasks[0]).toMatchObject({ title: '定義 API', status: 'completed', owner: 'a1', blockedBy: ['T0'], updatedAt: 2000 })
  })

  test('依賴自己的任務被拒絕', () => {
    const result = applyReport([], { tasks: [{ id: 'T1', title: 'x', status: 'pending', blockedBy: ['T1'] }], waitingFor: null }, { reporter: 'a1', agents, at })
    expect(result).toHaveProperty('error')
  })
})

describe('Claude Code 原生的任務工具（有開才會有這些呼叫）', () => {
  test('TaskCreate 從結果拿 id 建立任務，TaskUpdate 更新狀態、依賴與負責人，deleted 刪掉', () => {
    let tasks = applyNativeTool([], { tool: 'TaskCreate', input: { subject: '寫測試', description: '' }, result: { task: { id: '3', subject: '寫測試' } } }, { reporter: 'a1', agents, at: 1 })
    expect(tasks[0]).toMatchObject({ id: '#3', title: '寫測試', status: 'pending', owner: 'a1', source: 'native' })
    tasks = applyNativeTool(tasks, { tool: 'TaskUpdate', input: { taskId: '3', status: 'in_progress', addBlockedBy: ['1'], owner: 'backend' }, result: { success: true } }, { reporter: 'main', agents, at: 2 })
    expect(tasks[0]).toMatchObject({ status: 'in_progress', blockedBy: ['#1'], owner: 'a1' })
    tasks = applyNativeTool(tasks, { tool: 'TaskUpdate', input: { taskId: '3', status: 'deleted' }, result: { success: true } }, { reporter: 'main', agents, at: 3 })
    expect(tasks).toEqual([])
  })

  test('TodoWrite 用回報者的清單整份取代他之前的待辦', () => {
    const todos = (items: [string, string][]) => ({ tool: 'TodoWrite', input: { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) }, result: {} })
    let tasks = applyNativeTool([], todos([['讀程式', 'completed'], ['改程式', 'in_progress']]), { reporter: 'a2', agents, at: 1 })
    expect(tasks.map(task => [task.id, task.title, task.status, task.owner])).toEqual([
      ['a2:todo:1', '讀程式', 'completed', 'a2'],
      ['a2:todo:2', '改程式', 'in_progress', 'a2'],
    ])
    tasks = applyNativeTool(tasks, todos([['改程式', 'completed']]), { reporter: 'a2', agents, at: 2 })
    expect(tasks.map(task => task.title)).toEqual(['改程式'])
  })

  test('結果失敗或不是任務工具時原樣回傳', () => {
    const tasks: TaskRecord[] = []
    expect(applyNativeTool(tasks, { tool: 'TaskCreate', input: { subject: 'x' }, result: { deny: '不行' } }, { reporter: 'a1', agents, at: 1 })).toBe(tasks)
    expect(applyNativeTool(tasks, { tool: 'Read', input: {}, result: {} }, { reporter: 'a1', agents, at: 1 })).toBe(tasks)
  })
})

describe('進度與上限', () => {
  test('只算回報過的任務；沒有任務時進度是 null（畫面寫 Unknown），不編造百分比', () => {
    expect(taskProgress([])).toBeNull()
    const tasks = ['completed', 'completed', 'in_progress', 'pending'].map((status, index) => ({
      id: `T${index}`, title: 't', status, owner: 'main', blockedBy: [], source: 'report', updatedAt: 0,
    })) as TaskRecord[]
    expect(taskProgress(tasks)).toEqual({ completed: 2, total: 4, percent: 50 })
  })

  test('最多留 50 項：先丟最早更新的已完成任務', () => {
    const tasks = Array.from({ length: 52 }, (_, index) => ({
      id: `T${index}`, title: 't', status: index < 3 ? 'completed' : 'pending', owner: 'main', blockedBy: [], source: 'report', updatedAt: index,
    })) as TaskRecord[]
    const capped = capTasks(tasks)
    expect(capped).toHaveLength(50)
    expect(capped.some(task => task.id === 'T0' || task.id === 'T1')).toBe(false)
  })
})

describe('等待回報', () => {
  test('回報等待原因記在回報者底下；空字串清掉；沒變化回傳同一個物件', () => {
    const waiting = setWaiting({}, 'a2', '等 API schema', 5)
    expect(waiting).toEqual({ a2: { text: '等 API schema', at: 5 } })
    expect(setWaiting(waiting, 'a2', '等 API schema', 9)).toBe(waiting)
    expect(setWaiting(waiting, 'a2', '', 9)).toEqual({})
    const empty = {}
    expect(setWaiting(empty, 'a2', '', 9)).toBe(empty)
  })
})

describe('負責人補對', () => {
  test('登記時還沒派出的代理：派出後把用名字或任務說明寫的負責人換成它的 id；主對話與已對上的不動', () => {
    const tasks = [
      { id: 'T1', title: 'a', status: 'pending', owner: '做前端畫面', blockedBy: [], source: 'report', updatedAt: 0 },
      { id: 'T2', title: 'b', status: 'pending', owner: 'main', blockedBy: [], source: 'report', updatedAt: 0 },
      { id: 'T3', title: 'c', status: 'pending', owner: 'a1', blockedBy: [], source: 'report', updatedAt: 0 },
    ] as TaskRecord[]
    const resolved = resolvePendingOwners(tasks, agents)
    expect(resolved.map(task => task.owner)).toEqual(['a2', 'main', 'a1'])
    expect(resolvePendingOwners(resolved, agents)).toBe(resolved)
  })
})
