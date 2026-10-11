# tui-sim 幾支腳本共用：工作資料夾、依顯示欄寬切字與印快照
import os
import tempfile
import unicodedata

# 工作資料夾（指令檔、快照、暫時 Claude Code 的專案資料夾）：沒設 TUI_SIM_DIR 時放在系統暫存區。
# driver.py 與 sim.py、panel.py 要用同一個
WORK = os.environ.get('TUI_SIM_DIR') or os.path.join(tempfile.gettempdir(), 'tui-sim')


def char_width(char):
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in 'WF' else 1


# 從第 start 欄起的部分。快照的一列是去掉寬字佔位格後的字串，中文佔 2 欄，不能用字串位置切
def from_column(line, start):
    column, kept = 0, ''
    for char in line:
        if column >= start:
            kept += char
        column += char_width(char)
    return kept


# 印出快照：每列前面是列號（0 起算），只印第 start 欄起不是空白的列；最後列出反白的範圍
def print_snapshot(snapshot, start=0):
    for row, line in enumerate(snapshot['text']):
        kept = from_column(line, start).rstrip()
        if kept.strip():
            print(f'{row:2d}|{kept}')
    for run in snapshot['reverse']:
        print('反白', run['row'], run['cols'][0], run['cols'][-1], run['text'])
