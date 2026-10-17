// 測試共用：代替 mod 底下的 engine、窗格與畫面文字的小工具
import { mock } from 'claude-code/testing'

import { stateStore } from './state-store'

type SpawnReply = { model?: string; agentId?: string; deny?: string; teammateId?: string }
type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

// 代替 mod 底下的 engine：記下開關窗格、狀態列與註冊的指令；agent.spawn 依序回 a1、a2…（spawnReplies 有排定的先用）；
// tool.call 依序回 toolReplies（排完了回成功）；$.agent.list() 回 listed；
// 快照：$.fs.write 記在 writes，HOME 是 /home/test，session id 是 sess-1，$.process.run 回 pid（null 時讓它失敗）
export function engine(on: any, initialState: Record<string, unknown> = {}) {
  const control = {
    opens: [] as any[],
    closes: [] as any[],
    commands: [] as any[],
    tools: [] as any[],
    statuses: [] as (string | undefined)[],
    panes: [] as Pane[],
    spawnReplies: [] as SpawnReply[],
    spawned: 0,
    // 每次派出時送到 engine 的 prompt（mod 附加說明之後的）
    spawnPrompts: [] as string[],
    toolReplies: [] as object[],
    listed: [] as object[],
    listCalls: 0,
    state: stateStore(on, initialState),
    clock: mock.clock(on),
    writes: [] as { path: string; text: string }[],
    pid: '4242' as string | null,
  }
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('command.register', (_$: any, e: any) => {
    control.commands.push(e)
    return { value: undefined }
  })
  on('tool.register', (_$: any, e: any) => {
    control.tools.push(e)
    return { value: { tool: `mcp__agent-supervisor__${e.name}` } }
  })
  on('ui.open', (_$: any, e: any) => {
    control.opens.push(e)
    control.panes = [...control.panes.filter(pane => pane.id !== e.id), { id: e.id, title: e.title, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: any, e: any) => {
    control.closes.push(e)
    control.panes = control.panes.filter(pane => pane.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: control.panes }))
  on('fs.write', (_$: any, e: any) => {
    control.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('process.run', () => {
    if (control.pid === null) throw new Error('不能執行')
    return { value: { exitCode: 0, stdout: `${control.pid}\n`, stderr: '' } }
  })
  on('ui.status', (_$: any, e: any) => {
    control.statuses.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', (_$: any, e: any) => {
    control.spawnPrompts.push(e.prompt)
    return control.spawnReplies.shift() ?? { model: 'claude-opus-5-5', agentId: `a${++control.spawned}` }
  })
  on('agent.list', () => {
    control.listCalls++
    return { value: control.listed }
  })
  on('tool.call', () => control.toolReplies.shift() ?? { result: {}, text: 'ok' })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return control
}

export const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
export const runSupervisor = ($: any, args = '') => $.command.run({ command: 'supervisor', args } as any)

export const spawnAgent = ($: any, patch: object = {}) =>
  $.agent.spawn({
    tool_use_id: 'u1', prompt: '做事', description: '任務', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...patch,
  })

export const callTool = ($: any, input: object) => $.tool.call(input as any)

export const finishTurn = ($: any, patch: object = {}) =>
  $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, turnId: 't', ...patch } as any)

// 跑完一次請求的串流
export async function step($: any, agentId?: string) {
  const stream = $.turn.step({ turnId: 'x', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // 只是把串流讀完
  }
  return stream.result
}

export function paneOf(options: { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline' } = {}) {
  const { bodyColumns = 44, bodyRows = 40, placement = 'dock' } = options
  return {
    plugin: 'agent-supervisor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-supervisor',
    props: { title: 'Agent Supervisor', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
  }
}

// 畫出來的每一列文字（每個 Text 一列，內層的 Text 併進同一列）
export function drawnRows(node: any): string[] {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'Text') return [textOf(node)]
  return ((node.children ?? []) as unknown[]).flatMap(drawnRows)
}

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return ((node.children ?? []) as unknown[]).map(textOf).join('')
}
