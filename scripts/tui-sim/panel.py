# 重印已經存在的快照，只印第幾欄之後（例如停靠在右邊的面板）：python3 panel.py <快照名稱> <起始欄>
import json
import os
import sys

from common import WORK, print_snapshot

if len(sys.argv) < 3:
    raise SystemExit('用法：python3 panel.py <快照名稱> <起始欄>')
print_snapshot(json.load(open(os.path.join(WORK, f'snap-{sys.argv[1]}.json'))), int(sys.argv[2]))
