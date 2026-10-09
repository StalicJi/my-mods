# agent-panel 設計

- 日期：2026-10-09
- 狀態：待審核
- 位置：`my-mods/agent-panel/`（my-mods marketplace 的新 mod）

## 目的

Claude 派出子代理時，自動跳出一個面板，一眼看出這一批子代理各自在做什麼、用什麼模型、跑了多久、用了多少 token、大約花多少錢。完成後停用功能重疊的 `agent-radar@claude-code-mods`。

## 已確認的決定

| 項目 | 決定 |
| --- | --- |
| 位置 | 以右側窄欄設計（向 Claude Code 要求約 42 欄寬）；Claude Code 全螢幕版面且終端機至少 110 欄時停靠右邊，否則由 Claude Code 放到輸入框上方，兩種情況用同一份版面 |
| 跳出時機 | 這一回合派出第一個子代理時自動開啟；另有 `/agents` 指令手動開關 |
| 範圍 | 只列這一回合派出的子代理；上方總計也只算這一批 |
| 每個子代理 | 名稱、模型、effort、工具次數、正在做什麼、ctx %、token、估算費用、時間、進度條 |
| 進度 | 工具次數加正在做什麼；進度條在執行中跑動畫，完成後填滿，不假裝知道百分比 |
| 關閉 | 使用者送出下一則訊息時由 mod 自己關閉 |
| agent-radar | 本 mod 驗證完成後停用（不解除安裝） |
| 標籤語言 | 標籤用英文（Agents、Cost、Tokens、Time、Running、Finished、tools、ctx）；正在做什麼、失敗原因用繁體中文 |

## 不做的事

- 不顯示任務名稱（截圖裡的「Launch kit」）
- 不畫像素頭像：cmux 不支援終端機圖片協定，改用符號與顏色
- 不顯示 heavy／light 這類模型分級（那是 switchboard mod 的功能）
- 不做待辦清單式的 x/y 進度
- 不做整個 session 的累計
- 面板裡不放按鈕

## 前提（來自 Claude Code 2.1.295 的 mod API）

| 事實 | 影響 |
| --- | --- |
| 窗格只有在全螢幕（alternate screen）版面、終端機至少 110 欄時才停靠在右邊；一般畫面一律放在輸入框上方 | 版面要在窄欄與整寬兩種位置都能看 |
| mod 自己開的窗格（unasked）要終端機至少 144 欄才會放；使用者親手開過同一個窗格後降到 110 欄，紀錄跨 session 保留，直到使用者手動關閉窗格（✕ 或 ctrl+x x） | 提供 `/agents` 讓使用者親手開一次；mod 一律用 `$.ui.close` 關，不清掉紀錄 |
| `agent.spawn` 的 `next(e)` 回傳 `agentId`；`turn.step`（串流事件）的輸入有 `model`、`effort`、`agentId`，結果有 `usage`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`） | 每個子代理的模型、effort、token 都拿得到 |
| API 不提供美元費用 | 費用用 token 數乘以各模型單價估算，畫面一律標「≈」 |
| 外掛不能把鍵盤焦點從輸入框搶過來 | 面板不放按鈕，不需要焦點 |

## 架構

| 檔案 | 職責 |
| --- | --- |
| `hooks/batch.ts` | 批次資料與更新規則，全部是純函式：開新一批、新增子代理、記錄一次請求的用量、工具呼叫、標成完成或失敗 |
| `hooks/pricing.ts` | 模型 id 轉顯示名稱與系列、單價表、context 上限、單次請求的費用、ctx % |
| `hooks/layout.ts` | 版面用的純函式：依顯示寬度截斷、時間與 token 的格式、統計區塊要用三格還是單行、各狀態卡片的列與顏色、工具呼叫的描述文字（用字與 clean-view 的 `describe` 一致；mod 之間不能共用程式碼，所以複製一份） |
| `hooks/register.tsx` | 接事件、開關窗格、計時器、把 `layout.ts` 算好的結果畫成元素；盡量薄 |
| `types/index.d.ts` | state 合約 |
| `tests/*.test.ts(x)` | 見「測試」 |

`layout.ts` 是寫 spec 時從 `register.tsx` 拆出來的，讓版面規則能不經畫面直接測試。

### 資料模型

```ts
type AgentStatus = 'running' | 'done' | 'failed'

type AgentRow = {
  id: string
  description: string
  isNested: boolean                 // 由子代理再派出的
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  failureReason: string | null      // 已中斷、API 錯誤、模型拒絕
  model: string | null              // 最後一次請求的模型 id
  effort: string | number | null    // 最後一次請求的 effort
  toolCount: number
  activity: string                  // 正在做什麼，例如「讀取 src/app.ts」
  lastUsage: ModelUsage | null      // 最後一次請求的 4 種 token 數
  costUsd: number                   // 已知單價的請求累計
  hasUnpricedUsage: boolean         // 有請求的模型不在價目表
}

type Batch = { turnId: string; agents: AgentRow[] }
```

state 合約：

```ts
'agent-panel': {
  batch: Batch | null   // 最近一批
  tick: number          // 動畫計數器，只有面板讀
}
```

資料存在 `$.state`，熱重載後仍在；模組自己的變數（目前主回合的 turnId、計時器、是否已提示過）重載後重來。

## 資料收集

| 事件 | 處理 |
| --- | --- |
| `turn.start`（主迴圈，沒有 `agentId`） | 記下目前主回合的 turnId |
| `agent.spawn` | 先 `next(e)`；有 `deny` 或沒有 `agentId`（workflow 遠端子代理）或有 `teammateId` 就不處理。批次為空或 turnId 不是目前主回合時開新一批：上一批還在跑的帶過來，已完成的清掉。目前主回合的 turnId 不明（剛熱重載，模組變數歸零）時沿用現有批次，不開新的。加入新的一列，`isNested` 看 `parentAgentId`。這一批從空變成有一列時開窗格 |
| `turn.step` | 串流 hook，`const r = yield* next(e)` 原樣傳遞；只處理帶 `agentId` 而且在這一批裡的：記模型、effort、`lastUsage`，累加費用 |
| `tool.call` | 只處理帶 `agentId` 而且在這一批裡的：工具次數 +1，正在做什麼改成這個工具的描述；照原樣 `next(e)` |
| `turn.complete`（帶 `agentId`） | `answer` 標成完成；`aborted`、`error`、`refusal` 標成失敗，原因分別是「已中斷」「API 錯誤」「模型拒絕」 |
| `prompt.submit` | 文字不是 `/` 開頭時關閉窗格 |
| `session.start` | 註冊 `/agents`；用 `$.agent.list()` 補上這一批裡還在跑、但沒有紀錄的子代理；需要的話接回計時器 |
| `session.end` | 停掉計時器；`/clear` 時清空批次 |

所有 hook 只觀察：記錄失敗就略過，一律照原樣交回 `next(e)` 的結果，不擋任何事件。

## 數字的算法

| 欄位 | 算法 |
| --- | --- |
| token | `lastUsage` 的四種 token 加總（輸入、cache 讀、cache 寫、輸出） |
| ctx % | `lastUsage` 的輸入、cache 讀、cache 寫加總，除以該模型的 context 上限；上限未知時不顯示 |
| 費用 | 每次請求各自依模型單價計算（輸入、輸出、cache 讀、cache 寫四種單價）後累加；模型不在價目表時那次不計，並把 `hasUnpricedUsage` 設成 true，畫面顯示「≈?」（總計顯示「≈$0.28+?」） |
| 時間 | `startedAt` 到 `endedAt`；還在跑就算到現在。格式 `m:ss`，滿一小時 `h:mm:ss` |
| 總計 | 費用、token 為所有子代理加總；時間是最早的 `startedAt` 到最晚的 `endedAt`，還有在跑就算到現在 |
| token 的顯示 | 未滿 1000 照寫；未滿 100 萬四捨五入到 k（`26k`、`150k`）；滿 100 萬取一位小數（`1.2M`） |

單價與 context 上限集中在 `pricing.ts`，註明資料日期與來源。實作時用 claude-api skill 查官方數字，並對照 switchboard 估算費用的方式；不憑記憶寫。

## 版面

```
Agents
╭───────────╮╭───────────╮╭──────────╮
│ Cost      ││ Tokens    ││ Time     │
│ ≈$0.28    ││ 150k      ││ 0:47     │
╰───────────╯╰───────────╯╰──────────╯
Running · 1
● Review the whole kit
  Opus 5.5 · xhigh · 12 tools
  讀取 src/app.ts
  ctx 3% · 26k · ≈$0.00 · 0:02
  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆   ← 彗星動畫
──────────────────────────────────────
Finished · 3
✓ Build the landing page
  Opus 5.5 · low · 92 tools
  ctx 4% · 41k · ≈$0.08 · 0:44
  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆   ← 填滿，模型系列的顏色
──────────────────────────────────────
✗ Research competitor launches
  Sonnet 5.5 · high · 8 tools
  已中斷
  ctx 2% · 18k · ≈$0.01 · 0:09
  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆   ← 灰色
```

| 項目 | 規則 |
| --- | --- |
| 寬度 | 一律以窗格實際的 `bodyColumns` 排版：停靠右邊時約 42 欄（`columns` 只對停靠有效），放在輸入框上方時是整個寬度，進度條與分隔線跟著拉長 |
| 統計區塊 | 三格方框；面板內寬窄於 36 欄時改成一行「≈$0.28 · 150k · 0:47」 |
| 分組 | Running 在上、Finished 在下（失敗的也放 Finished），組內依派出順序 |
| 巢狀 | 名稱前加「↳ 」 |
| 執行中卡片 | 5 列：名稱、模型與 effort 與工具次數、正在做什麼、用量、進度條 |
| 完成卡片 | 4 列：少了正在做什麼 |
| 失敗卡片 | 5 列：第 3 列用紅字寫失敗原因 |
| 分隔 | 卡片之間一條暗色橫線 |
| 截斷 | 名稱、正在做什麼依顯示寬度截斷補「…」，東亞寬字元算兩格 |
| 模型未知 | 模型那一列顯示原始 id；還沒有任何請求時顯示「starting」 |
| 很多子代理 | 超過面板高度由 Claude Code 捲動，不另外摺疊 |
| 沒有批次 | 面板顯示「這個 session 還沒有派出子代理」 |

顏色與 clean-view 共用一套：

| 元素 | 顏色 |
| --- | --- |
| 執行中的 ● 與彗星 | 橘 `#f79a4f`、粉紅 `#ec4f8f`、紫 `#b45ce6`、藍 `#6f7df2` 依時間來回變化 |
| 完成的進度條、模型名稱 | 依模型系列：Opus 橘、Sonnet 藍、Haiku 綠、Fable 紫；未知系列灰 |
| ✓ | 綠（theme `success`） |
| 失敗的 ✗ 與原因 | 紅（theme `error`）；進度條灰 |
| 進度條底色 | `#4a4a52` |
| 進度條字元 | `▆`（Ghostty 會讓滿格方塊上下黏在一起） |

## 開關時機與 /agents

| 情況 | 動作 |
| --- | --- |
| 這一批出現第一個子代理 | `$.ui.open({ id: 'agent-panel', title: 'Agents', columns: 42 })`，不帶 `focus` |
| 同一批再派子代理 | 只更新資料 |
| `prompt.submit` 且文字不是 `/` 開頭 | `$.ui.close({ id: 'agent-panel' })` |
| `/agents` | 窗格已放上畫面就關閉；否則開啟並顯示最近一批 |
| 使用者按 ✕ 或 ctrl+x x | 照常關閉；這會清掉「親手開過」的紀錄，之後要再打一次 `/agents` 才能在 110 欄自動跳出 |
| `$.ui.open` 回傳 `isPlaced: false` | 窗格在背景等待，終端機變寬時自動出現；每個 session 最多跳一次提示「子代理面板放不下：打 /agents 開啟」 |

動畫與計時：只在「窗格開著而且有子代理在跑」時，用 `$.clock.every(200)` 遞增 `tick`；沒有子代理在跑或窗格關閉就停止。`tick` 只有面板讀，不用 `$.ui.invalidate`，避免整個對話紀錄重畫。

## 錯誤處理

| 情況 | 處理 |
| --- | --- |
| hook 內部出錯 | 略過這次記錄，照原樣回傳 `next(e)` 的結果 |
| 價目表裡沒有的模型 | 顯示原始 id，費用「≈?」，不顯示 ctx % |
| `usage` 為 null | 不累加，不當成 0 |
| 熱重載或面板開啟前就在跑的子代理 | `session.start` 與開新一批時用 `$.agent.list()` 補上，用量從之後的請求開始累計 |
| 派出被擋下（`deny`） | 不加入 |
| workflow 遠端子代理（沒有 `agentId`）、teammate（有 `teammateId`） | 不列入 |
| 窗格放不下 | 見上表，只提示一次 |
| session 結束、`/clear` | 停計時器；`/clear` 清空批次 |

## 測試

| 層級 | 內容 |
| --- | --- |
| `batch.ts` | 開新一批時帶過跑到一半的子代理、清掉已完成的；turnId 不明時沿用現有批次；新增子代理；記錄用量與累加費用；未知模型設 `hasUnpricedUsage`；工具次數與正在做什麼；完成與三種失敗原因 |
| `pricing.ts` | 模型 id 轉顯示名稱與系列；單次請求費用；ctx %；未知模型 |
| `layout.ts` | 依寬度截斷（含中文）；時間與 token 格式；36 欄以下改單行統計；三種狀態卡片的列數與顏色；工具描述 |
| hook | 派出時寫入 state 並開窗格（第二個不重開）；`deny`、沒有 `agentId` 不加入；子代理的請求記到對的列、主迴圈的請求不記；一般訊息關窗格、`/` 開頭不關；`/agents` 開關切換；放不下只提示一次 |
| 畫面 | 掛載 `Pane`，檢查 Agents、Cost、`Running · 1`、名稱、✓／✗ 與卡片列數；沒有批次時的提示文字 |
| 例行檢查 | `claude plugin test`、`claude plugin validate`、型別檢查（含測試）、`scripts/check-contracts.sh` |
| 真實 session | 安裝並 `/reload-plugins` 後先打一次 `/agents`；派兩個小型子代理，用 `cmux read-screen` 檢查面板；比對 token 數與 Claude Code 自己顯示的「· Nk tokens」；確認背景任務喚起 Claude 時面板不會被關掉 |

## 完成標準

1. 終端機 113 欄、打過一次 `/agents` 之後，派出子代理時面板自動跳出
2. 每個子代理的模型、effort、工具次數、正在做什麼、token、費用、時間隨執行更新，完成後顯示 ✓ 與最終用量
3. 使用者送出下一則訊息時面板自動關閉，打 `/` 指令時不關
4. 驗證完成後停用 `agent-radar@claude-code-mods`（停用 user 範圍外掛若被 auto mode 擋下，請使用者用 `!` 執行）

## 實作時要先驗證的事

這些不是未決的設計，而是設計依賴的事實，實作第一步先確認，結果跟設計不符時回報並調整：

1. token 的算法是否與 Claude Code 在子代理完成時顯示的「· Nk tokens」一致；不一致時改成跟它一樣
2. 背景任務完成而喚起 Claude 時，是否會觸發 `prompt.submit`；會的話改用能分辨來源的方式關窗格
3. `/agents` 這類斜線指令是否會觸發 `prompt.submit`；設計已排除 `/` 開頭的文字，這裡只是確認
4. 各模型的單價與 context 上限（claude-api skill）
