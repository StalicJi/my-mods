// Agent Supervisor：監控這個 session 的子代理、回報的任務與依賴、可能的阻塞與下一步建議。
// 只用 /supervisor 手動開關面板（使用者選的，不自動跳出）
import type { EngineInterface, Register } from 'claude-code'

const PANE_ID = 'agent-supervisor'
const PANE_TITLE = 'Agent Supervisor'
// 停靠在右邊時要求的寬度；放在輸入框上方時 Claude Code 會忽略它
const PANE_COLUMNS = 44
const EMPTY_HINT = '這個 session 還沒有派出子代理'

async function isPanelOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE_ID)
}

async function togglePanel($: EngineInterface): Promise<{ text: string }> {
  if (await isPanelOpen($)) {
    await $.ui.close({ id: PANE_ID }).catch(() => {})
    return { text: '已關閉 Agent Supervisor 面板。' }
  }
  // 使用者打指令開的窗格任何寬度都放得下：夠寬時停靠右邊，不然放在輸入框上方
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  return { text: '已開啟 Agent Supervisor 面板。' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 名稱已被佔用時會被拒絕，不影響其他功能
    await $.command.register({ name: 'supervisor', description: '開關 Agent Supervisor 面板：子代理、任務、阻塞與建議' }).catch(() => {})
    return started
  })

  on('command.run', { command: 'supervisor' }, async $ => togglePanel($))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{EMPTY_HINT}</Text>
  })
}
