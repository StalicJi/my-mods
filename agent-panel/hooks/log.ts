// 子代理詳細頁的紀錄：都是純函式、回傳新物件。
// 寫入的 turnId 跟現有的不同時（新的一批）從空的開始，不用另外清
import type { AgentLog, LogEntry, Logs } from '../types'

export const MAX_ENTRIES = 100
export const MESSAGE_LIMIT = 2_000
export const REPORT_LIMIT = 20_000
export const ERROR_LINE_LIMIT = 200

// 寫到哪一批的哪一個子代理；三個值總是一起傳
export type LogTarget = { turnId: string; agentId: string }
export type ToolEnd = { outcome: 'ok' | 'error' | 'denied'; errorLine: string | null }

const EMPTY_LOG: AgentLog = { entries: [], dropped: 0 }
// ANSI 色碼；用 fromCharCode 組，原始碼裡不寫跳脫碼（編輯工具會把跳脫碼解成實際字元）
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const TOOL_ERROR_TAG = /<\/?tool_use_error>/g

export function agentLog(logs: Logs | null, target: LogTarget): AgentLog {
  if (logs === null || logs.turnId !== target.turnId) return EMPTY_LOG
  return logs.byAgent[target.agentId] ?? EMPTY_LOG
}

export function addToolStart(logs: Logs | null, target: LogTarget, start: { id: string; at: number; summary: string }): Logs {
  return updateLog(logs, target, append({ kind: 'tool', ...start, outcome: 'running', errorLine: null }))
}

export function finishTool(logs: Logs | null, target: LogTarget, toolId: string, end: ToolEnd): Logs {
  return updateLog(logs, target, log => ({
    ...log,
    entries: log.entries.map(entry => (entry.kind === 'tool' && entry.id === toolId ? { ...entry, ...end } : entry)),
  }))
}

// 沒有要求工具的最後答案就是直接回覆的回報；已經用 SubagentHandback 交回過，就只是一則訊息
export function addAnswer(logs: Logs | null, target: LogTarget, answer: { at: number; text: string; isFinal: boolean }): Logs {
  const hasReport = agentLog(logs, target).entries.some(entry => entry.kind === 'report')
  if (answer.isFinal && !hasReport) return addReport(logs, target, { at: answer.at, text: answer.text })
  return updateLog(logs, target, append({ kind: 'message', at: answer.at, text: clip(answer.text, MESSAGE_LIMIT) }))
}

// 子代理常在交回前把報告原文說一遍：前一則訊息跟回報（照訊息的上限截斷後）相同就拿掉，詳細頁才不會出現兩次
export function addReport(logs: Logs | null, target: LogTarget, report: { at: number; text: string }): Logs {
  const asMessage = clip(report.text, MESSAGE_LIMIT).trim()
  return updateLog(logs, target, log => {
    const last = log.entries.at(-1)
    const entries = last?.kind === 'message' && last.text.trim() === asMessage ? log.entries.slice(0, -1) : log.entries
    return { ...log, entries: [...entries, { kind: 'report', at: report.at, text: clip(report.text, REPORT_LIMIT) }] }
  })
}

export function markUnfinished(logs: Logs | null, target: LogTarget): Logs {
  return updateLog(logs, target, log => ({
    ...log,
    entries: log.entries.map(entry => (entry.kind === 'tool' && entry.outcome === 'running' ? { ...entry, outcome: 'unfinished' } : entry)),
  }))
}

// tool.call 的結果：{ deny } 是被拒絕，isError 是出錯（text 是模型讀到的錯誤），其他是成功
export function toolEndOf(result: unknown): ToolEnd {
  const record = (typeof result === 'object' && result !== null ? result : {}) as { deny?: unknown; isError?: unknown; text?: unknown }
  if (typeof record.deny === 'string') return { outcome: 'denied', errorLine: firstErrorLine(record.deny) }
  if (record.isError === true) return { outcome: 'error', errorLine: typeof record.text === 'string' ? firstErrorLine(record.text) : null }
  return { outcome: 'ok', errorLine: null }
}

export function firstErrorLine(text: string): string | null {
  const cleaned = text.replace(TOOL_ERROR_TAG, '').replace(ANSI_COLOR, '')
  const line = cleaned
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')
  return line === undefined ? null : clip(line, ERROR_LINE_LIMIT)
}

function updateLog(logs: Logs | null, target: LogTarget, change: (log: AgentLog) => AgentLog): Logs {
  const current: Logs = logs !== null && logs.turnId === target.turnId ? logs : { turnId: target.turnId, byAgent: {} }
  const next = trimToLimit(change(agentLog(current, target)))
  return { ...current, byAgent: { ...current.byAgent, [target.agentId]: next } }
}

function append(entry: LogEntry) {
  return (log: AgentLog): AgentLog => ({ ...log, entries: [...log.entries, entry] })
}

function trimToLimit(log: AgentLog): AgentLog {
  const excess = log.entries.length - MAX_ENTRIES
  return excess > 0 ? { entries: log.entries.slice(excess), dropped: log.dropped + excess } : log
}

// 以字元（code point）計，不切出半個 emoji
function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length > limit ? chars.slice(0, limit).join('') : text
}
