// 給 statusline 腳本印的一行：顏色、粗體、暗色跟原本畫在畫面上的一樣，改用 ANSI 色碼表示
import type { ThemeKey } from 'claude-code'

import type { Segment, Span } from './shared'

type Rgb = readonly [number, number, number]

// 各段之間空兩格、不加「·」，跟 statusline 其他欄位一樣（10/13 使用者要求縮短間距）
const SEGMENT_SEPARATOR = '  '
// Claude Code 深色主題的色票（2.1.296 執行檔查到；使用者的 theme 是 auto、終端機是深色），只列這一列用得到的
const DARK_THEME: Partial<Record<ThemeKey, Rgb>> = {
  claude: [215, 119, 87],
  text: [255, 255, 255],
  success: [78, 186, 101],
  error: [255, 107, 128],
  warning: [255, 193, 7],
  suggestion: [177, 185, 249],
}
// 暗色字用深色主題的 inactive，接近 Claude Code 畫 dimColor 的樣子
const DIM: Rgb = [153, 153, 153]
const CSI = '\x1b['
const RESET = `${CSI}0m`

export function ansiLine(segments: readonly Segment[]): string {
  const spans = segments.flatMap((segment, index) => {
    const [first, ...rest] = segment.spans ?? [segment]
    if (first === undefined) return []
    // 分隔的空白跟著該段第一個片段的樣式（沒有底色，看起來一樣）
    return index === 0 ? [first, ...rest] : [{ ...first, text: SEGMENT_SEPARATOR + first.text }, ...rest]
  })
  return spans.length === 0 ? '' : spans.map(styled).join('') + RESET
}

function styled(span: Span): string {
  const codes: string[] = []
  if (span.isBold) codes.push('1')
  const rgb = (span.color === undefined ? undefined : DARK_THEME[span.color]) ?? (span.isDim ? DIM : undefined)
  if (rgb !== undefined) codes.push(`38;2;${rgb.join(';')}`)
  // 有顏色又是暗色（例如「通知暫停」）：顏色再加上淡化
  if (span.color !== undefined && span.isDim) codes.push('2')
  return `${RESET}${codes.length > 0 ? `${CSI}${codes.join(';')}m` : ''}${span.text}`
}
