// 東亞寬字元、全形符號與 emoji 在終端機佔兩格；範圍用 \u 跳脫，避免存檔時字元被正規化成別的碼位
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

function charWidth(char: string) {
  return WIDE_CHAR.test(char) ? 2 : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

// 超過寬度時依顯示寬度截斷，補「…」；中文一個字算兩格
export function fitToWidth(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return ''
  if (displayWidth(text) <= maxColumns) return text
  let kept = ''
  let width = 0
  for (const char of text) {
    if (width + charWidth(char) > maxColumns - 1) break
    kept += char
    width += charWidth(char)
  }
  return `${kept}…`
}

// 補空白到指定的顯示寬度；已經超過就原樣回傳
export function padToWidth(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - displayWidth(text)))
}

// 經過時間：「45秒」「2分05秒」「1小時02分」，跟 clean-view 的寫法一樣
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}小時${String(minutes).padStart(2, '0')}分`
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

// 事件的時間：本地時間的 時:分:秒
export function formatClock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}
