import { expect, test } from 'claude-code/testing'

import type { MascotState } from '../hooks/mascot'
import { LOOK_COUNT } from '../hooks/mascot'
import { MASCOT_IMAGE_COLUMNS, MASCOT_IMAGE_ROWS, mascotImage } from '../hooks/mascot-image'

const CANVAS_SIZE = 16
const BODY_ORANGE = 0xd97757
const STALLED_YELLOW = 0xe5c07b
const FAILED_GRAY = 0x8a8a94
const EYE_COLOR = 0x1f1f24
const STATES: MascotState[] = ['running', 'stalled', 'done', 'failed']
const STOPPED_STATES: MascotState[] = ['stalled', 'done', 'failed']
const BODY_COLORS: Record<MascotState, number> = { running: BODY_ORANGE, stalled: STALLED_YELLOW, done: BODY_ORANGE, failed: FAILED_GRAY }
// 使用者確認過的 7 種配件與顏色，依 look 順序；寫死在測試裡，模組改錯顏色才抓得到
const ACCESSORY_COLORS: number[][] = [
  [0x4fd6e8, 0xb8b8c4], // 天線：燈、桿
  [0x8b5a2b], // 牛仔帽
  [0x4c8df6], // 耳機
  [0xe5484d, 0xa8242c], // 鴨舌帽：帽身、帽舌
  [0xf5c400, 0xfff2a8], // 安全帽：帽身、凸稜
  [0x9b59d0, 0xffe066], // 巫師帽：帽身、星星
  [0x3fb950, 0x23803a, 0xf0f0f0], // 毛帽：帽身、反摺、毛球
]
const FEET_ROW = CANVAS_SIZE - 1

// 畫布上的一個像素：0xRRGGBB，透明是 null
type Pixel = number | null
type Options = { look: number; state: MascotState; frame?: number }

const looks = () => {
  expect(LOOK_COUNT).toBe(ACCESSORY_COLORS.length)
  return Array.from({ length: LOOK_COUNT }, (_, look) => look)
}
const imageOf = ({ look, state, frame = 0 }: Options) => mascotImage({ look, state, frame })
const rgbaOf = (options: Options) => imageOf(options).rgba
// 用環境的 atob 解 base64，跟模組自己的編碼互相獨立
const decodeBytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))

// 把放大後的圖縮回 16×16 畫布：每個放大方塊取左上角的像素（方塊內是否一致由尺寸測試檢查）
const canvasOf = (options: Options): Pixel[][] => {
  const image = imageOf(options)
  const bytes = decodeBytes(image.rgba)
  expect(bytes.length).toBe(image.width * image.height * 4)
  const scale = image.width / CANVAS_SIZE
  return Array.from({ length: CANVAS_SIZE }, (_, y) =>
    Array.from({ length: CANVAS_SIZE }, (_, x) => {
      const offset = (y * scale * image.width + x * scale) * 4
      if (bytes[offset + 3] === 0) return null
      return (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!
    }),
  )
}
const colorsOf = (canvas: Pixel[][]) => [...new Set(canvas.flat().filter((pixel): pixel is number => pixel !== null))].sort((a, b) => a - b)
const positionsOf = (canvas: Pixel[][], color: number) => canvas.flatMap((row, y) => row.flatMap((pixel, x) => (pixel === color ? [`${x},${y}`] : [])))
const mirrored = (positions: string[]) =>
  positions
    .map(position => {
      const [x, y] = position.split(',').map(Number)
      return `${CANVAS_SIZE - 1 - x!},${y!}`
    })
    .sort()
// 最下面一列不透明的欄位：就是著地的腳
const groundedColumns = (canvas: Pixel[][]) => canvas[FEET_ROW]!.flatMap((pixel, x) => (pixel === null ? [] : [x]))
// 連在一起的欄位算一隻腳
const countRuns = (columns: number[]) => columns.filter((column, index) => index === 0 || columns[index - 1] !== column - 1).length

test('尺寸：4 欄 × 2 列；圖是 16×16 畫布用最近鄰放大成整數倍的正方形，rgba 是標準 base64', () => {
  expect([MASCOT_IMAGE_COLUMNS, MASCOT_IMAGE_ROWS]).toEqual([4, 2])
  for (const look of looks()) {
    for (const state of STATES) {
      for (const frame of [0, 3]) {
        const image = imageOf({ look, state, frame })
        expect(image.width).toBe(image.height)
        expect(image.width % CANVAS_SIZE).toBe(0)
        const scale = image.width / CANVAS_SIZE
        expect(scale).toBeGreaterThanOrEqual(2)
        expect(image.rgba).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
        expect(image.rgba.length % 4).toBe(0)
        const bytes = decodeBytes(image.rgba)
        expect(bytes.length).toBe(image.width * image.height * 4)
        // 最近鄰放大：每個 scale × scale 方塊裡的像素跟方塊左上角完全一樣
        let mismatches = 0
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            const offset = (y * image.width + x) * 4
            const origin = (Math.floor(y / scale) * scale * image.width + Math.floor(x / scale) * scale) * 4
            for (let channel = 0; channel < 4; channel++) if (bytes[offset + channel] !== bytes[origin + channel]) mismatches++
          }
        }
        expect(mismatches).toBe(0)
      }
    }
  }
})

test('背景透明：alpha 只有 0 或 255，四個角落是透明的，透明的地方佔不少', () => {
  for (const look of looks()) {
    for (const state of STATES) {
      const bytes = decodeBytes(rgbaOf({ look, state }))
      const alphas = bytes.filter((_, index) => index % 4 === 3)
      expect(alphas.every(alpha => alpha === 0 || alpha === 255)).toBe(true)
      expect(alphas.filter(alpha => alpha === 0).length).toBeGreaterThan(alphas.length / 4)
      const canvas = canvasOf({ look, state })
      const last = CANVAS_SIZE - 1
      expect([canvas[0]![0], canvas[0]![last], canvas[last]![0], canvas[last]![last]]).toEqual([null, null, null, null])
    }
  }
})

test('7 種造型：配件顏色各自出現，任何狀態都保留原色，也不混進別種造型的顏色', () => {
  expect(LOOK_COUNT).toBe(7)
  for (const look of looks()) {
    for (const state of STATES) {
      const expected = [BODY_COLORS[state], EYE_COLOR, ...ACCESSORY_COLORS[look]!].sort((a, b) => a - b)
      expect(colorsOf(canvasOf({ look, state }))).toEqual(expected)
    }
  }
})

test('造型依 look 取餘數：負數、很大的數、小數、NaN、Infinity 都不會壞', () => {
  const sameAs = (look: number, expected: number) => expect(rgbaOf({ look, state: 'running' })).toBe(rgbaOf({ look: expected, state: 'running' }))
  sameAs(LOOK_COUNT, 0)
  sameAs(LOOK_COUNT + 2, 2)
  sameAs(-1, LOOK_COUNT - 1)
  sameAs(-LOOK_COUNT - 2, LOOK_COUNT - 2)
  sameAs(1_000_000_007, 1_000_000_007 % LOOK_COUNT)
  sameAs(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER % LOOK_COUNT)
  sameAs(2.7, 2)
  for (const look of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) sameAs(look, 0)
  // 每種造型的圖都不一樣
  expect(new Set(looks().map(look => rgbaOf({ look, state: 'running' }))).size).toBe(LOOK_COUNT)
})

test('running 依 frame 換腳：每 3 拍（0.6 秒）換一次，只有腳的部分會變；frame 是 NaN、Infinity、負數也不會壞', () => {
  for (const look of looks()) {
    const at = (frame: number) => rgbaOf({ look, state: 'running', frame })
    expect(at(1)).toBe(at(0))
    expect(at(2)).toBe(at(0))
    expect(at(3)).not.toBe(at(0))
    expect(at(5)).toBe(at(3))
    expect(at(6)).toBe(at(0))
    expect(at(-1)).toBe(at(3))
    for (const frame of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(at(frame)).toBe(at(0))
    // 身體、眼睛、配件都不動，只有最下面三列的腳換
    const first = canvasOf({ look, state: 'running', frame: 0 })
    const second = canvasOf({ look, state: 'running', frame: 3 })
    expect(second.slice(0, CANVAS_SIZE - 3)).toEqual(first.slice(0, CANVAS_SIZE - 3))
  }
})

test('running 兩個畫格輪流著地：最下面一列各兩隻腳、互不重疊，合起來剛好是停著時的四隻', () => {
  for (const look of looks()) {
    const standing = groundedColumns(canvasOf({ look, state: 'done' }))
    const first = groundedColumns(canvasOf({ look, state: 'running', frame: 0 }))
    const second = groundedColumns(canvasOf({ look, state: 'running', frame: 3 }))
    expect(countRuns(first)).toBe(2)
    expect(countRuns(second)).toBe(2)
    expect(first.filter(column => second.includes(column))).toEqual([])
    expect([...first, ...second].sort((a, b) => a - b)).toEqual(standing)
  }
})

test('stalled、done、failed 停下來不隨 frame 變；四隻腳都著地、彼此分開，是身體色', () => {
  for (const look of looks()) {
    for (const state of STOPPED_STATES) {
      const first = rgbaOf({ look, state, frame: 0 })
      for (const frame of [1, 3, 4, 7, 12, -1, Number.NaN]) expect(rgbaOf({ look, state, frame })).toBe(first)
      const canvas = canvasOf({ look, state })
      const feet = groundedColumns(canvas)
      expect(countRuns(feet)).toBe(4)
      for (const column of feet) expect(canvas[FEET_ROW]![column]).toBe(BODY_COLORS[state])
    }
  }
})

test('身體：左右對稱（走路的兩個畫格也是），兩側的小手伸到畫布邊緣', () => {
  for (const look of looks()) {
    for (const state of STATES) {
      for (const frame of [0, 3]) {
        const canvas = canvasOf({ look, state, frame })
        const body = positionsOf(canvas, BODY_COLORS[state]).sort()
        expect(mirrored(body)).toEqual(body)
        const armRows = canvas.filter(row => row[0] === BODY_COLORS[state] && row[CANVAS_SIZE - 1] === BODY_COLORS[state])
        expect(armRows.length).toBeGreaterThan(0)
      }
    }
  }
})

test('狀態顏色：stalled 身體變黃、failed 身體轉灰，running 與 done 是橘色', () => {
  for (const look of looks()) {
    const colors = (state: MascotState) => colorsOf(canvasOf({ look, state }))
    expect(colors('running')).toContain(BODY_ORANGE)
    expect(colors('done')).toContain(BODY_ORANGE)
    expect(colors('stalled')).toContain(STALLED_YELLOW)
    expect(colors('stalled')).not.toContain(BODY_ORANGE)
    expect(colors('failed')).toContain(FAILED_GRAY)
    expect(colors('failed')).not.toContain(BODY_ORANGE)
  }
})

test('眼睛：running 與 stalled 一樣，done、failed 跟 running 不同、彼此也不同；兩眼左右對稱、各在一側', () => {
  for (const look of looks()) {
    const eyes = (state: MascotState) => positionsOf(canvasOf({ look, state }), EYE_COLOR).sort()
    const running = eyes('running')
    expect(eyes('stalled')).toEqual(running)
    expect(eyes('done')).not.toEqual(running)
    expect(eyes('failed')).not.toEqual(running)
    expect(eyes('failed')).not.toEqual(eyes('done'))
    for (const state of STATES) {
      const positions = eyes(state)
      // 每隻眼睛至少 2 個像素，表情才看得出形狀
      expect(positions.length).toBeGreaterThanOrEqual(4)
      expect(mirrored(positions)).toEqual(positions)
      const leftHalf = positions.filter(position => Number(position.split(',')[0]) < CANVAS_SIZE / 2)
      expect(leftHalf.length * 2).toBe(positions.length)
    }
  }
})

test('快取：同一組（look、狀態、腳的畫格）回傳同一個物件，等價的 look、frame 也是；不同組合的圖不同', () => {
  for (const look of looks()) {
    for (const state of STATES) {
      const image = imageOf({ look, state, frame: 0 })
      expect(Object.isFrozen(image)).toBe(true)
      expect(imageOf({ look, state, frame: 0 })).toBe(image)
      expect(imageOf({ look: look + LOOK_COUNT, state, frame: 1 })).toBe(image)
    }
    expect(imageOf({ look, state: 'stalled', frame: 5 })).toBe(imageOf({ look, state: 'stalled', frame: 0 }))
    expect(imageOf({ look, state: 'running', frame: 3 })).toBe(imageOf({ look, state: 'running', frame: 4 }))
  }
  const all = looks().flatMap(look => [...STATES.map(state => rgbaOf({ look, state })), rgbaOf({ look, state: 'running', frame: 3 })])
  // stalled 的身體色不同，所以 5 種組合（running 兩格、stalled、done、failed）× 7 種造型都不一樣
  expect(new Set(all).size).toBe(LOOK_COUNT * 5)
})
