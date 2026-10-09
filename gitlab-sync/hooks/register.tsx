// GitLab Sync：輸入框上方一行顯示目前分支跟遠端差幾個 commit，以及自己開的或指派給自己、還開著的張數（GitLab 分 Task、Issue）；
// GitLab 與 GitHub 上自己開的、指派給自己的 issue／MR（PR），以及要自己審查的 MR（PR）有新動態時跳 toast；
// /gitlab、/github 立即檢查並列出該平台的未讀動態，以及那些還開著的項目（在該平台專案的 repo 裡兩者都只算這個專案的）
import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register, Timer } from 'claude-code'

import type { InboxStatus, KindCount, RepoSync } from '../types'
import { gitlabProjectOf, pollGitlab } from './gitlab'
import { githubRepoOf, pollGithub } from './github'
import {
  clipColumns,
  columnsWidth,
  describeEvent,
  formatAgo,
  groupByKind,
  inProject,
  openIssueLines,
  projectName,
  remoteHostOf,
  repoScopeLabel,
  toEvents,
  toStrings,
  type ForgeEvent,
  type EnvName,
  type ForgeUser,
  type Io,
  type OpenIssuesResult,
  type PollResult,
  type Segment,
  type Span,
} from './shared'

const TICK_MS = 60_000
const FETCH_INTERVAL_MS = 5 * 60_000
const POLL_INTERVAL_MS = 2 * 60_000
// 同一個 repo 開了好幾個 session 時，FETCH_HEAD 夠新就代表別的 session 剛 fetch 過，這次不必再抓
const FETCH_FRESH_MS = FETCH_INTERVAL_MS - 30_000
// 輪詢範圍往前多抓一段，避免伺服器時間誤差漏掉動態；重複抓到的事件靠 id 去掉
const POLL_OVERLAP_MS = 2 * 60_000
const GIT_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 30_000
const HTTP_TIMEOUT_MS = 15_000
const MAX_UNREAD = 50
const MAX_SEEN_IDS = 500
const TOAST_MS = 10_000
const TOAST_COLUMNS = 100
// band 是一行字，不加框也不上底色（框、底色、膠囊兩端都試過，使用者都不要）。
// 文字前留兩格：上方 where-am-i 的摘要框是「框線一格＋內距一格」才寫字，兩邊的文字起點才會對齊
const BAND_PADDING_X = 2
// 背景跑的 git 不能停在密碼提示，連不上就直接失敗
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
const EMPTY_INBOX: InboxStatus = { unreadCount: 0, problem: null, openCounts: null }

const repoSync = atom({ plugin: 'gitlab-sync', key: 'repo' } as const, null)
// GitLab 沿用最早的鍵名 inbox
const gitlabInbox = atom({ plugin: 'gitlab-sync', key: 'inbox' } as const, EMPTY_INBOX)
const githubInbox = atom({ plugin: 'gitlab-sync', key: 'githubInbox' } as const, EMPTY_INBOX)

// 平台的名稱：label 寫在 band、toast 與報告裡，command 是斜線指令
export type ForgeNames = { label: string; command: string }

type Forge = ForgeNames & {
  id: 'gitlab' | 'github'
  // $.store 的鍵；$.store 跨 session 共用：每個 session 都會輪詢，但同一個事件只記一次，未讀清單大家看同一份
  storeKeys: { since: string; seenIds: string; unread: string }
  // 這個 repo 在這個平台上的專案路徑；null 代表 remote 不在這個平台：
  // 未讀動態與還開著的項目不分專案全部列，band 不顯示張數
  projectOf: (repo: RepoSync | null) => string | null
  // 還開著的項目分哪幾種類型計數；這些類型 0 張也顯示，其他類型有才顯示
  issueKinds: readonly string[]
  // 這台電腦沒設定這個平台（pollPlatform 回傳 null）時，斜線指令的說明
  disabledHint: string
}

// 模組變數在熱重載時會歸零，所以只放可以重建的東西；要留住的放 $.state 或 $.store
type ForgeRuntime = {
  me: ForgeUser | null
  // 最近一次輪詢查到的還開著的 issue（全部專案，還沒依 repo 過濾）；null 代表還沒查、通知暫停中或平台關閉
  openIssues: OpenIssuesResult | null
  isDisabled: boolean
  lastPollAt: number
  lastToastedProblem: string | null
  hasSeededToasts: boolean
  toastedEventIds: Set<string>
}

// 每台電腦在 userConfig 各自設定；空字串代表沒設定，GitLab 部分整個關閉
let gitlabBaseUrl = ''

const GITLAB: Forge = {
  id: 'gitlab',
  label: 'GitLab',
  command: 'gitlab',
  // 沿用最早的鍵名：升級前存下的起點與未讀清單照常使用
  storeKeys: { since: 'since', seenIds: 'seenEventIds', unread: 'unread' },
  projectOf: repo => repo?.gitlabProject ?? null,
  // GitLab 的 work item 有 Task、Issue 等類型，別人指派過來的多半是 Task
  issueKinds: ['Task', 'Issue'],
  disabledHint: 'GitLab：這台電腦還沒設定 GitLab 網址，不檢查 GitLab（用 /plugin configure gitlab-sync 設定 gitlabUrl）。',
}

const GITHUB: Forge = {
  id: 'github',
  label: 'GitHub',
  command: 'github',
  storeKeys: { since: 'github.since', seenIds: 'github.seenEventIds', unread: 'github.unread' },
  projectOf: repo => repo?.githubRepo ?? null,
  issueKinds: ['Issue'],
  disabledHint: 'GitHub：這台電腦沒有登入 gh，不檢查 GitHub（在終端機執行 gh auth login 後，下一輪就會開始）。',
}

const FORGES = [GITLAB, GITHUB] as const

let tickTimer: Timer | undefined
let runningTick: Promise<void> | null = null
let lastFetchAt = 0
let lastBehind: { key: string; behind: number } | null = null
const fetchFailedByRoot = new Map<string, boolean>()
const runtimes = new Map<Forge, ForgeRuntime>()

function runtimeOf(forge: Forge): ForgeRuntime {
  let runtime = runtimes.get(forge)
  if (runtime === undefined) {
    runtime = { me: null, openIssues: null, isDisabled: false, lastPollAt: 0, lastToastedProblem: null, hasSeededToasts: false, toastedEventIds: new Set() }
    runtimes.set(forge, runtime)
  }
  return runtime
}

// ── 排程 ──────────────────────────────────────────────

function startTicking($: EngineInterface) {
  tickTimer?.cancel()
  tickTimer = $.clock.every(TICK_MS, () => void runTick($, false).catch(() => {}))
}

// 同一時間只跑一輪；斜線指令要求立即檢查時，等目前這輪跑完再強制跑一輪
function runTick($: EngineInterface, isForced: boolean): Promise<void> {
  if (runningTick) return isForced ? runningTick.catch(() => {}).then(() => runTick($, true)) : runningTick
  runningTick = tick($, isForced).finally(() => {
    runningTick = null
  })
  return runningTick
}

async function tick($: EngineInterface, isForced: boolean) {
  const now = await $.clock.now()
  const shouldFetch = isForced || now - lastFetchAt >= FETCH_INTERVAL_MS
  if (shouldFetch) lastFetchAt = now
  await refreshRepo($, shouldFetch, now)
  // 兩個平台同時查：一邊連不上等逾時，不拖住另一邊
  await Promise.all(
    FORGES.map(async forge => {
      const runtime = runtimeOf(forge)
      if (isForced || now - runtime.lastPollAt >= POLL_INTERVAL_MS) {
        runtime.lastPollAt = now
        await pollForge($, forge, now)
      }
      await syncInbox($, forge)
    }),
  )
}

// ── git ───────────────────────────────────────────────

async function git($: EngineInterface, cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  try {
    // --no-optional-locks：背景的 git status 不搶 index.lock，避免跟 Claude 正在跑的 git commit 撞在一起
    const result = await $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs, env: GIT_ENV })
    return result.exitCode === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

async function refreshRepo($: EngineInterface, shouldFetch: boolean, now: number) {
  const root = await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel'])
  if (root === null) return setRepo($, null)
  const branchName = await git($, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const isDetached = branchName === null
  const branch = branchName ?? (await git($, root, ['rev-parse', '--short', 'HEAD']))
  // 還沒有任何 commit 的 repo 沒有東西可以比
  if (branch === null) return setRepo($, null)

  const upstream = isDetached ? null : await resolveUpstream($, root, branch)
  if (upstream !== null && shouldFetch) {
    const fetched = await fetchUpstream($, root, upstream, now)
    if (fetched !== 'skipped') fetchFailedByRoot.set(root, fetched === 'failed')
  }
  const [ahead, behind] = upstream === null ? [0, 0] : parseCounts(await git($, root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]))
  const status = await git($, root, ['status', '--porcelain'])
  const dirtyCount = status ? status.split('\n').filter(line => line !== '').length : 0
  const remote = await resolveRemote($, root, upstream)

  notifyNewRemoteCommits($, `${root}\n${branch}\n${upstream}`, upstream, behind)
  await setRepo($, { branch, isDetached, upstream, ahead, behind, dirtyCount, isFetchFailed: fetchFailedByRoot.get(root) ?? false, ...remote })
}

type RemoteInfo = Pick<RepoSync, 'remoteHost' | 'gitlabProject' | 'githubRepo'>

// 看遠端分支所在的 remote；沒有遠端分支（detached、還沒 push）時看 origin
async function resolveRemote($: EngineInterface, root: string, upstream: string | null): Promise<RemoteInfo> {
  const remote = upstream === null ? 'origin' : upstream.slice(0, upstream.indexOf('/'))
  const remoteUrl = await git($, root, ['remote', 'get-url', remote])
  if (remoteUrl === null) return { remoteHost: null, gitlabProject: null, githubRepo: null }
  return { remoteHost: remoteHostOf(remoteUrl), gitlabProject: gitlabProjectOf(remoteUrl, gitlabBaseUrl), githubRepo: githubRepoOf(remoteUrl) }
}

// 優先用分支設定的 upstream；沒設時退回 origin/<同名分支>，跟 check-gitlab-version skill 的規則一樣
async function resolveUpstream($: EngineInterface, root: string, branch: string): Promise<string | null> {
  const configured = await git($, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (configured) return configured
  const fallback = `origin/${branch}`
  return (await git($, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${fallback}`])) === null ? null : fallback
}

async function fetchUpstream($: EngineInterface, root: string, upstream: string, now: number): Promise<'fetched' | 'failed' | 'skipped'> {
  const fetchHead = await git($, root, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])
  if (fetchHead !== null) {
    const stat = await $.fs.stat(fetchHead).catch(() => null)
    if (stat && now - stat.mtimeMs < FETCH_FRESH_MS) return 'skipped'
  }
  // upstream 是「遠端名稱/遠端分支」，分支名稱本身可能含斜線（feat/x），只切第一個
  const slash = upstream.indexOf('/')
  const fetched = await git($, root, ['fetch', '--quiet', upstream.slice(0, slash), upstream.slice(slash + 1)], FETCH_TIMEOUT_MS)
  return fetched === null ? 'failed' : 'fetched'
}

function parseCounts(output: string | null): [number, number] {
  const [ahead = 0, behind = 0] = (output ?? '').split(/\s+/).map(Number).filter(Number.isFinite)
  return [ahead, behind]
}

// 同一個 repo、分支與遠端分支，落後數比上次多才提醒；剛開 session 或換分支時只記下來
function notifyNewRemoteCommits($: EngineInterface, key: string, upstream: string | null, behind: number) {
  if (upstream !== null && lastBehind?.key === key && behind > lastBehind.behind) {
    toast($, `${upstream} 多了 ${behind - lastBehind.behind} 個新 commit，本機落後 ${behind} 個`)
  }
  lastBehind = { key, behind }
}

async function setRepo($: EngineInterface, next: RepoSync | null) {
  // 沒變就不寫：寫入會讓 band 重畫
  if (JSON.stringify(await read($, repoSync)) === JSON.stringify(next)) return
  await update($, repoSync, () => next)
  // 換了目錄或 remote，band 的數字要跟著換專案算，不等下一次輪詢
  await Promise.all(FORGES.map(forge => syncCounts($, forge)))
}

// ── 平台輪詢 ───────────────────────────────────────────

async function pollForge($: EngineInterface, forge: Forge, now: number) {
  const runtime = runtimeOf(forge)
  const storedSince = await $.store.get(forge.storeKeys.since)
  // 第一次輪詢只記下起點，不補之前的舊動態
  const sinceMs = typeof storedSince === 'string' ? Date.parse(storedSince) - POLL_OVERLAP_MS : null
  let result: PollResult | null
  try {
    result = await pollPlatform($, forge, sinceMs)
  } catch (error) {
    runtime.me = null
    runtime.isDisabled = false
    return stopPolling($, forge, error instanceof Error ? error.message : String(error))
  }
  runtime.isDisabled = result === null
  runtime.me = result?.me ?? null
  if (result === null) {
    await setProblem($, forge, null)
    return setOpenIssues($, forge, null)
  }
  if (sinceMs !== null) await recordEvents($, forge, result.events)
  await $.store.set(forge.storeKeys.since, new Date(now).toISOString())
  await setProblem($, forge, null)
  await setOpenIssues($, forge, result.openIssues)
}

// 回傳 null 代表這台電腦沒設定這個平台，整個不顯示、不算問題；丟出錯誤代表通知暫停，訊息就是原因。
// 載入器只准把 $ 傳給檔案最上層宣告的函式，所以輪詢函式不放在 Forge 物件裡，由這裡依平台分派
async function pollPlatform($: EngineInterface, forge: Forge, sinceMs: number | null): Promise<PollResult | null> {
  switch (forge.id) {
    case 'gitlab':
      return gitlabBaseUrl === '' ? null : pollGitlab(ioOf($), gitlabBaseUrl, sinceMs)
    case 'github':
      return pollGithub(ioOf($), sinceMs)
  }
}

// 平台模組的 I/O：token 只放在 header，不出現在網址或指令參數
function ioOf($: EngineInterface): Io {
  return {
    fetch: (url, headers) => fetchWithTimeout($, url, headers),
    run: (argv, timeoutMs) => runCommand($, argv, timeoutMs),
    env: name => readEnv($, name),
  }
}

async function readEnv($: EngineInterface, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case 'GITLAB_TOKEN':
      return $.env.get('GITLAB_TOKEN')
    case 'USER':
      return $.env.get('USER')
  }
}

async function fetchWithTimeout($: EngineInterface, url: string, headers: Record<string, string>): Promise<HttpResponse | null> {
  return withTimeout($, $.http.fetch(url, { headers }), HTTP_TIMEOUT_MS).catch(() => null)
}

async function runCommand($: EngineInterface, argv: readonly string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs })
    return { exitCode, stdout }
  } catch {
    return null
  }
}

// 用計時器而不是 $.clock.sleep：sleep 會算進 hook 的執行預算
function withTimeout<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error('timeout')))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      error => {
        timer.cancel()
        reject(error)
      },
    )
  })
}

// 通知暫停時張數也跟著清掉，band 只顯示暫停，不留一個不知道多舊的數字
async function stopPolling($: EngineInterface, forge: Forge, problem: string) {
  await setProblem($, forge, problem)
  await setOpenIssues($, forge, null)
}

async function setOpenIssues($: EngineInterface, forge: Forge, next: OpenIssuesResult | null) {
  runtimeOf(forge).openIssues = next
  await syncCounts($, forge)
}

// band 的數字（新動態則數、各類型的張數）跟斜線指令的清單用同一個 repo 過濾；
// 未讀清單、還開著的項目或目前的 repo 任一個變了都要重算
async function syncCounts($: EngineInterface, forge: Forge) {
  const project = forge.projectOf(await read($, repoSync))
  const unreadCount = inProject(toEvents(await $.store.get(forge.storeKeys.unread)), project).length
  const openIssues = runtimeOf(forge).openIssues
  const openCounts: KindCount[] | null =
    openIssues !== null && 'issues' in openIssues
      ? groupByKind(inProject(openIssues.issues, project), forge.issueKinds).map(group => ({ kind: group.kind, count: group.issues.length }))
      : null
  const status = await readInbox($, forge)
  if (status.unreadCount !== unreadCount || JSON.stringify(status.openCounts) !== JSON.stringify(openCounts)) await updateInbox($, forge, { unreadCount, openCounts })
}

// 載入器要求 read／update 直接寫出這個檔案的 atom，所以依平台分派
async function readInbox($: EngineInterface, forge: Forge): Promise<InboxStatus> {
  switch (forge.id) {
    case 'gitlab':
      return read($, gitlabInbox)
    case 'github':
      return read($, githubInbox)
  }
}

async function updateInbox($: EngineInterface, forge: Forge, changes: Partial<InboxStatus>) {
  switch (forge.id) {
    case 'gitlab':
      return update($, gitlabInbox, current => ({ ...current, ...changes }))
    case 'github':
      return update($, githubInbox, current => ({ ...current, ...changes }))
  }
}

async function recordEvents($: EngineInterface, forge: Forge, events: readonly ForgeEvent[]) {
  const seen = toStrings(await $.store.get(forge.storeKeys.seenIds))
  const fresh = [...events].filter(event => !seen.includes(event.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (fresh.length === 0) return
  // 寫入前才讀未讀清單，縮小跟其他 session 同時寫入的空窗
  const unread = toEvents(await $.store.get(forge.storeKeys.unread))
  await $.store.set(forge.storeKeys.unread, [...unread, ...fresh].slice(-MAX_UNREAD))
  await $.store.set(forge.storeKeys.seenIds, [...seen, ...fresh.map(event => event.id)].slice(-MAX_SEEN_IDS))
}

// 每個 session 各自跳 toast；剛啟動（或熱重載）時已經在清單裡的只彙總成一則。
// 別的專案的動態照樣跳，只是在這裡打斜線指令看不到，toast 會寫明到哪個 repo 看
async function syncInbox($: EngineInterface, forge: Forge) {
  const runtime = runtimeOf(forge)
  const unread = toEvents(await $.store.get(forge.storeKeys.unread))
  const fresh = unread.filter(event => !runtime.toastedEventIds.has(event.id))
  for (const event of fresh) runtime.toastedEventIds.add(event.id)
  const project = forge.projectOf(await read($, repoSync))
  if (!runtime.hasSeededToasts) {
    runtime.hasSeededToasts = true
    const summary = startupToastText(unread, project, forge)
    if (summary !== null) toast($, summary)
  } else if (fresh.length > 0) {
    toast($, toastText(fresh, project, forge))
  }
  await syncCounts($, forge)
}

async function setProblem($: EngineInterface, forge: Forge, problem: string | null) {
  const runtime = runtimeOf(forge)
  if (problem !== null && problem !== runtime.lastToastedProblem) toast($, `${forge.label} 通知暫停：${problem}`)
  runtime.lastToastedProblem = problem
  const status = await readInbox($, forge)
  if (status.problem !== problem) await updateInbox($, forge, { problem })
}

function toast($: EngineInterface, text: string) {
  void Promise.resolve($.ui.toast(clipColumns(text, TOAST_COLUMNS), { timeoutMs: TOAST_MS })).catch(() => {})
}

// ── /gitlab、/github ──────────────────────────────────

async function checkNow($: EngineInterface, forge: Forge): Promise<string> {
  await runTick($, true)
  const runtime = runtimeOf(forge)
  const [repo, status, unread, now] = await Promise.all([read($, repoSync), readInbox($, forge), $.store.get(forge.storeKeys.unread).then(toEvents), $.clock.now()])
  const project = forge.projectOf(repo)
  const lines = [repoReport(repo)]
  if (runtime.isDisabled) return [...lines, forge.disabledHint].join('\n')
  if (status.problem !== null) lines.push(`${forge.label} 通知暫停：${status.problem}`)
  // 只列、只標已讀目前 repo 的；別的專案的留著，到那個 repo 再看
  const shown = inProject(unread, project)
  // 「裡」直接接英文的平台名稱時空一格
  const scope = project === null ? '' : `${repoScopeLabel(project)} `
  if (shown.length === 0) {
    if (status.problem === null) lines.push(`${scope}${forge.label} 新動態 0 則。`)
  } else {
    lines.push(`${scope}${forge.label} 新動態 ${shown.length} 則（已標為已讀）：`)
    for (const event of [...shown].reverse()) lines.push(`• ${formatAgo(now, event.at)}  ${describeEvent(event)}`, `  ${event.url}`)
    await markRead($, forge, shown)
  }
  lines.push(...openIssuesReport(forge, project, now))
  return lines.join('\n')
}

// 用上面強制輪詢那一輪查到的結果，不另外再查；通知暫停時（沒 token、401、連不上）是 null，上面已經說明原因
function openIssuesReport(forge: Forge, project: string | null, now: number): string[] {
  const { openIssues, me } = runtimeOf(forge)
  if (openIssues === null || me === null) return []
  if ('error' in openIssues) return [`讀不到還開著的 ${forge.issueKinds.join('／')}：${openIssues.error}`]
  return openIssueLines(openIssues.issues, me, now, project, forge.issueKinds)
}

// 只移除這次列出的事件：列出到寫回之間，別的 session 可能剛記下新的
async function markRead($: EngineInterface, forge: Forge, shown: readonly ForgeEvent[]) {
  const runtime = runtimeOf(forge)
  const shownIds = new Set(shown.map(event => event.id))
  for (const id of shownIds) runtime.toastedEventIds.add(id)
  const remaining = toEvents(await $.store.get(forge.storeKeys.unread)).filter(event => !shownIds.has(event.id))
  await $.store.set(forge.storeKeys.unread, remaining)
  await syncCounts($, forge)
}

export function repoReport(repo: RepoSync | null): string {
  if (repo === null) return '目前目錄不是 git repo（或還沒有任何 commit）。'
  const sync = syncSegment(repo)
  const dirty = repo.dirtyCount > 0 ? `${repo.dirtyCount} 個檔案未提交` : '沒有未提交的檔案'
  const upstream = repo.upstream === null ? '' : `（比對 ${repo.upstream}）`
  return `分支 ${repo.branch}${upstream}：${sync ? `${sync.text}，` : ''}${dirty}`
}

// ── 畫面 ──────────────────────────────────────────────

export function bandSegments(repo: RepoSync | null, gitlabStatus: InboxStatus, githubStatus: InboxStatus = EMPTY_INBOX): Segment[] {
  const segments: Segment[] = []
  if (repo !== null) {
    segments.push(remoteSegment(repo))
    segments.push({ text: `⎇ ${repo.branch}${repo.isDetached ? '（detached）' : ''}`, isDim: true })
    const sync = syncSegment(repo)
    if (sync) segments.push(sync)
    if (repo.dirtyCount > 0) segments.push({ text: `${repo.dirtyCount} 個檔案未提交`, isDim: true })
  }
  const statuses = [
    { forge: GITLAB, status: gitlabStatus },
    { forge: GITHUB, status: githubStatus },
  ]
  for (const { forge, status } of statuses) {
    if (status.unreadCount > 0) segments.push({ text: `${forge.label} ${status.unreadCount} 則新動態（/${forge.command}）`, color: 'suggestion', isBold: true })
    else if (status.problem !== null) segments.push({ text: `${forge.label} 通知暫停（/${forge.command} 看原因）`, color: 'warning', isDim: true })
  }
  // 放最後：這一行太長時從尾端截斷，先犧牲這些一直都在的數字，新動態留著。0 張也顯示，還沒查到時才不顯示。
  // 只在該平台的專案裡顯示：在別的平台、本機或不在 repo 的目錄，這些數字是全部專案加總，容易誤會成這個 repo 的
  for (const { forge, status } of statuses) {
    // 熱重載後 $.state 可能還是舊版存的形狀（沒有 openCounts），下一次重算前先當成還沒查到
    const counts = status.openCounts ?? null
    if (forge.projectOf(repo) !== null && counts !== null) segments.push(...openCountSegments(counts, forge.command))
  }
  return segments
}

// 這個 repo 的遠端在哪裡：設定的 GitLab 用 Claude 橘色；GitHub 用主題的文字色（深色主題是白色，淺色主題自動變黑，不會白字白底）；
// 沒有遠端（本機）與其他主機（直接寫主機名稱）用暗色
export function remoteSegment(repo: RepoSync): Segment {
  if (repo.gitlabProject !== null) return { text: 'GitLab', color: 'claude' }
  if (repo.remoteHost === null) return { text: '本機', isDim: true }
  if (repo.remoteHost === 'github.com') return { text: 'GitHub', color: 'text' }
  return { text: repo.remoteHost, isDim: true }
}

// 每種類型一段，例如「Task 2 張  ·  Issue 0 張（/gitlab）」，指令提示只接在最後一段。
// 只有數字上色：0 張綠色，有張數紅色，其餘字暗色
function openCountSegments(counts: readonly KindCount[], command: string): Segment[] {
  return counts.map(({ kind, count }, index) => {
    const hint = index === counts.length - 1 ? `（/${command}）` : ''
    const spans: Span[] = [
      { text: `${kind} `, isDim: true },
      { text: String(count), color: count === 0 ? 'success' : 'error', isBold: true },
      { text: ` 張${hint}`, isDim: true },
    ]
    return { text: spans.map(span => span.text).join(''), spans }
  })
}

function syncSegment(repo: RepoSync): Segment | null {
  if (repo.isDetached) return null
  if (repo.upstream === null) return { text: '沒有遠端分支（還沒 push？）', isDim: true }
  const cached = repo.isFetchFailed ? '（fetch 失敗，依快取）' : ''
  if (repo.ahead === 0 && repo.behind === 0) return { text: `✓ 已同步${cached}`, color: 'success' }
  if (repo.behind === 0) return { text: `↑${repo.ahead} 待 push${cached}`, color: 'warning' }
  if (repo.ahead === 0) return { text: `↓${repo.behind} 待 pull${cached}`, color: 'warning' }
  return { text: `↑${repo.ahead} ↓${repo.behind} 分岔${cached}`, color: 'error' }
}

// 提示放在最後、不跟著截斷：太長時截的是動態內容
export function toastText(events: readonly ForgeEvent[], project: string | null, names: ForgeNames): string {
  const latest = events[events.length - 1]
  if (latest === undefined) return ''
  const elsewhere = elsewhereName(latest, project)
  const body = events.length === 1 ? `${names.label}：${describeEvent(latest)}` : `${names.label} ${events.length} 則新動態，最新：${describeEvent(latest)}`
  const hint = elsewhere !== null ? `（到 ${elsewhere} 用 /${names.command} 查看）` : events.length === 1 ? '' : `（/${names.command} 查看）`
  return `${clipColumns(body, TOAST_COLUMNS - columnsWidth(hint))}${hint}`
}

// 剛啟動（或熱重載）時的彙總：目前 repo 的與其他專案的分開算，其他專案寫出是哪幾個
export function startupToastText(unread: readonly ForgeEvent[], project: string | null, names: ForgeNames): string | null {
  if (unread.length === 0) return null
  const elsewhereNames = unread.map(event => elsewhereName(event, project)).filter((name): name is string => name !== null)
  const here = unread.length - elsewhereNames.length
  const others = `（${[...new Set(elsewhereNames)].join('、')}）`
  const hint = `（/${names.command} 查看）`
  if (elsewhereNames.length === 0) return `${names.label} 有 ${here} 則未讀動態${hint}`
  if (here === 0) return `${names.label} 其他專案有 ${elsewhereNames.length} 則未讀動態${others}，到那個 repo 用 /${names.command} 查看`
  return `${names.label} 有 ${here} 則未讀動態${hint}，其他專案還有 ${elsewhereNames.length} 則${others}`
}

// 動態不在目前 repo、這裡打斜線指令看不到時，回傳要去的專案名稱；看得到時是 null
function elsewhereName(event: ForgeEvent, project: string | null): string | null {
  if (event.projectPath === null || inProject([event], project).length > 0) return null
  return projectName(event.projectPath)
}

// ── 註冊 ──────────────────────────────────────────────

export const register: Register = (on, options) => {
  gitlabBaseUrl = typeof options.gitlabUrl === 'string' ? options.gitlabUrl.trim().replace(/\/+$/, '') : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 名稱已被佔用時會被拒絕，不影響其他功能。
    // 說明是選單上的一行字，太長會被截斷，細節（標為已讀、只列這個 repo 的）由指令輸出自己講
    await $.command
      .register({
        name: 'gitlab',
        description: '檢查分支與 GitLab，列出未讀動態和還開著的 Task、Issue',
      })
      .catch(() => {})
    await $.command
      .register({
        name: 'github',
        description: '檢查分支與 GitHub，列出未讀動態和還開著的 Issue',
      })
      .catch(() => {})
    startTicking($)
    // 不等它跑完：git fetch 與平台輪詢可能要幾秒，別擋住第一個 prompt
    void runTick($, false).catch(() => {})
    return started
  })

  on('command.run', { command: 'gitlab' }, async $ => ({ text: await checkNow($, GITLAB) }))
  on('command.run', { command: 'github' }, async $ => ({ text: await checkNow($, GITHUB) }))

  // Claude 可能剛 commit、push 或切了分支，回合結束就更新一次（只讀本機，不 fetch）
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    void refreshAfterTurn($)
    return completed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // 其他 mod 與 Claude Code 畫在這裡的內容照樣保留
    if (e.props.hasSurvey) return rest
    const segments = bandSegments(await read($, repoSync), await read($, gitlabInbox), await read($, githubInbox))
    if (segments.length === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    const line = (
      <Text wrap="truncate-end">
        {segments.flatMap((segment, index) =>
          (segment.spans ?? [segment]).map((span, spanIndex) => (
            // 分隔符號跟著該段第一個片段的樣式
            <Text key={`segment-${index}-${spanIndex}`} color={span.color} dimColor={span.isDim} bold={span.isBold}>
              {`${index > 0 && spanIndex === 0 ? '  ·  ' : ''}${span.text}`}
            </Text>
          )),
        )}
      </Text>
    )
    return (
      <Box flexDirection="column">
        <Box key="gitlab-band" paddingX={BAND_PADDING_X}>
          {line}
        </Box>
        {rest}
      </Box>
    )
  })
}

async function refreshAfterTurn($: EngineInterface) {
  try {
    await refreshRepo($, false, await $.clock.now())
  } catch {
    // 下一次計時器還會再更新
  }
}
