// GitLab 與 GitHub 共用的型別、文字處理與回應解析
import type { HttpResponse, ThemeKey } from 'claude-code'

export type EventKind = 'comment' | 'assigned' | 'review_requested' | 'approved' | 'changes_requested' | 'closed' | 'merged'

export type ForgeEvent = {
  // 去重用的 id，例如 note-551、closed-issue-47-<時間>
  id: string
  kind: EventKind
  actor: string
  // 例如 handbook#29、monitor!1、notes-app#3
  ref: string
  // 例如 acme/team/handbook、alice/notes-app，用來依目前 repo 過濾；null 代表不知道（舊版存下的動態）
  projectPath: string | null
  title: string
  // 留言開頭；其他種類是空字串
  excerpt: string
  url: string
  at: string
}

// GitHub 的 login 也放在 username
export type ForgeUser = { id: number; username: string }

// 「還開著的 issue」：跟動態通知分開查，不受 since 起點影響；band 顯示張數，指令列出清單。
// 查詢不分專案，顯示時才依目前 repo 過濾，換目錄不必重查
export type OpenIssue = {
  id: number
  // 類型的顯示名稱：GitLab 的 work item 有 Task、Issue 等類型，GitHub 一律是 Issue
  kind: string
  ref: string
  projectPath: string | null
  title: string
  url: string
  author: ForgeUser
  assignees: ForgeUser[]
  updatedAt: string
}
export type OpenIssuesResult = { issues: OpenIssue[] } | { error: string }

// 一輪輪詢的結果：events 是起點之後、跟自己有關的別人做的事
export type PollResult = { me: ForgeUser; events: ForgeEvent[]; openIssues: OpenIssuesResult }

// 平台回 401：token 被拒絕，跟連不上、其他 HTTP 錯誤分開，才知道要不要換 token 再試
export class TokenRejectedError extends Error {}

export type Span = { text: string; color?: ThemeKey; isDim?: boolean; isBold?: boolean }
// spans 有值時分段上色，text 是 spans 接起來的全文（判斷內容與測試看這個）
export type Segment = Span & { spans?: readonly Span[] }

// ── remote 網址 ───────────────────────────────────────

// remote 有三種寫法：http(s)://[帳號@]主機[:埠]/路徑、ssh://git@主機[:埠]/路徑、git@主機:路徑
const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+)$/i

// remote 的主機名稱（小寫）；本機路徑的 remote（/path/repo.git、../repo）不算主機，回傳 null
export function remoteHostOf(remoteUrl: string): string | null {
  const host = REMOTE_URL.exec(remoteUrl.trim())?.[1]
  return host !== undefined && /^[a-z0-9]/i.test(host) ? host.toLowerCase() : null
}

// remote 在指定主機上時回傳去掉 .git 的專案路徑；埠不比，SSH 跟網頁本來就走不同的埠
export function remoteProjectPath(remoteUrl: string, host: string): string | null {
  const [, remoteHost, rawPath] = REMOTE_URL.exec(remoteUrl.trim()) ?? []
  if (remoteHost === undefined || rawPath === undefined || remoteHost.toLowerCase() !== host.toLowerCase()) return null
  const path = rawPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  return path === '' ? null : path
}

// ── 依目前 repo 過濾 ──────────────────────────────────

// 在平台專案的 repo 裡只留這個專案的；project 是 null（不在 repo 裡、remote 不在這個平台）時全部留著。
// 不知道是哪個專案的（舊版存下的動態）每個 repo 都留著，免得永遠看不到。專案路徑不分大小寫
export function inProject<T extends { projectPath: string | null }>(items: readonly T[], project: string | null): T[] {
  if (project === null) return [...items]
  const wanted = project.toLowerCase()
  return items.filter(item => item.projectPath === null || item.projectPath.toLowerCase() === wanted)
}

// 「這個 repo（api-server）裡」；不分專案時是空字串
export function repoScopeLabel(project: string | null): string {
  return project === null ? '' : `這個 repo（${projectName(project)}）裡`
}

// acme/backend/api-server → api-server
export function projectName(projectPath: string): string {
  return projectPath.slice(projectPath.lastIndexOf('/') + 1)
}

// ── 文字 ──────────────────────────────────────────────

// 依類型分組：kinds 列的類型一定有、照 kinds 的順序（0 張也列），其他類型有才列、接在後面；組內維持原本的順序
export function groupByKind(issues: readonly OpenIssue[], kinds: readonly string[]): { kind: string; issues: OpenIssue[] }[] {
  const groups = new Map<string, OpenIssue[]>(kinds.map(kind => [kind, []]))
  for (const issue of issues) {
    const group = groups.get(issue.kind)
    if (group) group.push(issue)
    else groups.set(issue.kind, [issue])
  }
  return [...groups].map(([kind, grouped]) => ({ kind, issues: grouped }))
}

// 每種類型一段，0 張也照寫張數，不改說「沒有」
export function openIssueLines(issues: readonly OpenIssue[], me: ForgeUser, now: number, project: string | null, kinds: readonly string[]): string[] {
  const lines: string[] = []
  for (const group of groupByKind(inProject(issues, project), kinds)) {
    const heading = `${repoScopeLabel(project)}你開的或指派給你、還開著的 ${group.kind} ${group.issues.length} 張`
    if (group.issues.length === 0) {
      lines.push(`${heading}。`)
      continue
    }
    lines.push(`${heading}：`)
    for (const issue of group.issues) {
      lines.push(`• ${issue.ref}  ${issue.title}`, `  ${issueRole(issue, me)}，${formatAgo(now, issue.updatedAt)}更新`, `  ${issue.url}`)
    }
  }
  return lines
}

// 例如「你開的，指派給 bob」「bob 開的，指派給你、carol」「你開的，還沒指派」
function issueRole(issue: OpenIssue, me: ForgeUser): string {
  const opener = issue.author.id === me.id ? '你開的' : `${issue.author.username} 開的`
  const assignees = issue.assignees.map(user => (user.id === me.id ? '你' : user.username))
  if (assignees.length === 0) return `${opener}，還沒指派`
  // 中文直接接英文帳號時空一格：「指派給 bob」，接「你」時不空
  const separator = assignees[0] === '你' ? '' : ' '
  return `${opener}，指派給${separator}${assignees.join('、')}`
}

export function describeEvent(event: ForgeEvent): string {
  switch (event.kind) {
    case 'comment':
      return `${event.actor} 在 ${event.ref} 留言：${event.excerpt}`
    case 'assigned':
      return `${event.actor} 把 ${event.ref} 指派給你：${event.title}`
    case 'review_requested':
      return `${event.actor} 請你審查 ${event.ref}：${event.title}`
    case 'approved':
      return `${event.actor} 核准了 ${event.ref}：${event.title}`
    case 'changes_requested':
      return `${event.actor} 要求修改 ${event.ref}：${event.title}`
    case 'closed':
      return `${event.actor} 關閉了 ${event.ref}：${event.title}`
    case 'merged':
      return `${event.actor} 合併了 ${event.ref}：${event.title}`
  }
}

export function formatAgo(now: number, iso: string): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小時前` : `${Math.floor(hours / 24)} 天前`
}

const EXCERPT_COLUMNS = 60

// 留言內文是 Markdown：圖片換成「[圖片]」、連結只留文字、去掉強調符號，再壓成一行
export function excerptOf(body: string): string {
  const plain = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[圖片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clipColumns(plain, EXCERPT_COLUMNS)
}

// 依終端機顯示寬度截斷（中文字佔兩格），超過時結尾補「…」
export function clipColumns(text: string, maxColumns: number): string {
  if (columnsWidth(text) <= maxColumns) return text
  let used = 0
  let clipped = ''
  for (const char of text) {
    if (used + columnsOf(char) > maxColumns - 1) break
    used += columnsOf(char)
    clipped += char
  }
  return `${clipped}…`
}

export function columnsWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + columnsOf(char), 0)
}

function columnsOf(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  const isWide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  return isWide ? 2 : 1
}

// ── 對外的 I/O ─────────────────────────────────────────

// 平台模組讀得到的環境變數；載入器要求 $.env.get 的名稱寫死，所以只開放這幾個
export type EnvName = 'GITLAB_TOKEN' | 'USER'

// 平台模組用到的 I/O，由 register.tsx 用 $ 實作後傳進來（載入器不准把 $ 傳過 import）
export type Io = {
  // 逾時或連不上時是 null
  fetch(url: string, headers: Record<string, string>): Promise<HttpResponse | null>
  // 指令不存在或逾時時是 null
  run(argv: readonly string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string } | null>
  env(name: EnvName): Promise<string | undefined>
}

// ── 回應與 $.store 內容的解析 ───────────────────────────

export type Raw = Record<string, unknown>

export function asRecord(value: unknown): Raw | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function toStrings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string')
}

const EVENT_FIELDS = ['id', 'kind', 'actor', 'ref', 'title', 'excerpt', 'url', 'at'] as const

// 舊版存下的動態沒有 projectPath，當成不知道是哪個專案（null）
export function toEvents(value: unknown): ForgeEvent[] {
  return asArray(value).flatMap(item => {
    const raw = asRecord(item)
    if (raw === null || !EVENT_FIELDS.every(field => typeof raw[field] === 'string')) return []
    return [{ ...(raw as unknown as ForgeEvent), projectPath: asString(raw.projectPath) }]
  })
}
