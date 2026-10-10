// 子代理詳細頁的紀錄：都是純函式、回傳新物件。
// 依 agentId 存，不看批次：換批次時由 forgetAgents 刪掉沒被帶過去的子代理，被帶過去的（跨回合的背景子代理）保留紀錄
import type { AgentLog, LogEntry, Logs } from '../types'

export const MAX_ENTRIES = 100
export const MESSAGE_LIMIT = 2_000
export const REPORT_LIMIT = 20_000
export const ERROR_LINE_LIMIT = 200

export type ToolEnd = { outcome: 'ok' | 'error' | 'denied'; errorLine: string | null }

const EMPTY_LOG: AgentLog = { entries: [], dropped: 0 }
// ANSI 色碼；用 fromCharCode 組，原始碼裡不寫跳脫碼（編輯工具會把跳脫碼解成實際字元）
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const TOOL_ERROR_TAG = /<\/?tool_use_error>/g

export function agentLog(logs: Logs | null, agentId: string): AgentLog {
  return logs?.byAgent[agentId] ?? EMPTY_LOG
}

export function addToolStart(logs: Logs | null, agentId: string, start: { id: string; at: number; summary: string }): Logs {
  return updateLog(logs, agentId, append({ kind: 'tool', ...start, outcome: 'running', errorLine: null }))
}

export function finishTool(logs: Logs | null, agentId: string, toolId: string, end: ToolEnd): Logs {
  return updateLog(logs, agentId, log => ({
    ...log,
    entries: log.entries.map(entry => (entry.kind === 'tool' && entry.id === toolId ? { ...entry, ...end } : entry)),
  }))
}

// 沒有要求工具的最後答案就是直接回覆的回報；已經用 SubagentHandback 交回過，就只是一則訊息
export function addAnswer(logs: Logs | null, agentId: string, answer: { at: number; text: string; isFinal: boolean }): Logs {
  const hasReport = agentLog(logs, agentId).entries.some(entry => entry.kind === 'report')
  if (answer.isFinal && !hasReport) return addReport(logs, agentId, { at: answer.at, text: answer.text })
  return updateLog(logs, agentId, append({ kind: 'message', at: answer.at, text: clip(answer.text, MESSAGE_LIMIT) }))
}

// 子代理常在交回前把報告原文說一遍：前一則訊息跟回報（照訊息的上限截斷後）相同就拿掉，詳細頁才不會出現兩次
export function addReport(logs: Logs | null, agentId: string, report: { at: number; text: string }): Logs {
  const asMessage = clip(report.text, MESSAGE_LIMIT).trim()
  return updateLog(logs, agentId, log => {
    const last = log.entries.at(-1)
    const entries = last?.kind === 'message' && last.text.trim() === asMessage ? log.entries.slice(0, -1) : log.entries
    return { ...log, entries: [...entries, { kind: 'report', at: report.at, text: clip(report.text, REPORT_LIMIT) }] }
  })
}

export function markUnfinished(logs: Logs | null, agentId: string): Logs {
  return updateLog(logs, agentId, log => ({
    ...log,
    entries: log.entries.map(entry => (entry.kind === 'tool' && entry.outcome === 'running' ? { ...entry, outcome: 'unfinished' } : entry)),
  }))
}

// 換批次時刪掉沒被帶過去的子代理；沒有要刪的就回傳原物件，不多寫一次
export function forgetAgents(logs: Logs | null, agentIds: readonly string[]): Logs | null {
  if (logs === null || !agentIds.some(agentId => agentId in logs.byAgent)) return logs
  const byAgent = { ...logs.byAgent }
  for (const agentId of agentIds) delete byAgent[agentId]
  return { byAgent }
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

function updateLog(logs: Logs | null, agentId: string, change: (log: AgentLog) => AgentLog): Logs {
  const next = trimToLimit(change(agentLog(logs, agentId)))
  return { byAgent: { ...logs?.byAgent, [agentId]: next } }
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
