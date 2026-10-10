// 子代理卡片左邊的像素小人：Claude 吉祥物風格（橘色方身體、兩個眼睛、兩側小手、兩隻腳），
// 頭上的配件依派出順序輪流，讓同一個子代理從執行中到完成都認得出來。
// 純函式、不 import claude-code；畫好的格子交給 Raster 元件，cells 的編碼見 encodeRasterCells

export const MASCOT_COLUMNS = 5

export type MascotSize = 'large' | 'small'
export type MascotState = 'running' | 'stalled' | 'done' | 'failed'
export type MascotCell = { char: string; foreground: number; background: number }
type MascotOptions = { look: number; size: MascotSize; state: MascotState; frame: number }

// 像素圖的字母：'.' 透明、'B' 身體（顏色依狀態）、'E' 眼睛，其他字母是配件，顏色查各配件的 palette
export type Palette = Record<string, number>
type Accessory = { palette: Palette; pixels: string[] }

const TRANSPARENT = '.'
const BODY = 'B'
const EYE = 'E'

// Raster 的 0x01000000 是終端機預設色，當透明用，背景跟面板融在一起
const TERMINAL_DEFAULT = 0x01000000
export const EYE_COLOR = 0x1f1f24
// 卡住的黃色跟面板卡住時的進度條一致；失敗轉灰、眼睛打叉，一眼就跟完成（瞇眼笑）分開
export const STATE_STYLES: Record<MascotState, { bodyColor: number; eye: string }> = {
  running: { bodyColor: 0xd97757, eye: '•' },
  stalled: { bodyColor: 0xe5c07b, eye: '•' },
  done: { bodyColor: 0xd97757, eye: '^' },
  failed: { bodyColor: 0x8a8a94, eye: '×' },
}
// 計時器每拍 0.2 秒；每 3 拍（0.6 秒）換一次腳，比每拍都換穩重，面板上好幾隻一起走也不會太花
export const WALK_STEP_FRAMES = 3

// 大小人 6 個像素高（3 列）：上面 2 個像素留給配件；身體 3 個像素寬，眼睛佔第 1、2 個像素（同一格），
// 第 2 個像素兩側伸出手；最下面是腳。眼睛與手的那一格跟小小人一樣，兩種大小一眼看得出是同一隻
const LARGE_BODY = [
  '.....',
  '.....',
  '.EBE.',
  'BEBEB',
  '.BBB.',
]
// 兩隻腳停著時都著地；走路時輪流抬起一隻（左腳著地、右腳著地交替）
const STANDING_LEGS = '.B.B.'
const WALKING_LEGS = ['.B...', '...B.']

// 小小人 4 個像素高（2 列）：上面 2 個像素是配件，下面是眼睛與兩側的手，沒有腳
const SMALL_BODY = [
  '.....',
  '.....',
  '.EBE.',
  'BEBEB',
]

// 配件畫在最上面 2 個像素（剛好一列格子），'.' 的地方不蓋；兩種大小用同一個，只靠主色與輪廓分辨
const ACCESSORIES: Accessory[] = [
  // 天線：灰色桿子，頂端是藍綠色小燈
  {
    palette: { c: 0x4fd6e8, s: 0xb8b8c4 },
    pixels: [
      '..c..',
      '..s..',
    ],
  },
  // 牛仔帽：棕色，中間帽頂凸起、帽簷兩端往上翹
  {
    palette: { h: 0x8b5a2b },
    pixels: [
      'h.h.h',
      '.hhh.',
    ],
  },
  // 耳機：藍色頭帶從頭頂彎到兩側
  {
    palette: { p: 0x4c8df6 },
    pixels: [
      '.ppp.',
      'p...p',
    ],
  },
  // 紅色鴨舌帽：深紅色帽舌往右伸出去
  {
    palette: { r: 0xe5484d, v: 0xa8242c },
    pixels: [
      '.rrr.',
      '.rrvv',
    ],
  },
  // 黃色安全帽：圓頂、中間一道淺色凸稜、整圈帽簷
  {
    palette: { y: 0xf5c400, w: 0xfff2a8 },
    pixels: [
      '.ywy.',
      'yyyyy',
    ],
  },
  // 紫色巫師帽：尖頂、帽簷正中一顆金色星星、寬帽簷
  {
    palette: { m: 0x9b59d0, s: 0xffe066 },
    pixels: [
      '..m..',
      'mmsmm',
    ],
  },
  // 綠色毛帽：白色毛球、貼著頭不出帽簷；深綠色反摺只有圖片版畫得下
  {
    palette: { g: 0x3fb950, k: 0x23803a, w: 0xf0f0f0 },
    pixels: [
      '..w..',
      '.ggg.',
    ],
  },
]

export const LOOK_COUNT: number = ACCESSORIES.length
// 圖片版（mascot-image.ts）沿用同一套配件顏色，像素圖的字母也跟這裡一樣
export const ACCESSORY_PALETTES: readonly Palette[] = ACCESSORIES.map(accessory => accessory.palette)

export function mascotGrid({ look, size, state, frame }: MascotOptions): MascotCell[][] {
  const accessory = ACCESSORIES[wrapIndex(look, LOOK_COUNT)]!
  const body = size === 'large' ? [...LARGE_BODY, legs(state, frame)] : SMALL_BODY
  return toCells(overlay(body, accessory.pixels), accessory.palette, state)
}

export function mascotRaster(options: MascotOptions): { columns: number; rows: number; cells: string } {
  const grid = mascotGrid(options)
  return { columns: MASCOT_COLUMNS, rows: grid.length, cells: encodeRasterCells(grid) }
}

// 只有執行中會走路；卡住、完成、失敗都停下來
function legs(state: MascotState, frame: number): string {
  if (state !== 'running') return STANDING_LEGS
  return WALKING_LEGS[wrapIndex(frame / WALK_STEP_FRAMES, WALKING_LEGS.length)]!
}

// 把任意數字換算成 0 到 count - 1：負數從尾端繞回來，小數捨去，NaN、Infinity 當 0
export function wrapIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0
  return ((Math.floor(value) % count) + count) % count
}

function overlay(base: readonly string[], layer: readonly string[]): string[] {
  return base.map((row, y) => {
    const cover = layer[y]
    if (cover === undefined) return row
    return [...row].map((pixel, x) => (cover[x] === undefined || cover[x] === TRANSPARENT ? pixel : cover[x])).join('')
  })
}

// 每兩個像素列併成一列格子。眼睛那一格改畫一般字元：背景是身體色、前景是眼睛色，上下兩個像素都要是 E
function toCells(pixels: readonly string[], palette: Palette, state: MascotState): MascotCell[][] {
  const { bodyColor, eye } = STATE_STYLES[state]
  const colorOf = (pixel: string) => pixelColor(pixel, bodyColor, palette)
  return Array.from({ length: pixels.length / 2 }, (_, row) => {
    const upperRow = pixels[row * 2]!
    const lowerRow = pixels[row * 2 + 1]!
    return Array.from({ length: MASCOT_COLUMNS }, (_, column) => {
      const upper = upperRow[column]!
      const lower = lowerRow[column]!
      if (upper === EYE || lower === EYE) return { char: eye, foreground: EYE_COLOR, background: bodyColor }
      return halfBlockCell(colorOf(upper), colorOf(lower))
    })
  })
}

function pixelColor(pixel: string, bodyColor: number, palette: Palette): number | null {
  if (pixel === TRANSPARENT) return null
  if (pixel === BODY) return bodyColor
  const color = palette[pixel]
  if (color === undefined) throw new Error(`像素圖用了沒有定義顏色的字母：${pixel}`)
  return color
}

// 一格畫上下兩個像素：▀ 的前景是上面、背景是下面。只有下面有顏色時改用 ▄，背景留預設色才會透明
function halfBlockCell(upper: number | null, lower: number | null): MascotCell {
  if (upper === null) {
    return lower === null
      ? { char: ' ', foreground: TERMINAL_DEFAULT, background: TERMINAL_DEFAULT }
      : { char: '▄', foreground: lower, background: TERMINAL_DEFAULT }
  }
  if (lower === null) return { char: '▀', foreground: upper, background: TERMINAL_DEFAULT }
  if (upper === lower) return { char: '█', foreground: upper, background: upper }
  return { char: '▀', foreground: upper, background: lower }
}

const BYTES_PER_CELL = 12
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Raster 的 cells：row-major，每格三個 little-endian u32 [codePoint, 前景, 背景]，整串轉成標準 base64
export function encodeRasterCells(grid: MascotCell[][]): string {
  const cells = grid.flat()
  const bytes = new Uint8Array(cells.length * BYTES_PER_CELL)
  const view = new DataView(bytes.buffer)
  cells.forEach((cell, index) => {
    const offset = index * BYTES_PER_CELL
    view.setUint32(offset, cell.char.codePointAt(0) ?? 0x20, true)
    view.setUint32(offset + 4, cell.foreground, true)
    view.setUint32(offset + 8, cell.background, true)
  })
  return toBase64(bytes)
}

// 不用 Uint8Array.prototype.toBase64：claude plugin test 的環境有，但 ES2023 的型別與 Node 20 都沒有。
// 每 3 個位元組（24 bits）切成 4 個 6 bits 查表；尾端不足 3 個位元組時用 = 補齊
export function toBase64(bytes: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index
    const chunk = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    encoded += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]!
    encoded += remaining > 1 ? BASE64_ALPHABET[(chunk >> 6) & 63]! : '='
    encoded += remaining > 2 ? BASE64_ALPHABET[chunk & 63]! : '='
  }
  return encoded
}
