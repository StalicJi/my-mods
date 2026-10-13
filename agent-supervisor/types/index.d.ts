// 面板目前顯示的頁面：總覽，或只看代理、任務、事件
export type SupervisorView = 'overview' | 'agents' | 'tasks' | 'events'

declare module 'claude-code' {
  interface PluginState {
    'agent-supervisor': {
      view: SupervisorView
    }
  }
}
