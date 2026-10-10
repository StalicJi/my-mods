// 子代理卡片左邊的像素小人（圖片版）：跟 mascot.ts 的方塊字元版同一套造型、顏色、狀態與走路速度，
// 改畫成 16×16 的 RGBA 圖交給 Image 元件（kitty 圖片協定），畫在 4 欄 × 2 列裡，像素細很多。
// 交出去的是壓過的小 PNG 不是 RGBA：每張只有幾百個 base64 字元，kitty 一個序列就送完，原因見 png.ts。
// 純函式、不 import claude-code；面板每 0.2 秒重畫，同一組（造型、狀態、腳的畫格）的圖只算一次

import type { MascotState, Palette } from './mascot'
import { ACCESSORY_PALETTES, EYE_COLOR, LOOK_COUNT, STATE_STYLES, WALK_STEP_FRAMES, toBase64, wrapIndex } from './mascot'
import { encodePng } from './png'

export const MASCOT_IMAGE_COLUMNS = 4
export const MASCOT_IMAGE_ROWS = 2

// Image 的 source：一個完整 PNG 的 base64
export type MascotImage = Readonly<{ png: string }>
type MascotImageOptions = { look: number; state: MascotState; frame: number }

// 4 欄 × 2 列大約是正方形，畫布也用正方形，縮放才不會變形
const CANVAS_SIZE = 16
// 先用最近鄰放大成 64×64 再交給終端機縮放，邊緣比讓終端機直接放大 16×16 清楚
const UPSCALE = 4
const IMAGE_SIZE = CANVAS_SIZE * UPSCALE
const BYTES_PER_PIXEL = 4
const OPAQUE = 255

// 像素圖的字母：'.' 透明、'B' 身體（顏色依狀態）、'E' 眼睛，其他字母是配件，顏色查 mascot.ts 各配件的 palette
const TRANSPARENT = '.'
const BODY = 'B'
const EYE = 'E'

// 身體 12×8（第 5～12 列）、兩側小手在第 9、10 列伸到畫布邊緣；上面 5 列留給配件
const BODY_ROWS = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  'BBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBB',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
]

// 最下面 3 列是四隻腳，一像素寬、左右各兩隻，中間隔開。停著時都著地；
// 走路時外側一對、內側一對輪流著地，抬起來的那對短一格（跟方塊版一樣外側、內側交替）
const STANDING_LEGS = [
  '...B.B....B.B...',
  '...B.B....B.B...',
  '...B.B....B.B...',
]
const WALKING_LEGS = [
  [
    '...B.B....B.B...',
    '...B.B....B.B...',
    '...B........B...',
  ],
  [
    '...B.B....B.B...',
    '...B.B....B.B...',
    '.....B....B.....',
  ],
]

// 眼睛從第 7 列疊上去：睜眼是 2×2 的點，完成瞇眼笑成 ^，失敗打 ×；兩眼左右對稱
const EYE_TOP = 7
const OPEN_EYES = [
  '....EE....EE....',
  '....EE....EE....',
]
const HAPPY_EYES = [
  '.....E....E.....',
  '....E.E..E.E....',
]
const CROSSED_EYES = [
  '....E.E..E.E....',
  '.....E....E.....',
  '....E.E..E.E....',
]
const EYES: Record<MascotState, readonly string[]> = {
  running: OPEN_EYES,
  stalled: OPEN_EYES,
  done: HAPPY_EYES,
  failed: CROSSED_EYES,
}

// 配件從第 0 列往下疊在身體上，'.' 的地方不蓋。順序與字母跟 mascot.ts 的 ACCESSORIES 一致
const ACCESSORIES: readonly (readonly string[])[] = [
  // 天線：藍綠色圓燈、灰色短桿，底座坐在頭頂
  [
    '.......cc.......',
    '......cccc......',
    '.......cc.......',
    '.......ss.......',
    '.....ssssss.....',
  ],
  // 牛仔帽：棕色，帽簷比頭寬、兩端往上翹
  [
    '................',
    '......hhhh......',
    '.....hhhhhh.....',
    'h....hhhhhh....h',
    '.hhhhhhhhhhhhhh.',
  ],
  // 耳機：藍色頭帶跨過頭頂，耳罩貼在頭的兩側、眼睛的高度
  [
    '................',
    '................',
    '................',
    '....pppppppp....',
    '..pp........pp..',
    '.p............p.',
    '.pp..........pp.',
    '.pp..........pp.',
    '.pp..........pp.',
  ],
  // 紅色鴨舌帽：深紅色帽舌往右伸出頭外
  [
    '................',
    '................',
    '.....rrrrrr.....',
    '...rrrrrrrrrr...',
    '..rrrrrrrrrvvvvv',
  ],
  // 黃色安全帽：圓頂、中間一道淺色凸稜、整圈帽簷
  [
    '................',
    '.....yywwyy.....',
    '....yyywwyyy....',
    '...yyyywwyyyy...',
    '.yyyyyyyyyyyyyy.',
  ],
  // 紫色巫師帽：尖頂、帽身一顆金色十字星、寬帽簷
  [
    '.......mm.......',
    '......mmsm......',
    '.....mmsssm.....',
    '....mmmmsmmm....',
    'mmmmmmmmmmmmmmmm',
  ],
  // 綠色毛帽：白色毛球、深綠色反摺，貼著頭不出帽簷
  [
    '.......ww.......',
    '......wwww......',
    '.....gggggg.....',
    '...gggggggggg...',
    '..kkkkkkkkkkkk..',
  ],
]

// 造型最多 7 種、狀態 4 種、腳 3 種姿勢，快取不會無限長大
const imageCache = new Map<string, MascotImage>()

export function mascotImage({ look, state, frame }: MascotImageOptions): MascotImage {
  const lookIndex = wrapIndex(look, LOOK_COUNT)
  // 只有執行中會走路；null 代表停著、四隻腳都著地
  const walkStep = state === 'running' ? wrapIndex(frame / WALK_STEP_FRAMES, WALKING_LEGS.length) : null
  const cacheKey = `${lookIndex}|${state}|${walkStep ?? 'stand'}`
  const cached = imageCache.get(cacheKey)
  if (cached) return cached

  const legs = walkStep === null ? STANDING_LEGS : WALKING_LEGS[walkStep]!
  const withEyes = overlay([...BODY_ROWS, ...legs], EYES[state], EYE_TOP)
  const pixels = overlay(withEyes, ACCESSORIES[lookIndex]!, 0)
  const palette: Palette = { ...ACCESSORY_PALETTES[lookIndex], [BODY]: STATE_STYLES[state].bodyColor, [EYE]: EYE_COLOR }
  const png = encodePng({ pixels: rasterize(pixels, palette), width: IMAGE_SIZE, height: IMAGE_SIZE })
  const image = Object.freeze({ png: toBase64(png) })
  imageCache.set(cacheKey, image)
  return image
}

// 把 layer 從第 top 列起疊到 base 上，layer 的 '.' 不蓋
function overlay(base: readonly string[], layer: readonly string[], top: number): string[] {
  return base.map((row, y) => {
    const cover = layer[y - top]
    if (cover === undefined) return row
    return [...row].map((pixel, x) => (cover[x] === undefined || cover[x] === TRANSPARENT ? pixel : cover[x])).join('')
  })
}

// 每個畫布像素放大成 UPSCALE × UPSCALE 的方塊（最近鄰），透明的地方留 0（alpha 也是 0）
function rasterize(pixels: readonly string[], palette: Palette): Uint8Array {
  const bytes = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE * BYTES_PER_PIXEL)
  pixels.forEach((row, y) => {
    ;[...row].forEach((pixel, x) => {
      if (pixel === TRANSPARENT) return
      const color = palette[pixel]
      if (color === undefined) throw new Error(`像素圖用了沒有定義顏色的字母：${pixel}`)
      fillBlock(bytes, x, y, color)
    })
  })
  return bytes
}

function fillBlock(bytes: Uint8Array, canvasX: number, canvasY: number, color: number): void {
  for (let dy = 0; dy < UPSCALE; dy++) {
    for (let dx = 0; dx < UPSCALE; dx++) {
      const offset = ((canvasY * UPSCALE + dy) * IMAGE_SIZE + canvasX * UPSCALE + dx) * BYTES_PER_PIXEL
      bytes[offset] = (color >> 16) & 0xff
      bytes[offset + 1] = (color >> 8) & 0xff
      bytes[offset + 2] = color & 0xff
      bytes[offset + 3] = OPAQUE
    }
  }
}
