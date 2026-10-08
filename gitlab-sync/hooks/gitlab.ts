// GitLab API：一輪輪詢查出自己開的、指派給自己的 issue／MR 與要自己審查的 MR 的新動態，以及還開著的 issue
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

const KEYCHAIN_TIMEOUT_MS = 5_000
// macOS 鑰匙圈裡存 GitLab token 的項目名稱（security add-generic-password -s gitlab-token）
const KEYCHAIN_SERVICE = 'gitlab-token'

type ItemType = 'issue' | 'mr'
type StateChange = { at: string; by: ForgeUser }

export type GitlabItem = {
  type: ItemType
  id: number
  iid: number
  projectId: number
  title: string
  ref: string
  // null 代表 GitLab 沒給完整路徑
  projectPath: string | null
  url: string
  state: string
  closed: StateChange | null
  merged: StateChange | null
}

export type GitlabNote = { id: number; body: string; isSystem: boolean; createdAt: string; author: ForgeUser }
type GitlabClient = { baseUrl: string; token: string }

const ITEM_LISTS = [
  { type: 'issue', path: '/issues', scope: 'created_by_me' },
  { type: 'issue', path: '/issues', scope: 'assigned_to_me' },
  { type: 'mr', path: '/merge_requests', scope: 'created_by_me' },
  { type: 'mr', path: '/merge_requests', scope: 'assigned_to_me' },
  { type: 'mr', path: '/merge_requests', scope: 'reviews_for_me' },
] as const

const OPEN_ISSUE_SCOPES = ['created_by_me', 'assigned_to_me'] as const

// 模組變數在熱重載時會歸零，只放可以重建的東西
let currentUser: ForgeUser | null = null
// 從鑰匙圈換來的 token；有值時就不再用環境變數的，直到它也被拒絕
let keychainToken: string | null = null

// sinceMs 是 null 代表第一次輪詢：只查使用者與還開著的 issue，不補之前的舊動態。
// 沒有 token、token 被拒絕或連不上時丟出錯誤，訊息就是通知暫停的原因
export async function pollGitlab(io: Io, baseUrl: string, sinceMs: number | null): Promise<PollResult> {
  const token = await resolveToken(io)
  if (token === null) throw new Error(`GITLAB_TOKEN 是空的，鑰匙圈也讀不到 ${KEYCHAIN_SERVICE}（Keychain 鎖住，或還沒存）`)
  try {
    const { client, value } = await withKeychainFallback(io, { baseUrl, token }, current => pollEvents(io, current, sinceMs))
    return { ...value, openIssues: await queryOpenIssues(io, client) }
  } catch (error) {
    currentUser = null
    throw error
  }
}

async function pollEvents(io: Io, client: GitlabClient, sinceMs: number | null): Promise<{ me: ForgeUser; events: ForgeEvent[] }> {
  currentUser ??= toUser(await gitlabGet(io, client, '/user'))
  if (currentUser === null) throw new Error('讀不到 GitLab 使用者資料')
  const me = currentUser
  if (sinceMs === null) return { me, events: [] }
  const events: ForgeEvent[] = []
  for (const item of await listUpdatedItems(io, client, new Date(sinceMs).toISOString())) {
    events.push(...(await itemEvents(io, client, item, sinceMs, me)))
  }
  return { me, events }
}

// 只認主機跟設定的 GitLab 相同的 remote，回傳去掉 .git 的專案路徑
export function gitlabProjectOf(remoteUrl: string, gitlabUrl: string): string | null {
  const gitlabHost = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(gitlabUrl)?.[1]
  return gitlabHost === undefined ? null : remoteProjectPath(remoteUrl, gitlabHost)
}

// ── token ─────────────────────────────────────────────
// 環境變數 GITLAB_TOKEN 優先；它可能是 shell 啟動時從鑰匙圈讀出來的，之後在鑰匙圈換了 token，環境變數還是舊的，
// 所以環境變數是空的、或 GitLab 回 401 時，改讀鑰匙圈的最新值

async function resolveToken(io: Io): Promise<string | null> {
  if (keychainToken !== null) return keychainToken
  const envToken = await io.env('GITLAB_TOKEN')
  if (envToken) return envToken
  keychainToken = await readKeychainToken(io)
  return keychainToken
}

// token 被拒絕時換用鑰匙圈的最新 token 重試一次，回傳最後成功用的 client；鑰匙圈也沒有可用的就放棄
async function withKeychainFallback<T>(
  io: Io,
  client: GitlabClient,
  work: (client: GitlabClient) => Promise<T>,
): Promise<{ client: GitlabClient; value: T }> {
  const first = await attempt(client, work)
  if (first !== REJECTED) return { client, value: first }
  keychainToken = null
  const latest = await readKeychainToken(io)
  // 鑰匙圈裡是同一個被拒絕的 token 時，不必再試一次
  if (latest !== null && latest !== client.token) {
    const retried = { ...client, token: latest }
    const second = await attempt(retried, work)
    if (second !== REJECTED) {
      keychainToken = latest
      return { client: retried, value: second }
    }
  }
  throw new Error('GitLab token 無效或已過期（HTTP 401），鑰匙圈裡也沒有可用的新 token')
}

const REJECTED = Symbol('rejected')

// 只把 401 當成「不接受」，連不上或其他錯誤照常丟出
async function attempt<T>(client: GitlabClient, work: (client: GitlabClient) => Promise<T>): Promise<T | typeof REJECTED> {
  try {
    return await work(client)
  } catch (error) {
    if (error instanceof TokenRejectedError) return REJECTED
    throw error
  }
}

// token 從 stdout 讀回來，不出現在指令參數；不是 macOS、沒存或鑰匙圈鎖住時都是 null
async function readKeychainToken(io: Io): Promise<string | null> {
  const account = await io.env('USER')
  const argv = ['security', 'find-generic-password', ...(account ? ['-a', account] : []), '-s', KEYCHAIN_SERVICE, '-w']
  const result = await io.run(argv, KEYCHAIN_TIMEOUT_MS)
  const token = result?.stdout.trim() ?? ''
  return result?.exitCode === 0 && token !== '' ? token : null
}

// ── 查詢 ──────────────────────────────────────────────

async function gitlabGet(io: Io, client: GitlabClient, path: string): Promise<unknown> {
  // token 只放在 header，不出現在網址或指令參數
  const response = await io.fetch(`${client.baseUrl}/api/v4${path}`, { 'PRIVATE-TOKEN': client.token })
  if (response === null) throw new Error(`連不上 GitLab（${client.baseUrl}），可能不在能連到它的網路`)
  if (response.status === 401) throw new TokenRejectedError('GitLab token 無效或已過期（HTTP 401）')
  if (!response.ok) throw new Error(`GitLab 回應 HTTP ${response.status}（${path.split('?')[0]}）`)
  return JSON.parse(response.text)
}

async function listUpdatedItems(io: Io, client: GitlabClient, sinceIso: string): Promise<GitlabItem[]> {
  // 同一張 MR 可能同時是自己開的、指派給自己的、要自己審查的，用 type+id 合併
  const byKey = new Map<string, GitlabItem>()
  for (const list of ITEM_LISTS) {
    const query = `scope=${list.scope}&state=all&updated_after=${encodeURIComponent(sinceIso)}&per_page=100`
    for (const raw of asArray(await gitlabGet(io, client, `${list.path}?${query}`))) {
      const item = toItem(raw, list.type)
      if (item) byKey.set(`${item.type}:${item.id}`, item)
    }
  }
  return [...byKey.values()]
}

async function itemEvents(io: Io, client: GitlabClient, item: GitlabItem, since: number, me: ForgeUser): Promise<ForgeEvent[]> {
  const collection = item.type === 'mr' ? 'merge_requests' : 'issues'
  const raw = await gitlabGet(io, client, `/projects/${item.projectId}/${collection}/${item.iid}/notes?sort=desc&order_by=created_at&per_page=50`)
  const notes = asArray(raw)
    .map(toNote)
    .filter((note): note is GitlabNote => note !== null)
  return [...noteEvents(item, notes, since, me), ...stateEvents(item, since, me)]
}

// 別人在 since 之後留的言，以及 GitLab 自動產生、跟自己有關的系統留言（指派給我、請我審查、核准）
export function noteEvents(item: GitlabItem, notes: readonly GitlabNote[], since: number, me: ForgeUser): ForgeEvent[] {
  const events: ForgeEvent[] = []
  for (const note of notes) {
    if (note.author.id === me.id || Date.parse(note.createdAt) < since) continue
    const kind = noteKind(note, me)
    if (kind === null) continue
    events.push({
      id: `note-${note.id}`,
      kind,
      actor: note.author.username,
      ref: item.ref,
      projectPath: item.projectPath,
      title: item.title,
      excerpt: kind === 'comment' ? excerptOf(note.body) : '',
      url: kind === 'comment' ? `${item.url}#note_${note.id}` : item.url,
      at: note.createdAt,
    })
  }
  return events
}

// 系統留言是固定的英文句子（GitLab 19.4 實測：「assigned to @alice」「approved this merge request」）；
// 「requested review from @alice」照 GitLab 的固定寫法，還沒實測過。
// 「mentioned in commit」這類跟自己無關的略過
function noteKind(note: GitlabNote, me: ForgeUser): EventKind | null {
  if (!note.isSystem) return 'comment'
  const mentionsMe = note.body.split(/[\s,]+/).includes(`@${me.username}`)
  if (note.body.startsWith('assigned to') && mentionsMe) return 'assigned'
  if (note.body.startsWith('requested review from') && mentionsMe) return 'review_requested'
  if (note.body.startsWith('approved this merge request')) return 'approved'
  return null
}

// 關閉與合併沒有系統留言，改看 closed_at／merged_at 與執行的人
export function stateEvents(item: GitlabItem, since: number, me: ForgeUser): ForgeEvent[] {
  const changes = [
    { kind: 'closed', change: item.state === 'closed' ? item.closed : null },
    { kind: 'merged', change: item.state === 'merged' ? item.merged : null },
  ] as const
  return changes.flatMap(({ kind, change }) =>
    change === null || change.by.id === me.id || Date.parse(change.at) < since
      ? []
      : [
          {
            id: `${kind}-${item.type}-${item.id}-${change.at}`,
            kind,
            actor: change.by.username,
            ref: item.ref,
            projectPath: item.projectPath,
            title: item.title,
            excerpt: '',
            url: item.url,
            at: change.at,
          },
        ],
  )
}

// 跟動態分開接錯：這一段查不到只影響張數與指令的清單，不讓整個通知暫停
async function queryOpenIssues(io: Io, client: GitlabClient): Promise<OpenIssuesResult> {
  try {
    return { issues: await listOpenIssues(io, client) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// 自己開的又指派給自己的會出現兩次，用 id 合併；最近更新的排前面
async function listOpenIssues(io: Io, client: GitlabClient): Promise<OpenIssue[]> {
  const byId = new Map<number, OpenIssue>()
  for (const scope of OPEN_ISSUE_SCOPES) {
    for (const raw of asArray(await gitlabGet(io, client, `/issues?scope=${scope}&state=opened&per_page=100`))) {
      const issue = toOpenIssue(raw)
      if (issue) byId.set(issue.id, issue)
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

// ── 回應解析 ──────────────────────────────────────────

function toUser(value: unknown): ForgeUser | null {
  const raw = asRecord(value)
  return raw && typeof raw.id === 'number' && typeof raw.username === 'string' ? { id: raw.id, username: raw.username } : null
}

function toStateChange(at: unknown, by: unknown): StateChange | null {
  const time = asString(at)
  const user = toUser(by)
  return time !== null && user !== null ? { at: time, by: user } : null
}

export function toItem(value: unknown, type: ItemType): GitlabItem | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.id !== 'number' || typeof raw.iid !== 'number' || typeof raw.project_id !== 'number') return null
  const fullRef = asString(asRecord(raw.references)?.full) ?? `${raw.project_id}${type === 'mr' ? '!' : '#'}${raw.iid}`
  return {
    type,
    id: raw.id,
    iid: raw.iid,
    projectId: raw.project_id,
    title: asString(raw.title) ?? '',
    // acme/web/web-app#5 → web-app#5
    ref: fullRef.slice(fullRef.lastIndexOf('/') + 1),
    projectPath: projectPathOf(asString(asRecord(raw.references)?.full)),
    url: asString(raw.web_url) ?? '',
    state: asString(raw.state) ?? '',
    closed: toStateChange(raw.closed_at, raw.closed_by),
    merged: toStateChange(raw.merged_at, raw.merged_by),
  }
}

export function toOpenIssue(value: unknown): OpenIssue | null {
  const item = toItem(value, 'issue')
  const raw = asRecord(value)
  const author = toUser(raw?.author)
  const updatedAt = asString(raw?.updated_at)
  if (item === null || raw === null || author === null || updatedAt === null) return null
  const assignees = asArray(raw.assignees)
    .map(toUser)
    .filter((user): user is ForgeUser => user !== null)
  return { id: item.id, ref: item.ref, projectPath: item.projectPath, title: item.title, url: item.url, author, assignees, updatedAt }
}

// acme/web/web-app#5、acme/monitor!3 → 前面的專案路徑
function projectPathOf(fullRef: string | null): string | null {
  return /^(.+)[#!]\d+$/.exec(fullRef ?? '')?.[1] ?? null
}

export function toNote(value: unknown): GitlabNote | null {
  const raw = asRecord(value)
  const author = toUser(raw?.author)
  const createdAt = asString(raw?.created_at)
  if (!raw || typeof raw.id !== 'number' || author === null || createdAt === null) return null
  return { id: raw.id, body: asString(raw.body) ?? '', isSystem: raw.system === true, createdAt, author }
}
