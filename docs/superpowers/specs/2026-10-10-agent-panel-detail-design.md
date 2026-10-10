# agent-panel 子代理詳細頁設計

- 日期：2026-10-10
- 狀態：設計已確認，待寫實作計畫
- 位置：`my-mods/agent-panel/`（在現有 mod 上加功能，原設計見 `2026-10-09-agent-panel-design.md`）

## 目的

面板停靠在右邊時，點某個子代理的卡片標題，面板就切換成那個子代理的詳細頁，依時間列出它做過的工具呼叫、中途說的話與最後的回報，不用離開主畫面就能看它在做什麼、做到哪裡。

Claude Code 沒有開放 mod 切換到原生的子代理畫面（`$.agent` 只有 `list`、`register`），所以詳細頁是 mod 自己記錄、自己畫的。

## 已確認的決定

| 項目 | 決定 |
|---|---|
| 顯示方式 | 切換成詳細頁：整個面板換成那個子代理，最上面有「← 返回」；一次只看一個 |
| 資料來源 | 事件即時記錄到 `$.state`（`tool.call`、`turn.step`），不讀子代理的紀錄檔 |
| 訊息長度 | 中途訊息最多顯示 3 行；最後的回報完整顯示 |
| 保留上限 | 每個子代理最多 100 筆；訊息存前 2,000 字；回報存前 20,000 字 |
| 時間格式 | 相對時間 `+分:秒`（從子代理開始算），滿 1 小時是 `+時:分:秒` |
| 哪裡能點 | 只有面板停靠右邊時；放在輸入框上方時維持現狀 |

不讀紀錄檔（`~/.claude/projects/<專案>/<session>/subagents/agent-<id>.jsonl`）的原因：檔案很大（只等待 150 秒的示範子代理就有 290KB），是沒有文件的內部格式，即時更新要輪詢重新解析。代價是只記得到 mod 載入之後的事。

## 不做的事

- 自訂鍵盤快捷鍵（按鈕本身就能用 Claude Code 內建的焦點操作加 Enter）
- 搜尋、篩選紀錄
- 工具的完整輸出（出錯時只留錯誤訊息第一行）
- 思考內容（API 拿不到）
- 面板在輸入框上方時的詳細頁
- 跨批次的歷史紀錄（新的一批開始就丟掉舊的）

## 前提（來自 Claude Code 2.1.296 的 mod API）

- `Button`：終端機上滑鼠點擊，或焦點在它上面按 Enter，會觸發 `ui.press` 與它的 `onPress`。`plain` 時只畫標籤本身（沒有 `[ ]`），焦點與滑鼠移上去時反白。子元素可以是同一列裡的多段 `Text`（例如名稱加一段淡色時間），所以能點的是卡片的標題列，不是整張卡片。全螢幕版面用滑鼠點按鈕已實測可用（blast-radius 的 Cancel）。
- `turn.step` 的結果（`TurnStepResult`）有 `answer`：那一步看得到的回覆文字，只呼叫工具時是空字串；`toolUses` 是那一步要求的工具；`stopReason` 是停下的原因。
- `tool.call` 的輸入有 `tool`、工具參數與選填的 `tool_use_id`；結果是 `{ result, text }`，出錯時多 `isError`，被拒絕時是 `{ deny }`。
- 子代理可以用 `SubagentHandback` 工具交回回報（Agent 工具的完成結果有 `handback` 與 `handbackReport` 欄位）；這個工具呼叫也會經過子代理的 `tool.call`。
- 窗格內容比高度長時，使用者可以自己捲動；畫面的 `e.props.scroll` 有 `offset`（目前第一列）與 `bodyRows`。`$.ui.scroll({ in: <窗格 id>, to: 'end' })` 可捲到最底下，回應使用者點擊時允許。型別說明提到終端機本身會「跟著尾端」。
- 狀態寫入不能在 `ui.render` 畫圖時做，要在 `onPress` 或其他事件裡。
- 載入器規則（之前踩過）：`$` 只能傳給檔案最上層宣告的函式，傳給 `register` 裡的閉包會讓整個模組載入失敗；`onPress` 要呼叫最上層的函式。

## 架構

| 檔案 | 改動 |
|---|---|
| `types/index.d.ts` | 新增紀錄型別與兩個 state 鍵 `logs`、`selected` |
| `hooks/log.ts`（新） | 純函式：新增一筆、更新工具結果、標記未完成、裁到 100 筆、換批次重設 |
| `hooks/detail.ts`（新） | 純函式：把一個子代理的紀錄排成一列一列的 `Span[]`（圖示、顏色、換行、3 行截斷、相對時間） |
| `hooks/register.tsx` | 收集紀錄；`onPress` 處理；`ui.render` 依狀態畫詳細頁或清單；標題列包成 `Button` |
| `hooks/layout.ts` | 不改；標題列與精簡列沿用現有組版，只在 register 外面包一層 `Button` |

### 資料模型

```ts
// 工具呼叫的狀態；unfinished 是子代理結束時結果還沒回來（中斷、失敗、熱重載）
export type ToolOutcome = 'running' | 'ok' | 'error' | 'denied' | 'unfinished'

export type LogEntry =
  | {
      kind: 'tool'
      // tool_use_id，沒有就由 hook 產生
      id: string
      at: number
      // describeTool 產生的一行摘要，跟卡片上「正在做什麼」一致
      summary: string
      outcome: ToolOutcome
      // 出錯或被拒絕時的第一行，其他為 null
      errorLine: string | null
    }
  | { kind: 'message'; at: number; text: string }
  | { kind: 'report'; at: number; text: string }

// dropped：超過 100 筆時從最舊的丟掉了幾筆
export type AgentLog = { entries: LogEntry[]; dropped: number }

// turnId 跟 batch 的不同就是舊資料，下一次寫入直接換掉
export type Logs = { turnId: string; byAgent: Record<string, AgentLog> }
```

`PluginState['agent-panel']` 新增：

- `logs: Logs | null`
- `selected: string | null`：目前打開詳細頁的 agentId

`logs` 跟 `batch` 分開存：清單畫面不讀 `logs`，新增紀錄不會讓清單重畫，只有詳細頁讀它。兩個鍵都由 host 保存，熱重載後還在。改完合約要跑 `scripts/check-contracts.sh`。

## 資料收集

都只觀察：寫入出錯就略過這一筆，不影響子代理。沿用 `isInBatch` 檢查，主代理自己的工具與 Claude Code 內部 fork（例如 compaction）不記錄。寫入用 `update`，多個子代理同時寫入發生版本衝突時自動重試。

| 事件 | 記錄 |
|---|---|
| 子代理的 `tool.call`（`SubagentHandback` 以外） | 呼叫前加一筆 `tool`，`outcome: 'running'`；等 `next(e)` 回來後依結果改成 `ok`、`error`（`isError`）或 `denied`（`deny`），出錯與被拒絕時存錯誤第一行 |
| 子代理的 `SubagentHandback` | 加一筆 `report`，文字取回報參數；不另外記成工具 |
| 子代理 `turn.step` 的結果，`answer` 不是空的 | 那一步沒有要求工具、而且這個子代理還沒有 `report`：記成 `report`（這是直接回覆的最後答案）；其他情況記成 `message` |
| 子代理的 `turn.complete` | 還在 `running` 的工具改成 `unfinished` |
| 新的一批開始（`recordSpawn` 的 `isNewBatch`） | `selected` 清空；`logs` 因 `turnId` 不同，下一次寫入換掉 |
| `session.end` 的 `clear` | `logs`、`selected` 跟 `batch` 一起清空 |

文字處理：

- 訊息存前 2,000 字，回報存前 20,000 字（以字元計）。
- 錯誤第一行：取第一個非空白行，去掉 `<tool_use_error>` 標籤與 ANSI 色碼（跟 clean-view 的處理一樣），最多 200 字。
- 每個子代理超過 100 筆時從最舊的丟，`dropped` 加上丟掉的筆數。

## 版面

### 清單畫面

- 面板停靠右邊（`placement === 'dock'`）時，每張卡片的標題列包成 `Button`（`plain`，`key` 用 `open-<agentId>`），外觀不變；精簡模式（一個子代理一列）的那一列也包成 `Button`。
- 放在輸入框上方（`inline`）時不包按鈕，跟現在一樣。

### 詳細頁

條件：面板停靠右邊、`selected` 有值、而且那個子代理在這一批裡。任一條件不成立就畫清單；`inline` 時 `selected` 保留，回到停靠時繼續顯示詳細頁。

由上往下：

1. 第一列：左邊 `Button`「← 返回」（`plain`，`key: 'back'`），右邊淡色顯示整批狀態（`●1 ✓2` 與耗時，取 `statusLine` 的內容）。
2. 那個子代理的卡片，跟清單裡同一個畫法（小人、模型、工具次數、正在做什麼、ctx、進度條），會即時更新。
3. 分隔線。
4. 紀錄，舊的在上、新的在下：

```
+0:04 ✓ 讀取 config.ghostty
+0:06 ✓ 執行 gh search code …
+0:10 「找到 4 個 cmux 自有鍵，接著確認
       哪些有啟用…」
+0:12 ✗ 讀取 GhosttyConfig.swift
       File does not exist
+1:58 … 搜尋 ConfigPaths            0:04
```

| 紀錄 | 畫法 |
|---|---|
| 工具 `ok` | `✓`（綠色）＋摘要，一行，放不下截斷 |
| 工具 `error` | `✗`（紅色）＋摘要；下一列縮排、淡紅色顯示錯誤第一行 |
| 工具 `denied` | `⊘`（黃色）＋摘要；下一列縮排顯示被拒絕原因的第一行 |
| 工具 `running` | `…`＋摘要，右邊顯示已經跑了多久 |
| 工具 `unfinished` | 淡色 `·`＋摘要 |
| 中途訊息 | `「`＋全文＋`」`，自動換行，最多 3 行，超過時第 3 行結尾換成 `…」` |
| 回報 | 一列「回報」，下面完整顯示全文，自動換行 |

- 時間欄是相對子代理 `startedAt` 的 `+分:秒`；續行對齊時間欄之後那一欄。
- 有 `dropped` 時，紀錄最上面一列淡色「更早的 N 筆已省略」。
- 沒有任何紀錄時（例如熱重載前就在跑），顯示淡色「mod 載入前的紀錄沒有保留」。
- 寬度算法沿用 `displayWidth`（中文字 2 欄）。
- 子代理執行中面板每 0.2 秒重畫一次，回報最長可到幾百列，所以 `detail.ts` 的換行結果依「紀錄內容、寬度」快取，不每次重算。

## 互動

- 點標題列：`selected` 設成那個 agentId，接著 `$.ui.scroll({ in: 'agent-panel', to: 'end' })` 捲到最新一筆。
- 點「← 返回」：`selected` 清空。
- 停在最底下時，新紀錄出現會跟著往下捲；往上捲去看舊紀錄時不會被拉回來。先靠終端機本身「跟著尾端」的行為，實作時驗證；不成立就用 `e.props.scroll.offset` 判斷上一次是否在最底下，是才捲到底。
- 每次打開面板（新的一批自動開、`/agents` 打開）都從清單開始：`selected` 清空。
- 面板什麼時候關閉不變：沒有子代理在跑時，使用者送出一般訊息就關閉。
- `onPress` 只呼叫檔案最上層的函式（例如 `selectAgent($, agentId)`、`showList($)`）。

## 錯誤處理

- 收集紀錄的每個寫入都包 try/catch，出錯就略過，不影響子代理與其他功能。
- 詳細頁畫面出錯沿用現有的保護：接住例外，畫一行「面板暫時畫不出來：原因」，不讓 Claude Code 卸載窗格。
- `SubagentHandback` 的參數找不到預期欄位時，退回取第一個字串欄位，不讓回報整個消失。

## 測試

單元測試：

- `log.ts`：超過 100 筆從最舊的丟、`dropped` 正確；換批次重設；工具狀態依 id 更新（running → ok／error／denied）；`turn.complete` 把 running 改成 unfinished；2,000 與 20,000 字上限；最後答案記成 report，已有 report 時記成 message。
- `detail.ts`：各種紀錄的圖示與顏色；工具列截斷到指定寬度、中文字寬度；中途訊息最多 3 行加 `…」`；回報完整換行；「已省略」與「沒有紀錄」提示；`+分:秒` 與 `+時:分:秒`；快取不影響結果。

`register` 測試（`claude plugin test`，用現有的 `tests/state-store.ts` 替身與測試套件內建的 `ui.press`）：

- 子代理的工具呼叫記錄開始與結果（成功、`isError`、`deny`）；`answer` 記錄；`SubagentHandback` 變成 report；不在這一批的 agentId 略過。
- 點標題設定 `selected`、點返回清除、新的一批清除、`/agents` 打開清除。
- 停靠且有 `selected` 時畫詳細頁；`inline` 時畫清單；按鈕只在停靠時出現。

其他：

- 現有 146 個測試全部通過。
- `claude plugin validate`、`tsc`、`scripts/check-contracts.sh` 通過。

## 完成標準

- 全螢幕版面、面板停靠右邊時，點卡片標題會切到詳細頁，點「← 返回」回到清單。
- 詳細頁照上面的版面顯示工具呼叫（含成功、出錯、被拒絕、執行中、未完成）、中途訊息（最多 3 行）與完整回報，時間是 `+分:秒`。
- 放在輸入框上方時行為跟現在一樣。
- 上面列的測試與檢查全部通過，並在 cmux 實機驗證過。

實機驗證（cmux 全螢幕、面板停靠右邊）：派一個示範子代理，讀幾個檔、故意讀一個不存在的檔、中途說一句話、最後交回報告。使用者負責點擊與往上捲動，Claude 用 `cmux read-screen` 檢查詳細頁內容、圖示、3 行截斷、完整回報與返回；往上捲之後有新紀錄時，確認不會被拉回最底下。

## 實作時驗證的事

- `SubagentHandback` 的參數欄位名稱（用真實呼叫確認）。
- 直接回覆的最後一步，`stopReason` 的實際值，以及「沒有要求工具」能不能可靠判斷最後答案。
- `Button` 加 `plain` 包住多段帶顏色的 `Text` 時，外觀是否跟原本的標題列一致。
- `onPress` 裡先寫 `selected` 再 `$.ui.scroll` 到底，捲動是否發生在詳細頁畫出來之後。
- 終端機的「跟著尾端」是否成立；不成立就改用 `offset` 判斷。
- 詳細頁裡的卡片畫圖片版小人是否正常（跟清單同一個 `Image` 畫法）。
