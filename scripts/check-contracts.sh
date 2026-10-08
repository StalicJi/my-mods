#!/bin/sh
# 檢查 my-mods 之間互相宣告的 state 形狀是否一致。
# 每個 mod 的 types/index.d.ts 會宣告自己的 state，以及它讀取的其他 mod 的 state（例如 where-am-i 讀
# clean-view 的 combinedBox）。把它們放進同一個編譯單元，同一個 key 兩邊宣告的型別不同時 tsc 會報 TS2717。
# claude plugin validate 不檢查別的 mod 的 state，所以改了任何 mod 的 types 後跑這支。
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 只要讓 'claude-code' 模組存在，各 mod 的 PluginState 才能擴充它；不需要完整的 API 型別
cat > "$work/claude-code.d.ts" <<'STUB'
declare module 'claude-code' {
  interface PluginState {}
}
STUB

files="\"$work/claude-code.d.ts\""
for contract in "$root"/*/types/index.d.ts; do
  files="$files, \"$contract\""
done

cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true
  },
  "files": [$files]
}
JSON

if npx -y -p typescript@5 tsc -p "$work/tsconfig.json"; then
  echo "合約一致：$(ls "$root"/*/types/index.d.ts | wc -l | tr -d ' ') 個 mod 的 state 宣告沒有衝突"
else
  echo "合約不一致：上面的 TS2717 指出哪個 key 兩邊宣告不同" >&2
  exit 1
fi
