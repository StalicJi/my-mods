import { expect, test } from 'claude-code/testing'

import { addAnswer, addReport, addToolStart, agentLog, finishTool, firstErrorLine, forgetAgents, markUnfinished, toolEndOf } from '../hooks/log'
import type { Logs } from '../types'

const target = 'a1'
const tool = (id: string, at = 0) => ({ id, at, summary: `讀取 ${id}` })

test('不同子代理的紀錄各自保留，forgetAgents 只刪掉指定的；沒有要刪的回傳原物件', () => {
  let logs = addToolStart(null, 'a9', tool('x'))
  logs = addToolStart(logs, target, tool('r1'))
  expect(Object.keys(logs.byAgent).sort()).toEqual(['a1', 'a9'])
  expect(Object.keys(forgetAgents(logs, ['a9'])!.byAgent)).toEqual(['a1'])
  expect(forgetAgents(logs, ['nobody'])).toBe(logs)
  expect(forgetAgents(null, ['a1'])).toBeNull()
})

test('工具開始是 running，finishTool 依 id 更新；找不到 id 不變', () => {
  let logs = addToolStart(null, target, tool('r1', 4000))
  expect(agentLog(logs, target).entries[0]).toEqual({ kind: 'tool', id: 'r1', at: 4000, summary: '讀取 r1', outcome: 'running', errorLine: null })
  logs = finishTool(logs, target, 'r1', { outcome: 'error', errorLine: 'File does not exist.' })
  expect(agentLog(logs, target).entries[0]).toMatchObject({ outcome: 'error', errorLine: 'File does not exist.' })
  expect(finishTool(logs, target, 'nope', { outcome: 'ok', errorLine: null })).toEqual(logs)
})

test('超過 100 筆從最舊的丟，dropped 累計', () => {
  let logs: Logs | null = null
  for (let i = 0; i < 102; i++) logs = addToolStart(logs, target, tool(`r${i}`))
  const log = agentLog(logs, target)
  expect(log.entries).toHaveLength(100)
  expect(log.dropped).toBe(2)
  expect(log.entries[0]).toMatchObject({ id: 'r2' })
})

test('markUnfinished 只把 running 改成 unfinished', () => {
  let logs = addToolStart(null, target, tool('r1'))
  logs = addToolStart(logs, target, tool('r2'))
  logs = finishTool(logs, target, 'r1', { outcome: 'ok', errorLine: null })
  const outcomes = agentLog(markUnfinished(logs, target), target).entries.map((entry: any) => entry.outcome)
  expect(outcomes).toEqual(['ok', 'unfinished'])
})

test('addAnswer：最後答案且還沒有回報時記成 report，其他記成 message', () => {
  let logs = addAnswer(null, target, { at: 1, text: '先看設定檔', isFinal: false })
  logs = addAnswer(logs, target, { at: 2, text: '結論', isFinal: true })
  logs = addAnswer(logs, target, { at: 3, text: '補充', isFinal: true })
  expect(agentLog(logs, target).entries.map((entry: any) => entry.kind)).toEqual(['message', 'report', 'message'])
})

test('addReport：前一筆訊息跟回報相同時移除那則訊息，不同時保留', () => {
  const same = addReport(addAnswer(null, target, { at: 1, text: '報告全文', isFinal: false }), target, { at: 2, text: '報告全文' })
  expect(agentLog(same, target).entries.map((entry: any) => entry.kind)).toEqual(['report'])
  const differ = addReport(addAnswer(null, target, { at: 1, text: '接著回報', isFinal: false }), target, { at: 2, text: '報告全文' })
  expect(agentLog(differ, target).entries.map((entry: any) => entry.kind)).toEqual(['message', 'report'])
})

test('訊息截到 2,000 字、回報截到 20,000 字，以字元計（emoji 算一個）', () => {
  const message = agentLog(addAnswer(null, target, { at: 1, text: '😀'.repeat(2500), isFinal: false }), target).entries[0] as any
  expect(Array.from(message.text)).toHaveLength(2000)
  expect(message.text.endsWith('😀')).toBe(true)
  const report = agentLog(addReport(null, target, { at: 1, text: '字'.repeat(25_000) }), target).entries[0] as any
  expect(Array.from(report.text)).toHaveLength(20_000)
})

test('toolEndOf 與 firstErrorLine', () => {
  const esc = String.fromCharCode(27)
  expect(toolEndOf({ result: {}, text: 'ok' })).toEqual({ outcome: 'ok', errorLine: null })
  expect(toolEndOf({ result: {}, text: `<tool_use_error>\n${esc}[31mFile does not exist.${esc}[0m\nmore</tool_use_error>`, isError: true }))
    .toEqual({ outcome: 'error', errorLine: 'File does not exist.' })
  expect(toolEndOf({ deny: '不允許讀這個檔\n細節' })).toEqual({ outcome: 'denied', errorLine: '不允許讀這個檔' })
  expect(firstErrorLine('   \n  ')).toBeNull()
  expect(firstErrorLine('x'.repeat(300))).toHaveLength(200)
})

test('agentLog：沒有紀錄的子代理回空的', () => {
  expect(agentLog(null, target)).toEqual({ entries: [], dropped: 0 })
  expect(agentLog(addToolStart(null, target, tool('r1')), 'a2')).toEqual({ entries: [], dropped: 0 })
})
