# agent-panel 子代理詳細頁實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板停靠右邊時，點子代理卡片的標題列切換成那個子代理的詳細頁，依時間列出工具呼叫、中途訊息與回報，按「← 返回」回到清單。

**Architecture:** 子代理的 `tool.call`、`turn.step`、`turn.complete` 事件即時寫進新的 state 鍵 `logs`（純函式在 `hooks/log.ts`），詳細頁的組版是 `hooks/detail.ts` 的純函式；`register.tsx` 負責收集、`onPress` 處理與依 `selected` 決定畫詳細頁或清單。清單不讀 `logs`，新增紀錄不讓清單重畫。

**Tech Stack:** Claude Code 2.1.296 function hooks（TypeScript／TSX，JSX 編譯成全域 `h`）、`claude-code/testing`、`claude plugin test`／`validate`、TypeScript 5 型別檢查。

**Spec:** `docs/superpowers/specs/2026-10-10-agent-panel-detail-design.md`

## Global Constraints

- 位置：`my-mods/agent-panel/`；分支 `main`，每個 Task 一個 commit，不 push。commit 訊息格式 `agent-panel：<中文說明>`，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 動工前先用 Skill 工具載入 `plugin-authoring`，讓 bundled-skills 的 `claude-code.d.ts` 存在；型別一律以它為準。
- `$` 只能傳給檔案最上層宣告的函式；`onPress` 的閉包只呼叫最上層函式（例如 `() => void selectAgent($, id)`）。
- 狀態寫入不能在 `ui.render` 裡做，只在事件與 `onPress` 裡。
- 所有收集紀錄的 hook 只觀察：寫入出錯就略過（try/catch），一律回傳 `next(e)` 的結果。
- 原計畫的「面板裡不放按鈕」由本計畫取代：只有停靠（`placement === 'dock'`）時放按鈕。
- 上限（spec 已確認）：每個子代理 100 筆；訊息存前 2,000 字；回報存前 20,000 字；錯誤第一行最多 200 字。字數以字元（code point，`Array.from`）計。
- 時間格式：`+分:秒`，滿 1 小時 `+時:分:秒`，從子代理的 `startedAt` 算起。
- 圖示與顏色：`✓` `success`、`✗` `error`、`⊘` `warning`、`…` 預設色、`·` 整列 `isDim`；時間欄 `isDim`。
- 固定文字：`← 返回`、`回報`、`更早的 N 筆已省略`、`mod 載入前的紀錄沒有保留`。
- 工具名稱：`SubagentHandback`，回報文字在參數 `message`（2026-10-10 從 5 個真實子代理紀錄確認）。
- 補充 spec（依真實資料）：5 個子代理中有 1 個在交回前說的最後一段話與回報一字不差，所以記錄回報時，若前一筆是內容相同的訊息（以 2,000 字截斷後比對），移除那則訊息。
- ANSI 色碼的正規表示式用 `String.fromCharCode(27)` 組，不在原始碼寫 `\u001b`、`\x1b`（Write／Edit 工具會把跳脫碼解成實際字元）。
- 測試替身格式：engine 事件的 stub 直接回傳結果形狀；`$` 呼叫（`ui.scroll`、`ui.open` 等）的 stub 回傳 `{ value: … }`；`turn.step` 的 stub 是 `async function*`。
- 驗證指令（在 `~/.claude/mods-marketplaces/my-mods` 下）：
  - 測試：`claude plugin test agent-panel`
  - 檢查：`claude plugin validate agent-panel && sh scripts/check-contracts.sh`
  - 型別檢查：

```bash
cd ~/.claude/mods-marketplaces/my-mods
T=$(find "$(ls -d /private/tmp/claude-501/bundled-skills/*/ | sort -V | tail -1)" -name claude-code.d.ts -path '*plugin-authoring*' | head -1)
npx -y -p typescript@5 tsc --noEmit --strict --noUncheckedIndexedAccess --target es2023 --lib es2023 \
  --module esnext --moduleResolution bundler --jsx react --jsxFactory h --jsxFragmentFactory Fragment \
  "$T" agent-panel/hooks/*.ts agent-panel/hooks/*.tsx agent-panel/tests/*.ts* agent-panel/types/index.d.ts
```

## Review Focus

1. 子代理輸出很長而且沒有空白的字串（例如 300 字元的網址）：要依寬度硬切換行，任何一列都不超出面板寬度（Task 2 測試）。
2. 多個子代理同時呼叫工具：`logs` 用 `update` 重試，兩個子代理的紀錄都不能遺失（Task 3 測試）。
3. 熱重載後補進來、沒有任何紀錄的子代理被點開：顯示「mod 載入前的紀錄沒有保留」，不出錯（Task 4 測試）。
4. `$.ui.scroll` 被拒絕或拋錯：仍然要切到詳細頁（Task 4 測試）。
5. 截斷含 emoji 等 4 位元組字元的文字：以字元計數，不切出半個字（Task 1 測試）。

---

### Task 1: 紀錄型別與 `log.ts`

**Files:**
- Modify: `agent-panel/types/index.d.ts`
- Create: `agent-panel/hooks/log.ts`
- Create: `agent-panel/tests/log.test.ts`
- Modify: `agent-panel/tests/state-store.ts`

**Interfaces:**
- Produces（`types/index.d.ts`，形狀照 spec「資料模型」）：`ToolOutcome`、`LogEntry`、`AgentLog`、`Logs`；`PluginState['agent-panel']` 加 `logs: Logs | null`、`selected: string | null`。
- Produces（`hooks/log.ts`）：

```ts
export const MAX_ENTRIES = 100
export const MESSAGE_LIMIT = 2_000
export const REPORT_LIMIT = 20_000
export const ERROR_LINE_LIMIT = 200
// 寫到哪一批的哪一個子代理；三個值總是一起傳
export type LogTarget = { turnId: string; agentId: string }
export type ToolEnd = { outcome: 'ok' | 'error' | 'denied'; errorLine: string | null }

export function agentLog(logs: Logs | null, target: LogTarget): AgentLog
export function addToolStart(logs: Logs | null, target: LogTarget, start: { id: string; at: number; summary: string }): Logs
export function finishTool(logs: Logs | null, target: LogTarget, toolId: string, end: ToolEnd): Logs
export function addAnswer(logs: Logs | null, target: LogTarget, answer: { at: number; text: string; isFinal: boolean }): Logs
export function addReport(logs: Logs | null, target: LogTarget, report: { at: number; text: string }): Logs
export function markUnfinished(logs: Logs | null, target: LogTarget): Logs
export function toolEndOf(result: unknown): ToolEnd
export function firstErrorLine(text: string): string | null
```

- Produces（`tests/state-store.ts`）：處理的鍵擴充為 `batch`、`tick`、`logs`、`selected`；新增 `reads(key)`，回傳 mod 經 `state.get` 讀這個鍵的次數。

- [ ] **Step 1: 寫失敗的測試 `tests/log.test.ts`**

```ts
const target = { turnId: 't1', agentId: 'a1' }
const tool = (id: string, at = 0) => ({ id, at, summary: `讀取 ${id}` })

test('turnId 不同的舊 logs 寫入時換成新的', () => {
  const old = addToolStart(null, { turnId: 't0', agentId: 'a9' }, tool('x'))
  const next = addToolStart(old, target, tool('r1'))
  expect(next.turnId).toBe('t1')
  expect(Object.keys(next.byAgent)).toEqual(['a1'])
})

test('工具開始是 running，finishTool 依 id 更新；找不到 id 不變', () => {
  let logs = addToolStart(null, target, tool('r1', 4000))
  expect(agentLog(logs, target).entries[0]).toEqual({ kind: 'tool', id: 'r1', at: 4000, summary: '讀取 r1', outcome: 'running', errorLine: null })
  logs = finishTool(logs, target, 'r1', { outcome: 'error', errorLine: 'File does not exist.' })
  expect(agentLog(logs, target).entries[0]).toMatchObject({ outcome: 'error', errorLine: 'File does not exist.' })
  expect(finishTool(logs, target, 'nope', { outcome: 'ok', errorLine: null })).toEqual(logs)
})

test('超過 100 筆從最舊的丟，dropped 累計', () => {
  let logs: Logs | null = null
  for (let i = 0; i < 102; i++) logs = addToolStart(logs, target, tool(`r${i}`))
  const log = agentLog(logs, target)
  expect(log.entries).toHaveLength(100)
  expect(log.dropped).toBe(2)
  expect(log.entries[0]).toMatchObject({ id: 'r2' })
})

test('markUnfinished 只把 running 改成 unfinished', () => {
  let logs = addToolStart(null, target, tool('r1'))
  logs = addToolStart(logs, target, tool('r2'))
  logs = finishTool(logs, target, 'r1', { outcome: 'ok', errorLine: null })
  const outcomes = agentLog(markUnfinished(logs, target), target).entries.map((entry: any) => entry.outcome)
  expect(outcomes).toEqual(['ok', 'unfinished'])
})

test('addAnswer：最後答案且還沒有回報時記成 report，其他記成 message', () => {
  let logs = addAnswer(null, target, { at: 1, text: '先看設定檔', isFinal: false })
  logs = addAnswer(logs, target, { at: 2, text: '結論', isFinal: true })
  logs = addAnswer(logs, target, { at: 3, text: '補充', isFinal: true })
  expect(agentLog(logs, target).entries.map((entry: any) => entry.kind)).toEqual(['message', 'report', 'message'])
})

test('addReport：前一筆訊息跟回報相同時移除那則訊息，不同時保留', () => {
  const same = addReport(addAnswer(null, target, { at: 1, text: '報告全文', isFinal: false }), target, { at: 2, text: '報告全文' })
  expect(agentLog(same, target).entries.map((entry: any) => entry.kind)).toEqual(['report'])
  const differ = addReport(addAnswer(null, target, { at: 1, text: '接著回報', isFinal: false }), target, { at: 2, text: '報告全文' })
  expect(agentLog(differ, target).entries.map((entry: any) => entry.kind)).toEqual(['message', 'report'])
})

test('訊息截到 2,000 字、回報截到 20,000 字，以字元計（emoji 算一個）', () => {
  const message = agentLog(addAnswer(null, target, { at: 1, text: '😀'.repeat(2500), isFinal: false }), target).entries[0] as any
  expect(Array.from(message.text)).toHaveLength(2000)
  expect(message.text.endsWith('😀')).toBe(true)
  const report = agentLog(addReport(null, target, { at: 1, text: '字'.repeat(25_000) }), target).entries[0] as any
  expect(Array.from(report.text)).toHaveLength(20_000)
})

test('toolEndOf 與 firstErrorLine', () => {
  const esc = String.fromCharCode(27)
  expect(toolEndOf({ result: {}, text: 'ok' })).toEqual({ outcome: 'ok', errorLine: null })
  expect(toolEndOf({ result: {}, text: `<tool_use_error>\n${esc}[31mFile does not exist.${esc}[0m\nmore</tool_use_error>`, isError: true }))
    .toEqual({ outcome: 'error', errorLine: 'File does not exist.' })
  expect(toolEndOf({ deny: '不允許讀這個檔\n細節' })).toEqual({ outcome: 'denied', errorLine: '不允許讀這個檔' })
  expect(firstErrorLine('   \n  ')).toBeNull()
  expect(firstErrorLine('x'.repeat(300))).toHaveLength(200)
})

test('agentLog：沒有紀錄或 turnId 不符時回空的', () => {
  expect(agentLog(null, target)).toEqual({ entries: [], dropped: 0 })
  expect(agentLog(addToolStart(null, target, tool('r1')), { turnId: 't2', agentId: 'a1' })).toEqual({ entries: [], dropped: 0 })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（`hooks/log.ts` 不存在）

- [ ] **Step 3: 實作**

合約檔照 spec「資料模型」加型別與兩個 state 鍵；`log.ts` 全部是純函式、回傳新物件。`addAnswer` 判斷 report 的條件是 `isFinal` 而且這個子代理還沒有 `kind: 'report'` 的紀錄。`addReport` 比對「前一筆是 `message`，而且 `message.text === 回報截到 2,000 字`」才移除。`firstErrorLine` 去掉 `<tool_use_error>`、`</tool_use_error>` 與 ANSI 色碼後取第一個非空白行，`trim` 後截到 200 字。`toolEndOf`：有字串 `deny` → `denied`；`isError === true` → `error`（取 `text`）；其他 → `ok`。`state-store.ts` 的鍵清單加上 `logs`、`selected`，在 `state.get` stub 裡累計讀取次數。

- [ ] **Step 4: 跑測試與合約檢查**

Run: `claude plugin test agent-panel && sh scripts/check-contracts.sh`
Expected: 全部通過（原本 146 個加上這次的），合約一致

- [ ] **Step 5: Commit**

```bash
git add agent-panel/types/index.d.ts agent-panel/hooks/log.ts agent-panel/tests/log.test.ts agent-panel/tests/state-store.ts
git commit -m "agent-panel：新增子代理紀錄的型別與純函式"
```

---

### Task 2: 詳細頁組版 `detail.ts`

**Files:**
- Create: `agent-panel/hooks/detail.ts`
- Create: `agent-panel/tests/detail.test.ts`

**Interfaces:**
- Consumes：`AgentLog`、`LogEntry`（Task 1）；`Span`、`displayWidth`、`fitToWidth`、`formatElapsed`（`hooks/layout.ts`，不修改）。
- Produces：

```ts
export const BACK_LABEL = '← 返回'
export type DetailOptions = { columns: number; now: number; startedAt: number }
// 紀錄區的每一列（不含返回列、卡片與分隔線），每列顯示寬度 ≤ columns
export function detailRows(log: AgentLog, options: DetailOptions): Span[][]
export function formatOffset(ms: number): string
// 依顯示寬度換行（中文 2 欄、逐字硬切）；'\n' 分段，空段落回 ''
export function wrapToWidth(text: string, width: number): string[]
```

版面規則（給測試與實作共用）：時間欄寬 = 所有紀錄 `formatOffset` 的最大顯示寬度，不足的補空白；一列是「時間欄 + 1 空白 + 內容」；內容的續行縮排 = 時間欄寬 + 1；工具的錯誤或拒絕原因列縮排 = 時間欄寬 + 3。中途訊息先把連續空白（含換行）合成一個空白，包成 `「…」` 後換行，最多 3 列，超過時第 3 列結尾是 `…」`。回報先一列 `回報`（`isBold`），下面照原本段落完整換行。

- [ ] **Step 1: 寫失敗的測試 `tests/detail.test.ts`**

```ts
const options = { columns: 40, now: 122_000, startedAt: 0 }
const texts = (rows: Span[][]) => rows.map(row => row.map(span => span.text).join(''))
const tool = (at: number, summary: string, outcome: string, errorLine: string | null = null) =>
  ({ kind: 'tool', id: `${at}`, at, summary, outcome, errorLine }) as LogEntry

test('formatOffset', () => {
  expect(formatOffset(4000)).toBe('+0:04')
  expect(formatOffset(3_723_000)).toBe('+1:02:03')
  expect(formatOffset(-5)).toBe('+0:00')
})

test('工具五種狀態的圖示、顏色與錯誤列', () => {
  const rows = detailRows({ entries: [
    tool(4000, '讀取 config.ghostty', 'ok'),
    tool(12_000, '讀取 GhosttyConfig.swift', 'error', 'File does not exist'),
    tool(13_000, '執行：rm -rf /', 'denied', '不允許'),
    tool(14_000, '讀取 a.ts', 'unfinished'),
    tool(118_000, '搜尋 ConfigPaths', 'running'),
  ], dropped: 0 }, options)
  expect(texts(rows).slice(0, 6)).toEqual([
    '+0:04 ✓ 讀取 config.ghostty',
    '+0:12 ✗ 讀取 GhosttyConfig.swift',
    '        File does not exist',
    '+0:13 ⊘ 執行：rm -rf /',
    '        不允許',
    '+0:14 · 讀取 a.ts',
  ])
  // 右邊是已經跑了多久（跟卡片的耗時一樣，不加 +）
  expect(texts(rows)[6]).toMatch(/^\+1:58 … 搜尋 ConfigPaths +0:04$/)
  expect(displayWidth(texts(rows)[6]!)).toBe(40)
  expect(rows[0]!.find(span => span.text === '✓')).toMatchObject({ color: 'success' })
  expect(rows[1]!.find(span => span.text === '✗')).toMatchObject({ color: 'error' })
  expect(rows[2]!.at(-1)).toMatchObject({ color: 'error' })
  expect(rows[3]!.find(span => span.text === '⊘')).toMatchObject({ color: 'warning' })
  expect(rows[5]!.every(span => span.isDim)).toBe(true)
  expect(rows[0]![0]).toMatchObject({ isDim: true })
})

test('時間欄依最寬的對齊', () => {
  const rows = detailRows({ entries: [tool(4000, '讀取 a', 'ok'), tool(754_000, '讀取 b', 'ok')], dropped: 0 }, { ...options, now: 760_000 })
  expect(texts(rows)).toEqual(['+0:04  ✓ 讀取 a', '+12:34 ✓ 讀取 b'])
})

test('中途訊息最多 3 列、結尾 …」，續行對齊；短訊息一列；換行合成空白', () => {
  const long = detailRows({ entries: [{ kind: 'message', at: 10_000, text: '找到 4 個 cmux 自有鍵，'.repeat(10) }], dropped: 0 }, { ...options, columns: 30 })
  const lines = texts(long)
  expect(lines).toHaveLength(3)
  expect(lines[0]!.startsWith('+0:10 「')).toBe(true)
  expect(lines[1]!.startsWith('      ')).toBe(true)
  expect(lines[2]!.endsWith('…」')).toBe(true)
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30)
  expect(texts(detailRows({ entries: [{ kind: 'message', at: 10_000, text: '找到\n4 個鍵' }], dropped: 0 }, options))).toEqual(['+0:10 「找到 4 個鍵」'])
})

test('回報：標題列加粗，全文完整換行並保留空行', () => {
  const report = '第一段' + '很長'.repeat(30) + '\n\n第二段'
  const rows = detailRows({ entries: [{ kind: 'report', at: 123_000, text: report }], dropped: 0 }, options)
  expect(texts(rows)[0]).toBe('+2:03 回報')
  expect(rows[0]!.find(span => span.text === '回報')).toMatchObject({ isBold: true })
  const body = texts(rows).slice(1)
  expect(body.every(line => line === '' || line.startsWith('      '))).toBe(true)
  expect(body.map(line => line.trim()).join('')).toBe(report.replace(/\n/g, ''))
  expect(body.some(line => line.trim() === '')).toBe(true)
})

test('沒有空白的長字串依寬度硬切，不超出面板', () => {
  const url = 'https://example.com/' + 'a'.repeat(280)
  const rows = detailRows({ entries: [{ kind: 'report', at: 0, text: url }, { kind: 'message', at: 0, text: url }], dropped: 0 }, { ...options, columns: 30 })
  for (const line of texts(rows)) expect(displayWidth(line)).toBeLessThanOrEqual(30)
})

test('換行快取不影響結果：同一段紀錄換寬度再換回來，結果一致', () => {
  const log = { entries: [{ kind: 'report', at: 0, text: '很長的回報'.repeat(40) }] as LogEntry[], dropped: 0 }
  const first = detailRows(log, { ...options, columns: 30 })
  expect(detailRows(log, options)).not.toEqual(first)
  expect(detailRows(log, { ...options, columns: 30 })).toEqual(first)
})

test('已省略提示與沒有紀錄的提示', () => {
  expect(texts(detailRows({ entries: [tool(0, '讀取 a', 'ok')], dropped: 3 }, options))[0]).toBe('更早的 3 筆已省略')
  expect(detailRows({ entries: [], dropped: 0 }, options)).toEqual([[{ text: 'mod 載入前的紀錄沒有保留', isDim: true }]])
})

test('wrapToWidth：中文 2 欄、分段', () => {
  expect(wrapToWidth('中文字', 4)).toEqual(['中文', '字'])
  expect(wrapToWidth('ab\n\ncd', 10)).toEqual(['ab', '', 'cd'])
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（`hooks/detail.ts` 不存在）

- [ ] **Step 3: 實作 `detail.ts`**

`formatOffset(ms)` 是 `'+' + formatElapsed(ms)`。執行中工具列的右側是 `formatElapsed(now - at)`（不加 `+`），摘要用 `fitToWidth` 留出右側寬度後補空白，讓右側靠右對齊到 `columns`。換行結果用模組層的 `Map` 快取，key 是 `${width}|${text}`，超過 50 筆整個清掉。

- [ ] **Step 4: 跑測試確認通過**

Run: `claude plugin test agent-panel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/detail.ts agent-panel/tests/detail.test.ts
git commit -m "agent-panel：新增詳細頁紀錄的組版"
```

---

### Task 3: 收集子代理的紀錄

**Files:**
- Modify: `agent-panel/hooks/register.tsx`（`recordTool`、`recordSpawn`、`tool.call`、`turn.step`、`turn.complete`、`session.end`、`/agents`、`openPanel`）
- Modify: `agent-panel/tests/register.test.tsx`

**Interfaces:**
- Consumes：Task 1 的 `log.ts` 全部函式與 `LogTarget`。
- Produces（`register.tsx` 最上層）：

```ts
const HANDBACK_TOOL = 'SubagentHandback'
const logsAtom = atom({ plugin: 'agent-panel', key: 'logs' } as const, null as Logs | null)
const selectedAtom = atom({ plugin: 'agent-panel', key: 'selected' } as const, null as string | null)
// 讀 batch 確認 agentId 在這一批後，用 batch.turnId 組 LogTarget 寫入；不在這一批就不寫
async function updateLog($: EngineInterface, agentId: string, change: (logs: Logs | null, target: LogTarget) => Logs): Promise<void>
// 原本的 recordTool 不變（只更新卡片的工具次數與正在做什麼）。
// 新增 recordToolStart：只加一筆工具紀錄，回傳紀錄 id（不在這一批回 null）；id 是 call.tool_use_id，沒有時用模組計數器產生
async function recordToolStart($: EngineInterface, agentId: string, call: ToolCallInput): Promise<string | null>
async function recordToolEnd($: EngineInterface, agentId: string, toolId: string, result: unknown): Promise<void>
async function recordReport($: EngineInterface, agentId: string, text: string): Promise<void>
async function recordAnswer($: EngineInterface, agentId: string, answer: { text: string; isFinal: boolean }): Promise<void>
// 清空 selected；openPanel 開頭與 /agents 打開時呼叫
export async function showList($: EngineInterface): Promise<void>
```

- [ ] **Step 1: 擴充測試替身並寫失敗的測試**

`engine()` 加三個排程佇列：`toolReplies`（`tool.call` 非 Agent 時先用，預設 `{ result: {}, text: 'ok' }`）、`stepReplies`（`turn.step` 的 `answer`、`toolUses`、`stopReason`，預設 `''`、`[]`、`'end_turn'`）、`scrolls`（`ui.scroll` stub 記錄參數並回 `{ value: {} }`）。

```ts
test('子代理的工具呼叫記成紀錄，結果回來改成 ok、error、denied', async ($, on) => {
  const control = engine(on)
  control.toolReplies.push({ result: {}, text: 'ok' }, { result: {}, text: '<tool_use_error>File does not exist.</tool_use_error>', isError: true }, { deny: '不允許\n細節' })
  await start($)
  await spawnAgent($)
  await control.clock.advance(4000)
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: 'a1', tool_use_id: 'r1' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/w/x.ts', agentId: 'a1', tool_use_id: 'r2' } as any)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', agentId: 'a1', tool_use_id: 'r3' } as any)
  const logs = control.state.get('logs')
  expect(logs.turnId).toBe('t1')
  expect(logs.byAgent.a1.entries).toEqual([
    { kind: 'tool', id: 'r1', at: 4000, summary: '讀取 src/app.ts', outcome: 'ok', errorLine: null },
    { kind: 'tool', id: 'r2', at: 4000, summary: '讀取 w/x.ts', outcome: 'error', errorLine: 'File does not exist.' },
    { kind: 'tool', id: 'r3', at: 4000, summary: '執行：rm -rf /', outcome: 'denied', errorLine: '不允許' },
  ])
})

test('SubagentHandback 記成回報，不記成工具；卡片的工具次數照舊累加', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await $.tool.call({ tool: 'SubagentHandback', message: '報告內容', agentId: 'a1' } as any)
  expect(control.state.get('logs').byAgent.a1.entries).toEqual([{ kind: 'report', at: 0, text: '報告內容' }])
  expect(control.state.get('batch').agents[0].toolCount).toBe(1)
})

test('SubagentHandback 沒有 message 欄位時，取第一個字串參數當回報', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await $.tool.call({ tool: 'SubagentHandback', report: '另一種欄位', agentId: 'a1' } as any)
  expect(control.state.get('logs').byAgent.a1.entries).toEqual([{ kind: 'report', at: 0, text: '另一種欄位' }])
})

test('子代理的 answer 記成訊息；沒有要求工具而且 end_turn 時記成回報', async ($, on) => {
  const control = engine(on)
  control.stepReplies.push({ answer: '先看設定檔', toolUses: [{ id: 'u', name: 'Read', input: {} }], stopReason: 'tool_use' }, { answer: '結論', toolUses: [], stopReason: 'end_turn' })
  await start($)
  await spawnAgent($)
  await step($, 'a1')
  await step($, 'a1')
  expect(control.state.get('logs').byAgent.a1.entries.map((entry: any) => [entry.kind, entry.text])).toEqual([['message', '先看設定檔'], ['report', '結論']])
})

test('主迴圈與不在這一批的 agentId 不寫 logs', async ($, on) => {
  const control = engine(on)
  control.stepReplies.push({ answer: '主迴圈的話' }, { answer: 'fork 的話' })
  await start($)
  await spawnAgent($)
  await step($)
  await step($, 'internal-fork')
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts', agentId: 'internal-fork' } as any)
  expect(control.state.writes('logs')).toBe(0)
})

test('平行的兩個子代理同時呼叫工具，紀錄都在', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  await spawnAgent($)
  await Promise.all([
    $.tool.call({ tool: 'Read', file_path: '/w/a.ts', agentId: 'a1', tool_use_id: 'x1' } as any),
    $.tool.call({ tool: 'Read', file_path: '/w/b.ts', agentId: 'a2', tool_use_id: 'x2' } as any),
  ])
  const logs = control.state.get('logs')
  expect(logs.byAgent.a1.entries).toHaveLength(1)
  expect(logs.byAgent.a2.entries).toHaveLength(1)
})

test('子代理結束時還在 running 的工具改成 unfinished', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  control.state.set('logs', { turnId: 't1', byAgent: { a1: { entries: [{ kind: 'tool', id: 'r1', at: 0, summary: '讀取 a', outcome: 'running', errorLine: null }], dropped: 0 } } })
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, agentId: 'a1', turnId: 'x' } as any)
  expect(control.state.get('logs').byAgent.a1.entries[0].outcome).toBe('unfinished')
})

test('新的一批與 /agents 打開時 selected 清空；/clear 清空 logs 與 selected', async ($, on) => {
  const control = engine(on)
  await start($)
  await spawnAgent($)
  control.state.set('selected', 'a1')
  await $.turn.start({ text: '再來', turnId: 't2' })
  await spawnAgent($)
  expect(control.state.get('selected')).toBeNull()
  control.state.set('selected', 'a2')
  await $.command.run({ command: 'agents' } as any) // 開著 → 關
  await $.command.run({ command: 'agents' } as any) // 關著 → 開
  expect(control.state.get('selected')).toBeNull()
  control.state.set('selected', 'a2')
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts', agentId: 'a2' } as any)
  await $.session.end({ reason: 'clear' } as any)
  expect(control.state.get('logs')).toBeNull()
  expect(control.state.get('selected')).toBeNull()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（新測試失敗，原本的全部通過）

- [ ] **Step 3: 實作**

`tool.call` 的子代理分支一律先 `recordTool`（卡片照舊）。`SubagentHandback` 接著 `recordReport` 取 `e.message`（不是字串時取參數中第一個字串欄位，`tool`、`agentId`、`tool_use_id` 除外），然後 `return next(e)`；其他工具 `recordToolStart` 取得 id → `const result = await next(e)` → id 不是 null 時 `recordToolEnd`（`toolEndOf(result)`）→ 回傳 `result`。`turn.step` 在 `answer.trim() !== ''` 時呼叫 `recordAnswer`，`isFinal = result.toolUses.length === 0 && result.stopReason === 'end_turn'`。`recordFinish` 之後對同一個 agentId 做 `markUnfinished`。`openPanel` 與 `/agents` 打開的分支先 `showList`。`session.end` 的 `clear` 也把 `logs`、`selected` 寫成 `null`。`at` 一律取 `$.clock.now()`。

- [ ] **Step 4: 跑測試、檢查與型別檢查**

Run: `claude plugin test agent-panel && claude plugin validate agent-panel && sh scripts/check-contracts.sh`，再跑 Global Constraints 的型別檢查指令
Expected: 全部通過，tsc 沒有輸出

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/register.tsx agent-panel/tests/register.test.tsx
git commit -m "agent-panel：記錄子代理的工具呼叫、訊息與回報"
```

---

### Task 4: 點擊與詳細頁畫面

**Files:**
- Modify: `agent-panel/hooks/register.tsx`（`ui.render`、新增最上層的 `selectAgent`）
- Modify: `agent-panel/tests/render.test.tsx`

**Interfaces:**
- Consumes：`detailRows`、`BACK_LABEL`（Task 2）；`logsAtom`、`selectedAtom`、`showList`、`agentLog`（Task 1、3）；現有的 `statusLine`、`cardView`。
- Produces（`register.tsx` 最上層）：

```ts
// 寫 selected 後捲到最底下；捲動失敗不影響切換
export async function selectAgent($: EngineInterface, agentId: string): Promise<void>
```

畫面規則：`isDetail = placement === 'dock' && selected !== null && batch 裡有這個 agentId`。只有 `isDetail` 時才讀 `logsAtom`。詳細頁由上往下：一列 `<Box flexDirection="row" columnGap={1}>`，裡面是 `<Button key="back" plain label={BACK_LABEL} onPress={() => void showList($)} />` 與 `spanRow(statusLine(batch, now, columns - displayWidth(BACK_LABEL) - 1))`；那個子代理的 `cardView`；`{ text: '─'.repeat(columns), isDim: true }` 一列；`detailRows(agentLog(logs, { turnId: batch.turnId, agentId }), { columns, now, startedAt: agent.startedAt })` 每列一個 `spanRow`。清單在 `placement === 'dock'` 時，卡片標題列（`card.lines[0]`）與精簡列各包成 `<Button key={`open-${agent.id}`} plain onPress={() => void selectAgent($, agent.id)}>{spanRow(…)}</Button>`；`inline` 時不包。詳細頁裡那張卡片的標題列不包按鈕（`cardView` 多一個「標題要不要包按鈕」的參數）。

- [ ] **Step 1: 擴充畫面測試的 setup 並寫失敗的測試**

`setup(on, agents, extra?: { logs?: Logs; selected?: string; scrollFails?: boolean })` 改成回傳 `{ store, scrolls }`：`store` 是 `stateStore` 本身，`scrolls` 是 `ui.scroll` stub 記下的參數（stub 預設回 `{ value: {} }`，`scrollFails` 時拋錯）。原本不看回傳值的呼叫照舊。`drawnRows` 不用改：按鈕裡包的是一個 `Text`，仍算一列。

```ts
test('停靠時卡片標題列與精簡列是 plain 按鈕；放在輸入框上方時沒有按鈕', async ($, on) => {
  const ui = await mountWith($, on, [row('a'), done('d')])
  expect((await ui.find({ key: 'open-a' }))?.props).toMatchObject({ plain: true })
  await ui.unmount()
  const compact = await mount($, { bodyRows: 3 })
  expect(await compact.find({ key: 'open-d' })).toBeDefined()
  await compact.unmount()
  const inline = await mount($, { placement: 'inline' })
  expect(countNodes(await inline.drawn(), node => node.type === 'Button')).toBe(0)
  await inline.unmount()
})

test('按標題切到詳細頁並捲到最底下：返回列、卡片、分隔線、紀錄依序出現；詳細頁的卡片標題不是按鈕', async ($, on) => {
  const { store, scrolls } = setup(on, [row('a', { startedAt: 0 })], { logs: { turnId: 't1', byAgent: { a: { entries: [{ kind: 'tool', id: 'r1', at: 4000, summary: '讀取 config.ghostty', outcome: 'ok', errorLine: null }], dropped: 0 } } } })
  const ui = await mount($)
  await ui.press({ key: 'open-a' })
  expect(store.get('selected')).toBe('a')
  expect(scrolls).toEqual([{ in: 'agent-panel', to: 'end' }])
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'open-a' })).toBeUndefined()
  const rows = drawnRows(await ui.drawn())
  const title = rows.findIndex(line => line.startsWith('● Explore · 任務 a'))
  const separator = rows.findIndex(line => /^─+$/.test(line))
  expect(rows[0]).toMatch(/^Agents/)
  expect(title).toBeGreaterThan(0)
  expect(separator).toBeGreaterThan(title)
  expect(rows[separator + 1]).toBe('+0:04 ✓ 讀取 config.ghostty')
  await ui.unmount()
})

test('按返回回到清單，selected 清空', async ($, on) => {
  const { store } = setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($)
  await ui.press({ key: 'back' })
  expect(store.get('selected')).toBeNull()
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await ui.find({ key: 'open-a' })).toBeDefined()
  await ui.unmount()
})

test('沒有紀錄的子代理點開時顯示提示', async ($, on) => {
  setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($)
  expect(drawnRows(await ui.drawn())).toContain('mod 載入前的紀錄沒有保留')
  await ui.unmount()
})

test('捲動被拒絕時仍切到詳細頁', async ($, on) => {
  setup(on, [row('a')], { scrollFails: true })
  const ui = await mount($)
  await ui.press({ key: 'open-a' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('selected 不在這一批時畫清單', async ($, on) => {
  setup(on, [row('a')], { selected: 'gone' })
  const ui = await mount($)
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('放在輸入框上方時畫清單，但不清掉 selected', async ($, on) => {
  const { store } = setup(on, [row('a')], { selected: 'a' })
  const ui = await mount($, { placement: 'inline' })
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(store.get('selected')).toBe('a')
  await ui.unmount()
})

test('清單畫面不讀 logs', async ($, on) => {
  const { store } = setup(on, [row('a')])
  const ui = await mount($)
  await ui.drawn()
  expect(store.reads('logs')).toBe(0)
  await ui.unmount()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（新測試失敗，原本的全部通過）

- [ ] **Step 3: 實作**

照上面的畫面規則改 `ui.render`。`selectAgent`：`update($, selectedAtom, () => agentId)` 後 `await $.ui.scroll({ in: PANE_ID, to: 'end' }).catch(() => {})`，整段包 try/catch。

- [ ] **Step 4: 跑測試、檢查與型別檢查**

Run: `claude plugin test agent-panel && claude plugin validate agent-panel && sh scripts/check-contracts.sh`，再跑型別檢查指令
Expected: 全部通過。`validate` 若拒絕「`Button` 裡包 `Text`」，改成把各段 `Text` 直接放進 `Button`，同時把 `drawnRows` 改成「`Button` 算一列」，再跑一次

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/register.tsx agent-panel/tests/render.test.tsx
git commit -m "agent-panel：點卡片標題切換子代理詳細頁"
```

---

### Task 5: 文件更新與真實 session 驗證

**Files:**
- Modify: `README.md`（agent-panel 那一列的說明加上「停靠右邊時點卡片標題看子代理的工具呼叫、訊息與回報」）
- Modify: `docs/superpowers/specs/2026-10-10-agent-panel-detail-design.md`（狀態改成「已實作」；「資料收集」補上回報去重的規則與 `message` 欄位名稱；「實作時驗證的事」寫上結果）

- [ ] **Step 1: 全部檢查**

Run: `claude plugin test agent-panel && claude plugin validate agent-panel && sh scripts/check-contracts.sh`，再跑型別檢查指令
Expected: 全部通過

- [ ] **Step 2: 載入新版**

請使用者在目前的 session 執行 `/reload-plugins`。
Expected: 輸出有 agent-panel 的「re-read from its folder」

- [ ] **Step 3: 實機驗證（cmux 全螢幕、面板停靠右邊）**

派一個 `general-purpose` 示範子代理：讀 2 個存在的檔、讀 1 個不存在的檔、說一句話、用 `python3 -c 'import time; time.sleep(60)'` 停 60 秒、最後交回 3 段以上的報告。使用者點它的標題列；Claude 用 `cmux read-screen` 讀畫面確認：

1. 面板停靠右邊，第一列有 `← 返回`，下面是那張卡片與分隔線；卡片左邊的小人是圖片版（前兩列有 kitty 佔位字元 U+10EEEE，4 欄 × 2 列）
2. 兩個 `✓`、一個 `✗` 且下一列是錯誤訊息、等待期間有 `…` 與耗時
3. 中途訊息最多 3 列；回報有 `回報` 標題列且全文完整
4. 使用者往上捲之後，新紀錄出現時畫面不被拉回最底下；不成立時改用 `e.props.scroll.offset` 判斷（另開一個 commit，附測試）
5. 使用者點 `← 返回` 回到清單

Expected: 1～5 都符合；不符合的項目回報給使用者，修正後重跑對應的測試

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-10-agent-panel-detail-design.md
git commit -m "agent-panel：詳細頁完成，更新 README 與 spec"
```
