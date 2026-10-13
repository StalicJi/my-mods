import { describe, expect, test } from 'claude-code/testing'

import { addSpawn, finishAgent, recordToolOutcome } from '../hooks/agents'
import { blockedSubjects, detectBlockers, suggestActions } from '../hooks/blockers'
import type { AgentRecord, TaskRecord, WaitingReports } from '../types'

const spawn = (id: string, name: string) => ({ id, name, agentType: 'general-purpose', description: `${name} 的任務`, parentId: null, startedAt: 0 })
const task = (id: string, status: string, owner: string, blockedBy: string[] = []): TaskRecord =>
  ({ id, title: `標題 ${id}`, status, owner, blockedBy, source: 'report', updatedAt: 0 }) as TaskRecord

const team = (): AgentRecord[] => [spawn('b', 'backend'), spawn('f', 'frontend'), spawn('q', 'qa')].reduce((rows, facts) => addSpawn(rows, facts), [] as AgentRecord[])
const model = (patch: { agents?: AgentRecord[]; tasks?: TaskRecord[]; waiting?: WaitingReports } = {}) => ({ agents: team(), tasks: [], waiting: {}, ...patch })

describe('確認的阻塞', () => {
  test('任務已經在做，但依賴的任務還沒完成：確認是阻塞，指向負責那個任務的代理', () => {
    const blockers = detectBlockers(model({ tasks: [task('B1', 'in_progress', 'b'), task('F1', 'in_progress', 'f', ['B1'])] }))
    expect(blockers).toEqual([
      expect.objectContaining({ certainty: 'confirmed', source: 'dependency', subject: 'f', dependsOn: 'b', taskId: 'F1' }),
    ])
    expect(blockers[0]!.reason).toContain('標題 F1')
    expect(blockers[0]!.reason).toContain('標題 B1')
  })

  test('還沒開始的任務在等依賴：正常的先後順序，不算阻塞', () => {
    expect(detectBlockers(model({ tasks: [task('B1', 'in_progress', 'b'), task('F1', 'pending', 'f', ['B1'])] }))).toEqual([])
  })

  test('依賴的任務完成後就不算阻塞', () => {
    expect(detectBlockers(model({ tasks: [task('B1', 'completed', 'b'), task('F1', 'in_progress', 'f', ['B1'])] }))).toEqual([])
  })

  test('還沒結束的代理回報在等什麼：確認是阻塞；它的任務有沒完成的依賴時指向那個負責人', () => {
    const blockers = detectBlockers(
      model({ tasks: [task('B1', 'in_progress', 'b'), task('F1', 'pending', 'f', ['B1'])], waiting: { f: { text: '等 API schema', at: 5 } } }),
    )
    expect(blockers).toEqual([expect.objectContaining({ certainty: 'confirmed', source: 'report', subject: 'f', dependsOn: 'b', reason: '等 API schema' })])
  })

  test('主對話回報在等什麼也算', () => {
    const blockers = detectBlockers(model({ waiting: { main: { text: '等你決定用哪個資料庫', at: 5 } } }))
    expect(blockers).toEqual([expect.objectContaining({ certainty: 'confirmed', subject: 'main', dependsOn: null })])
  })

  test('已結束的代理留下的等待原因不算', () => {
    const agents = finishAgent(team(), 'f', 'answer', 9)
    expect(detectBlockers(model({ agents, waiting: { f: { text: '等 API', at: 5 } } }))).toEqual([])
  })
})

describe('可能的阻塞（POSSIBLE BLOCKER）', () => {
  test('依賴沒有人回報過的任務', () => {
    const blockers = detectBlockers(model({ tasks: [task('F1', 'in_progress', 'f', ['X9'])] }))
    expect(blockers).toEqual([expect.objectContaining({ certainty: 'possible', source: 'missing-task', subject: 'f', taskId: 'F1' })])
  })

  test('擋路的任務負責人已經結束卻沒把任務標成完成', () => {
    const agents = finishAgent(team(), 'b', 'answer', 9)
    const blockers = detectBlockers(model({ agents, tasks: [task('B1', 'in_progress', 'b'), task('F1', 'pending', 'f', ['B1'])] }))
    expect(blockers).toEqual([expect.objectContaining({ certainty: 'possible', source: 'stale-owner', subject: 'f', dependsOn: 'b', taskId: 'B1' })])
  })

  test('還在跑的代理連續 3 次工具失敗；2 次不算', () => {
    let agents = team()
    for (let count = 0; count < 2; count++) agents = recordToolOutcome(agents, 'q', { outcome: 'error', errorLine: 'Exit code 1' })
    expect(detectBlockers(model({ agents }))).toEqual([])
    agents = recordToolOutcome(agents, 'q', { outcome: 'error', errorLine: 'Exit code 1' })
    expect(detectBlockers(model({ agents }))).toEqual([
      expect.objectContaining({ certainty: 'possible', source: 'tool-errors', subject: 'q', reason: '連續 3 次工具失敗：Exit code 1' }),
    ])
  })

  test('只是跑很久、沒有新事件，不算阻塞', () => {
    const agents = team().map(agent => ({ ...agent, startedAt: 0, activityAt: 0 }))
    expect(detectBlockers(model({ agents }))).toEqual([])
  })
})

describe('BLOCKED 狀態', () => {
  test('只有確認的阻塞讓代理變成 BLOCKED；可能的不改狀態', () => {
    let agents = team()
    for (let count = 0; count < 3; count++) agents = recordToolOutcome(agents, 'q', { outcome: 'error', errorLine: 'x' })
    const blockers = detectBlockers(model({ agents, waiting: { f: { text: '等 API', at: 1 } } }))
    expect([...blockedSubjects(blockers)]).toEqual(['f'])
  })
})

describe('下一步建議', () => {
  test('擋路的任務負責人還在做：建議先完成那個任務', () => {
    const current = model({ tasks: [task('B1', 'in_progress', 'b'), task('F1', 'in_progress', 'f', ['B1'])] })
    const [first] = suggestActions(current, detectBlockers(current))
    expect(first).toBe('先完成「標題 B1」（backend），frontend 才能繼續')
  })

  test('擋路的任務負責人已經結束：建議指派', () => {
    const agents = finishAgent(team(), 'b', 'answer', 9)
    const current = model({ agents, tasks: [task('B1', 'in_progress', 'b'), task('F1', 'pending', 'f', ['B1'])] })
    expect(suggestActions(current, detectBlockers(current))[0]).toBe('「標題 B1」的負責人 backend 已結束：確認是否完成，或改派')
  })

  test('回報在等但不知道等誰：建議處理它在等的事', () => {
    const current = model({ waiting: { q: { text: '等你決定測試範圍', at: 1 } } })
    expect(suggestActions(current, detectBlockers(current))).toEqual(['處理 qa 在等的事：等你決定測試範圍'])
  })

  test('代理失敗：建議看原因、決定要不要重派', () => {
    const agents = finishAgent(team(), 'q', 'error', 9)
    const current = model({ agents })
    expect(suggestActions(current, detectBlockers(current))).toEqual(['查看 qa 失敗的原因（API 錯誤），決定要不要重派'])
  })

  test('全部任務完成、也沒有代理在跑：建議整理結果', () => {
    const agents = ['b', 'f', 'q'].reduce((rows, id) => finishAgent(rows, id, 'answer', 9), team())
    const current = model({ agents, tasks: [task('B1', 'completed', 'b')] })
    expect(suggestActions(current, detectBlockers(current))).toEqual(['全部任務完成：整理結果'])
  })

  test('沒有足夠資訊時不給建議；最多兩則', () => {
    expect(suggestActions(model(), [])).toEqual([])
    const agents = ['b', 'f', 'q'].reduce((rows, id) => finishAgent(rows, id, 'error', 9), team())
    const current = model({ agents })
    expect(suggestActions(current, detectBlockers(current))).toHaveLength(2)
  })
})
