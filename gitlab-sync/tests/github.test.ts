import { describe, expect, mock, test } from 'claude-code/testing'

import { githubRepoOf, linkUrl, timelineEvents, toItem, toOpenIssue, toTimelineEntries } from '../hooks/github'
import type { GithubItem } from '../hooks/github'
import { bandSegments } from '../hooks/register'
import type { InboxStatus, RepoSync } from '../types'

const GITLAB_URL = 'http://gitlab.test'
const OPTIONS = { options: { gitlabUrl: GITLAB_URL } }
const T0 = Date.parse('2026-10-08T03:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ME = { id: 112, login: 'alice' }
const OCTO = { id: 583, login: 'octocat' }
const ME_USER = { id: ME.id, username: ME.login }
const REPO_URL = 'https://api.github.com/repos/alice/notes-app'
const NO_INBOX: InboxStatus = { unreadCount: 0, problem: null, openCounts: null }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 200 }

const issueRaw = (number: number, title: string, user: typeof ME, assignees: (typeof ME)[] = [], extra: Record<string, unknown> = {}) => ({
  id: 9000 + number,
  number,
  title,
  state: 'open',
  html_url: `https://github.com/alice/notes-app/issues/${number}`,
  repository_url: REPO_URL,
  user,
  assignees,
  updated_at: iso(T0 - 3_600_000),
  ...extra,
})
const ISSUE_RAW = issueRaw(3, '報表數字對不上', ME)
const ISSUE = toItem(ISSUE_RAW) as GithubItem
const PR = toItem(issueRaw(5, 'feat: 加上匯出', ME, [], { pull_request: { merged_at: iso(T0 + 5_000) } })) as GithubItem

const commented = (id: number, user: typeof ME, body: string, at: number) => ({
  event: 'commented',
  id,
  user,
  actor: user,
  body,
  created_at: iso(at),
  html_url: `https://github.com/alice/notes-app/issues/3#issuecomment-${id}`,
})
const entries = (...raw: unknown[]) => raw.flatMap(toTimelineEntries)
const kinds = (item: GithubItem, raw: unknown[]) => timelineEvents(item, entries(...raw), T0, ME_USER).map(event => event.kind)

describe('解析 GitHub 回應', () => {
  test('remote 網址換成 owner/repo：https、SSH 都認，GitLab 或本機路徑不算', () => {
    expect(githubRepoOf('https://github.com/alice/notes-app.git')).toBe('alice/notes-app')
    expect(githubRepoOf('git@github.com:alice/notes-app.git\n')).toBe('alice/notes-app')
    expect(githubRepoOf('ssh://git@github.com/alice/notes-app')).toBe('alice/notes-app')
    expect(githubRepoOf('http://gitlab.example.com/acme/handbook.git')).toBe(null)
    expect(githubRepoOf('/Users/me/repos/local.git')).toBe(null)
  })

  test('issue 與 PR：從 repository_url 取得 owner/repo，PR 記下是否已合併；欄位不齊的略過', () => {
    expect(ISSUE).toMatchObject({ id: 9003, number: 3, repo: 'alice/notes-app', isMerged: false })
    expect(PR.isMerged).toBe(true)
    expect(toItem({ id: 1, number: 2 })).toBe(null)
  })

  test('還開著的 issue 只算 issue，不算 PR', () => {
    expect(toOpenIssue(ISSUE_RAW)).toMatchObject({ ref: 'notes-app#3', projectPath: 'alice/notes-app', author: ME_USER, assignees: [] })
    expect(toOpenIssue(issueRaw(5, 'PR', ME, [], { pull_request: { merged_at: null } }))).toBe(null)
  })

  test('分頁 Link header 取出指定 rel 的網址', () => {
    const header = '<https://api.github.com/repositories/1/issues/3/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/3/timeline?per_page=100&page=4>; rel="last"'
    expect(linkUrl(header, 'last')).toBe('https://api.github.com/repositories/1/issues/3/timeline?per_page=100&page=4')
    expect(linkUrl(undefined, 'last')).toBe(null)
  })
})

describe('判斷哪些 timeline 事件要通知', () => {
  test('別人的新留言要通知，自己的、起點之前的都不算；網址指到那則留言', () => {
    const events = timelineEvents(ISSUE, entries(commented(7001, OCTO, '我這邊也重現了', T0 + 60_000), commented(7002, ME, '我的回覆', T0 + 70_000), commented(7000, OCTO, '舊的', T0 - 60_000)), T0, ME_USER)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'comment-7001', kind: 'comment', actor: 'octocat', ref: 'notes-app#3', projectPath: 'alice/notes-app', excerpt: '我這邊也重現了' })
    expect(events[0]?.url).toBe('https://github.com/alice/notes-app/issues/3#issuecomment-7001')
  })

  test('指派與請求審查只算給我的；別人開 issue 時直接指派給我也算', () => {
    const at = iso(T0 + 1_000)
    expect(
      kinds(ISSUE, [
        { event: 'assigned', id: 1, actor: OCTO, assignee: ME, created_at: at },
        { event: 'assigned', id: 2, actor: OCTO, assignee: OCTO, created_at: at },
        { event: 'assigned', id: 3, actor: ME, assignee: ME, created_at: at },
        { event: 'review_requested', id: 4, actor: OCTO, requested_reviewer: ME, created_at: at },
        { event: 'review_requested', id: 5, actor: OCTO, requested_reviewer: OCTO, created_at: at },
        { event: 'labeled', id: 6, actor: OCTO, created_at: at },
      ]),
    ).toEqual(['assigned', 'review_requested'])
  })

  test('審查：核准、要求修改照通知；只有逐行意見的審查不另外通知，逐行意見拆成一則則留言', () => {
    const at = iso(T0 + 2_000)
    expect(
      kinds(PR, [
        { event: 'reviewed', id: 11, user: OCTO, state: 'approved', body: '', submitted_at: at },
        { event: 'reviewed', id: 12, user: OCTO, state: 'changes_requested', body: '', submitted_at: at },
        { event: 'reviewed', id: 13, user: OCTO, state: 'commented', body: '整體可以', submitted_at: at },
        { event: 'reviewed', id: 14, user: OCTO, state: 'commented', body: '', submitted_at: at },
        { event: 'line-commented', node_id: 'x', comments: [{ id: 21, user: OCTO, body: '這行要四捨五入', created_at: at, html_url: 'u21' }] },
      ]),
    ).toEqual(['approved', 'changes_requested', 'comment', 'comment'])
  })

  test('合併的 PR 只通知合併、不通知關閉；issue 被別人關閉要通知，自己關的不算', () => {
    const at = iso(T0 + 5_000)
    const mergeAndClose = [
      { event: 'merged', id: 31, actor: OCTO, created_at: at },
      { event: 'closed', id: 32, actor: OCTO, created_at: at },
    ]
    expect(kinds(PR, mergeAndClose)).toEqual(['merged'])
    expect(kinds(ISSUE, [{ event: 'closed', id: 33, actor: OCTO, created_at: at }])).toEqual(['closed'])
    expect(kinds(ISSUE, [{ event: 'closed', id: 34, actor: ME, created_at: at }])).toEqual([])
  })
})

describe('band', () => {
  const GITHUB_REPO: RepoSync = { branch: 'main', isDetached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirtyCount: 0, isFetchFailed: false, remoteHost: 'github.com', gitlabProject: null, githubRepo: 'alice/notes-app' }
  const GITLAB_REPO: RepoSync = { ...GITHUB_REPO, remoteHost: 'gitlab.example.com', gitlabProject: 'acme/handbook', githubRepo: null }
  const texts = (repo: RepoSync, gitlab: InboxStatus, github: InboxStatus) => bandSegments(repo, gitlab, github).map(segment => segment.text)

  test('在 GitHub repo 裡顯示 GitHub 的新動態與 Issue 張數；GitLab 的張數不顯示', () => {
    expect(texts(GITHUB_REPO, { ...NO_INBOX, openCounts: [{ kind: 'Task', count: 4 }, { kind: 'Issue', count: 9 }] }, { unreadCount: 1, problem: null, openCounts: [{ kind: 'Issue', count: 2 }] })).toEqual([
      'GitHub',
      '⎇ main',
      '✓ 已同步',
      'GitHub 1 則新動態（/github）',
      'Issue 2 張（/github）',
    ])
    expect(texts(GITHUB_REPO, NO_INBOX, { ...NO_INBOX, problem: 'HTTP 401' })).toEqual(['GitHub', '⎇ main', '✓ 已同步', 'GitHub 通知暫停（/github 看原因）'])
  })

  test('在 GitLab repo 裡 GitHub 的新動態照樣顯示，張數只顯示 GitLab 的（Task、Issue 分開）', () => {
    expect(texts(GITLAB_REPO, { ...NO_INBOX, openCounts: [{ kind: 'Task', count: 0 }, { kind: 'Issue', count: 0 }] }, { ...NO_INBOX, unreadCount: 2, openCounts: [{ kind: 'Issue', count: 5 }] })).toEqual([
      'GitLab',
      '⎇ main',
      '✓ 已同步',
      'GitHub 2 則新動態（/github）',
      'Task 0 張',
      'Issue 0 張（/gitlab）',
    ])
  })
})

// ── 整合情境：模擬 engine、git、gh 與 GitHub API ─────────────

type Request = { url: string; authorization: string | undefined }
type GithubRoute = (path: string, params: URLSearchParams, token: string) => { body: unknown; headers?: Record<string, string> } | 'unauthorized' | undefined

const processResult = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
})

// gh 回傳 ghToken（null 代表沒登入）；git 指令都當成在 GitHub 的 notes-app repo 裡、已同步；鑰匙圈是空的
function fakeCommands(on: any, gh: { token: string | null; reads: number }) {
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'gh') {
      gh.reads += 1
      return gh.token === null ? processResult(1, '') : processResult(0, `${gh.token}\n`)
    }
    if (argv[0] === 'security') return processResult(44, '')
    const args = argv.slice(4)
    if (args.includes('--show-toplevel')) return processResult(0, '/work-gh')
    if (args.includes('@{upstream}')) return processResult(0, 'origin/main')
    if (args.includes('--git-path')) return processResult(0, '/work-gh/.git/FETCH_HEAD')
    if (args[0] === 'symbolic-ref') return processResult(0, 'main')
    if (args[0] === 'fetch' || args[0] === 'status') return processResult(0, '')
    if (args[0] === 'rev-list') return processResult(0, '0\t0')
    if (args[0] === 'remote') return processResult(0, 'git@github.com:alice/notes-app.git')
    return processResult(1, '')
  })
}

// GitLab 那邊一律正常、沒有動態，測試只看 GitHub
function fakeHttp(on: any, route: GithubRoute, requests: Request[]) {
  on('http.fetch', (_$: any, e: any) => {
    const url = new URL(e.url)
    if (url.origin === GITLAB_URL) {
      const body = url.pathname === '/api/v4/user' ? { id: 6, username: 'alice' } : []
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    const authorization: string | undefined = e.init?.headers?.Authorization
    requests.push({ url: e.url, authorization })
    const result = route(url.pathname, url.searchParams, (authorization ?? '').replace('Bearer ', ''))
    if (result === 'unauthorized') return { value: { status: 401, ok: false, headers: {}, text: '{"message":"Bad credentials"}' } }
    if (result === undefined) return { value: { status: 404, ok: false, headers: {}, text: '{}' } }
    return { value: { status: 200, ok: true, headers: result.headers ?? {}, text: JSON.stringify(result.body) } }
  })
}

function captureToasts(on: any): string[] {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

async function start($: any, on: any) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work-gh' }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'GITLAB_TOKEN' ? 'gitlab-token' : undefined }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine draws' })
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work-gh' } as any)
}

const runGithub = async ($: any): Promise<string> => (await $.command.run({ command: 'github', args: '' } as any)).text

async function bandText($: any, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'gitlab-sync', surface, component: 'AbovePrompt', props: BAND_PROPS } as any)
  const texts: string[] = []
  const walk = (node: any) => {
    if (typeof node === 'string') texts.push(node)
    else if (node && typeof node === 'object') (Array.isArray(node) ? node : [node.children]).flat().forEach(walk)
  }
  walk(await ui.find({ type: 'Box' }))
  await ui.unmount()
  return texts.join('')
}

describe('整合情境', () => {
  test('別人回覆我的 issue：第一次只記起點，之後跳 toast、band 顯示新動態與 Issue 張數，/github 列出後標為已讀', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const gh = { token: 'gh-token' as string | null, reads: 0 }
    fakeCommands(on, gh)
    const requests: Request[] = []
    let timeline: unknown[] = []
    fakeHttp(
      on,
      (path, params) => {
        if (path === '/user') return { body: ME }
        if (path === '/issues') {
          if (params.get('state') === 'open') return { body: params.get('filter') === 'created' ? [ISSUE_RAW] : [] }
          return { body: params.get('filter') === 'created' && timeline.length > 0 ? [ISSUE_RAW] : [] }
        }
        if (path === '/search/issues') return { body: { total_count: 0, items: [] } }
        if (path === '/repos/alice/notes-app/issues/3/timeline') return { body: timeline }
        return undefined
      },
      requests,
    )

    await start($, on)
    await clock.advance(0)
    expect(await bandText($)).toContain('GitHub  ·  ⎇ main  ·  ✓ 已同步  ·  Issue 1 張（/github）')

    timeline = [commented(7001, OCTO, '我這邊也重現了', T0 + 60_000)]
    await clock.advance(3 * 60_000)
    expect(toasts).toContain('GitHub：octocat 在 notes-app#3 留言：我這邊也重現了')
    for (const surface of ['terminal', 'desktop'] as const) expect(await bandText($, surface)).toContain('GitHub 1 則新動態（/github）')

    const report = await runGithub($)
    expect(report).toContain('這個 repo（notes-app）裡 GitHub 新動態 1 則（已標為已讀）：')
    expect(report).toContain('octocat 在 notes-app#3 留言：我這邊也重現了')
    expect(report).toContain('https://github.com/alice/notes-app/issues/3#issuecomment-7001')
    expect(report).toContain('這個 repo（notes-app）裡你開的或指派給你、還開著的 Issue 1 張：\n• notes-app#3  報表數字對不上\n  你開的，還沒指派')
    expect(await bandText($)).not.toContain('則新動態')
    expect(await runGithub($)).toContain('這個 repo（notes-app）裡 GitHub 新動態 0 則。')

    // token 只走 Authorization header，網址裡沒有；只打 GitHub API
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.authorization === 'Bearer gh-token' && !request.url.includes('gh-token'))).toBe(true)
    expect(requests.every(request => request.url.startsWith('https://api.github.com/'))).toBe(true)
  })

  test('別人開 issue 指派給我、請我審查 PR：都會通知，PR 清單用搜尋查，timeline 超過一頁時讀最後兩頁', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on, { 'github.since': iso(T0) })
    captureToasts(on)
    const gh = { token: 'gh-token' as string | null, reads: 0 }
    fakeCommands(on, gh)
    const requests: Request[] = []
    const assignedIssue = issueRaw(4, '分頁算錯', OCTO, [ME])
    const pullRequest = issueRaw(6, 'feat: 加上快取', OCTO, [], { pull_request: { merged_at: null } })
    const timelinePages: Record<string, unknown[]> = {
      '1': [{ event: 'labeled', id: 40, actor: OCTO, created_at: iso(T0 - 600_000) }],
      '2': [{ event: 'review_requested', id: 41, actor: OCTO, requested_reviewer: ME, created_at: iso(T0 + 10_000) }],
      '3': [{ event: 'commented', id: 42, user: OCTO, actor: OCTO, body: '麻煩看一下快取策略', created_at: iso(T0 + 20_000), html_url: 'u42' }],
    }
    fakeHttp(
      on,
      (path, params) => {
        if (path === '/user') return { body: ME }
        if (path === '/issues') {
          if (params.get('state') === 'open') return { body: params.get('filter') === 'assigned' ? [assignedIssue] : [] }
          return { body: params.get('filter') === 'assigned' ? [assignedIssue] : [] }
        }
        if (path === '/search/issues') return { body: { items: (params.get('q') ?? '').includes('review-requested:@me') ? [pullRequest] : [] } }
        if (path === '/repos/alice/notes-app/issues/4/timeline') return { body: [{ event: 'assigned', id: 50, actor: OCTO, assignee: ME, created_at: iso(T0 + 5_000) }] }
        if (path === '/repos/alice/notes-app/issues/6/timeline') {
          const page = params.get('page') ?? '1'
          const last = 'https://api.github.com/repos/alice/notes-app/issues/6/timeline?per_page=100&page=3'
          const headers: Record<string, string> = page === '1' ? { link: `<${last.replace('page=3', 'page=2')}>; rel="next", <${last}>; rel="last"` } : {}
          return { body: timelinePages[page] ?? [], headers }
        }
        return undefined
      },
      requests,
    )

    await start($, on)
    const report = await runGithub($)
    expect(report).toContain('GitHub 新動態 3 則（已標為已讀）：')
    expect(report).toContain('octocat 把 notes-app#4 指派給你：分頁算錯')
    expect(report).toContain('octocat 請你審查 notes-app#6：feat: 加上快取')
    expect(report).toContain('octocat 在 notes-app#6 留言：麻煩看一下快取策略')
    // 別人開、指派給我的 issue 也算進還開著的張數
    expect(report).toContain('還開著的 Issue 1 張：\n• notes-app#4  分頁算錯\n  octocat 開的，指派給你')
    expect(requests.some(request => decodeURIComponent(request.url).includes('q=is:pr review-requested:@me updated:>=2026-10-08T02:58:00Z'))).toBe(true)
    const timelineUrls = requests.filter(request => request.url.includes('/issues/6/timeline')).map(request => new URL(request.url).searchParams.get('page'))
    // 啟動時一輪、/github 強制一輪：每輪都讀第一頁，再讀最後兩頁
    expect(timelineUrls).toEqual([null, '2', '3', null, '2', '3'])
  })

  test('這台電腦沒登入 gh：GitHub 部分整個不顯示、不算通知暫停，/github 說明怎麼開始', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const gh = { token: null as string | null, reads: 0 }
    fakeCommands(on, gh)
    const requests: Request[] = []
    fakeHttp(on, () => undefined, requests)

    await start($, on)
    await clock.advance(0)
    const band = await bandText($)
    expect(band).toContain('GitHub  ·  ⎇ main  ·  ✓ 已同步')
    expect(band).not.toContain('GitHub 通知暫停')
    expect(band).not.toContain('Issue ')
    expect(toasts.some(text => text.startsWith('GitHub'))).toBe(false)
    expect(await runGithub($)).toContain('GitHub：這台電腦沒有登入 gh，不檢查 GitHub（在終端機執行 gh auth login 後，下一輪就會開始）。')
    expect(requests).toEqual([])
  })

  test('GitHub 拒絕 token（401）時通知暫停並說明；重新登入 gh 換了 token，下一輪自動恢復', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const gh = { token: 'revoked-token' as string | null, reads: 0 }
    fakeCommands(on, gh)
    const requests: Request[] = []
    fakeHttp(
      on,
      (path, params, token) => {
        if (token !== 'fresh-token') return 'unauthorized'
        if (path === '/user') return { body: ME }
        if (path === '/issues') return { body: params.get('state') === 'open' && params.get('filter') === 'created' ? [ISSUE_RAW] : [] }
        return { body: { items: [] } }
      },
      requests,
    )

    await start($, on)
    await clock.advance(0)
    expect(await bandText($)).toContain('GitHub 通知暫停（/github 看原因）')
    expect(toasts).toContain('GitHub 通知暫停：GitHub token 無效或已過期（HTTP 401），在終端機執行 gh auth login 重新登入')

    gh.token = 'fresh-token'
    await clock.advance(2 * 60_000)
    const band = await bandText($)
    expect(band).not.toContain('通知暫停')
    expect(band).toContain('Issue 1 張（/github）')
    // 被拒絕後下一輪才重新向 gh 要 token，不是每輪都要
    expect(gh.reads).toBe(2)
  })
})
