# my-mods

個人使用的 Claude Code mod marketplace。這裡只放通用的程式碼，網址、token 這類私人設定由每台電腦各自設定，不進版控。

| mod | 用途 |
| --- | --- |
| `clean-view` | 工具呼叫收成一行淡色摘要（Edit、Write、Bash 與錯誤訊息照常顯示），計畫清單顯示在輸入框上方；`/clean` 切換 |
| `next-steps` | 回合結束後建議下一步（繁體中文版，fork 自 anthropics/claude-plugins-community，Apache 2.0） |
| `gitlab-sync` | 分支跟遠端的同步狀態與還開著的張數（GitLab 的 Task、Issue 分開計數）；GitLab 與 GitHub 上自己的 issue／MR（PR）有新動態時通知，`/gitlab`、`/github` 查看 |
| `agent-supervisor` | 監控子代理、回報的任務與依賴、可能的阻塞與下一步建議；`/supervisor` 開關面板，說明見 [agent-supervisor/README.md](agent-supervisor/README.md) |

## 在新電腦安裝

clone 到固定的資料夾，再把那個資料夾加成 marketplace。這樣 Claude Code 會直接讀資料夾裡的程式，`git pull` 之後執行 `/reload-plugins` 就是新版：

```sh
git clone <這個 repo 的網址> ~/.claude/mods-marketplaces/my-mods
claude plugin marketplace add ~/.claude/mods-marketplaces/my-mods
claude plugin install clean-view@my-mods
claude plugin install next-steps@my-mods
claude plugin install gitlab-sync@my-mods
claude plugin install agent-supervisor@my-mods
```

## 每台電腦各自的設定（gitlab-sync）

| 項目 | 設定方式 | 沒設定時 |
| --- | --- | --- |
| GitLab 網址 | 在 Claude Code 執行 `/plugin configure gitlab-sync`，填入 `gitlabUrl`（例如 `https://gitlab.example.com`，不含 `/api/v4`）；也可以執行 `echo '{"gitlabUrl":"https://gitlab.example.com"}' \| claude plugin configure gitlab-sync@my-mods --values-stdin` | 不檢查 GitLab |
| GitLab token | 環境變數 `GITLAB_TOKEN`；或存進 macOS 鑰匙圈：`security add-generic-password -U -a "$USER" -s gitlab-token -w`。環境變數優先，是空的或被拒絕（401）時改讀鑰匙圈 | 同步狀態列顯示「GitLab 通知暫停」（在 GitHub repo 裡不顯示：只顯示目前 repo 所屬平台的新動態與通知暫停） |
| GitHub | `gh auth login`，token 跟 gh CLI 共用 | 不檢查 GitHub |
| 同步狀態列 | mod 把這一列（含 ANSI 顏色）寫到 `~/.claude/gitlab-sync/statusline/<session id>.txt`，每分鐘重寫一次；在自己的 statusline 腳本用輸入的 `session_id` 找檔、檔案 3 分鐘內有更新才印。閒置時 statusline 不會重跑，`settings.json` 的 `statusLine` 要加 `"refreshInterval": 10`（秒） | 看不到同步狀態列（`/gitlab`、`/github` 照常） |

設定值存在這台電腦的 Claude Code 設定裡，不在這個 repo。

## 開發

改完任一個 mod：

```sh
claude plugin test <mod 資料夾>
claude plugin validate <mod 資料夾>
bash scripts/check-contracts.sh   # 改過任何 types/index.d.ts 後執行
```

可能有好幾個 Claude Code session 同時在改這裡的檔案，動手前先看 `git status`。

### 在虛擬終端機裡實測畫面

`scripts/tui-sim/` 會在背景的虛擬終端機裡跑一個暫時的 Claude Code，可以送按鍵、滑鼠事件，擷取畫面時連反白都讀得到。用來實測點擊範圍、狀態列、停靠位置這類 `claude plugin test` 測不到的地方，用法見 [scripts/tui-sim/README.md](scripts/tui-sim/README.md)。

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

`clean-view` 與 `gitlab-sync` 採用根目錄的 [MIT License](LICENSE)。`next-steps`（Apache 2.0）是 fork，依它資料夾裡的 LICENSE。
