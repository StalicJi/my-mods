# my-mods

個人使用的 Claude Code mod marketplace。這裡只放通用的程式碼，網址、token 這類私人設定由每台電腦各自設定，不進版控。

| mod | 用途 |
| --- | --- |
| `clean-view` | 工具呼叫收成一行淡色摘要（Edit、Write、Bash 與錯誤訊息照常顯示），計畫清單顯示在輸入框上方；`/clean` 切換 |
| `where-am-i` | 輸入框上方的進度摘要（繁體中文版，fork 自 [hamzafer/claude-code-mods](https://github.com/hamzafer)，MIT） |
| `next-steps` | 回合結束後建議下一步（繁體中文版，fork 自 anthropics/claude-plugins-community，Apache 2.0） |
| `gitlab-sync` | 分支跟遠端的同步狀態與還開著的張數（GitLab 的 Task、Issue 分開計數）；GitLab 與 GitHub 上自己的 issue／MR（PR）有新動態時通知，`/gitlab`、`/github` 查看 |
| `agent-panel` | 派出子代理時跳出面板（右側或輸入框上方），一眼看出每個子代理在做什麼、有沒有卡住或失敗：類型或名稱、模型、正在做什麼、token 與時間，卡住時轉黃；卡片左邊有像素小人，依派出順序換配件，執行中會走路，卡住變黃、完成閉眼、失敗變灰（開啟終端機圖片時改畫細像素的圖片版，見下方「agent-panel：開啟圖片版小人」）；子代理多或放在輸入框上方時一個一列，面板放不下時輸入框下方顯示一行狀態；停靠在右邊時點卡片標題切到那個子代理的詳細頁，依時間列出工具呼叫（成功、出錯、被拒絕、執行中）、中途說的話與最後的回報，點開時捲到最新一筆，上下各有一個「← 返回」；`/agents` 開關，`/agents focus`（或 `/agents-focus`）直接把鍵盤交給面板（Tab 移動、Enter 按下、Esc 回到輸入框；ctrl+x tab 遇到輸入框上方有按鈕時會先停在那一排）；要用快捷鍵，在 `~/.claude/keybindings.json` 的 `Chat` 情境加 `"ctrl+x a": "command:agents-focus"`（快捷鍵綁定不能帶參數，所以用不帶參數的版本） |

## 在新電腦安裝

clone 到固定的資料夾，再把那個資料夾加成 marketplace。這樣 Claude Code 會直接讀資料夾裡的程式，`git pull` 之後執行 `/reload-plugins` 就是新版：

```sh
git clone <這個 repo 的網址> ~/.claude/mods-marketplaces/my-mods
claude plugin marketplace add ~/.claude/mods-marketplaces/my-mods
claude plugin install clean-view@my-mods
claude plugin install where-am-i@my-mods
claude plugin install next-steps@my-mods
claude plugin install gitlab-sync@my-mods
claude plugin install agent-panel@my-mods
```

## 每台電腦各自的設定（gitlab-sync）

| 項目 | 設定方式 | 沒設定時 |
| --- | --- | --- |
| GitLab 網址 | 在 Claude Code 執行 `/plugin configure gitlab-sync`，填入 `gitlabUrl`（例如 `https://gitlab.example.com`，不含 `/api/v4`）；也可以執行 `echo '{"gitlabUrl":"https://gitlab.example.com"}' \| claude plugin configure gitlab-sync@my-mods --values-stdin` | 不檢查 GitLab |
| GitLab token | 環境變數 `GITLAB_TOKEN`；或存進 macOS 鑰匙圈：`security add-generic-password -U -a "$USER" -s gitlab-token -w`。環境變數優先，是空的或被拒絕（401）時改讀鑰匙圈 | 輸入框上方顯示「GitLab 通知暫停」（在 GitHub repo 裡不顯示：band 只顯示目前 repo 所屬平台的新動態與通知暫停） |
| GitHub | `gh auth login`，token 跟 gh CLI 共用 | 不檢查 GitHub |

設定值存在這台電腦的 Claude Code 設定裡，不在這個 repo。

## agent-panel：開啟圖片版小人

小人預設用方塊字元畫，一格只能畫上下兩個像素，比較粗。有設定環境變數 `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`（非空）時，改用 kitty 圖片協定畫 4 欄 × 2 列的細像素小人；沒有設定時維持方塊版。

在 cmux 裡使用時，在 shell 設定檔（例如 `~/.zshrc`）加入只在 cmux、而且不在 tmux 時開啟的設定：

```zsh
if [[ -n "$CMUX_SURFACE_ID" && -z "$TMUX" ]]; then
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
fi
```

- 只在 cmux 開：不支援 kitty 圖片的終端機強制開啟，會出現亂碼或空白；不在 tmux 開：tmux 不會把圖片轉給終端機
- 背景 session 會繼承背景服務（`claude daemon`）啟動時的環境變數。改完設定後開新分頁，執行 `claude daemon stop --any`（會結束所有背景 session，對話保留），再從新分頁 `claude attach` 或 `claude --resume` 接回
- 不要改用 `settings.json` 的 `env`：它會套用到所有終端機，而且無法確認它在 Claude Code 判斷圖片能力之前就生效

## 開發

改完任一個 mod：

```sh
claude plugin test <mod 資料夾>
claude plugin validate <mod 資料夾>
bash scripts/check-contracts.sh   # 改過任何 types/index.d.ts 後執行
```

可能有好幾個 Claude Code session 同時在改這裡的檔案，動手前先看 `git status`。

### 推送前的私人資訊檢查

`scripts/git-hooks/pre-push` 會在 `git push` 前掃描要送出去的 commit：新增的行、檔名、作者與提交者、commit 訊息。找到私有網段 IP，或私人關鍵字清單裡的字，就擋下推送。每個 clone 要做兩件事：

```sh
git config core.hooksPath scripts/git-hooks
# 這台電腦的私人關鍵字清單：一行一個延伸正規表示式，不分大小寫，# 開頭是註解
$EDITOR ~/.config/git/private-patterns
```

- 清單本身就是私人資訊，只放在每台電腦，不進 repo。清單檔不存在、或裡面有寫錯的正規表示式時，一律擋下推送。
- 確定是誤判時用 `git push --no-verify`。

## 授權

`clean-view` 與 `gitlab-sync` 採用根目錄的 [MIT License](LICENSE)。`where-am-i`（MIT）與 `next-steps`（Apache 2.0）是 fork，依各自資料夾裡的 LICENSE。
