import { describe, expect, mock, test } from 'claude-code/testing'

import { gitlabProjectOf, noteEvents, stateEvents, toItem, toNote, toOpenIssue } from '../hooks/gitlab'
import type { GitlabItem, GitlabNote } from '../hooks/gitlab'
import { bandSegments, remoteSegment, repoReport, startupToastText, toastText } from '../hooks/register'
import { clipColumns, describeEvent, excerptOf, formatAgo, inProject, openIssueLines, remoteHostOf } from '../hooks/shared'
import type { ForgeEvent } from '../hooks/shared'
import type { InboxStatus, RepoSync } from '../types'

const GITLAB_URL = 'http://gitlab.test'
const OPTIONS = { options: { gitlabUrl: `${GITLAB_URL}/` } }
const T0 = Date.parse('2026-10-08T03:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ME = { id: 6, username: 'alice' }
const BOB = { id: 9, username: 'bob' }
const NO_INBOX: InboxStatus = { unreadCount: 0, problem: null, openIssueCount: null }
const SYNCED: RepoSync = { branch: 'develop', isDetached: false, upstream: 'origin/develop', ahead: 0, behind: 0, dirtyCount: 0, isFetchFailed: false, remoteHost: 'gitlab.example.com', gitlabProject: 'acme/team/handbook', githubRepo: null }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160 }
const GITLAB_NAMES = { label: 'GitLab', command: 'gitlab' }

const ISSUE_RAW = {
  id: 47,
  iid: 5,
  project_id: 3,
  title: '登入頁面載入很慢',
  state: 'opened',
  web_url: `${GITLAB_URL}/acme/web/web-app/-/work_items/5`,
  references: { full: 'acme/web/web-app#5' },
  closed_at: null,
  closed_by: null,
  author: ME,
  assignees: [BOB],
  updated_at: iso(T0 - 26 * 3_600_000),
}
const ISSUE = toItem(ISSUE_RAW, 'issue') as GitlabItem

const note = (id: number, author: typeof ME, body: string, at: number, isSystem = false): GitlabNote => ({ id, author, body, createdAt: iso(at), isSystem })
const kinds = (events: readonly ForgeEvent[]) => events.map(event => event.kind)

describe('解析 GitLab 回應', () => {
  test('issue 的 ref 只留最後一段專案名稱，另外記下完整的專案路徑（MR 也是）', () => {
    expect(ISSUE.ref).toBe('web-app#5')
    expect(ISSUE.projectPath).toBe('acme/web/web-app')
    expect(toItem({ id: 88, iid: 3, project_id: 6, references: { full: 'acme/monitor!3' } }, 'mr')?.projectPath).toBe('acme/monitor')
    expect(toItem({ id: 88, iid: 3, project_id: 6 }, 'mr')?.projectPath).toBe(null)
    expect(ISSUE.projectId).toBe(3)
    expect(ISSUE.closed).toBe(null)
  })

  test('remote 網址換成 GitLab 專案路徑：三種寫法都認，別台主機或本機路徑不算', () => {
    const gitlabUrl = 'http://gitlab.example.com'
    expect(gitlabProjectOf('http://gitlab.example.com/acme/backend/api-server.git', gitlabUrl)).toBe('acme/backend/api-server')
    expect(gitlabProjectOf('https://oauth2:secret@gitlab.example.com:8443/acme/handbook/', gitlabUrl)).toBe('acme/handbook')
    expect(gitlabProjectOf('ssh://git@gitlab.example.com:2222/acme/monitor.git', gitlabUrl)).toBe('acme/monitor')
    expect(gitlabProjectOf('git@gitlab.example.com:acme/team/handbook.git\n', gitlabUrl)).toBe('acme/team/handbook')
    expect(gitlabProjectOf('git@github.com:someone/repo.git', gitlabUrl)).toBe(null)
    expect(gitlabProjectOf('http://gitlab.example.com.example.com/x/y.git', gitlabUrl)).toBe(null)
    expect(gitlabProjectOf('/Users/me/repos/local.git', gitlabUrl)).toBe(null)
  })

  test('remote 的主機名稱：三種寫法都認，本機路徑不算主機', () => {
    expect(remoteHostOf('http://gitlab.example.com/acme/handbook.git')).toBe('gitlab.example.com')
    expect(remoteHostOf('https://GitHub.com/someone/repo.git')).toBe('github.com')
    expect(remoteHostOf('git@github.com:someone/repo.git\n')).toBe('github.com')
    expect(remoteHostOf('ssh://git@bitbucket.org:22/team/repo.git')).toBe('bitbucket.org')
    expect(remoteHostOf('/Users/me/repos/local.git')).toBe(null)
    expect(remoteHostOf('../local.git')).toBe(null)
  })

  test('欄位不齊的資料直接略過', () => {
    expect(toItem({ id: 1, title: 'x' }, 'issue')).toBe(null)
    expect(toNote({ id: 1, body: 'x' })).toBe(null)
    expect(toNote({ id: 1, body: 'x', system: true, created_at: iso(T0), author: BOB })).toEqual(note(1, BOB, 'x', T0, true))
  })
})

describe('判斷哪些留言要通知', () => {
  test('別人的新留言要通知，自己的、起點之前的都不算', () => {
    const notes = [note(3, BOB, '謝謝回報', T0 + 60_000), note(2, ME, '我自己的回覆', T0 + 30_000), note(1, BOB, '舊留言', T0 - 60_000)]
    const events = noteEvents(ISSUE, notes, T0, ME)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'note-3', kind: 'comment', actor: 'bob', ref: 'web-app#5', excerpt: '謝謝回報' })
    expect(events[0]?.url).toBe(`${ISSUE.url}#note_3`)
  })

  test('系統留言只挑指派給我、請我審查與核准，給別人的或 mentioned in commit 都略過', () => {
    const notes = [
      note(4, BOB, 'assigned to @alice and unassigned @bob', T0 + 1_000, true),
      note(5, BOB, 'assigned to @bob', T0 + 2_000, true),
      note(6, BOB, 'approved this merge request', T0 + 3_000, true),
      note(7, BOB, 'mentioned in commit 793a70ba', T0 + 4_000, true),
      note(8, BOB, 'assigned to @aliceJr', T0 + 5_000, true),
      note(9, BOB, 'requested review from @alice and @bob', T0 + 6_000, true),
      note(10, BOB, 'requested review from @bob', T0 + 7_000, true),
      note(11, BOB, 'removed review request for @alice', T0 + 8_000, true),
    ]
    expect(kinds(noteEvents(ISSUE, notes, T0, ME))).toEqual(['assigned', 'approved', 'review_requested'])
  })

  test('關閉與合併看執行的人：別人做的才通知，起點之前的不算', () => {
    const closedByCary = { ...ISSUE, state: 'closed', closed: { at: iso(T0 + 1_000), by: BOB } }
    const closedByMe = { ...ISSUE, state: 'closed', closed: { at: iso(T0 + 1_000), by: ME } }
    const closedLongAgo = { ...ISSUE, state: 'closed', closed: { at: iso(T0 - 1_000), by: BOB } }
    const mergedByCary = { ...ISSUE, type: 'mr' as const, state: 'merged', merged: { at: iso(T0 + 2_000), by: BOB } }
    expect(kinds(stateEvents(closedByCary, T0, ME))).toEqual(['closed'])
    expect(stateEvents(closedByMe, T0, ME)).toEqual([])
    expect(stateEvents(closedLongAgo, T0, ME)).toEqual([])
    expect(kinds(stateEvents(mergedByCary, T0, ME))).toEqual(['merged'])
    // 重新打開過的 issue 還留著舊的 closed_at，但 state 不是 closed，不算
    expect(stateEvents({ ...closedByCary, state: 'opened' }, T0, ME)).toEqual([])
  })
})

describe('文字與畫面', () => {
  test('留言摘要去掉 Markdown 壓成一行，太長依顯示寬度截斷', () => {
    expect(excerptOf('**一、原因**\n\n見 [說明](http://x/y) 與 ![圖](a.png)')).toBe('一、原因 見 說明 與 [圖片]')
    expect(clipColumns('一二三四五', 6)).toBe('一二…')
    expect(clipColumns('abc', 3)).toBe('abc')
  })

  test('時間用相對說法，不受時區影響', () => {
    expect(formatAgo(T0, iso(T0 - 20_000))).toBe('剛剛')
    expect(formatAgo(T0, iso(T0 - 5 * 60_000))).toBe('5 分鐘前')
    expect(formatAgo(T0, iso(T0 - 3 * 3_600_000))).toBe('3 小時前')
    expect(formatAgo(T0, iso(T0 - 50 * 3_600_000))).toBe('2 天前')
  })

  test('toast：一則直接寫內容，多則寫數量與最新一則', () => {
    const comment: ForgeEvent = { id: 'note-1', kind: 'comment', actor: 'bob', ref: 'handbook#29', projectPath: 'acme/team/handbook', title: 't', excerpt: '好', url: 'u', at: iso(T0) }
    const assigned: ForgeEvent = { ...comment, id: 'note-2', kind: 'assigned', title: '部署圖' }
    expect(toastText([comment], null, GITLAB_NAMES)).toBe('GitLab：bob 在 handbook#29 留言：好')
    expect(toastText([comment, assigned], null, GITLAB_NAMES)).toBe('GitLab 2 則新動態，最新：bob 把 handbook#29 指派給你：部署圖（/gitlab 查看）')
    expect(describeEvent({ ...comment, kind: 'merged', title: 'Feat' })).toBe('bob 合併了 handbook#29：Feat')
    expect(describeEvent({ ...comment, kind: 'review_requested', title: 'Feat' })).toBe('bob 請你審查 handbook#29：Feat')
  })

  test('toast：別的專案的動態照跳，寫明到哪個 repo 看；太長時截內容、提示留著', () => {
    const HERE = 'acme/web/web-app'
    const site: ForgeEvent = { id: 'note-3', kind: 'comment', actor: 'bob', ref: 'web-app#5', projectPath: HERE, title: 't', excerpt: '謝謝', url: 'u', at: iso(T0) }
    const l1: ForgeEvent = { ...site, id: 'note-1', ref: 'handbook#29', projectPath: 'acme/team/handbook', excerpt: '好' }
    expect(toastText([site], HERE, GITLAB_NAMES)).toBe('GitLab：bob 在 web-app#5 留言：謝謝')
    expect(toastText([l1], HERE, GITLAB_NAMES)).toBe('GitLab：bob 在 handbook#29 留言：好（到 handbook 用 /gitlab 查看）')
    expect(toastText([site, l1], HERE, GITLAB_NAMES)).toBe('GitLab 2 則新動態，最新：bob 在 handbook#29 留言：好（到 handbook 用 /gitlab 查看）')
    expect(toastText([l1, site], HERE, GITLAB_NAMES)).toBe('GitLab 2 則新動態，最新：bob 在 web-app#5 留言：謝謝（/gitlab 查看）')
    const long = toastText([{ ...l1, excerpt: '很長的留言'.repeat(20) }], HERE, GITLAB_NAMES)
    expect(long.endsWith('…（到 handbook 用 /gitlab 查看）')).toBe(true)
    expect(clipColumns(long, 100)).toBe(long)
  })

  test('啟動時的未讀彙總：目前 repo 的與其他專案的分開算，其他專案寫出名稱', () => {
    const HERE = 'acme/team/handbook'
    const comment: ForgeEvent = { id: 'note-1', kind: 'comment', actor: 'bob', ref: 'handbook#29', projectPath: HERE, title: 't', excerpt: '好', url: 'u', at: iso(T0) }
    const site: ForgeEvent = { ...comment, id: 'note-3', projectPath: 'acme/web/web-app' }
    const monitor: ForgeEvent = { ...comment, id: 'note-4', projectPath: 'acme/monitor' }
    expect(startupToastText([], HERE, GITLAB_NAMES)).toBe(null)
    expect(startupToastText([comment], HERE, GITLAB_NAMES)).toBe('GitLab 有 1 則未讀動態（/gitlab 查看）')
    expect(startupToastText([site, { ...site, id: 'note-5' }], HERE, GITLAB_NAMES)).toBe('GitLab 其他專案有 2 則未讀動態（web-app），到那個 repo 用 /gitlab 查看')
    expect(startupToastText([comment, site, monitor], HERE, GITLAB_NAMES)).toBe('GitLab 有 1 則未讀動態（/gitlab 查看），其他專案還有 2 則（web-app、monitor）')
    expect(startupToastText([site, monitor], null, GITLAB_NAMES)).toBe('GitLab 有 2 則未讀動態（/gitlab 查看）')
  })

  test('band 各種同步狀態的文字與顏色', () => {
    const texts = (repo: RepoSync | null, inbox = NO_INBOX) => bandSegments(repo, inbox).map(segment => segment.text)
    expect(texts(SYNCED)).toEqual(['GitLab', '⎇ develop', '✓ 已同步'])
    expect(texts({ ...SYNCED, ahead: 1, dirtyCount: 3 })).toEqual(['GitLab', '⎇ develop', '↑1 待 push', '3 個檔案未提交'])
    expect(texts({ ...SYNCED, behind: 2, isFetchFailed: true })).toEqual(['GitLab', '⎇ develop', '↓2 待 pull（fetch 失敗，依快取）'])
    expect(bandSegments({ ...SYNCED, ahead: 1, behind: 2 }, NO_INBOX)[2]).toMatchObject({ text: '↑1 ↓2 分岔', color: 'error' })
    expect(texts({ ...SYNCED, upstream: null })).toEqual(['GitLab', '⎇ develop', '沒有遠端分支（還沒 push？）'])
    expect(texts({ ...SYNCED, branch: 'a1b2c3d', isDetached: true, upstream: null })).toEqual(['GitLab', '⎇ a1b2c3d（detached）'])
    expect(texts(null, { ...NO_INBOX, unreadCount: 2 })).toEqual(['GitLab 2 則新動態（/gitlab）'])
    expect(texts(null, { ...NO_INBOX, problem: '連不上' })).toEqual(['GitLab 通知暫停（/gitlab 看原因）'])
    expect(texts(null)).toEqual([])
  })

  test('band 的還開著的 issue 張數：排在最後，0 張也顯示，還沒查到時不顯示；數字 0 張綠色、有張數紅色', () => {
    const texts = (repo: RepoSync | null, inbox: InboxStatus) => bandSegments(repo, inbox).map(segment => segment.text)
    expect(texts(SYNCED, { ...NO_INBOX, openIssueCount: 1 })).toEqual(['GitLab', '⎇ develop', '✓ 已同步', 'Issue 1 張（/gitlab）'])
    expect(texts({ ...SYNCED, dirtyCount: 2 }, { ...NO_INBOX, unreadCount: 3, openIssueCount: 4 })).toEqual([
      'GitLab',
      '⎇ develop',
      '✓ 已同步',
      '2 個檔案未提交',
      'GitLab 3 則新動態（/gitlab）',
      'Issue 4 張（/gitlab）',
    ])
    expect(texts(SYNCED, { ...NO_INBOX, openIssueCount: 0 })).toEqual(['GitLab', '⎇ develop', '✓ 已同步', 'Issue 0 張（/gitlab）'])
    expect(texts(SYNCED, NO_INBOX)).toEqual(['GitLab', '⎇ develop', '✓ 已同步'])
    const issueSegment = (count: number) => bandSegments(SYNCED, { ...NO_INBOX, openIssueCount: count }).at(-1)
    expect(issueSegment(0)?.spans).toEqual([
      { text: 'Issue ', isDim: true },
      { text: '0', color: 'success', isBold: true },
      { text: ' 張（/gitlab）', isDim: true },
    ])
    expect(issueSegment(3)?.spans?.[1]).toEqual({ text: '3', color: 'error', isBold: true })
  })

  test('band 最前面標示來源：設定的 GitLab、GitHub、本機或主機名稱；不在設定的 GitLab 專案時不顯示 Issue 張數，新動態照常', () => {
    const texts = (repo: RepoSync | null, inbox: InboxStatus) => bandSegments(repo, inbox).map(segment => segment.text)
    const github: RepoSync = { ...SYNCED, remoteHost: 'github.com', gitlabProject: null }
    const local: RepoSync = { ...SYNCED, upstream: null, remoteHost: null, gitlabProject: null }
    const bitbucket: RepoSync = { ...SYNCED, remoteHost: 'bitbucket.org', gitlabProject: null }
    expect(remoteSegment(SYNCED).text).toBe('GitLab')
    expect(texts(github, { ...NO_INBOX, openIssueCount: 3 })).toEqual(['GitHub', '⎇ develop', '✓ 已同步'])
    expect(texts(local, { ...NO_INBOX, openIssueCount: 3 })).toEqual(['本機', '⎇ develop', '沒有遠端分支（還沒 push？）'])
    expect(texts(bitbucket, { ...NO_INBOX, openIssueCount: 3 })).toEqual(['bitbucket.org', '⎇ develop', '✓ 已同步'])
    expect(texts(github, { ...NO_INBOX, unreadCount: 2, openIssueCount: 3 })).toEqual(['GitHub', '⎇ develop', '✓ 已同步', 'GitLab 2 則新動態（/gitlab）'])
    // 不在 repo 的目錄也一樣：張數是全部專案加總，不顯示
    expect(texts(null, { ...NO_INBOX, openIssueCount: 3 })).toEqual([])
  })

  test('來源標示的顏色：GitLab Claude 橘、GitHub 主題文字色（深色主題是白色）、本機與其他主機暗色', () => {
    const style = (repo: RepoSync) => {
      const { text, color, isDim } = bandSegments(repo, NO_INBOX)[0] ?? {}
      return { text, color, isDim }
    }
    expect(style(SYNCED)).toEqual({ text: 'GitLab', color: 'claude', isDim: undefined })
    expect(style({ ...SYNCED, remoteHost: 'github.com', gitlabProject: null })).toEqual({ text: 'GitHub', color: 'text', isDim: undefined })
    expect(style({ ...SYNCED, remoteHost: null, gitlabProject: null })).toEqual({ text: '本機', color: undefined, isDim: true })
    expect(style({ ...SYNCED, remoteHost: 'bitbucket.org', gitlabProject: null })).toEqual({ text: 'bitbucket.org', color: undefined, isDim: true })
  })

  test('還開著的 issue：寫出誰開的、指派給誰；一張都沒有時寫 0 張', () => {
    const issue = toOpenIssue(ISSUE_RAW)
    expect(issue).toMatchObject({ ref: 'web-app#5', author: ME, assignees: [BOB] })
    expect(toOpenIssue({ ...ISSUE_RAW, author: null })).toBe(null)
    const unassigned = toOpenIssue({ ...ISSUE_RAW, assignees: [] })
    expect(openIssueLines([issue!, unassigned!], ME, T0, null)).toEqual([
      '你開的或指派給你、還開著的 issue 2 張：',
      `• web-app#5  ${ISSUE_RAW.title}`,
      '  你開的，指派給 bob，1 天前更新',
      `  ${ISSUE_RAW.web_url}`,
      `• web-app#5  ${ISSUE_RAW.title}`,
      '  你開的，還沒指派，1 天前更新',
      `  ${ISSUE_RAW.web_url}`,
    ])
    expect(openIssueLines([], ME, T0, null)).toEqual(['你開的或指派給你、還開著的 issue 0 張。'])
  })

  test('在 GitLab 專案的 repo 裡只列這個專案的 issue，路徑不分大小寫，不知道專案的照列；這個專案沒有時寫 0 張', () => {
    const site = toOpenIssue(ISSUE_RAW)!
    const device = toOpenIssue({ ...ISSUE_RAW, id: 60, iid: 2, references: { full: 'acme/backend/api-server#2' } })!
    const noPath = toOpenIssue({ ...ISSUE_RAW, id: 61, references: null })!
    expect(site.projectPath).toBe('acme/web/web-app')
    expect(noPath.projectPath).toBe(null)
    expect(inProject([site, device, noPath], 'Acme/Backend/api-server')).toEqual([device, noPath])
    expect(inProject([site, device, noPath], null)).toEqual([site, device, noPath])
    expect(openIssueLines([site, device], ME, T0, 'acme/web/web-app')).toEqual([
      '這個 repo（web-app）裡你開的或指派給你、還開著的 issue 1 張：',
      `• web-app#5  ${ISSUE_RAW.title}`,
      '  你開的，指派給 bob，1 天前更新',
      `  ${ISSUE_RAW.web_url}`,
    ])
    expect(openIssueLines([site, device], ME, T0, 'acme/team/handbook')).toEqual(['這個 repo（handbook）裡你開的或指派給你、還開著的 issue 0 張。'])
  })

  test('/gitlab 的分支說明', () => {
    expect(repoReport(null)).toBe('目前目錄不是 git repo（或還沒有任何 commit）。')
    expect(repoReport({ ...SYNCED, behind: 2, dirtyCount: 1 })).toBe('分支 develop（比對 origin/develop）：↓2 待 pull，1 個檔案未提交')
  })
})

// ── 整合情境：模擬 engine、git 與 GitLab ─────────────────────

// remotes：remote 名稱對網址；沒給時 git remote get-url 失敗，等於不在 GitLab 專案裡
type FakeRepo = { root: string; branch: string; upstream: string; counts: string; status: string; remotes?: Record<string, string> }
// 鑰匙圈裡的 token 可以中途換掉；reads 記下每次 security 指令的 argv
type FakeKeychain = { token: string | null; reads: string[][] }
// route 回傳 UNAUTHORIZED 代表 GitLab 拒絕這個 token（HTTP 401）
const UNAUTHORIZED = Symbol('401')
type GitlabRoute = (path: string, scope: string | null, state: string | null, token: string | undefined) => unknown

// $ 呼叫（process.run、env.get…）的 stub 要包成 { value }；engine 事件（session.start…）直接回傳結果形狀
const processResult = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
})

function engine(on: any) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', () => ({ value: { command: 'gitlab' } }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine draws' })
  })
}

// 所有 process.run 都在這裡回應，測試不會真的去讀這台電腦的鑰匙圈；沒給 keychain 時鑰匙圈是空的
function fakeCommands(on: any, repo: () => FakeRepo, keychain: FakeKeychain = { token: null, reads: [] }) {
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'security') {
      keychain.reads.push([...e.argv])
      // 找不到項目時 security 的結束碼是 44
      return keychain.token === null ? processResult(44, '') : processResult(0, `${keychain.token}\n`)
    }
    // argv 是 git --no-optional-locks -C <目錄> <子指令> ...
    const args: string[] = e.argv.slice(4)
    const current = repo()
    const ok = (stdout: string) => processResult(0, stdout)
    if (args.includes('--show-toplevel')) return ok(current.root)
    if (args.includes('@{upstream}')) return ok(current.upstream)
    if (args.includes('--git-path')) return ok(`${current.root}/.git/FETCH_HEAD`)
    if (args[0] === 'symbolic-ref') return ok(current.branch)
    if (args[0] === 'fetch') return ok('')
    if (args[0] === 'rev-list') return ok(current.counts)
    if (args[0] === 'status') return ok(current.status)
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const remoteUrl = current.remotes?.[args[2] ?? '']
      return remoteUrl === undefined ? processResult(2, '') : ok(remoteUrl)
    }
    return processResult(1, '')
  })
}

// 記下每個請求，順便確認 token 只走 header
function fakeGitlab(on: any, route: GitlabRoute, requests: { url: string; token: string | undefined }[] = []) {
  on('http.fetch', (_$: any, e: any) => {
    const token: string | undefined = e.init?.headers?.['PRIVATE-TOKEN']
    requests.push({ url: e.url, token })
    const url = new URL(e.url)
    const body = route(url.pathname.replace('/api/v4', ''), url.searchParams.get('scope'), url.searchParams.get('state'), token)
    if (body === UNAUTHORIZED) return { value: { status: 401, ok: false, headers: {}, text: '{"message":"401 Unauthorized"}' } }
    return { value: body === undefined ? { status: 404, ok: false, headers: {}, text: '{}' } : { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
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

// 只回應給定的環境變數，其他都是空的
function fakeEnv(on: any, values: Record<string, string>) {
  on('env.get', (_$: any, e: any) => ({ value: values[e.name] }))
}

// 只接受 fresh-token 的 GitLab：其他 token 一律 401
const acceptsFreshTokenOnly: GitlabRoute = (path, _scope, _state, token) => (token !== 'fresh-token' ? UNAUTHORIZED : path === '/user' ? ME : [])

async function start($: any, on: any) {
  engine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
}

const runGitlab = async ($: any): Promise<string> => (await $.command.run({ command: 'gitlab', args: '' } as any)).text

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
  test('第一次只記下起點；之後別人留言會跳 toast、band 顯示未讀，/gitlab 列出後標為已讀', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const requests: { url: string; token: string | undefined }[] = []
    on('env.get', (_$: any, e: any) => ({ value: e.name === 'GITLAB_TOKEN' ? 'test-token' : undefined }))
    fakeCommands(on,() => ({ root: '/work-a', branch: 'develop', upstream: 'origin/develop', counts: '0\t0', status: '' }))
    let notes: unknown[] = []
    fakeGitlab(
      on,
      (path, scope) => {
        if (path === '/user') return ME
        if (path === '/issues') return scope === 'created_by_me' && notes.length > 0 ? [ISSUE_RAW] : []
        if (path === '/merge_requests') return []
        if (path === '/projects/3/issues/5/notes') return notes
        return undefined
      },
      requests,
    )

    await start($, on)
    expect(await runGitlab($)).toBe('分支 develop（比對 origin/develop）：✓ 已同步，沒有未提交的檔案\nGitLab 新動態 0 則。\n你開的或指派給你、還開著的 issue 0 張。')

    notes = [{ id: 9551, system: false, body: '謝謝回報，查清楚了。', created_at: iso(T0 + 60_000), author: BOB }]
    await clock.advance(3 * 60_000) // 背景每分鐘一輪，GitLab 每兩分鐘輪詢一次
    expect(toasts).toContain('GitLab：bob 在 web-app#5 留言：謝謝回報，查清楚了。')
    for (const surface of ['terminal', 'desktop'] as const) expect(await bandText($, surface)).toContain('GitLab 1 則新動態（/gitlab）')

    const report = await runGitlab($)
    expect(report).toContain('GitLab 新動態 1 則（已標為已讀）：')
    expect(report).toContain('bob 在 web-app#5 留言：謝謝回報，查清楚了。')
    expect(report).toContain(`${ISSUE_RAW.web_url}#note_9551`)
    expect(await bandText($)).not.toContain('則新動態')
    expect(await runGitlab($)).toContain('GitLab 新動態 0 則。')

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.token === 'test-token' && !request.url.includes('test-token'))).toBe(true)
    expect(requests.every(request => request.url.startsWith(`${GITLAB_URL}/api/v4/`))).toBe(true)
  })

  test('被指定為 reviewer 的 MR：別人請我審查與留言都會通知，清單用 reviews_for_me 查', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on, { since: iso(T0) })
    const requests: { url: string; token: string | undefined }[] = []
    on('env.get', () => ({ value: 'test-token' }))
    fakeCommands(on,() => ({ root: '/work-d', branch: 'develop', upstream: 'origin/develop', counts: '0\t0', status: '' }))
    const mergeRequest = {
      id: 88,
      iid: 3,
      project_id: 6,
      title: 'Feat: 新增匯出',
      state: 'opened',
      web_url: `${GITLAB_URL}/acme/monitor/-/merge_requests/3`,
      references: { full: 'acme/monitor!3' },
    }
    const notes = [
      { id: 9702, system: false, body: '麻煩幫忙看匯出格式', created_at: iso(T0 + 60_000), author: BOB },
      { id: 9701, system: true, body: 'requested review from @alice', created_at: iso(T0 + 30_000), author: BOB },
    ]
    fakeGitlab(
      on,
      (path, scope) => {
        if (path === '/user') return ME
        if (path === '/merge_requests') return scope === 'reviews_for_me' ? [mergeRequest] : []
        if (path === '/issues') return []
        if (path === '/projects/6/merge_requests/3/notes') return notes
        return undefined
      },
      requests,
    )

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('GitLab 新動態 2 則（已標為已讀）：')
    expect(report).toContain('bob 請你審查 monitor!3：Feat: 新增匯出')
    expect(report).toContain('bob 在 monitor!3 留言：麻煩幫忙看匯出格式')
    expect(requests.some(request => request.url.includes('/merge_requests?scope=reviews_for_me&'))).toBe(true)
  })

  test('/gitlab 列出自己開的或指派給自己、還開著的 issue：兩個範圍合併去重，最近更新的在前', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    const requests: { url: string; token: string | undefined }[] = []
    on('env.get', () => ({ value: 'test-token' }))
    fakeCommands(on,() => ({ root: '/work-e', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }))
    const issueRaw = (iid: number, title: string, author: typeof ME, assignees: (typeof ME)[], updatedAt: number) => ({
      ...ISSUE_RAW,
      id: 100 + iid,
      iid,
      title,
      author,
      assignees,
      updated_at: iso(updatedAt),
      web_url: `${GITLAB_URL}/acme/web/web-app/-/work_items/${iid}`,
      references: { full: `acme/web/web-app#${iid}` },
    })
    const assignedToMe = issueRaw(7, '請幫忙驗證付款流程', BOB, [ME, { id: 12, username: 'carol' }], T0 - 3_600_000)
    const mineAndAssignedToMe = issueRaw(8, '自己記的待辦', ME, [ME], T0 - 60_000)
    fakeGitlab(
      on,
      (path, scope, state) => {
        if (path === '/user') return ME
        if (path === '/merge_requests') return []
        if (path !== '/issues') return undefined
        // 已關閉的不該出現：只回應 state=opened 的查詢
        if (state !== 'opened') return []
        if (scope === 'created_by_me') return [ISSUE_RAW, mineAndAssignedToMe]
        if (scope === 'assigned_to_me') return [assignedToMe, mineAndAssignedToMe]
        return []
      },
      requests,
    )

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('GitLab 新動態 0 則。\n你開的或指派給你、還開著的 issue 3 張：')
    expect([...report.matchAll(/^• (\S+)/gm)].map(match => match[1])).toEqual(['web-app#8', 'web-app#7', 'web-app#5'])
    expect(report).toContain('• web-app#8  自己記的待辦\n  你開的，指派給你，1 分鐘前更新')
    expect(report).toContain('• web-app#7  請幫忙驗證付款流程\n  bob 開的，指派給你、carol，1 小時前更新')
    expect(report).toContain('  你開的，指派給 bob，1 天前更新')
    expect(report).toContain(`${GITLAB_URL}/acme/web/web-app/-/work_items/7`)
    for (const scope of ['created_by_me', 'assigned_to_me']) {
      expect(requests.some(request => request.url.includes(`/issues?scope=${scope}&state=opened&`))).toBe(true)
    }
    // 沒有 remote 的 repo：band 標「本機」，不顯示全部專案加總的張數
    const band = await bandText($)
    expect(band).toContain('本機  ·  ⎇ main  ·  ✓ 已同步')
    expect(band).not.toContain('Issue ')
  })

  test('在 GitLab 專案的 repo 裡只列這個專案的 issue，band 張數也只算這個專案；換 repo 時回合結束就跟著換', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    on('env.get', () => ({ value: 'test-token' }))
    on('turn.complete', () => ({ text: '' }))
    // 遠端分支在 gitlab 這個 remote 上，不是 origin；SSH 寫法、路徑大小寫跟 GitLab 不同也要認得
    const siteRepo: FakeRepo = { root: '/work-k', branch: 'main', upstream: 'gitlab/main', counts: '0\t0', status: '', remotes: { gitlab: 'git@gitlab.test:Acme/Web/web-app.git' } }
    let repo = siteRepo
    fakeCommands(on, () => repo)
    const deviceIssue = {
      ...ISSUE_RAW,
      id: 60,
      iid: 2,
      title: 'API 的待辦',
      web_url: `${GITLAB_URL}/acme/backend/api-server/-/work_items/2`,
      references: { full: 'acme/backend/api-server#2' },
    }
    fakeGitlab(on, (path, scope, state) => {
      if (path === '/user') return ME
      if (path !== '/issues' || state !== 'opened') return []
      return scope === 'created_by_me' ? [ISSUE_RAW, deviceIssue] : []
    })

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('這個 repo（web-app）裡你開的或指派給你、還開著的 issue 1 張：\n• web-app#5')
    expect(report).not.toContain('api-server')
    expect(await bandText($)).toContain('Issue 1 張（/gitlab）')

    // 換到一張都沒有的專案：回合結束只讀本機就重算，不必等下一次輪詢
    repo = { ...siteRepo, root: '/work-l', remotes: { gitlab: `${GITLAB_URL}/acme/team/handbook.git` } }
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1 } as any)
    await clock.advance(0)
    expect(await bandText($)).toContain('Issue 0 張（/gitlab）')
    expect(await runGitlab($)).toContain('這個 repo（handbook）裡你開的或指派給你、還開著的 issue 0 張。')

    // remote 在 GitHub：/gitlab 不分專案全部列；band 標 GitHub、不顯示張數
    repo = { ...siteRepo, root: '/work-m', remotes: { gitlab: 'git@github.com:someone/repo.git' } }
    const all = await runGitlab($)
    expect(all).toContain('\n你開的或指派給你、還開著的 issue 2 張：')
    const githubBand = await bandText($)
    expect(githubBand).toContain('GitHub  ·  ⎇ main')
    expect(githubBand).not.toContain('Issue ')
  })

  test('在 GitLab 專案的 repo 裡未讀動態只列、只標已讀這個專案的，band 則數也只算這個專案；別的專案照跳 toast 並寫明去哪看', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    // 舊版存下、沒有 projectPath 的未讀動態：不知道是哪個專案，每個 repo 都列得到
    const legacy = { id: 'note-1', kind: 'comment', actor: 'bob', ref: 'old#1', title: '舊', excerpt: '舊留言', url: 'u-legacy', at: iso(T0 - 60_000) }
    mock.store(on, { since: iso(T0), unread: [legacy] })
    const toasts = captureToasts(on)
    on('env.get', () => ({ value: 'test-token' }))
    on('turn.complete', () => ({ text: '' }))
    const deviceRepo: FakeRepo = { root: '/work-n', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '', remotes: { origin: `${GITLAB_URL}/acme/backend/api-server.git` } }
    let repo = deviceRepo
    fakeCommands(on, () => repo)
    const mergeRequest = {
      id: 88,
      iid: 3,
      project_id: 7,
      title: 'Feat: 加上重試',
      state: 'opened',
      web_url: `${GITLAB_URL}/acme/backend/api-server/-/merge_requests/3`,
      references: { full: 'acme/backend/api-server!3' },
    }
    let siteNotes: unknown[] = []
    let mrNotes: unknown[] = []
    fakeGitlab(on, (path, scope, state) => {
      if (path === '/user') return ME
      if (path === '/issues') return scope === 'created_by_me' && state === 'all' ? [ISSUE_RAW] : []
      if (path === '/merge_requests') return scope === 'created_by_me' ? [mergeRequest] : []
      if (path === '/projects/3/issues/5/notes') return siteNotes
      if (path === '/projects/7/merge_requests/3/notes') return mrNotes
      return undefined
    })

    await start($, on)
    await clock.advance(0)
    expect(toasts).toContain('GitLab 有 1 則未讀動態（/gitlab 查看）')

    // 別的專案有人留言：照跳 toast，寫明要到哪個 repo 看；這裡的 band 則數不變
    siteNotes = [{ id: 9551, system: false, body: '謝謝回報', created_at: iso(T0 + 60_000), author: BOB }]
    await clock.advance(2 * 60_000)
    expect(toasts).toContain('GitLab：bob 在 web-app#5 留言：謝謝回報（到 web-app 用 /gitlab 查看）')
    expect(await bandText($)).toContain('GitLab 1 則新動態（/gitlab）')

    mrNotes = [{ id: 9601, system: false, body: '看起來可以', created_at: iso(T0 + 180_000), author: BOB }]
    await clock.advance(2 * 60_000)
    expect(toasts).toContain('GitLab：bob 在 api-server!3 留言：看起來可以')
    expect(await bandText($)).toContain('GitLab 2 則新動態（/gitlab）')

    const report = await runGitlab($)
    expect(report).toContain('這個 repo（api-server）裡 GitLab 新動態 2 則（已標為已讀）：')
    expect(report).toContain('bob 在 api-server!3 留言：看起來可以')
    expect(report).toContain('bob 在 old#1 留言：舊留言')
    expect(report).not.toContain('web-app#5')
    expect(await bandText($)).not.toContain('則新動態')
    expect(await runGitlab($)).toContain('這個 repo（api-server）裡 GitLab 新動態 0 則。')

    // 別的專案的那則還沒讀：換到那個 repo，回合結束就算進 band，/gitlab 列得到
    repo = { ...deviceRepo, root: '/work-o', remotes: { origin: `${GITLAB_URL}/acme/web/web-app.git` } }
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1 } as any)
    await clock.advance(0)
    expect(await bandText($)).toContain('GitLab 1 則新動態（/gitlab）')
    const siteReport = await runGitlab($)
    expect(siteReport).toContain('這個 repo（web-app）裡 GitLab 新動態 1 則（已標為已讀）：')
    expect(siteReport).toContain('bob 在 web-app#5 留言：謝謝回報')
  })

  test('啟動時已在清單裡的未讀動態：目前 repo 的與其他專案的分開彙總成一則 toast', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const event = (id: string, projectPath: string) => ({ id, kind: 'comment', actor: 'bob', ref: 'x#1', projectPath, title: 't', excerpt: '好', url: 'u', at: iso(T0) })
    mock.store(on, {
      since: iso(T0),
      unread: [event('note-1', 'acme/backend/api-server'), event('note-2', 'acme/web/web-app')],
    })
    const toasts = captureToasts(on)
    on('env.get', () => ({ value: 'test-token' }))
    const remotes = { origin: `${GITLAB_URL}/acme/backend/api-server.git` }
    fakeCommands(on, () => ({ root: '/work-p', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '', remotes }))
    fakeGitlab(on, path => (path === '/user' ? ME : []))

    await start($, on)
    await clock.advance(0)
    expect(toasts).toContain('GitLab 有 1 則未讀動態（/gitlab 查看），其他專案還有 1 則（web-app）')
    expect(await bandText($)).toContain('GitLab 1 則新動態（/gitlab）')
  })

  test('band 是一行字：不加框、不上底色，文字前留兩格跟上方摘要框的內文對齊', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    on('env.get', () => ({ value: 'test-token' }))
    fakeCommands(on, () => ({ root: '/work-q', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }))
    fakeGitlab(on, path => (path === '/user' ? ME : []))

    await start($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'gitlab-sync', surface, component: 'AbovePrompt', props: BAND_PROPS } as any)
      const band = await ui.find({ type: 'Box', key: 'gitlab-band' })
      expect(band?.props).toMatchObject({ paddingX: 2 })
      expect(band?.props.borderStyle).toBeUndefined()
      expect(band?.props.paddingY).toBeUndefined()
      expect((await ui.findAll({ type: 'Box' })).some(box => box.props.backgroundColor !== undefined)).toBe(false)
      expect(await ui.find({ type: 'Text', text: /⎇ main/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('band 的還開著的 issue 張數：背景輪詢會更新，查不到或通知暫停時不留舊數字', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    let token: string | undefined = 'test-token'
    on('env.get', () => ({ value: token }))
    const remotes = { origin: `${GITLAB_URL}/acme/web/web-app.git` }
    fakeCommands(on, () => ({ root: '/work-g', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '', remotes }))
    let createdByMe: unknown[] = [ISSUE_RAW, { ...ISSUE_RAW, id: 48, iid: 6 }]
    let isOpenQueryBroken = false
    fakeGitlab(on, (path, scope, state) => {
      if (path === '/user') return ME
      if (path !== '/issues' || state !== 'opened') return []
      if (isOpenQueryBroken) return undefined
      return scope === 'created_by_me' ? createdByMe : []
    })

    await start($, on)
    await clock.advance(0)
    expect(await bandText($)).toContain('⎇ main  ·  ✓ 已同步  ·  Issue 2 張（/gitlab）')

    // 背景每兩分鐘輪詢一次，關掉一張就少一張
    createdByMe = [ISSUE_RAW]
    await clock.advance(2 * 60_000)
    expect(await bandText($)).toContain('Issue 1 張（/gitlab）')

    // 只有這一段查不到：不顯示張數，也不算通知暫停
    isOpenQueryBroken = true
    await clock.advance(2 * 60_000)
    expect(await bandText($)).not.toContain('Issue ')
    expect(await bandText($)).not.toContain('通知暫停')

    isOpenQueryBroken = false
    await clock.advance(2 * 60_000)
    expect(await bandText($)).toContain('Issue 1 張（/gitlab）')

    token = undefined
    await clock.advance(2 * 60_000)
    const paused = await bandText($)
    expect(paused).toContain('GitLab 通知暫停（/gitlab 看原因）')
    expect(paused).not.toContain('Issue ')
  })

  test('查不到還開著的 issue 時說明原因，動態部分照常', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    on('env.get', () => ({ value: 'test-token' }))
    fakeCommands(on,() => ({ root: '/work-f', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }))
    // 只讓 state=opened 的查詢失敗；動態輪詢用的 state=all 照常回應
    fakeGitlab(on, (path, _scope, state) => (path === '/user' ? ME : state === 'opened' ? undefined : []))

    await start($, on)
    const report = await runGitlab($)
    expect(report).not.toContain('通知暫停')
    expect(report).toContain('GitLab 新動態 0 則。')
    expect(report).toContain('讀不到還開著的 issue：GitLab 回應 HTTP 404（/issues）')
  })

  test('沒有 GITLAB_TOKEN、鑰匙圈也讀不到時通知暫停，band 與 /gitlab 都說明原因，git 部分照常', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    on('env.get', () => ({ value: undefined }))
    fakeCommands(on,() => ({ root: '/work-b', branch: 'main', upstream: 'origin/main', counts: '1\t0', status: '' }))
    fakeGitlab(on, () => undefined)

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('分支 main（比對 origin/main）：↑1 待 push')
    expect(report).toContain('GitLab 通知暫停：GITLAB_TOKEN 是空的，鑰匙圈也讀不到 gitlab-token')
    expect(report).not.toContain('還開著的 issue')
    expect(toasts.filter(text => text.startsWith('GitLab 通知暫停'))).toHaveLength(1)
    expect(await bandText($)).toContain('GitLab 通知暫停（/gitlab 看原因）')
  })

  test('環境變數的 token 被拒絕（401）時改用鑰匙圈的最新 token，之後沿用、不再每輪讀鑰匙圈', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const requests: { url: string; token: string | undefined }[] = []
    fakeEnv(on, { GITLAB_TOKEN: 'stale-token', USER: 'alice' })
    const keychain: FakeKeychain = { token: 'fresh-token', reads: [] }
    fakeCommands(on, () => ({ root: '/work-h', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }), keychain)
    fakeGitlab(on, acceptsFreshTokenOnly, requests)

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('GitLab 新動態 0 則。')
    expect(report).not.toContain('通知暫停')
    expect(toasts.some(text => text.startsWith('GitLab 通知暫停'))).toBe(false)
    // 舊 token 只在第一次查使用者時被拒絕一次，之後都用鑰匙圈的
    expect(requests.filter(request => request.token === 'stale-token').map(request => request.url)).toEqual([`${GITLAB_URL}/api/v4/user`])

    const pollsBefore = requests.length
    await clock.advance(4 * 60_000)
    const laterRequests = requests.slice(pollsBefore)
    expect(laterRequests.length).toBeGreaterThan(0)
    expect(laterRequests.every(request => request.token === 'fresh-token')).toBe(true)
    // 讀固定的鑰匙圈項目 gitlab-token；token 只從 stdout 讀回來，argv 裡沒有
    expect(keychain.reads).toEqual([['security', 'find-generic-password', '-a', 'alice', '-s', 'gitlab-token', '-w']])
  })

  test('沒有 GITLAB_TOKEN 時直接用鑰匙圈的 token', OPTIONS, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    const requests: { url: string; token: string | undefined }[] = []
    fakeEnv(on, { USER: 'alice' })
    const keychain: FakeKeychain = { token: 'fresh-token', reads: [] }
    fakeCommands(on, () => ({ root: '/work-i', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }), keychain)
    fakeGitlab(on, acceptsFreshTokenOnly, requests)

    await start($, on)
    expect(await runGitlab($)).not.toContain('通知暫停')
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.token === 'fresh-token')).toBe(true)
    // 啟動時一輪、/gitlab 一輪，鑰匙圈只讀一次
    expect(keychain.reads).toHaveLength(1)
  })

  test('鑰匙圈也沒有可用的新 token 時通知暫停並說明；鑰匙圈換上新 token 後下一輪自動恢復', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const requests: { url: string; token: string | undefined }[] = []
    fakeEnv(on, { GITLAB_TOKEN: 'stale-token', USER: 'alice' })
    // 一開始鑰匙圈裡跟環境變數是同一個舊 token
    const keychain: FakeKeychain = { token: 'stale-token', reads: [] }
    fakeCommands(on, () => ({ root: '/work-j', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '' }), keychain)
    fakeGitlab(on, acceptsFreshTokenOnly, requests)

    await start($, on)
    const report = await runGitlab($)
    expect(report).toContain('GitLab 通知暫停：GitLab token 無效或已過期（HTTP 401），鑰匙圈裡也沒有可用的新 token')
    // 鑰匙圈裡是同一個 token 就不拿它重試：兩輪各只查一次使用者
    expect(requests.map(request => request.token)).toEqual(['stale-token', 'stale-token'])

    // 鑰匙圈換成另一個也失效的 token：試過還是暫停
    keychain.token = 'revoked-token'
    await clock.advance(2 * 60_000)
    expect(requests.some(request => request.token === 'revoked-token')).toBe(true)
    expect(await bandText($)).toContain('GitLab 通知暫停（/gitlab 看原因）')

    keychain.token = 'fresh-token'
    await clock.advance(2 * 60_000)
    expect(await bandText($)).not.toContain('通知暫停')
  })

  test('遠端多了新 commit 時提醒一次；回合結束就更新未提交的檔案數', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    on('env.get', () => ({ value: 'test-token' }))
    on('turn.complete', () => ({ text: '' }))
    let behind = 0
    let status = ' M a.ts\n?? b.ts'
    fakeCommands(on,() => ({ root: '/work-c', branch: 'develop', upstream: 'origin/develop', counts: `0\t${behind}`, status }))
    fakeGitlab(on, path => (path === '/user' ? ME : []))

    await start($, on)
    await clock.advance(0)
    expect(await bandText($)).toContain('⎇ develop  ·  ✓ 已同步  ·  2 個檔案未提交')
    expect(toasts.some(text => text.includes('新 commit'))).toBe(false)

    behind = 2
    await clock.advance(5 * 60_000)
    expect(toasts.filter(text => text === 'origin/develop 多了 2 個新 commit，本機落後 2 個')).toHaveLength(1)
    expect(await bandText($)).toContain('↓2 待 pull')

    status = ''
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1 } as any)
    await clock.advance(0)
    expect(await bandText($)).not.toContain('未提交')
  })

  test('這台電腦沒設定 GitLab 網址：GitLab 部分整個不顯示、不讀 token、不連線，/gitlab 說明怎麼設定', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts = captureToasts(on)
    const keychain: FakeKeychain = { token: 'fresh-token', reads: [] }
    const remotes = { origin: 'git@gitlab.example.com:acme/web/web-app.git' }
    fakeCommands(on, () => ({ root: '/work-r', branch: 'main', upstream: 'origin/main', counts: '0\t0', status: '', remotes }), keychain)
    const requests: { url: string; token: string | undefined }[] = []
    fakeGitlab(on, () => ME, requests)
    on('env.get', () => ({ value: 'test-token' }))

    await start($, on)
    await clock.advance(0)
    const band = await bandText($)
    // 認不出是 GitLab，來源直接寫主機名稱；沒有通知暫停也沒有 Issue 張數
    expect(band).toContain('gitlab.example.com  ·  ⎇ main  ·  ✓ 已同步')
    expect(band).not.toContain('GitLab')
    expect(band).not.toContain('Issue ')
    expect(toasts.some(text => text.startsWith('GitLab'))).toBe(false)
    expect(await runGitlab($)).toContain('GitLab：這台電腦還沒設定 GitLab 網址，不檢查 GitLab（用 /plugin configure gitlab-sync 設定 gitlabUrl）。')
    expect(requests).toEqual([])
    expect(keychain.reads).toEqual([])
  })
})
