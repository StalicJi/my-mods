import { describe, expect, test } from 'claude-code/testing'

import { addSpawn, finishAgent, reconcile, recordActivity } from '../hooks/agents'
import { displayWidth } from '../hooks/text'
import { agentStatus, overviewRows } from '../hooks/view'
import type { AgentRecord, MainLoop, TaskRecord } from '../types'

const MAIN_IDLE: MainLoop = { isRunning: false, activity: '', activityAt: null }
const EMPTY = { agents: [] as AgentRecord[], tasks: [] as TaskRecord[], waiting: {} }
const spawn = (id: string, patch: object = {}) => ({ id, name: null, agentType: 'general-purpose', description: `任務 ${id}`, parentId: null, startedAt: 0, ...patch })
const textOf = (row: { text: string }[]) => row.map(span => span.text).join('')
const rowsText = (rows: { text: string }[][]) => rows.map(textOf)

describe('狀態標籤', () => {
  test('事件或 Claude Code 清單確認的狀態直接顯示，推測的另外標示', () => {
    let agents = ['r', 'c', 'f'].reduce((rows, id) => addSpawn(rows, spawn(id)), [] as AgentRecord[])
    agents = finishAgent(agents, 'c', 'answer', 10)
    agents = finishAgent(agents, 'f', 'error', 10)
    expect(agents.map(agent => agentStatus(agent))).toEqual([
      { label: 'RUNNING', isInferred: false },
      { label: 'COMPLETED', isInferred: false },
      { label: 'FAILED', isInferred: false },
    ])
    const [missing] = reconcile(addSpawn([], spawn('m')), [])
    expect(agentStatus(missing!)).toEqual({ label: 'UNKNOWN', isInferred: true })
    const [idle] = reconcile(addSpawn([], spawn('i')), [{ id: 'i', description: '', type: 'x', status: 'idle' }])
    expect(agentStatus(idle!)).toEqual({ label: 'IDLE', isInferred: false })
  })
})

describe('總覽', () => {
  test('沒有子代理時：Supervisor 那一列加上說明，不畫進度', () => {
    const rows = rowsText(overviewRows({ ...EMPTY, mainLoop: MAIN_IDLE }, { columns: 44, now: 0 }))
    expect(rows[0]).toContain('Supervisor')
    expect(rows.join('\n')).toContain('這個 session 還沒有派出子代理')
  })

  test('每個代理兩列：有名字時標題是名字、第二列是任務；沒名字時標題是任務、第二列是最近活動（沒有活動寫類型）', () => {
    const agents = addSpawn(addSpawn([], spawn('a1', { name: 'backend', startedAt: 1000 })), spawn('a2', { startedAt: 1000 }))
    const rows = rowsText(overviewRows({ ...EMPTY, agents, mainLoop: MAIN_IDLE }, { columns: 44, now: 126_000 }))
    const backend = rows.findIndex(row => row.includes('backend'))
    expect(rows[backend]).toMatch(/RUNNING$/)
    expect(rows[backend + 1]).toContain('任務 a1')
    expect(rows[backend + 1]).toContain('2分05秒')
    expect(rows.some(row => row.includes('general-purpose'))).toBe(true)
  })

  test('沒名字的代理有活動時，第二列寫最近活動', () => {
    const agents = recordActivity(addSpawn([], spawn('a1', { description: '跑 echo 25 次' })), 'a1', { activity: '執行：echo 第12次', at: 0, isToolCall: true })
    const rows = rowsText(overviewRows({ ...EMPTY, agents, mainLoop: MAIN_IDLE }, { columns: 44, now: 0 }))
    const title = rows.findIndex(row => row.includes('跑 echo 25 次'))
    expect(rows[title]).toMatch(/RUNNING$/)
    expect(rows[title + 1]).toContain('執行：echo 第12次')
  })

  test('開始時間不知道（開面板前就在跑）時經過時間寫 Unknown，推測的狀態加「?」並附說明', () => {
    const [seeded] = reconcile([], [{ id: 'x', description: '補上的', type: 'Explore', status: 'running' }])
    const missing = reconcile([seeded!], [])
    const rows = rowsText(overviewRows({ ...EMPTY, agents: missing, mainLoop: MAIN_IDLE }, { columns: 44, now: 5000 }))
    expect(rows.join('\n')).toContain('Unknown')
    expect(rows.some(row => /UNKNOWN\?$/.test(row))).toBe(true)
    expect(rows.join('\n')).toContain('? 表示推測')
  })

  test('執行中排前面，已結束的排後面', () => {
    let agents = addSpawn(addSpawn([], spawn('done', { name: 'done' })), spawn('live', { name: 'live' }))
    agents = finishAgent(agents, 'done', 'answer', 10)
    const rows = rowsText(overviewRows({ ...EMPTY, agents, mainLoop: MAIN_IDLE }, { columns: 44, now: 20 }))
    expect(rows.findIndex(row => row.includes('live'))).toBeLessThan(rows.findIndex(row => row.includes('done')))
  })

  test('失敗的代理第二列寫原因', () => {
    const agents = finishAgent(addSpawn([], spawn('a1', { name: 'qa' })), 'a1', 'aborted', 10)
    const rows = rowsText(overviewRows({ ...EMPTY, agents, mainLoop: MAIN_IDLE }, { columns: 44, now: 20 }))
    expect(rows[rows.findIndex(row => row.includes('qa')) + 1]).toContain('已中斷')
  })

  test('窄面板（30 欄）每一列都不超過寬度', () => {
    const agents = addSpawn([], spawn('a1', { name: '很長很長的代理名稱-backend-service', description: '實作 Modbus API 與所有相關的整合測試與文件' }))
    const rows = overviewRows({ ...EMPTY, agents, mainLoop: { isRunning: true, activity: '檢查 API 合約與前後端的欄位對應', activityAt: 0 } }, { columns: 30, now: 0 })
    for (const row of rows) expect(displayWidth(textOf(row))).toBeLessThanOrEqual(30)
  })

  test('主對話跑著時 Supervisor 是 RUNNING 並寫正在做什麼，閒著時寫等你下指令', () => {
    const running = rowsText(overviewRows({ ...EMPTY, mainLoop: { isRunning: true, activity: '讀取 api.ts', activityAt: 0 } }, { columns: 44, now: 0 }))
    expect(running[0]).toMatch(/Supervisor.*RUNNING$/)
    expect(running[1]).toContain('讀取 api.ts')
    const idle = rowsText(overviewRows({ ...EMPTY, mainLoop: MAIN_IDLE }, { columns: 44, now: 0 }))
    expect(idle[0]).toMatch(/IDLE$/)
    expect(idle[1]).toContain('等你下指令')
  })

  test('代理超過上限時只列前面幾個，最後一列寫還有幾個', () => {
    const agents = Array.from({ length: 9 }, (_, index) => spawn(`a${index}`)).reduce((rows, facts) => addSpawn(rows, facts), [] as AgentRecord[])
    const rows = rowsText(overviewRows({ ...EMPTY, agents, mainLoop: MAIN_IDLE }, { columns: 44, now: 0, maxAgents: 6 }))
    expect(rows.join('\n')).toContain('還有 3 個代理')
  })
})

const task = (id: string, status: string, patch: object = {}): TaskRecord =>
  ({ id, title: `標題 ${id}`, status, owner: 'main', blockedBy: [], source: 'report', updatedAt: 0, ...patch }) as TaskRecord

describe('任務區', () => {
  const backend = addSpawn([], spawn('a1', { name: 'backend' }))

  test('沒有回報的任務時寫 Unknown，不畫百分比', () => {
    const rows = rowsText(overviewRows({ ...EMPTY, agents: backend, mainLoop: MAIN_IDLE }, { columns: 44, now: 0 }))
    const header = rows.indexOf('TASKS')
    expect(header).toBeGreaterThan(-1)
    expect(rows[header + 1]).toContain('Unknown')
    expect(rows.join('\n')).not.toMatch(/\d+%/)
  })

  test('有任務時寫完成數與百分比，每項用 [x]／[>]／[ ] 標狀態並寫負責人；等別的任務的註明', () => {
    const tasks = [task('T1', 'completed', { owner: 'a1' }), task('T2', 'in_progress', { owner: 'a1' }), task('T3', 'pending', { owner: 'qa', blockedBy: ['T2'] })]
    const rows = rowsText(overviewRows({ ...EMPTY, agents: backend, tasks, mainLoop: MAIN_IDLE }, { columns: 60, now: 0 }))
    const header = rows.indexOf('TASKS')
    expect(rows[header + 1]).toBe('  Completed: 1 / 3 · Progress: 33%')
    expect(rows).toContain('  [>] T2 標題 T2 · backend')
    expect(rows).toContain('  [ ] T3 標題 T3 · qa（等 T2）')
    expect(rows).toContain('  [x] T1 標題 T1 · backend')
  })

  test('主對話負責的任務寫 Supervisor', () => {
    const rows = rowsText(overviewRows({ ...EMPTY, tasks: [task('T1', 'pending')], mainLoop: MAIN_IDLE }, { columns: 60, now: 0 }))
    expect(rows).toContain('  [ ] T1 標題 T1 · Supervisor')
  })
})
