# Agent Supervisor

Claude Code 的 mod：在 Claude Code 裡用一個面板監控這個 session 的子代理、代理回報的任務與依賴、可能的阻塞，以及下一步建議。不是獨立程式，不需要另外開 CLI、伺服器或資料庫。

```text
a: 代理 t: 任務 l: 事件 r: 更新 q: 關閉
● Supervisor                              RUNNING
  委派 agent：做前端畫面

AGENTS
◐ 做前端畫面                              BLOCKED
  執行：讀取 schema.json · 1分12秒
● 定義 API schema                         RUNNING
  執行：echo schema第5次 · 1分20秒

TASKS
  Completed: 0 / 2 · Progress: 0%
  [>] T1 定義 API schema · 定義 API schema
  [!] T2 做前端畫面 · 做前端畫面（等 T1）

ATTENTION
⚠ 做前端畫面 被 定義 API schema 擋住
  等 API schema

SUGGESTED ACTION
→ 先完成「定義 API schema」（定義 API schema），做前端畫面 才能繼續

EVENTS
17:26:43 做前端畫面 開始
17:26:50 做前端畫面 回報在等：等 API schema
```

## 安裝與啟用

這個 mod 在 my-mods 這個本機 marketplace 裡：

```sh
claude plugin install agent-supervisor@my-mods
```

在 Claude Code 裡執行 `/reload-plugins` 就會載入。停用：`claude plugin disable agent-supervisor@my-mods`（之後再 `/reload-plugins`），面板、指令與回報工具都會一起拿掉。

## 使用

| 操作 | 作用 |
| --- | --- |
| `/supervisor` | 開關面板。不會自己跳出來，只在你打指令時開 |
| `/supervisor agents`、`tasks`、`logs` | 直接開那一頁 |
| `/supervisor focus` | 把鍵盤交給面板，之後可以按下面的快捷鍵 |
| `a`、`t`、`l`、`o` | 切到代理、任務、事件頁，`o` 回總覽（面板要先拿到鍵盤：`/supervisor focus`、ctrl+x tab 或用滑鼠點） |
| `r` | 立刻跟 Claude Code 的代理清單對帳並重畫 |
| `q` | 關閉面板 |
| Esc | 鍵盤回到輸入框 |

面板沒開而有代理在跑時，輸入框下方會釘一行 `Supervisor ●2 · /supervisor`。

### 版面

- 終端機夠寬（全螢幕版面 110 欄以上）時停靠在右邊，總覽列最近 3 筆事件。
- 窄的時候（例如 cmux 分割的窗格）放在輸入框上方，改用精簡版：每個代理一列、最多 3 個代理與 3 項任務、不列事件，阻塞與建議照樣顯示。每一列依顯示寬度截斷，不會折行。

## 給外部 App 的快照

面板的狀態也會寫成一份 JSON，給外部 App（例如 Splex 終端機）顯示同樣的內容：

- 路徑：`~/.claude/agent-supervisor/sessions/<session id>.json`，每個 session 一份。
- 時機：代理、任務、等待原因或主對話活動改變後約 0.5 秒寫一次，連續的改變合併成一次；內容沒變不重寫。
- session 結束時寫入 `"ended": true`（mod 沒有刪檔的 API）。
- `pid` 是 Claude Code 本身的程序，外部 App 用它比對是哪個終端機窗格；取不到時是 `null`，改用 `cwd` 比對。
- `waiting` 的 `isMain` 為 `true` 表示主對話在等：子代理不能直接問使用者，只有這種等待代表在等你（Splex 只對這種跳 WAIT 提醒）。
- 檔案直接覆寫、不是原子寫入：讀的一方讀到不完整的 JSON 時，沿用上一次的內容即可。

格式（`version` 有不相容的改動時加一，欄位見 `hooks/snapshot.ts` 的 `SupervisorSnapshot`）：

```json
{
  "version": 1, "sessionId": "…", "pid": 4242, "cwd": "/Users/me/app", "updatedAt": 1792233300000, "ended": false,
  "main": { "isRunning": true, "activity": "委派", "activityAt": 1792233290000 },
  "agents": [{ "id": "a1", "name": "定義 API schema", "status": "RUNNING", "isInferred": false, "activity": "讀取 schema.json",
               "detail": null, "failureReason": null, "startedAt": 1792233220000, "endedAt": null, "toolCount": 3,
               "activityAt": 1792233280000 }],
  "tasks": [{ "id": "T2", "title": "做前端畫面", "status": "pending", "owner": "做前端畫面", "blockedBy": ["T1"] }],
  "progress": { "completed": 0, "total": 2, "percent": 0 },
  "waiting": [{ "reporter": "做前端畫面", "isMain": false, "text": "等 API schema", "at": 1792233250000 }],
  "attention": [{ "subject": "做前端畫面", "dependsOn": "定義 API schema", "reason": "…", "source": "dependency", "certainty": "confirmed", "taskId": "T2" }],
  "suggestions": ["先完成「定義 API schema」…"],
  "events": [{ "at": 1792233250000, "kind": "waiting", "text": "做前端畫面 回報在等：等 API schema" }]
}
```

## 面板上的資訊從哪裡來

面板只顯示真的觀察到或回報過的資料，不知道的寫 `Unknown`，不編造進度。

| 資訊 | 來源 |
| --- | --- |
| 代理的開始、結束、失敗原因 | Claude Code 的事件（`agent.spawn`、`turn.complete`） |
| 最近活動、工具次數、連續失敗 | 子代理的每次請求與工具呼叫（`turn.step`、`tool.call`） |
| IDLE、等待背景工作 | Claude Code 的代理清單（`$.agent.list()`），有代理沒結束時每 3 秒對一次，不呼叫模型 |
| 任務、依賴、在等什麼 | 代理用回報工具回報；也會讀 Claude Code 原生的 TaskCreate、TaskUpdate、TodoWrite（開了 `CLAUDE_CODE_ENABLE_TASKS` 才有） |
| 建議 | 規則式，不呼叫模型 |

### 狀態

| 狀態 | 意思 |
| --- | --- |
| RUNNING | 正在跑 |
| IDLE | 這一輪結束，等訊息喚醒或等自己的背景工作 |
| BLOCKED | 有確認的阻塞（見下面） |
| COMPLETED、FAILED | 結束；FAILED 會寫原因（已中斷、API 錯誤、模型拒絕、已停止） |
| UNKNOWN? | 清單上找不到又沒收到結束事件 |

狀態後面有 `?` 的是推測的，其他都由事件或 Claude Code 確認。開面板前就在跑的代理，開始時間寫 `Unknown`。

## 回報工具

mod 註冊 `mcp__agent-supervisor__report`，讓主對話與子代理回報：

- `tasks`：任務的 `id`、`title`（新任務必填，繁體中文）、`status`（`pending`、`in_progress`、`completed`）、`blockedBy`（要先完成的任務 id）、`owner`（`main`，或子代理的任務說明、名字；預設是回報者）
- `waitingFor`：在等什麼；空字串表示不再等待

主對話的 system prompt 會加一段說明：分派子代理前先登記計畫與依賴。子代理的任務尾端附一段說明：有多個步驟或卡住時才回報，不要每個工具呼叫都回報。這會讓代理稍微改變做法、多用一點 token；workflow 的代理不附說明。

## 阻塞偵測

| 等級 | 條件 |
| --- | --- |
| 確認（⚠，代理顯示 BLOCKED，任務標 `[!]`） | 已經在做的任務還有沒完成的依賴；還沒結束的代理或主對話自己回報在等什麼 |
| 可能（`? POSSIBLE BLOCKER`，不改狀態） | 依賴沒有人回報過的任務；擋路任務的負責人已結束卻沒標完成；還在跑的代理連續 3 次工具失敗 |

不算阻塞：跑很久、一陣子沒有新事件、Claude Code 清單上的 waiting、還沒開始的任務在等依賴（只寫「（等 T1）」）。

## 限制

- 這個環境的 Agent 工具沒有 `name` 參數，代理多半用任務說明當標題。
- 在其他終端機窗格跑的 teammate、workflow 的代理沒有本機的執行迴圈，追蹤不到。
- 代理「目前的任務」只有派出時的說明與最近一次活動；要更細的任務與依賴得靠回報。
- 記錄存在這個 session（熱重載後仍在）：最多 30 個代理、50 項任務、最近 50 筆事件；`/clear` 會清掉。

## 開發

```sh
claude plugin test agent-supervisor      # 在 my-mods 根目錄執行
claude plugin validate agent-supervisor
bash scripts/check-contracts.sh          # 改過 types/index.d.ts 後執行
```

| 檔案 | 內容 |
| --- | --- |
| `hooks/register.tsx` | 掛事件、指令、回報工具、計時器、狀態列與面板 |
| `hooks/agents.ts` | 代理狀態：派出、活動、工具結果、結束、跟清單對帳 |
| `hooks/tasks.ts` | 回報格式檢查、任務更新、原生任務工具、等待回報 |
| `hooks/blockers.ts` | 阻塞規則與建議 |
| `hooks/events.ts` | 事件串 |
| `hooks/view.ts`、`names.ts`、`text.ts` | 面板版面、名稱、顯示寬度與時間格式 |

`agents.ts` 與部分版面改寫自已刪除的 agent-panel。
