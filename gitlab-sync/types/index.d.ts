// 目前所在 repo 跟遠端追蹤分支的差距
export type RepoSync = {
  // detached HEAD 時是短 hash
  branch: string
  isDetached: boolean
  // 比對的遠端分支（例如 origin/develop）；null 代表找不到可比對的遠端分支
  upstream: string | null
  ahead: number
  behind: number
  dirtyCount: number
  // 最近一次 fetch 失敗，ahead／behind 是用本機快取比對的
  isFetchFailed: boolean
  // remote 的主機名稱（例如 gitlab.example.com、github.com），band 用來標示 GitLab／GitHub／本機；null 代表沒有 remote
  remoteHost: string | null
  // 這個 repo 在設定的 GitLab 上的專案路徑（例如 acme/backend/api-server）；
  // null 代表 remote 不在這台 GitLab：/gitlab 的未讀動態與還開著的 Task、Issue 不分專案全部列，band 不顯示張數
  gitlabProject: string | null
  // remote 在 github.com 時的 owner/repo（例如 alice/notes-app）；
  // null 代表不在 GitHub：/github 的未讀動態與還開著的 issue 不分專案全部列，band 不顯示 GitHub 的 Issue 張數
  githubRepo: string | null
}

// 一種類型（例如 Task、Issue）還開著的張數
export type KindCount = { kind: string; count: number }

// 一個平台（GitLab 或 GitHub）通知的狀況：problem 不是 null 代表輪詢停擺，內容是原因；unreadCount 是未讀動態則數；
// openCounts 是自己開的或指派給自己、還開著的張數，依類型分開（GitLab 的 Task、Issue 等，GitHub 只有 Issue），
// null 代表還沒查到、查不到或平台沒設定。兩種數字在該平台專案的 repo 裡都只算這個專案的
export type InboxStatus = { unreadCount: number; problem: string | null; openCounts: KindCount[] | null }

declare module 'claude-code' {
  interface PluginState {
    'gitlab-sync': {
      repo: RepoSync | null
      // GitLab 的通知狀況（沿用最早的鍵名）
      inbox: InboxStatus
      githubInbox: InboxStatus
    }
  }
}
