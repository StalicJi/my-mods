# tui-sim：在虛擬終端機裡實測 mod 畫面

在背景開一個虛擬終端機（pty），裡面跑一個暫時的 Claude Code，用 [pyte](https://github.com/selectel/pyte) 解析畫面。可以送按鍵與滑鼠事件，擷取畫面時連反白都讀得到。用來實測面板、按鈕這類 `claude plugin test` 測不到的地方，例如點擊範圍、狀態列、停靠位置。

為什麼不用其他方法：

- computer-use 在背景 session 拿不到授權。
- `cmux send` 送不了滑鼠事件：Claude Code 開了 kitty 鍵盤協定，Esc 會被編成 `\x1b[27u`。

## 需要

- `uv`，用來暫時載入 pyte。
- `~/.local/bin/claude`。

## 用法

```sh
cd scripts/tui-sim
# 背景啟動：欄 列（預設 200 50）。面板要 110 欄以上才會自己停靠，窄於這個寬度只有狀態列
uv run --no-project --with pyte python driver.py 200 50 &

python3 sim.py snap start            # 存一張快照並印出
python3 sim.py type '請派一個子代理…'  # 打字
python3 sim.py key enter
python3 sim.py find '← 返回'          # 找文字的格子（列、欄，0 起算）
python3 sim.py click 3 175            # 點格子
python3 sim.py move 43 170            # 游標移過去，快照會列出反白
python3 sim.py snap detail 145        # 只印第 145 欄之後（停靠在右邊的面板）
python3 sim.py resize 100 50          # 改變視窗大小
python3 sim.py quit                   # 關掉暫時的 Claude Code 與 driver
python3 panel.py detail 145           # 重印已經存在的快照
```

`python3 sim.py` 不帶參數會列出所有指令。

## 注意

- **工作資料夾：** 放指令檔、快照和暫時 Claude Code 的專案資料夾，預設在系統暫存區的 `tui-sim`。要換位置就設 `TUI_SIM_DIR`，三支腳本都要用同一個。
- **信任確認：** 第一次用某個工作資料夾時會出現信任確認。預設選項是「No, exit」，要先送方向鍵下（`python3 sim.py type $'\e[B'`），再按 Enter。
- **權限：** 暫時的 Claude Code 只放行 `echo`（`driver.py` 的 `CLAUDE_ARGS`），示範子代理才不會停在權限詢問。
- **切右側面板要依顯示欄寬：** 快照的一列是去掉寬字佔位格後的字串，中文佔 2 欄，不能用字串位置切。`snap`、`panel.py` 已經依欄寬切。
- **畫面殘影：** 畫面偶爾會有捲動殘影。要看完整畫面，可以 `resize` 成別的大小再改回來，讓 Claude Code 整個重畫。
- **測完要 `quit`：** 確認沒有殘留程序，例如 `ps aux | grep tui-sim/driver.py`。
