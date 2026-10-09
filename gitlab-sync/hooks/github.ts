// GitHub API：一輪輪詢查出自己開的、指派給自己的 issue／PR 與要自己審查的 PR 的新動態，以及還開著的 issue。
// token 跟 gh CLI 共用（gh auth token），這台電腦沒登入 gh 時整個 GitHub 部分關閉，不算問題
import {
  asArray,
  asRecord,
  asString,
  excerptOf,
  remoteProjectPath,
  TokenRejectedError,
  type EventKind,
  type ForgeEvent,
  type ForgeUser,
  type Io,
  type OpenIssue,
  type OpenIssuesResult,
  type PollResult,
} from './shared'

const API_URL = 'https://api.github.com'
const GH_TIMEOUT_MS = 5_000
const PER_PAGE = 100

export type GithubItem = {
  id: number
  number: number
  // owner/repo
  repo: string
  title: string
  url: string
  // 已合併的 PR：timeline 會同時有 merged 與 closed，只通知合併
  isMerged: boolean
}

// timeline 的一筆，已整理成判斷要不要通知需要的欄位
export type TimelineEntry = {
  id: string
  type: 'comment' | 'review' | 'assigned' | 'review_requested' | 'closed' | 'merged'
  actor: ForgeUser
  at: string
  body: string
  // 審查結果：approved、changes_requested、commented、dismissed
  reviewState: string
  // 被指派或被請求審查的人
  target: ForgeUser | null
  url: string | null
}

type Response = { body: unknown; headers: Record<string, string> }

// 模組變數在熱重載時會歸零，只放可以重建的東西
let cachedToken: string | null = null
let currentUser: ForgeUser | null = null

// 回傳 null 代表這台電腦沒登入 gh：不輪詢、不顯示。sinceMs 是 null 代表第一次輪詢，只查使用者與還開著的 issue。
// token 被拒絕或連不上時丟出錯誤，訊息就是通知暫停的原因
export async function pollGithub(io: Io, sinceMs: number | null): Promise<PollResult | null> {
  cachedToken ??= await readGhToken(io)
  const token = cachedToken
  if (token === null) {
    currentUser = null
    return null
  }
  try {
    currentUser ??= toUser((await githubGet(io, token, '/user')).body)
    if (currentUser === null) throw new Error('讀不到 GitHub 使用者資料')
    const me = currentUser
    const events: ForgeEvent[] = []
    if (sinceMs !== null) {
      for (const item of await listUpdatedItems(io, token, sinceMs)) {
        events.push(...timelineEvents(item, await readTimeline(io, token, item), sinceMs, me))
      }
    }
    return { me, events, openIssues: await queryOpenIssues(io, token) }
  } catch (error) {
    currentUser = null
    // 下一輪重新向 gh 要 token：使用者可能剛重新登入
    if (error instanceof TokenRejectedError) cachedToken = null
    throw error
  }
}

// remote 在 github.com 時回傳 owner/repo
export function githubRepoOf(remoteUrl: string): string | null {
  return remoteProjectPath(remoteUrl, 'github.com')
}

// token 從 stdout 讀回來，不出現在指令參數；gh 沒裝、沒登入時是 null
async function readGhToken(io: Io): Promise<string | null> {
  const result = await io.run(['gh', 'auth', 'token'], GH_TIMEOUT_MS)
  const token = result?.stdout.trim() ?? ''
  return result?.exitCode === 0 && token !== '' ? token : null
}

// ── 查詢 ──────────────────────────────────────────────

// pathOrUrl 是 /開頭的路徑，或分頁 Link header 給的完整網址（只接受 api.github.com 的，token 不外流）
async function githubGet(io: Io, token: string, pathOrUrl: string): Promise<Response> {
  const url = pathOrUrl.startsWith('/') ? `${API_URL}${pathOrUrl}` : pathOrUrl
  if (!url.startsWith(`${API_URL}/`)) throw new Error(`不是 GitHub API 的網址：${url}`)
  // token 只放在 header，不出現在網址或指令參數
  const response = await io.fetch(url, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gitlab-sync-mod',
  })
  const path = new URL(url).pathname
  if (response === null) throw new Error('連不上 GitHub（api.github.com）')
  if (response.status === 401) throw new TokenRejectedError('GitHub token 無效或已過期（HTTP 401），在終端機執行 gh auth login 重新登入')
  if (!response.ok) throw new Error(`GitHub 回應 HTTP ${response.status}（${path}）`)
  return { body: JSON.parse(response.text), headers: response.headers }
}

// 自己開的、指派給自己的 issue 與 PR（GitHub 的 /issues 兩種都包含），加上請自己審查、自己審查過的 PR。
// 同一張可能同時符合好幾個條件，用 id 合併
async function listUpdatedItems(io: Io, token: string, sinceMs: number): Promise<GithubItem[]> {
  const sinceIso = new Date(sinceMs).toISOString()
  // 搜尋語法的時間不接受毫秒
  const searchSince = sinceIso.replace(/\.\d{3}Z$/, 'Z')
  const lists = [
    `/issues?filter=created&state=all&since=${encodeURIComponent(sinceIso)}&per_page=${PER_PAGE}`,
    `/issues?filter=assigned&state=all&since=${encodeURIComponent(sinceIso)}&per_page=${PER_PAGE}`,
    `/search/issues?q=${encodeURIComponent(`is:pr review-requested:@me updated:>=${searchSince}`)}&per_page=${PER_PAGE}`,
    `/search/issues?q=${encodeURIComponent(`is:pr reviewed-by:@me updated:>=${searchSince}`)}&per_page=${PER_PAGE}`,
  ]
  const byId = new Map<number, GithubItem>()
  for (const path of lists) {
    const { body } = await githubGet(io, token, path)
    // 搜尋的結果包在 items 裡
    for (const raw of Array.isArray(body) ? body : asArray(asRecord(body)?.items)) {
      const item = toItem(raw)
      if (item) byId.set(item.id, item)
    }
  }
  return [...byId.values()]
}

// timeline 由舊到新排，新動態在最後一頁；超過一頁時讀最後兩頁，足夠涵蓋兩分鐘內的新動態
async function readTimeline(io: Io, token: string, item: GithubItem): Promise<TimelineEntry[]> {
  const first = await githubGet(io, token, `/repos/${item.repo}/issues/${item.number}/timeline?per_page=${PER_PAGE}`)
  const lastUrl = linkUrl(first.headers.link, 'last')
  const pages = [first.body]
  if (lastUrl !== null) {
    const lastPage = Number(new URL(lastUrl).searchParams.get('page'))
    if (lastPage > 2) {
      const previousUrl = new URL(lastUrl)
      previousUrl.searchParams.set('page', String(lastPage - 1))
      pages.push((await githubGet(io, token, previousUrl.toString())).body)
    }
    pages.push((await githubGet(io, token, lastUrl)).body)
  }
  return pages.flatMap(asArray).flatMap(toTimelineEntries)
}

// Link: <https://api.github.com/...&page=2>; rel="next", <https://api.github.com/...&page=5>; rel="last"
export function linkUrl(header: string | undefined, rel: string): string | null {
  for (const part of (header ?? '').split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)
    if (match?.[2] === rel) return match[1] ?? null
  }
  return null
}

// 別人在 since 之後做的、跟自己有關的事：留言、審查結果、指派給我、請我審查、關閉、合併
export function timelineEvents(item: GithubItem, entries: readonly TimelineEntry[], since: number, me: ForgeUser): ForgeEvent[] {
  const events: ForgeEvent[] = []
  for (const entry of entries) {
    if (entry.actor.id === me.id || Date.parse(entry.at) < since) continue
    const kind = entryKind(entry, item, me)
    if (kind === null) continue
    events.push({
      id: entry.id,
      kind,
      actor: entry.actor.username,
      ref: `${item.repo.slice(item.repo.indexOf('/') + 1)}#${item.number}`,
      projectPath: item.repo,
      title: item.title,
      excerpt: kind === 'comment' ? excerptOf(entry.body) : '',
      url: entry.url ?? item.url,
      at: entry.at,
    })
  }
  return events
}

function entryKind(entry: TimelineEntry, item: GithubItem, me: ForgeUser): EventKind | null {
  switch (entry.type) {
    case 'comment':
      return 'comment'
    case 'review':
      // 只有逐行意見、沒寫總評的審查，逐行意見本身會以留言出現
      if (entry.reviewState === 'approved') return 'approved'
      if (entry.reviewState === 'changes_requested') return 'changes_requested'
      return entry.reviewState === 'commented' && entry.body.trim() !== '' ? 'comment' : null
    case 'assigned':
      return entry.target?.id === me.id ? 'assigned' : null
    case 'review_requested':
      return entry.target?.id === me.id ? 'review_requested' : null
    case 'closed':
      return item.isMerged ? null : 'closed'
    case 'merged':
      return 'merged'
  }
}

// 跟動態分開接錯：這一段查不到只影響張數與指令的清單，不讓整個通知暫停
async function queryOpenIssues(io: Io, token: string): Promise<OpenIssuesResult> {
  try {
    return { issues: await listOpenIssues(io, token) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// 只算 issue、不算 PR；自己開的又指派給自己的會出現兩次，用 id 合併；最近更新的排前面
async function listOpenIssues(io: Io, token: string): Promise<OpenIssue[]> {
  const byId = new Map<number, OpenIssue>()
  for (const filter of ['created', 'assigned']) {
    for (const raw of asArray((await githubGet(io, token, `/issues?filter=${filter}&state=open&per_page=${PER_PAGE}`)).body)) {
      const issue = toOpenIssue(raw)
      if (issue) byId.set(issue.id, issue)
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

// ── 回應解析 ──────────────────────────────────────────

function toUser(value: unknown): ForgeUser | null {
  const raw = asRecord(value)
  return raw && typeof raw.id === 'number' && typeof raw.login === 'string' ? { id: raw.id, username: raw.login } : null
}

// https://api.github.com/repos/alice/notes-app → alice/notes-app
function repoOf(raw: Record<string, unknown>): string | null {
  return /\/repos\/([^/]+\/[^/]+)$/.exec(asString(raw.repository_url) ?? '')?.[1] ?? null
}

export function toItem(value: unknown): GithubItem | null {
  const raw = asRecord(value)
  const repo = raw === null ? null : repoOf(raw)
  if (raw === null || repo === null || typeof raw.id !== 'number' || typeof raw.number !== 'number') return null
  return {
    id: raw.id,
    number: raw.number,
    repo,
    title: asString(raw.title) ?? '',
    url: asString(raw.html_url) ?? '',
    isMerged: asString(asRecord(raw.pull_request)?.merged_at) !== null,
  }
}

export function toOpenIssue(value: unknown): OpenIssue | null {
  const item = toItem(value)
  const raw = asRecord(value)
  const author = toUser(raw?.user)
  const updatedAt = asString(raw?.updated_at)
  if (item === null || raw === null || author === null || updatedAt === null || raw.pull_request !== undefined) return null
  const assignees = asArray(raw.assignees)
    .map(toUser)
    .filter((user): user is ForgeUser => user !== null)
  return {
    id: item.id,
    kind: 'Issue',
    ref: `${item.repo.slice(item.repo.indexOf('/') + 1)}#${item.number}`,
    projectPath: item.repo,
    title: item.title,
    url: item.url,
    author,
    assignees,
    updatedAt,
  }
}

// timeline 各種事件的欄位不一樣：留言的人在 user（也有 actor）、審查的人只有 user、時間是 submitted_at；
// 逐行意見（line-commented）一筆包了好幾則留言，拆開來各算一則
export function toTimelineEntries(value: unknown): TimelineEntry[] {
  const raw = asRecord(value)
  if (raw === null) return []
  const base = { body: asString(raw.body) ?? '', reviewState: '', target: null, url: asString(raw.html_url) }
  switch (raw.event) {
    case 'commented':
      return entry(raw, 'comment', `comment-${raw.id}`, toUser(raw.user) ?? toUser(raw.actor), raw.created_at, base)
    case 'line-commented':
      return asArray(raw.comments).flatMap(item => {
        const comment = asRecord(item)
        if (comment === null) return []
        const commentBase = { ...base, body: asString(comment.body) ?? '', url: asString(comment.html_url) }
        return entry(comment, 'comment', `review-comment-${comment.id}`, toUser(comment.user), comment.created_at, commentBase)
      })
    case 'reviewed':
      return entry(raw, 'review', `review-${raw.id}`, toUser(raw.user), raw.submitted_at, { ...base, reviewState: (asString(raw.state) ?? '').toLowerCase() })
    case 'assigned':
      return entry(raw, 'assigned', `assigned-${raw.id}`, toUser(raw.actor), raw.created_at, { ...base, target: toUser(raw.assignee) })
    case 'review_requested':
      return entry(raw, 'review_requested', `review-requested-${raw.id}`, toUser(raw.actor), raw.created_at, { ...base, target: toUser(raw.requested_reviewer) })
    case 'closed':
      return entry(raw, 'closed', `closed-${raw.id}`, toUser(raw.actor), raw.created_at, base)
    case 'merged':
      return entry(raw, 'merged', `merged-${raw.id}`, toUser(raw.actor), raw.created_at, base)
    default:
      return []
  }
}

function entry(
  raw: Record<string, unknown>,
  type: TimelineEntry['type'],
  id: string,
  actor: ForgeUser | null,
  at: unknown,
  rest: Pick<TimelineEntry, 'body' | 'reviewState' | 'target' | 'url'>,
): TimelineEntry[] {
  const time = asString(at)
  return typeof raw.id !== 'number' || actor === null || time === null ? [] : [{ id, type, actor, at: time, ...rest }]
}
