# agent-panel 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 my-mods 新增 `agent-panel` mod：派出子代理時自動跳出面板，顯示這一回合每個子代理的模型、effort、工具次數、正在做什麼、ctx、token、估算費用與時間。

**Architecture:** 三個純函式模組（`pricing.ts` 算單價與 ctx、`batch.ts` 維護這一批的資料、`layout.ts` 把資料變成每一列的文字與顏色）加上一個薄的 `register.tsx`（接事件、開關窗格、計時器、把版面畫成元素）。資料存在 `$.state`，面板是 `$.ui.open` 開的 `Pane`。

**Tech Stack:** Claude Code 2.1.295 function hooks（TypeScript／TSX，JSX 編譯成全域 `h`）、`claude-code/testing` 測試套件、`claude plugin test`／`validate`、TypeScript 5 型別檢查。

**Spec:** `docs/superpowers/specs/2026-10-09-agent-panel-design.md`

## Global Constraints

- mod 資料夾：`my-mods/agent-panel/`；在 `my-mods/.claude-plugin/marketplace.json` 登記，README 的 mod 表格加一列。
- 動工前先用 Skill 工具載入 `plugin-authoring`，讓 `/private/tmp/claude-501/bundled-skills/<版本>/…/plugin-authoring/types/claude-code.d.ts` 存在；型別一律以它為準。
- 模組環境沒有 DOM 與 Node：元素從 `$.ui.resolve(e)` 取得；`$` 只能傳給檔案最上層宣告的函式，傳給 `register` 裡的閉包會讓整個模組載入失敗。
- 所有 hook 只觀察：記錄失敗就略過，一律回傳 `next(e)` 的結果，不擋任何事件。
- 窗格：`id: 'agent-panel'`、`title: 'Agents'`、`columns: 42`、不帶 `focus`；面板裡不放按鈕。
- 標籤用英文：`Agents`、`Cost`、`Tokens`、`Time`、`Running`、`Finished`、`tools`、`ctx`、`starting`；正在做什麼與失敗原因用繁體中文；程式註解用繁體中文。
- 顏色：橘 `#f79a4f`、粉紅 `#ec4f8f`、紫 `#b45ce6`、藍 `#6f7df2`、進度條底色 `#4a4a52`、灰 `#8a8a94`、Haiku 綠 `#46b06e`；進度條字元 `▆`。系列配色：opus 橘、sonnet 藍、haiku 綠、fable 紫、unknown 灰。
- state 合約（`types/index.d.ts`）：`'agent-panel': { batch: Batch | null; tick: number }`。合約檔只能 export 型別，不能 `import` `'claude-code'` 的型別（`scripts/check-contracts.sh` 的 stub 模組只有 `PluginState`），所以 token 用量型別在合約檔自己定義為 `TokenUsage`。
- 東亞寬字元的正規表示式要用 `\uXXXX` 跳脫；Write／Edit 工具會把 `\u` 解成實際字元，這一行要用 Python `chr(92)` 組字串寫入，寫完用 `grep` 確認是字面的 `\u`。
- 測試替身的格式：engine 事件（`session.start`、`turn.start`、`turn.complete`、`agent.spawn`、`prompt.submit`）的 stub 直接回傳結果形狀；`$` 呼叫（`command.register`、`ui.open`、`ui.close`、`ui.panes`、`ui.toast`、`agent.list`、`clock.every`）的 stub 回傳 `{ value: … }`；`turn.step` 的 stub 是 `async function*`，`return` 結果形狀。
- 型別檢查指令（不寫暫存設定檔）：

```bash
cd ~/.claude/mods-marketplaces/my-mods
T=$(find "$(ls -d /private/tmp/claude-501/bundled-skills/*/ | sort -V | tail -1)" -name claude-code.d.ts -path '*plugin-authoring*' | head -1)
npx -y -p typescript@5 tsc --noEmit --strict --noUncheckedIndexedAccess --target es2023 --lib es2023 \
  --module esnext --moduleResolution bundler --jsx react --jsxFactory h --jsxFragmentFactory Fragment \
  "$T" agent-panel/hooks/*.ts agent-panel/hooks/*.tsx agent-panel/tests/*.ts* agent-panel/types/index.d.ts
```

- 單價（每百萬 token，美元；來源 claude-api skill，資料日期 2026-10-06）。cache 寫入一律用 5 分鐘的單價（`usage` 分不出 5 分鐘或 1 小時）：

| 模型 key | 輸入 | 輸出 | cache 寫 | cache 讀 | context 上限 |
| --- | --- | --- | --- | --- | --- |
| `fable-5-1`、`mythos-5-1` | 10 | 50 | 12.5 | 0.25 | 1,000,000 |
| `fable-5`、`mythos-5` | 10 | 50 | 12.5 | 1.0 | 1,000,000 |
| `opus-5-5` | 4 | 20 | 5 | 0.2 | 1,000,000 |
| `opus-5`、`opus-4-8`、`opus-4-7`、`opus-4-6` | 5 | 25 | 6.25 | 0.5 | 1,000,000 |
| `sonnet-5-5`、`sonnet-5` | 2 | 10 | 2.5 | 0.2 | 1,000,000 |
| `sonnet-4-6` | 3 | 15 | 3.75 | 0.3 | 1,000,000 |
| `haiku-5-5`（提示 ≤ 100,000 token） | 0.1 | 0.5 | 0.125 | 0.01 | 1,000,000 |
| `haiku-5-5`（提示 > 100,000 token） | 0.5 | 2.5 | 0.625 | 0.05 | 1,000,000 |
| `haiku-4-5` | 1 | 5 | 1.25 | 0.1 | 200,000 |

  「提示」= `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。

## Review Focus

1. 同一回合平行派出很多子代理（例如 8 個）：每個都要有卡片，清單不能少列；面板超過高度時交給 Claude Code 捲動。
2. 很長的中文描述加上窄面板（例如 30 欄）：名稱與正在做什麼要依顯示寬度截斷補「…」，不能折行或超出框線。
3. 使用者按 ✕ 關掉面板後，同一回合又派出子代理：不能再自動跳出（只有這一批從空變成一列時才開）。
4. 前景子代理完成時 Agent 工具結果帶 `totalTokens`：token 以它為準；背景子代理的 Agent 結果沒有總計，維持即時累計，不能變成 0。
5. 模型 id 的各種寫法：`anthropic.claude-opus-5-5`（Bedrock）、`claude-opus-5-5[1m]`、`claude-haiku-4-5-20251001`（日期後綴）、`claude-opus-4-5@20251101`（Vertex），都要對到同一個 key；完全不認得的 id 顯示原字、費用 `≈?`。

---

### Task 1: 骨架與 `pricing.ts`

**Files:**
- Create: `agent-panel/.claude-plugin/plugin.json`
- Create: `agent-panel/hooks/hooks.json`
- Create: `agent-panel/hooks/register.tsx`（暫時只有 `export const register: Register = () => {}`）
- Create: `agent-panel/types/index.d.ts`
- Create: `agent-panel/hooks/pricing.ts`
- Test: `agent-panel/tests/pricing.test.ts`

**Interfaces:**
- Produces（`types/index.d.ts`）：

```ts
export type TokenUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type AgentStatus = 'running' | 'done' | 'failed'
export type AgentRow = {
  id: string; description: string; isNested: boolean; status: AgentStatus
  startedAt: number; endedAt: number | null; failureReason: string | null
  model: string | null; effort: string | number | null
  toolCount: number; activity: string
  lastUsage: TokenUsage | null; reportedTokens: number | null
  costUsd: number; hasUnpricedUsage: boolean
}
export type Batch = { turnId: string; agents: AgentRow[] }
// PluginState: 'agent-panel': { batch: Batch | null; tick: number }
```

  `reportedTokens` 是 spec 資料模型之外新增的欄位：查證後確認 Agent 工具結果帶 `totalTokens`（spec「實作時要先驗證的事」第 1 點），完成時以它為準。
- Produces（`pricing.ts`）：
  - `type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown'`
  - `modelInfo(modelId: string): { key: string | null; name: string; family: ModelFamily; contextWindow: number | null }`
  - `promptTokens(usage: TokenUsage): number`（輸入＋cache 讀＋cache 寫）
  - `totalTokens(usage: TokenUsage): number`（`promptTokens`＋輸出）
  - `requestCostUsd(modelId: string, usage: TokenUsage): number | null`（不在價目表回傳 null）
  - `contextPercent(modelId: string, usage: TokenUsage): number | null`（四捨五入到整數）

- [ ] **Step 1: 寫骨架檔**

`plugin.json`：`{ "name": "agent-panel", "version": "0.1.0", "description": "派出子代理時跳出面板，顯示每個子代理的模型、effort、工具次數、正在做什麼、ctx、token、估算費用與時間；/agents 開關", "author": { "name": "StalicJi" }, "types": "./types/index.d.ts" }`。`hooks.json`：`{ "modules": ["./register.tsx"] }`。`types/index.d.ts` 照上面的 Interfaces。

- [ ] **Step 2: 寫會失敗的測試 `tests/pricing.test.ts`**

```ts
test('模型 id 的各種寫法都對到同一個 key 與顯示名稱', () => {
  for (const id of ['claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5-5[1m]'])
    expect(modelInfo(id)).toEqual({ key: 'opus-5-5', name: 'Opus 5.5', family: 'opus', contextWindow: 1_000_000 })
  expect(modelInfo('claude-haiku-4-5-20251001')).toMatchObject({ key: 'haiku-4-5', name: 'Haiku 4.5', contextWindow: 200_000 })
  expect(modelInfo('claude-opus-4-5@20251101')).toMatchObject({ name: 'Opus 4.5', family: 'opus', key: null })
  expect(modelInfo('claude-fable-5-1')).toMatchObject({ name: 'Fable 5.1', family: 'fable' })
  expect(modelInfo('claude-mythos-5-1')).toMatchObject({ name: 'Mythos 5.1', family: 'fable' })
  expect(modelInfo('gpt-x')).toEqual({ key: null, name: 'gpt-x', family: 'unknown', contextWindow: null })
})

test('單次請求的費用依四種 token 各自的單價', () => {
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }
  expect(requestCostUsd('claude-opus-5-5', usage)).toBeCloseTo(0.071, 6)
  expect(requestCostUsd('claude-opus-4-5', usage)).toBeNull()
})

test('Haiku 5.5 提示超過 100,000 token 改用高價', () => {
  const small = { input_tokens: 50_000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const large = { ...small, input_tokens: 150_000 }
  expect(requestCostUsd('claude-haiku-5-5', small)).toBeCloseTo(0.0055, 6)
  expect(requestCostUsd('claude-haiku-5-5', large)).toBeCloseTo(0.0775, 6)
})

test('ctx % 以提示 token 除以 context 上限', () => {
  const usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 3000 }
  expect(promptTokens(usage)).toBe(30_000)
  expect(totalTokens(usage)).toBe(30_500)
  expect(contextPercent('claude-opus-5-5', usage)).toBe(3)
  expect(contextPercent('claude-haiku-4-5', { ...usage, cache_read_input_tokens: 45_000 })).toBe(25)
  expect(contextPercent('gpt-x', usage)).toBeNull()
})
```

- [ ] **Step 2b: 跑測試確認失敗**

Run: `cd ~/.claude/mods-marketplaces/my-mods && claude plugin test agent-panel`
Expected: FAIL（`pricing.ts` 不存在）

- [ ] **Step 3: 實作 `pricing.ts`**

先去掉 `anthropic.` 前綴與 `[…]`、`@…` 後綴，再用 `/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/` 解析；名稱是系列首字大寫加版本（`Opus 5.5`），`mythos` 歸 `fable` 系列；key 是 `系列-主版本[-次版本]`，價目表照 Global Constraints，查不到時 `key: null`。

- [ ] **Step 4: 跑測試確認通過**

Run: `claude plugin test agent-panel`
Expected: PASS（4 個）

- [ ] **Step 5: Commit**

```bash
git add agent-panel/.claude-plugin/plugin.json agent-panel/hooks/hooks.json agent-panel/hooks/register.tsx agent-panel/hooks/pricing.ts agent-panel/types/index.d.ts agent-panel/tests/pricing.test.ts
git commit -m "agent-panel：骨架與模型單價、ctx 計算"
```

### Task 2: `batch.ts`

**Files:**
- Create: `agent-panel/hooks/batch.ts`
- Test: `agent-panel/tests/batch.test.ts`

**Interfaces:**
- Consumes：`TokenUsage`、`AgentRow`、`Batch`（types）；`requestCostUsd`、`totalTokens`（pricing）
- Produces：
  - `addAgent(batch: Batch | null, currentTurnId: string | null, spawn: { id: string; description: string; isNested: boolean; startedAt: number }): Batch`
  - `recordStep(batch: Batch, agentId: string, step: { model: string; effort?: string | number; usage: TokenUsage | null }): Batch`
  - `recordToolCall(batch: Batch, agentId: string, activity: string): Batch`
  - `recordReported(batch: Batch, agentId: string, reported: { totalTokens?: unknown; totalToolUseCount?: unknown }): Batch`
  - `finishAgent(batch: Batch, agentId: string, reason: 'answer' | 'aborted' | 'error' | 'refusal', endedAt: number): Batch`
  - `seedRunning(batch: Batch | null, listed: readonly { id: string; description: string; status: string; parentId?: string }[], now: number): Batch | null`
  - `hasRunning(batch: Batch | null): boolean`
  - `agentTokens(row: AgentRow): number`（`reportedTokens` 優先，其次 `totalTokens(lastUsage)`，都沒有是 0）
  - `batchTotals(batch: Batch, now: number): { costUsd: number; hasUnpriced: boolean; tokens: number; elapsedMs: number }`

- [ ] **Step 1: 寫會失敗的測試 `tests/batch.test.ts`**

```ts
const spawn = (id: string, startedAt = 0, isNested = false) => ({ id, description: `任務 ${id}`, isNested, startedAt })
const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 5000 }

test('同一回合加進同一批，重複 id 不重複加', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = addAgent(b, 't1', spawn('b'))
  b = addAgent(b, 't1', spawn('b'))
  expect(b.turnId).toBe('t1')
  expect(b.agents.map(a => a.id)).toEqual(['a', 'b'])
  expect(b.agents[0]).toMatchObject({ status: 'running', toolCount: 0, activity: '', model: null, costUsd: 0, hasUnpricedUsage: false, reportedTokens: null })
})

test('新回合開新一批：帶過跑到一半的，清掉已完成的；turnId 不明時沿用', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = finishAgent(b, 'a', 'answer', 10)
  b = addAgent(b, 't2', spawn('c', 20))
  expect(b.turnId).toBe('t2')
  expect(b.agents.map(a => a.id)).toEqual(['b', 'c'])
  expect(addAgent(b, null, spawn('d')).agents.map(a => a.id)).toEqual(['b', 'c', 'd'])
})

test('記錄請求：模型、effort、最後一次用量與累加費用；未知模型標記；不在這一批的忽略', () => {
  let b = addAgent(null, 't1', spawn('a'))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', effort: 'xhigh', usage })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', effort: 'xhigh', usage })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage: null })
  expect(b.agents[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', lastUsage: usage })
  expect(b.agents[0]!.costUsd).toBeCloseTo(0.142, 6)
  expect(recordStep(b, 'a', { model: 'gpt-x', usage }).agents[0]!.hasUnpricedUsage).toBe(true)
  expect(recordStep(b, 'zzz', { model: 'claude-opus-5-5', usage })).toEqual(b)
})

test('工具呼叫、Agent 結果的總計、完成與三種失敗原因', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a')), 't1', spawn('b'))
  b = recordToolCall(b, 'a', '讀取 src/app.ts')
  expect(b.agents[0]).toMatchObject({ toolCount: 1, activity: '讀取 src/app.ts' })
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  expect(agentTokens(b.agents[0]!)).toBe(18_000)
  b = recordReported(b, 'a', { totalTokens: 26_000, totalToolUseCount: 12 })
  expect(agentTokens(b.agents[0]!)).toBe(26_000)
  expect(b.agents[0]!.toolCount).toBe(12)
  expect(recordReported(b, 'b', { totalTokens: 'x' }).agents[1]!.reportedTokens).toBeNull()
  expect(finishAgent(b, 'a', 'answer', 5).agents[0]).toMatchObject({ status: 'done', endedAt: 5, failureReason: null })
  expect(finishAgent(b, 'a', 'aborted', 5).agents[0]!.failureReason).toBe('已中斷')
  expect(finishAgent(b, 'a', 'error', 5).agents[0]!.failureReason).toBe('API 錯誤')
  expect(finishAgent(b, 'a', 'refusal', 5).agents[0]!.failureReason).toBe('模型拒絕')
})

test('總計：費用、未定價標記、token 加總，時間從最早開始到最晚結束或現在', () => {
  let b = addAgent(addAgent(null, 't1', spawn('a', 1000)), 't1', spawn('b', 3000))
  b = recordStep(b, 'a', { model: 'claude-opus-5-5', usage })
  b = finishAgent(b, 'a', 'answer', 5000)
  expect(batchTotals(b, 9000)).toMatchObject({ tokens: 18_000, hasUnpriced: false, elapsedMs: 8000 })
  b = finishAgent(b, 'b', 'answer', 7000)
  expect(batchTotals(b, 9000).elapsedMs).toBe(6000)
  expect(hasRunning(b)).toBe(false)
})

test('seedRunning 補上清單裡還在跑、這一批沒有的子代理', () => {
  const b = seedRunning(addAgent(null, 't1', spawn('a')), [
    { id: 'a', description: 'x', status: 'running' },
    { id: 'n', description: '巢狀', status: 'running', parentId: 'a' },
    { id: 'old', description: '舊的', status: 'completed' },
  ], 50)
  expect(b!.agents.map(a => [a.id, a.isNested, a.startedAt])).toEqual([['a', false, 0], ['n', true, 50]])
  expect(seedRunning(null, [], 0)).toBeNull()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（`batch.ts` 不存在）

- [ ] **Step 3: 實作 `batch.ts`**

全部回傳新物件，不改傳入的 batch；找不到 `agentId` 時原樣回傳同一個物件。`addAgent` 在 `batch === null` 時用 `currentTurnId ?? 'unknown'` 當 turnId。`recordStep`：`effort` 有值才覆寫；`usage` 為 null 時不動 `lastUsage` 與費用。`recordReported`：只接受數字，`totalTokens` 寫進 `reportedTokens`、`totalToolUseCount` 覆寫 `toolCount`，其他型別一律忽略（背景子代理的 Agent 結果沒有這兩個欄位）。`seedRunning` 在 `batch === null` 時回傳 null。

- [ ] **Step 4: 跑測試確認通過**

Run: `claude plugin test agent-panel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/batch.ts agent-panel/tests/batch.test.ts
git commit -m "agent-panel：這一批子代理的資料與更新規則"
```

### Task 3: `layout.ts`

**Files:**
- Create: `agent-panel/hooks/layout.ts`
- Test: `agent-panel/tests/layout.test.ts`

**Interfaces:**
- Consumes：`AgentRow`、`Batch`（types）；`modelInfo`、`contextPercent`（pricing）；`agentTokens`、`batchTotals`（batch）
- Produces：
  - `displayWidth(text: string): number`、`fitToWidth(text: string, maxColumns: number): string`（照搬 clean-view 的同名函式與 `WIDE_CHAR` 範圍）
  - `formatElapsed(ms: number): string`（`m:ss`；滿一小時 `h:mm:ss`）
  - `formatTokens(n: number): string`（`<1000` 照寫；`<1,000,000` 四捨五入成 `26k`；之後一位小數 `1.2M`）
  - `formatCost(costUsd: number, hasUnpriced: boolean): string`（`≈$0.08`；只有未定價且金額 0 時 `≈?`；兩者都有 `≈$0.28+?`；金額固定兩位小數）
  - `describeTool(tool: string, input: unknown): string`（照搬 clean-view 的 `describe`）
  - `type Span = { text: string; color?: string; isDim?: boolean; isBold?: boolean }`
  - `type Card = { lines: Span[][]; bar: string[] }`（`bar` 是每一格的顏色，長度 `columns - 2`）
  - `agentCard(row: AgentRow, options: { columns: number; now: number; frame: number }): Card`
  - `summaryMode(columns: number): 'tiles' | 'line'`（`columns < 36` 為 `line`）
  - `splitSections(batch: Batch): { running: AgentRow[]; finished: AgentRow[] }`（依派出順序；失敗放 finished）
  - `colorRuns(cells: readonly string[]): { color: string; count: number }[]`（照搬 clean-view）
  - `cometColor(frame: number): string`（照搬 clean-view：橘→粉紅→紫→藍來回，半週期 15 拍）

卡片規則（每一列以兩格縮排開頭，第一列除外）：

| 狀態 | 第 1 列 | 第 2 列 | 第 3 列 | 第 4 列 | 進度條 |
| --- | --- | --- | --- | --- | --- |
| running | `● ` 粗體，顏色 `cometColor(frame)`，巢狀加 `↳ ` | 模型名（系列色）` · effort · N tools`，其餘暗色；沒有模型時 `starting` | 正在做什麼（暗色），空字串時 `思考中` | 用量列 | 彗星：頭在 `frame % (寬 + 5)`，往左依 `[1, 0.7, 0.45, 0.25, 0.1]` 漸暗到底色 |
| done | `✓ ` 綠（theme `success`） | 同上 | 用量列 | — | 全部系列色 |
| failed | `✗ ` 紅（theme `error`） | 同上 | 失敗原因（紅） | 用量列 | 全部灰 `#8a8a94` |

用量列：`ctx 3% · 26k · ≈$0.00 · 0:02`，ctx 未知時省略 `ctx …` 那段；時間用 `now - startedAt` 或 `endedAt - startedAt`。名稱與正在做什麼用 `fitToWidth` 截到該列可用寬度。

- [ ] **Step 1: 寫會失敗的測試 `tests/layout.test.ts`**

```ts
const row = (patch: Partial<AgentRow> = {}): AgentRow => ({
  id: 'a', description: 'Review the whole kit', isNested: false, status: 'running', startedAt: 0, endedAt: null,
  failureReason: null, model: 'claude-opus-5-5', effort: 'xhigh', toolCount: 12, activity: '讀取 src/app.ts',
  lastUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 0 },
  reportedTokens: null, costUsd: 0.004, hasUnpricedUsage: false, ...patch,
})
const text = (line: Span[]) => line.map(s => s.text).join('')

test('格式：時間、token、費用', () => {
  expect([formatElapsed(2000), formatElapsed(47_000), formatElapsed(3_723_000)]).toEqual(['0:02', '0:47', '1:02:03'])
  expect([formatTokens(950), formatTokens(26_400), formatTokens(150_000), formatTokens(1_240_000)]).toEqual(['950', '26k', '150k', '1.2M'])
  expect([formatCost(0.08, false), formatCost(0, true), formatCost(0.28, true)]).toEqual(['≈$0.08', '≈?', '≈$0.28+?'])
})

test('依顯示寬度截斷，中文一字兩格', () => {
  expect(fitToWidth('Review the whole kit', 10)).toBe('Review th…')
  expect(fitToWidth('檢查整份設計文件與實作計畫', 11)).toBe('檢查整份設…')
  expect(displayWidth(fitToWidth('檢查整份設計文件與實作計畫', 11))).toBeLessThanOrEqual(11)
})

test('執行中卡片 5 列：名稱、模型、正在做什麼、用量、進度條', () => {
  const card = agentCard(row(), { columns: 40, now: 2000, frame: 3 })
  expect(card.lines.map(text)).toEqual(['● Review the whole kit', '  Opus 5.5 · xhigh · 12 tools', '  讀取 src/app.ts', '  ctx 3% · 27k · ≈$0.00 · 0:02'])
  expect(card.bar).toHaveLength(38)
  expect(card.lines[1]![0]).toMatchObject({ text: '  ' })
  expect(card.lines[1]![1]).toMatchObject({ text: 'Opus 5.5', color: '#f79a4f' })
})

test('完成 4 列、失敗 5 列，巢狀加箭頭，沒有模型顯示 starting', () => {
  const done = agentCard(row({ status: 'done', endedAt: 44_000, model: 'claude-sonnet-5-5' }), { columns: 40, now: 50_000, frame: 0 })
  expect(done.lines.map(text)[0]).toBe('✓ Review the whole kit')
  expect(done.lines).toHaveLength(3)
  expect(new Set(done.bar)).toEqual(new Set(['#6f7df2']))
  const failed = agentCard(row({ status: 'failed', failureReason: '已中斷', endedAt: 9000 }), { columns: 40, now: 9000, frame: 0 })
  expect(failed.lines.map(text)[2]).toBe('  已中斷')
  expect(new Set(failed.bar)).toEqual(new Set(['#8a8a94']))
  expect(text(agentCard(row({ isNested: true, model: null, activity: '' }), { columns: 40, now: 0, frame: 0 }).lines[0]!)).toBe('● ↳ Review the whole kit')
  expect(agentCard(row({ model: null, activity: '' }), { columns: 40, now: 0, frame: 0 }).lines.map(text).slice(1, 3)).toEqual(['  starting · xhigh · 12 tools', '  思考中'])
})

test('窄面板：很長的中文描述截斷，不超過寬度', () => {
  const card = agentCard(row({ description: '把這週每一天的工作日報都補齊並且彙總成月報再寄出' }), { columns: 30, now: 0, frame: 0 })
  for (const line of card.lines) expect(displayWidth(text(line))).toBeLessThanOrEqual(30)
})

test('統計區塊模式與分組', () => {
  expect([summaryMode(36), summaryMode(35)]).toEqual(['tiles', 'line'])
  const b = { turnId: 't', agents: [row({ id: 'r' }), row({ id: 'd', status: 'done' }), row({ id: 'f', status: 'failed' })] }
  const { running, finished } = splitSections(b)
  expect([running.map(a => a.id), finished.map(a => a.id)]).toEqual([['r'], ['d', 'f']])
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL（`layout.ts` 不存在）

- [ ] **Step 3: 實作 `layout.ts`**

`displayWidth`、`fitToWidth`、`colorRuns`、`cometColor`、`describeTool` 從 `clean-view/hooks/register.tsx` 照搬（`describe` 改名 `describeTool`），檔頭註明來源；`WIDE_CHAR` 那行依 Global Constraints 用 `chr(92)` 寫入。用量列 token 用 `agentTokens(row)`；巢狀箭頭算在名稱可用寬度內。

- [ ] **Step 4: 跑測試確認通過**

Run: `claude plugin test agent-panel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/layout.ts agent-panel/tests/layout.test.ts
git commit -m "agent-panel：卡片版面、格式與截斷"
```

### Task 4: 收集事件與自動開窗格

**Files:**
- Modify: `agent-panel/hooks/register.tsx`
- Test: `agent-panel/tests/register.test.tsx`

**Interfaces:**
- Consumes：Task 2 的全部函式；`describeTool`（layout）
- Produces：模組常數 `PANE_ID = 'agent-panel'`；atom `batchAtom = atom({ plugin: 'agent-panel', key: 'batch' }, null)`、`tickAtom = atom({ plugin: 'agent-panel', key: 'tick' }, 0)`；模組變數 `currentTurnId: string | null`、`hasWarnedNarrow: boolean`；最上層函式 `openPanel($: EngineInterface): Promise<void>`（開窗格，`isPlaced: false` 且還沒提示過時 `$.ui.toast('子代理面板放不下：打 /agents 開啟')`）。

| hook | 行為 |
| --- | --- |
| `turn.start` | `currentTurnId = e.turnId`，回傳 `next(e)` |
| `agent.spawn` | `const r = await next(e)`；`r.deny`、沒有 `r.agentId`、`e.teammateId` 時直接回傳 r；否則 `addAgent`（`isNested: e.parentAgentId !== undefined`、`startedAt: await $.clock.now()`）；結果開了新的一批（之前沒有批次，或 turnId 跟之前不同）時 `openPanel($)`，同一批加列不開 |
| `turn.step` | `async function*`：`const r = yield* next(e)`；有 `e.agentId` 時 `recordStep(batch, e.agentId, { model: e.model, effort: e.effort, usage: r.usage })`；`return r` |
| `tool.call` | 有 `e.agentId`：`recordToolCall(batch, e.agentId, describeTool(e.tool, e))` 後 `return next(e)`。沒有 `e.agentId` 且 `e.tool === 'Agent'`：`const r = await next(e)`，`r.result` 是物件且有字串 `agentId` 時 `recordReported`，回傳 r |
| `turn.complete` | 有 `e.agentId`：`finishAgent(batch, e.agentId, e.reason, await $.clock.now())`；回傳 `next(e)` |
| `session.start` | `next(e)` 後註冊 `/agents`（`.catch(() => {})`），`seedRunning(batch, await $.agent.list(), now)`（`.catch` 失敗就略過） |

每個 hook 的記錄部分包在 `try/catch`，失敗只略過記錄。

- [ ] **Step 1: 寫會失敗的測試 `tests/register.test.tsx`**

engine 替身登記：`session.start`、`turn.start`、`turn.complete`、`agent.spawn`（依序回 `{ model: 'claude-opus-5-5', agentId: 'a1' }`、`'a2'`…）、`turn.step`（`async function*` 回 `{ turnId, index, answer: '', toolUses: [], stopReason: 'end_turn', usage }`）、`tool.call`（Agent 回 `{ result: { agentId: 'a1', totalTokens: 26_000, totalToolUseCount: 12 }, text: '' }`，其他回 `{ result: {}, text: 'ok' }`）、`command.register`、`ui.open`（記錄次數，回 `{ value: { isPlaced } }`，`isPlaced` 由測試切換）、`ui.toast`（記錄文字）、`agent.list`、`clock.now`；state 用記憶體 store 替身（`state.get`／`state.set`）。

測試（名稱與斷言）：
- `派出第一個子代理時開窗格，同一批第二個不重開`：spawn 兩次 → `ui.open` 1 次，參數 `{ id: 'agent-panel', title: 'Agents', columns: 42 }`，沒有 `focus`；state 的 batch 兩列。
- `被擋下、沒有 agentId、teammate 不加入`：三種 spawn → batch 仍是 null，`ui.open` 0 次。
- `使用者手動關掉後同一回合再派，不再自動跳出`：spawn a1 → 模擬手動關（不經 mod）→ spawn a2 → `ui.open` 仍 1 次。
- `子代理的請求記到對的列，主迴圈的請求不記`：`$.turn.step` 帶 `agentId: 'a1'` 與不帶各一次 → a1 的 `lastUsage` 等於替身的 usage、`model` 為 `claude-opus-5-5`；主迴圈那次沒有改變任何列。
- `子代理的工具呼叫累加次數並更新正在做什麼`：`$.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: 'a1' })` → `toolCount 1`、`activity '讀取 src/app.ts'`。
- `前景子代理完成時以 Agent 結果的總計為準`：主迴圈 `$.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' })` → a1 `reportedTokens 26_000`、`toolCount 12`。
- `子代理結束標成完成或失敗`：`$.turn.complete({ reason: 'aborted', agentId: 'a1', … })` → `status 'failed'`、`failureReason '已中斷'`。
- `窗格放不下時只提示一次`：`isPlaced: false`，連續兩批各派一個 → `ui.toast` 1 次，內容 `子代理面板放不下：打 /agents 開啟`。
- `平行派出 8 個子代理全部記下`：spawn 8 次 → batch 8 列、`ui.open` 1 次。

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL

- [ ] **Step 3: 實作上表的 hook 與 `openPanel`**

- [ ] **Step 4: 跑測試確認通過**

Run: `claude plugin test agent-panel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/register.tsx agent-panel/tests/register.test.tsx
git commit -m "agent-panel：收集子代理事件並自動開啟面板"
```

### Task 5: 關閉規則、`/agents`、計時器與畫面

**Files:**
- Modify: `agent-panel/hooks/register.tsx`
- Test: `agent-panel/tests/register.test.tsx`（加測試）、`agent-panel/tests/render.test.tsx`

**Interfaces:**
- Consumes：Task 3 的 `agentCard`、`summaryMode`、`splitSections`、`colorRuns`、`formatCost`、`formatTokens`、`formatElapsed`；Task 2 的 `batchTotals`、`hasRunning`；Task 4 的 atom 與 `openPanel`
- Produces：最上層函式 `syncTimer($: EngineInterface): Promise<void>`（窗格已放上畫面且 `hasRunning(batch)` 時確保有一個 `$.clock.every(200, …)` 遞增 `tick`，否則取消）；模組變數 `timer: Timer | undefined`

| 規則 | 行為 |
| --- | --- |
| `prompt.submit` | `e.origin.kind` 是 `composer` 或 `bridge`，而且 `e.text.trimStart()` 不是 `/` 開頭時 `$.ui.close({ id: PANE_ID })`；一律回傳 `next(e)` |
| `/agents`（`command.run`） | `$.ui.panes()` 裡 `agent-panel` 已放上畫面就關閉並回 `{ text: '已關閉子代理面板。' }`；否則開啟並回 `{ text: '已開啟子代理面板。' }` |
| `syncTimer` 的呼叫時機 | 開窗格後、關窗格後、每次 batch 寫入後、`session.start` 結束前 |
| `session.end` | 取消計時器；`e.reason === 'clear'` 時 batch 設回 null |
| `Pane` 畫面 | 讀 batch 與 tick；`columns = e.props.bodyColumns`。batch 為 null 時只畫暗色 `這個 session 還沒有派出子代理`。否則依序畫：粗體 `Agents`；`summaryMode` 為 `tiles` 時三個 `borderStyle="round"` 的 Box（寬 `Math.floor(columns / 3)`，標題暗色 `Cost`／`Tokens`／`Time`，下一列是值），為 `line` 時一行 `≈$0.28 · 150k · 0:47`；有執行中時暗色 `Running · N` 加卡片；有完成時暗色 `Finished · N` 加卡片；卡片之間暗色 `'─'.repeat(columns)`；進度條用 `colorRuns` 合併同色格子，每段一個 `Text` 畫 `'▆'.repeat(count)`，前面兩格縮排 |

- [ ] **Step 1: 寫會失敗的測試**

`register.test.tsx` 加：
- `你送出訊息時關閉面板，/ 開頭、背景通知與外掛送的不關`：`origin.kind` 為 `composer` 文字 `繼續` → `ui.close` 1 次；`composer` 文字 `/agents`、`task-notification`、`plugin` 各一次 → 仍 1 次。
- `/agents 開著就關、關著就開`：`ui.panes` 回 `[{ id: 'agent-panel', isPlaced: true }]` 時 `command.run` → `ui.close` 1 次、回覆 `已關閉子代理面板。`；回 `[]` 時 → `ui.open` 1 次、回覆 `已開啟子代理面板。`。
- `有子代理在跑而且面板開著才跑計時器`：spawn 後 `clock.every` 1 次（間隔 200）；`turn.complete` 讓最後一個結束後計時器被取消（`cancel` 被呼叫）。
- `熱重載後 session.start 接回計時器`：state 先放一批有 running 的 batch、`ui.panes` 回已放上 → `session.start` 後 `clock.every` 1 次。
- `/clear 清空批次`：`session.end({ reason: 'clear' })` → state batch 為 null。

`render.test.tsx`：掛載 `{ plugin: 'agent-panel', surface: 'terminal', component: 'Pane', requestId: 'agent-panel', props: { title: 'Agents', isFocused: false, bodyColumns: 42, placement: 'dock' } }`：
- `沒有批次時顯示提示`：找得到 `這個 session 還沒有派出子代理`。
- `三格統計、Running 與 Finished 分組`：state 放一批 1 個 running、2 個 done → 找得到 `Agents`、`Cost`、`Tokens`、`Time`、`Running · 1`、`Finished · 2`、三個 round 邊框的 Box、`✓ ` 開頭的名稱兩個。
- `窄面板改成一行統計`：`bodyColumns: 30` → 沒有 `Cost` 標題，找得到符合 `/^≈\$\d+\.\d{2} · .+ · \d+:\d{2}$/` 的 Text。
- `8 個子代理全部畫出來`：8 個 running → `●` 開頭的名稱 8 個。

- [ ] **Step 2: 跑測試確認失敗**

Run: `claude plugin test agent-panel`
Expected: FAIL

- [ ] **Step 3: 實作上表的規則、`syncTimer` 與 `Pane` 畫面**

- [ ] **Step 4: 跑測試與全部檢查**

Run: `claude plugin test agent-panel && claude plugin validate agent-panel && sh scripts/check-contracts.sh`，再跑 Global Constraints 的型別檢查指令
Expected: 測試全過；validate 顯示 `✔ Validation passed`，有警告時逐一回報；`check-contracts.sh` 顯示合約一致；tsc 沒有輸出

- [ ] **Step 5: Commit**

```bash
git add agent-panel/hooks/register.tsx agent-panel/tests/register.test.tsx agent-panel/tests/render.test.tsx
git commit -m "agent-panel：關閉規則、/agents、計時器與面板畫面"
```

### Task 6: 登記、安裝與真實 session 驗證

**Files:**
- Modify: `.claude-plugin/marketplace.json`（`plugins` 加 `{ "name": "agent-panel", "source": "./agent-panel", "description": "Agent Panel：派出子代理時跳出面板，顯示模型、effort、工具次數、正在做什麼、ctx、token、估算費用與時間；/agents 開關" }`）
- Modify: `README.md`（mod 表格加 `| \`agent-panel\` | 派出子代理時跳出面板（右側或輸入框上方），顯示每個子代理的模型、用量、估算費用與時間；\`/agents\` 開關 |`，安裝指令段落加 `claude plugin install agent-panel@my-mods`）

- [ ] **Step 1: 登記並確認 JSON 有效**

Run: `python3 -I -c 'import json; json.load(open(".claude-plugin/marketplace.json")); print("OK")' && claude plugin validate .`
Expected: `OK`，validate 通過

- [ ] **Step 2: 安裝**

Run: `claude plugin marketplace update my-mods && claude plugin install agent-panel@my-mods`
Expected: `Successfully installed plugin: agent-panel@my-mods`。被 auto mode 擋下時，請使用者用 `!` 執行同一行。之後請使用者跑 `/reload-plugins`，數量應比原本多 1。

- [ ] **Step 3: 真實 session 驗證（請使用者配合）**

1. 請使用者打一次 `/agents`（建立「親手開過」紀錄），再打一次關掉。
2. 派兩個小型子代理（例如兩個 `Explore`，各讀一個 my-mods 的 README 段落），其中一個 `run_in_background: true`。
3. 子代理執行中用 `cmux identify` 取得 focused 的 workspace／surface，`cmux read-screen` 擷取畫面，確認：面板自動跳出、`Running · 2`、模型與 effort、工具次數會變、`ctx`、token、`≈$`、時間在跑。
4. 前景子代理完成後，比對面板的 token 與 Agent 結果顯示的「· Nk tokens」相同。
5. 背景子代理完成喚起 Claude 後，面板仍開著；使用者送出下一則訊息時面板關閉。

Expected: 1～5 都符合；不符合的項目回報給使用者，修正後重跑對應的測試。

- [ ] **Step 4: 停用 agent-radar**

Run: `claude plugin disable agent-radar@claude-code-mods`
Expected: 停用成功；被 auto mode 擋下時請使用者用 `!` 執行。請使用者 `/reload-plugins`，確認輸入框上方不再有 agent-radar 的那一行。

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/marketplace.json README.md
git commit -m "agent-panel：登記到 marketplace 並補 README"
```
