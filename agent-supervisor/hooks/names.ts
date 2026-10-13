// 面板與建議裡怎麼稱呼代理與負責人
import type { AgentRecord } from '../types'

// 標題：Agent({ name }) 給的名字；這個環境的 Agent 工具通常沒有 name，就用任務說明，都沒有才用類型
export function agentName(agent: AgentRecord): string {
  return agent.name ?? (agent.description || agent.agentType)
}

// 負責人顯示名稱：主對話是 Supervisor，代理用面板上的標題，對不到的原樣寫
export function ownerName(owner: string, agents: readonly AgentRecord[]): string {
  if (owner === 'main') return 'Supervisor'
  const agent = agents.find(candidate => candidate.id === owner)
  return agent === undefined ? owner : agentName(agent)
}
