# 在虛擬終端機裡跑一個暫時的 Claude Code，用 pyte 解析畫面。用法（見同資料夾 README.md）：
#   uv run --no-project --with pyte python driver.py [欄 列]
# 透過工作資料夾裡的 cmd.jsonl 下指令（通常用 sim.py）：send（送原始位元組）、snap（存畫面與反白位置）、
# find（找文字的格子座標）、resize（改變視窗大小）、quit
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

import pyte

from common import WORK

# 初始大小可由參數指定：python driver.py 欄 列。面板要 110 欄以上才會自己停靠，窄於這個寬度只有狀態列
COLS = int(sys.argv[1]) if len(sys.argv) > 1 else 200
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 50
# 暫時 Claude Code 的參數：只放行 echo，示範子代理不會停在權限詢問
CLAUDE_ARGS = ['--model', 'sonnet', '--allowedTools', 'Bash(echo:*)']
PROJECT = os.path.join(WORK, 'project')
CMD = os.path.join(WORK, 'cmd.jsonl')
os.makedirs(PROJECT, exist_ok=True)
open(CMD, 'w').close()

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    os.chdir(PROJECT)
    # 只給最基本的環境變數：不帶 CLAUDE_*、CMUX_*，免得它以為自己是背景 session 或被 cmux 接管
    env = {
        'HOME': os.environ['HOME'],
        'USER': os.environ.get('USER', ''),
        'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:' + os.environ['HOME'] + '/.local/bin',
        'LANG': 'en_US.UTF-8',
        'TERM': 'xterm-256color',
        'SHELL': '/bin/zsh',
        'TMPDIR': os.environ.get('TMPDIR', '/tmp'),
    }
    os.execve(os.environ['HOME'] + '/.local/bin/claude', ['claude', *CLAUDE_ARGS], env)

# 終端機查詢（游標位置、裝置屬性）的回覆寫回給 Claude Code
screen.write_process_input = lambda text: os.write(fd, text.encode())


def rows_of_cells():
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        cells = []
        for x in range(screen.columns):
            char = line[x]
            if char.data == '':
                continue
            cells.append((x, char.data, char.reverse))
        rows.append(cells)
    return rows


def snap(name):
    rows = rows_of_cells()
    text = [''.join(data for _, data, _ in cells).rstrip() for cells in rows]
    reverse = []
    for y, cells in enumerate(rows):
        run = [(x, data) for x, data, rev in cells if rev and data.strip() != '']
        if run:
            reverse.append({'row': y, 'cols': [x for x, _ in run], 'text': ''.join(d for _, d in run)})
    with open(os.path.join(WORK, f'snap-{name}.json'), 'w') as f:
        json.dump({'text': text, 'reverse': reverse, 'cursor': [screen.cursor.y, screen.cursor.x]}, f, ensure_ascii=False, indent=0)


def find(needle, name):
    hits = []
    for y, cells in enumerate(rows_of_cells()):
        joined = ''
        cols = []
        for x, data, _ in cells:
            joined += data
            cols.extend([x] * len(data))
        start = joined.find(needle)
        while start >= 0:
            hits.append({'row': y, 'col': cols[start]})
            start = joined.find(needle, start + 1)
    with open(os.path.join(WORK, f'find-{name}.json'), 'w') as f:
        json.dump(hits, f, ensure_ascii=False)


offset = 0
alive = True
while alive:
    readable, _, _ = select.select([fd], [], [], 0.05)
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        stream.feed(data)
    with open(CMD) as f:
        f.seek(offset)
        chunk = f.read()
        offset = f.tell()
    for line in chunk.splitlines():
        if not line.strip():
            continue
        command = json.loads(line)
        op = command['op']
        if op == 'send':
            os.write(fd, bytes.fromhex(command['hex']))
        elif op == 'snap':
            snap(command['name'])
        elif op == 'find':
            find(command['text'], command['name'])
        elif op == 'resize':
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['cols'], 0, 0))
            screen.resize(command['rows'], command['cols'])
            os.kill(pid, signal.SIGWINCH)
        elif op == 'quit':
            alive = False
    time.sleep(0.01)

try:
    os.kill(pid, 15)
except ProcessLookupError:
    pass
