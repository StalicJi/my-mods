# agent-panel 設計

- 日期：2026-10-09
- 狀態：已實作，2026-10-09 改版（改了什麼、為什麼改，見文末「2026-10-09 改版」）
- 位置：`my-mods/agent-panel/`（my-mods marketplace 的新 mod）

## 目的

Claude 派出子代理時，自動跳出一個面板，一眼看出這一批子代理各自在做什麼、用什麼模型、跑了多久、用了多少 token，有沒有卡住或失敗。完成後停用功能重疊的 `agent-radar@claude-code-mods`。

## 已確認的決定

| 項目 | 決定 |
| --- | --- |
| 位置 | 以右側窄欄設計（向 Claude Code 要求約 42 欄寬）；Claude Code 全螢幕版面且終端機至少 110 欄時停靠右邊，否則由 Claude Code 放到輸入框上方。放在輸入框上方時，或子代理多到完整版面放不下時，改用每個子代理一列的精簡模式 |
| 跳出時機 | 這一回合派出第一個子代理時自動開啟；另有 `/agents` 指令手動開關 |
| 範圍 | 只列這一回合派出的子代理；頂端狀態列的數量與整批耗時也只算這一批 |
| 每個子代理 | 類型（或 Agent 呼叫給的 name）、描述、模型、effort、工具次數、正在做什麼與這一步耗時、ctx %、token、時間；執行中的另有進度條。不顯示費用 |
| 進度 | 工具次數加正在做什麼；進度條只在執行中畫彗星動畫，不假裝知道百分比；完成、失敗不畫進度條 |
| 卡住提醒 | 同一個工具超過 3 分鐘、或思考超過 5 分鐘，正在做什麼那一列轉黃，進度條變成靜止的黃色 |
| 關閉 | 使用者本人送出一般訊息、而且這一批已全部結束時，由 mod 自己關閉；還有子代理在跑就不關 |
| 面板沒放上畫面時 | 有子代理在跑就在輸入框下方釘一行狀態列 |
| agent-radar | 本 mod 驗證完成後停用（不解除安裝） |
| 標籤語言 | 標籤用英文（Agents、Running、Failed、Done、tools、ctx、starting）；正在做什麼、失敗原因用繁體中文 |

## 不做的事

- 不顯示任務名稱（截圖裡的「Launch kit」）
- 不顯示費用：token 乘單價只能估算，2026-10-09 改版拿掉
- 不顯示 Claude Code 子代理清單第二段的進度摘要：那是 Claude Code 另外產生的，mod API 拿不到；改用「正在做什麼」
- 不畫像素頭像：cmux 不支援終端機圖片協定，改用符號與顏色
- 不顯示 heavy／light 這類模型分級（那是 switchboard mod 的功能）
- 不做待辦清單式的 x/y 進度
- 不做整個 session 的累計
- 面板裡不放按鈕

## 前提（來自 Claude Code 2.1.295 的 mod API）

| 事實 | 影響 |
| --- | --- |
| 窗格只有在全螢幕（alternate screen）版面、終端機至少 110 欄時才停靠在右邊；一般畫面一律放在輸入框上方 | 版面要在窄欄與整寬兩種位置都能看 |
| `Pane` 的 render props 有 `placement`（`dock` 停靠右邊、`inline` 輸入框上方）、`bodyColumns`、`scroll.bodyRows`（面板最多能用的列數） | 依這三個值決定寬度，以及要不要改用精簡模式 |
| mod 自己開的窗格（unasked）要終端機至少 144 欄才會放；使用者親手開過同一個窗格後降到 110 欄，紀錄跨 session 保留，直到使用者手動關閉窗格（✕ 或 ctrl+x x） | 提供 `/agents` 讓使用者親手開一次；mod 一律用 `$.ui.close` 關，不清掉紀錄 |
| `agent.spawn` 的輸入有 `description`、`subagentType`（`general-purpose`、`Explore`、外掛的 agent…）與 `name`（Agent 呼叫有給才有）；`next(e)` 回傳 `agentId` | 卡片標題用類型或 name，跟 Claude Code 自己的子代理清單（↓ to manage）第一段對得起來 |
| `turn.step`（串流事件）在子代理每次送出請求時觸發，輸入有 `model`、`effort`、`agentId`，結果有 `usage`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`） | 每個子代理的模型、effort、token 都拿得到；送出請求就是「思考中」的起點 |
| API 不提供美元費用，token 乘單價也分不出 cache 存 5 分鐘還是 1 小時 | 不顯示費用，也不維護單價表 |
| `$.ui.status(text)` 在輸入框下方釘一行文字，每個外掛一行，傳 `undefined` 清掉 | 面板沒放上畫面時用它當保底 |
| 外掛不能把鍵盤焦點從輸入框搶過來 | 面板不放按鈕，不需要焦點 |

## 架構

| 檔案 | 職責 |
| --- | --- |
| `hooks/batch.ts` | 批次資料與更新規則，全部是純函式：開新一批、新增子代理（含類型與 name）、記錄一次請求的用量、思考中、工具呼叫、Agent 工具結果的總計、標成完成或失敗、整批耗時 |
| `hooks/pricing.ts` | 模型 id 轉顯示名稱與系列、各模型的 context 上限、ctx %（檔名沿用；2026-10-09 改版後不再有單價表與費用計算） |
| `hooks/layout.ts` | 版面用的純函式：依顯示寬度截斷、時間與 token 的格式、狀態列文字、分組順序、完整或精簡模式、各狀態卡片的列與顏色、卡住判斷、工具呼叫的描述文字（用字與 clean-view 的 `describe` 一致；mod 之間不能共用程式碼，所以複製一份） |
| `hooks/register.tsx` | 接事件、開關窗格、計時器、輸入框下方的狀態列、把 `layout.ts` 算好的結果畫成元素；盡量薄 |
| `types/index.d.ts` | state 合約 |
| `tests/*.test.ts(x)` | 見「測試」 |

`layout.ts` 是寫 spec 時從 `register.tsx` 拆出來的，讓版面規則能不經畫面直接測試。

### 資料模型

```ts
type AgentStatus = 'running' | 'done' | 'failed'

type AgentRow = {
  id: string
  description: string
  agentType: string                 // agent.spawn 的 subagentType
  agentName: string | null          // Agent 呼叫給的 name；沒給是 null
  isNested: boolean                 // 由子代理再派出的
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  failureReason: string | null      // 已中斷、API 錯誤、模型拒絕
  model: string | null              // 最後一次請求的模型 id
  effort: string | number | null    // 最後一次請求的 effort
  toolCount: number
  activity: string                  // 正在做什麼：「思考中」或工具描述；結束後保留，失敗卡片用來說停在哪個動作
  activityStartedAt: number         // 這一步開始的時間，算這一步耗時與卡住提醒
  lastUsage: TokenUsage | null      // 最後一次請求的 4 種 token 數
  reportedTokens: number | null     // 前景子代理完成時 Agent 工具結果的 totalTokens；有值時以它為準
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
| `agent.spawn` | 先 `next(e)`；有 `deny` 或沒有 `agentId`（workflow 遠端子代理）或有 `teammateId` 就不處理。批次為空或 turnId 不是目前主回合時開新一批：上一批還在跑的帶過來，已完成的清掉。目前主回合的 turnId 不明（剛熱重載，模組變數歸零）時沿用現有批次，不開新的。加入新的一列：記下 `subagentType`、`name`，`isNested` 看 `parentAgentId`，這一步從派出時算起。開了新的一批時開窗格 |
| `turn.step` | 串流 hook，`const r = yield* next(e)` 原樣傳遞；只處理帶 `agentId` 而且在這一批裡的：送出請求時正在做什麼改成「思考中」並記下開始時間，請求結束後記模型、effort、`lastUsage` |
| `tool.call`（帶 `agentId`） | 只處理在這一批裡的：工具次數 +1，正在做什麼改成這個工具的描述並記下開始時間；照原樣 `next(e)` |
| `tool.call`（主迴圈的 `Agent`） | 前景子代理完成時，工具結果帶 Claude Code 自己算的 `totalTokens`、`totalToolUseCount`，記成這個子代理的 token 與工具次數 |
| `turn.complete`（帶 `agentId`） | `answer` 標成完成；`aborted`、`error`、`refusal` 標成失敗，原因分別是「已中斷」「API 錯誤」「模型拒絕」；保留最後的正在做什麼 |
| `prompt.submit` | 使用者本人送出的一般訊息（`origin.kind` 是 `composer` 或 `bridge`，文字不是 `/` 開頭），而且這一批沒有子代理在跑時關閉窗格 |
| `session.start` | 註冊 `/agents`；用 `$.agent.list()` 補上這一批裡還在跑、但沒有紀錄的子代理（類型取 `type`）；需要的話接回計時器與狀態列 |
| `session.end` | 停掉計時器；`/clear` 時清空批次與狀態列 |

所有 hook 只觀察：記錄失敗就略過，一律照原樣交回 `next(e)` 的結果，不擋任何事件。

## 數字的算法

| 欄位 | 算法 |
| --- | --- |
| token | 有 `reportedTokens`（前景子代理完成後 Claude Code 自己算的總計）時用它；否則用 `lastUsage` 的四種 token 加總（輸入、cache 讀、cache 寫、輸出） |
| ctx % | `lastUsage` 的輸入、cache 讀、cache 寫加總，除以該模型的 context 上限；上限未知時不顯示 |
| 時間（卡片） | `startedAt` 到 `endedAt`；還在跑就算到現在。格式 `m:ss`，滿一小時 `h:mm:ss` |
| 這一步耗時 | `activityStartedAt` 到現在，只在執行中顯示 |
| 卡住 | 正在做什麼是「思考中」且這一步超過 5 分鐘，或是工具且超過 3 分鐘 |
| 整批耗時（狀態列） | 最早的 `startedAt` 到最晚的 `endedAt`，還有在跑就算到現在 |
| 狀態數量（狀態列） | 執行中、完成、失敗各幾個；數量 0 的不列 |
| token 的顯示 | 未滿 1000 照寫；未滿 100 萬四捨五入到 k（`26k`、`150k`）；滿 100 萬取一位小數（`1.2M`） |

context 上限集中在 `pricing.ts`，註明資料日期與來源（claude-api skill）；不憑記憶寫。

## 版面

完整模式，停靠右邊約 42 欄（2 個執行中、1 個失敗、1 個完成）：

```
Agents  ●2 ✓1 ✗1                      5:31
Running
● reviewer · 審查改版後的測試         5:31
  Opus 5.5 · xhigh · 34 tools
  執行：跑全部測試 · 3:20
  ctx 41% · 410k
  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆
● Explore · 找出 openPanel 的呼叫端   0:47
  Haiku 5.5 · low · 12 tools
  讀取 hooks/register.tsx · 0:03
  ctx 3% · 26k
  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆

Failed
✗ general-purpose · 整理 README       0:09
  已中斷 · 停在 讀取 my-mods/README.md
  Sonnet 5.5 · 8 tools

Done
✓ Explore · 找出設定檔                0:44
  Haiku 5.5 · low · 9 tools · 41k
```

- 第一張卡片有給 name（`reviewer`），標題用 name；其他沒給的用類型
- 第一張卡片的工具已跑 3 分 20 秒，超過 3 分鐘：「執行：跑全部測試 · 3:20」整列黃色，進度條是靜止的黃色
- 第二張卡片正常執行，進度條是彗星動畫

精簡模式，放在輸入框上方（整個終端機寬度）或完整模式放不下時：

```
Agents  ●2 ✓1 ✗1                                                    5:31
● reviewer · 審查改版後的測試  執行：跑全部測試                     5:31
● Explore · 找出 openPanel 的呼叫端  讀取 hooks/register.tsx        0:47
✗ general-purpose · 整理 README  已中斷                             0:09
✓ Explore · 找出設定檔                                              0:44
```

| 項目 | 規則 |
| --- | --- |
| 寬度 | 一律以窗格實際的 `bodyColumns` 排版：停靠右邊時約 42 欄（`columns` 只對停靠有效），放在輸入框上方時是整個寬度，進度條跟著拉長 |
| 模式 | 預設完整模式；`placement` 是 `inline`，或完整模式需要的列數（狀態列、各組的組名與卡片、組間空行）超過 `scroll.bodyRows` 時改精簡模式 |
| 狀態列 | 第一列：「Agents」後接「●執行中數 ✓完成數 ✗失敗數」，數量 0 的不列；整批耗時靠右。token 只在卡片上 |
| 分組 | Running → Failed → Done，沒有子代理的組不畫；每組上方一列暗色組名，組內依派出順序；組與組之間空一行 |
| 卡片標題 | 狀態符號、「標籤 · 描述」，耗時靠右；標籤是 Agent 呼叫給的 name，沒給時用類型；巢狀在標籤前加「↳ 」 |
| 執行中卡片 | 4 列＋進度條：標題；模型 · effort · N tools；正在做什麼 · 這一步耗時；ctx · token |
| 完成卡片 | 2 列，不畫進度條：標題；模型 · effort · N tools · token |
| 失敗卡片 | 3 列，不畫進度條：標題；紅字「失敗原因 · 停在 最後的動作」；模型 · N tools |
| 精簡模式 | 每個子代理一列：狀態符號、標籤 · 描述、正在做什麼（失敗的寫失敗原因）、耗時靠右；卡住的那一列整列轉黃 |
| 分隔 | 卡片之間不畫分隔線 |
| 截斷 | 描述、正在做什麼依顯示寬度截斷補「…」，東亞寬字元算兩格；靠右的耗時不截 |
| 模型未知 | 模型那一列顯示原始 id；還沒有任何請求時顯示「starting」 |
| 很多子代理 | 改精簡模式；精簡模式還放不下時由 Claude Code 捲動 |
| 沒有批次 | 面板顯示「這個 session 還沒有派出子代理」 |

顏色與 clean-view 共用一套：

| 元素 | 顏色 |
| --- | --- |
| 執行中的 ● 與彗星 | 橘 `#f79a4f`、粉紅 `#ec4f8f`、紫 `#b45ce6`、藍 `#6f7df2` 依時間來回變化 |
| 模型名稱 | 依模型系列：Opus 橘、Sonnet 藍、Haiku 綠、Fable 紫；未知系列灰 |
| ✓ | 綠（theme `success`） |
| 失敗的 ✗ 與原因 | 紅（theme `error`） |
| 卡住的動作列與進度條 | 黃（theme `warning`）；進度條整條靜止，不跑彗星 |
| 狀態列的 ●、✓、✗ | ● 固定粉紅 `#ec4f8f`（不跟著彗星換色）、✓ 綠、✗ 紅 |
| 組名 | 暗色 |
| 進度條底色 | `#4a4a52` |
| 進度條字元 | `▆`（Ghostty 會讓滿格方塊上下黏在一起） |

## 開關時機與 /agents

| 情況 | 動作 |
| --- | --- |
| 這一批出現第一個子代理 | `$.ui.open({ id: 'agent-panel', title: 'Agents', columns: 42 })`，不帶 `focus` |
| 同一批再派子代理 | 只更新資料 |
| 使用者本人送出一般訊息（`origin.kind` 是 `composer` 或 `bridge`，文字不是 `/` 開頭） | 這一批還有子代理在跑：不關；全部結束：`$.ui.close({ id: 'agent-panel' })` |
| `/` 開頭的指令、背景任務的通知、外掛或其他 session 送的訊息 | 不關 |
| `/agents` | 窗格已放上畫面就關閉；否則開啟並顯示最近一批 |
| 使用者按 ✕ 或 ctrl+x x | 照常關閉；這會清掉「親手開過」的紀錄，之後要再打一次 `/agents` 才能在 110 欄自動跳出 |
| `$.ui.open` 回傳 `isPlaced: false` | 窗格在背景等待，終端機變寬時自動出現；每個 session 最多跳一次提示「子代理面板放不下：打 /agents 開啟」 |
| 有子代理在跑、但面板沒放上畫面 | `$.ui.status('Agents  ●2 ✓1 ✗1')` 在輸入框下方釘一行；全部結束或面板放上畫面後 `$.ui.status(undefined)` 清掉 |

狀態列只在派出、完成與面板開關時更新，不跟動畫計時器走，所以不放會一直跳動的耗時。

動畫與計時：只在「窗格已放上畫面而且有子代理在跑」時，用 `$.clock.every(200)` 遞增 `tick`；沒有子代理在跑或窗格關閉就停止。彗星、時間、這一步耗時與卡住判斷都在畫面時依當下時間計算，跟著 `tick` 更新。`tick` 只有面板讀，不用 `$.ui.invalidate`，避免整個對話紀錄重畫。

## 錯誤處理

| 情況 | 處理 |
| --- | --- |
| hook 內部出錯 | 略過這次記錄，照原樣回傳 `next(e)` 的結果 |
| 畫面丟例外 | 接住，畫一行紅字「面板暫時畫不出來：原因」，不讓 Claude Code 卸載窗格 |
| context 上限表裡沒有的模型 | 認得系列與版本時顯示名稱，否則顯示原始 id；不顯示 ctx % |
| `usage` 為 null | 不覆寫 `lastUsage`，不當成 0 |
| 熱重載或面板開啟前就在跑的子代理 | `session.start` 與開新一批時用 `$.agent.list()` 補上，用量從之後的請求開始累計 |
| 派出被擋下（`deny`） | 不加入 |
| workflow 遠端子代理（沒有 `agentId`）、teammate（有 `teammateId`） | 不列入 |
| 窗格放不下 | 見上表：只提示一次，有子代理在跑時輸入框下方顯示狀態列 |
| session 結束、`/clear` | 停計時器；`/clear` 清空批次與狀態列 |

## 測試

| 層級 | 內容 |
| --- | --- |
| `batch.ts` | 開新一批時帶過跑到一半的子代理、清掉已完成的；turnId 不明時沿用現有批次；新增子代理帶類型與 name；記錄用量（沒有費用欄位）；思考中與工具呼叫更新正在做什麼與開始時間；Agent 工具結果的總計；完成與三種失敗原因，結束後保留最後的動作；整批耗時 |
| `pricing.ts` | 模型 id 轉顯示名稱與系列（含 Bedrock、Vertex 的寫法）；context 上限表；ctx %；未知模型 |
| `layout.ts` | 依寬度截斷（含中文）；時間與 token 格式；狀態列文字（數量 0 不列、耗時靠右）；Running → Failed → Done 的順序；三種狀態卡片的列數與顏色；卡住門檻（工具 3 分鐘、思考 5 分鐘）；完整模式需要的列數（與卡片實際列數一致）；精簡模式一列的內容；工具描述 |
| hook | 派出時寫入 state 並開窗格（第二個不重開）；`deny`、沒有 `agentId`、teammate 不加入；子代理的請求記到對的列並改成思考中、主迴圈的請求不記；一般訊息在還有子代理在跑時不關、全部結束後才關；`/` 開頭與背景通知不關；`/agents` 開關切換；放不下只提示一次；面板沒放上畫面時出現狀態列，全部結束或面板放上後清掉 |
| 畫面 | 掛載 `Pane`，檢查狀態列、卡片標題、✓／✗ 與卡片列數，畫面上沒有 Cost 與 ≈$；`placement` 是 `inline` 時是精簡模式；沒有批次時的提示文字 |
| 例行檢查 | `claude plugin test`、`claude plugin validate`、型別檢查（含測試）、`scripts/check-contracts.sh` |
| 真實 session | 安裝並 `/reload-plugins` 後先打一次 `/agents`；平行派出幾個小型子代理，用 `cmux read-screen` 檢查面板；卡片標題跟 Claude Code 子代理清單（↓ to manage）的第一段對得起來；比對 token 數與 Claude Code 自己顯示的「· Nk tokens」；子代理還在跑時送出訊息面板不關；確認背景任務喚起 Claude 時面板不會被關掉；終端機調窄時輸入框下方出現狀態列 |

## 完成標準

1. 終端機 113 欄、打過一次 `/agents` 之後，派出子代理時面板自動跳出；面板沒放上畫面時，輸入框下方有一行狀態列
2. 每個子代理的類型或 name、描述、模型、effort、工具次數、正在做什麼與這一步耗時、ctx、token、時間隨執行更新；完成後顯示 ✓ 與最終 token，失敗時顯示原因與停在哪個動作；畫面上沒有費用
3. 工具超過 3 分鐘、思考超過 5 分鐘時，那一列轉黃
4. 子代理還在跑時送出訊息，面板不關；全部結束後的下一則訊息才關；打 `/` 指令時不關
5. 驗證完成後停用 `agent-radar@claude-code-mods`（停用 user 範圍外掛若被 auto mode 擋下，請使用者用 `!` 執行）

## 實作時驗證的事

這些不是未決的設計，而是設計依賴的事實：

| 事項 | 結果 |
| --- | --- |
| token 的算法是否與 Claude Code 在子代理完成時顯示的「· Nk tokens」一致 | 前景子代理完成時改用 Agent 工具結果的 `totalTokens`（Claude Code 自己算的總計）；背景子代理的結果沒有這個欄位，維持 `lastUsage` 加總 |
| 背景任務完成而喚起 Claude 時，是否會觸發 `prompt.submit` | 改用 `origin.kind` 分辨來源：只有 `composer`、`bridge` 算使用者本人送的，其他來源一律不關 |
| `/agents` 這類斜線指令是否會觸發 `prompt.submit` | 不影響：`/` 開頭的文字一律不關 |
| 各模型的 context 上限 | 依 claude-api skill 的資料寫進 `pricing.ts`，註明資料日期；單價表在 2026-10-09 改版刪除 |

## 2026-10-09 改版

起因：使用者以主管模式工作，常平行派出多個子代理，要一眼看出誰在做什麼、有沒有卡住或失敗。原本的面板偏重用量與費用，而且一個子代理佔 5 列，派出三、四個就要捲動。

1. 不顯示費用：畫面拿掉 Cost 與 ≈$，刪掉單價表與費用資料（`costUsd`、`hasUnpricedUsage`），`pricing.ts` 只留算 ctx % 需要的各模型 context 上限。原因：API 不給美元費用，token 乘單價只能估算（連 cache 存多久都分不出來），數字不可靠又要維護單價表；面板改成專注在進度
2. 關閉時機：使用者本人送出一般訊息時，這一批還有子代理在跑就不關，全部結束後的下一則才關；`/` 開頭、背景通知、外掛送的照舊不關。原因：主管模式下常邊等子代理邊補指令，面板要留著看進度
3. 狀態列取代統計方框：頂端一列「Agents  ●2 ✓1 ✗1」加靠右的整批耗時，數量 0 的不列；token 只顯示在卡片上。原因：方框佔 4 列只放兩個數字；一列就能看出幾個在跑、幾個完成、幾個失敗
4. 卡片標題改成「類型（或 Agent 的 name） · 描述」，耗時靠右放在標題列。原因：Claude Code 自己的子代理清單（↓ to manage）第一段就是類型或 name，可以對照；清單第二段是 Claude Code 另外產生的進度摘要，mod API 拿不到
5. 卡片收緊：分組改成 Running → Failed → Done；執行中 4 列＋彗星進度條，完成 2 列，失敗 3 列（紅字寫失敗原因與停在哪個動作），完成與失敗不畫進度條；拿掉卡片間的分隔線，組與組之間空一行。原因：平行派出多個時要一個畫面看完；失敗的排在完成前面比較容易注意到；已結束的不需要進度條
6. 即時動作與卡住提醒：子代理每次送出請求時正在做什麼改成「思考中」，呼叫工具時改成工具描述，並記下這一步開始的時間；工具超過 3 分鐘或思考超過 5 分鐘，那一列轉黃、進度條變成靜止的黃色。原因：原本只在呼叫工具時更新，子代理在思考時看起來像停在上一個工具；有了開始時間才分得出是在忙還是卡住
7. 精簡模式：面板放在輸入框上方（`placement` 是 `inline`），或完整模式需要的列數超過面板可見列數（`scroll.bodyRows`）時，每個子代理只畫一列（狀態、標籤 · 描述、正在做什麼或失敗原因、耗時）。原因：放在輸入框上方時會擠掉對話的空間；子代理多時完整模式要捲動才看得完
8. 狀態列保底：有子代理在跑、但面板沒放上畫面時，用 `$.ui.status` 在輸入框下方釘一行「Agents ●2 ✓1 ✗1」，全部結束或面板放上後清掉；只在派出、完成與面板開關時更新。原因：終端機不夠寬時面板在背景等，原本只跳一次提示，之後就看不到子代理的狀態；不跟動畫計時器走，避免一直重畫輸入框下方
