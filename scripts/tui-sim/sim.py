# 對 driver.py 下指令的小工具。座標都是 0 起算的格子（列、欄），送滑鼠事件時轉成 SGR 的 1 起算
import json
import os
import sys
import time

from common import WORK, print_snapshot

CMD = os.path.join(WORK, 'cmd.jsonl')
USAGE = """用法：python3 sim.py <指令> [參數]
  type <文字>              像打字一樣送出文字
  key <按鍵>               enter、tab、esc、ctrl+x、ctrl+c、end
  click <列> <欄>          在格子上點一下（按下再放開）
  move <列> <欄>           游標移到格子上（看反白）
  wheel <列> <欄> <次數> <up|down>   在格子上捲動滾輪
  snap <名稱> [起始欄]     存一張快照並印出（只印起始欄之後，依顯示欄寬切）
  find <文字>              找文字所在的格子（列、欄）
  resize <欄> <列>         改變視窗大小
  quit                     關掉暫時的 Claude Code 與 driver"""


def push(command):
    with open(CMD, 'a') as f:
        f.write(json.dumps(command, ensure_ascii=False) + '\n')


def send_bytes(data: bytes):
    push({'op': 'send', 'hex': data.hex()})


def mouse(button: int, row: int, col: int, release=False):
    send_bytes(f'\x1b[<{button};{col + 1};{row + 1}{"m" if release else "M"}'.encode())


def wait_file(path):
    for _ in range(100):
        if os.path.exists(path):
            time.sleep(0.05)
            return
        time.sleep(0.05)
    raise SystemExit(f'沒有產生 {path}')


def main(argv):
    op = argv[0]
    if op == 'type':
        send_bytes(argv[1].encode())
    elif op == 'key':
        keys = {'enter': b'\r', 'tab': b'\t', 'esc': b'\x1b', 'ctrl+x': b'\x18', 'ctrl+c': b'\x03', 'end': b'\x1b[F'}
        send_bytes(keys[argv[1]])
    elif op == 'click':
        row, col = int(argv[1]), int(argv[2])
        mouse(0, row, col)
        time.sleep(0.05)
        mouse(0, row, col, release=True)
    elif op == 'move':
        mouse(35, int(argv[1]), int(argv[2]))
    elif op == 'wheel':
        row, col, count = int(argv[1]), int(argv[2]), int(argv[3])
        button = 65 if argv[4] == 'down' else 64
        for _ in range(count):
            mouse(button, row, col)
            time.sleep(0.03)
    elif op == 'snap':
        name = argv[1]
        path = os.path.join(WORK, f'snap-{name}.json')
        if os.path.exists(path):
            os.remove(path)
        push({'op': 'snap', 'name': name})
        wait_file(path)
        print_snapshot(json.load(open(path)), int(argv[2]) if len(argv) > 2 else 0)
    elif op == 'find':
        name = 'q'
        path = os.path.join(WORK, f'find-{name}.json')
        if os.path.exists(path):
            os.remove(path)
        push({'op': 'find', 'text': argv[1], 'name': name})
        wait_file(path)
        print(json.load(open(path)))
    elif op == 'resize':
        push({'op': 'resize', 'cols': int(argv[1]), 'rows': int(argv[2])})
    elif op == 'quit':
        push({'op': 'quit'})
    else:
        raise SystemExit(USAGE)


main(sys.argv[1:] if len(sys.argv) > 1 else ['help'])
