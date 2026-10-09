import { expect, test } from 'claude-code/testing'

import type { MascotCell, MascotSize, MascotState } from '../hooks/mascot'
import { LOOK_COUNT, MASCOT_COLUMNS, encodeRasterCells, mascotGrid, mascotRaster } from '../hooks/mascot'

const TERMINAL_DEFAULT = 0x01000000
const BODY_ORANGE = 0xd97757
const STALLED_YELLOW = 0xe5c07b
const FAILED_GRAY = 0x8a8a94
const SIZES: MascotSize[] = ['large', 'small']
const STATES: MascotState[] = ['running', 'stalled', 'done', 'failed']
// 半格方塊與空白以外的字元就是眼睛
const BLOCK_CHARS = new Set([' ', '▀', '▄', '█'])
// 東亞寬字元與全形符號（跟 layout.ts 的 WIDE_CHAR 同範圍）
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
// 字母、數字、標點、符號、一般空白；控制字元、組合符號、格式字元都不算可列印
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]$/u

const ROWS: Record<MascotSize, number> = { large: 4, small: 2 }
// 先確認尺寸對，下面逐格比對的測試才不會因為空陣列而空轉通過
const grid = (look: number, size: MascotSize, state: MascotState, frame = 0) => {
  const cells = mascotGrid({ look, size, state, frame })
  expect(cells.map(row => row.length)).toEqual(Array.from({ length: ROWS[size] }, () => MASCOT_COLUMNS))
  return cells
}
const looks = () => {
  expect(LOOK_COUNT).toBeGreaterThanOrEqual(6)
  return Array.from({ length: LOOK_COUNT }, (_, look) => look)
}
const chars = (cells: MascotCell[][]) => cells.map(row => row.map(cell => cell.char).join(''))
const eyeCells = (cells: MascotCell[][]) => cells.flat().filter(cell => !BLOCK_CHARS.has(cell.char))
// 畫得出來的顏色：空白格不算，終端機預設色（透明）不算
const visibleColors = (cells: MascotCell[][]) =>
  cells.flat().flatMap(cell => (cell.char === ' ' ? [] : [cell.foreground, cell.background])).filter(color => color !== TERMINAL_DEFAULT)
// 配件的顏色：扣掉眼睛格用到的眼睛色與身體色（手、腳也是身體色）
const accessoryColors = (cells: MascotCell[][]) => {
  const eyeAndBody = new Set(eyeCells(cells).flatMap(cell => [cell.foreground, cell.background]))
  return [...new Set(visibleColors(cells).filter(color => !eyeAndBody.has(color)))].sort((a, b) => a - b)
}
const isNarrowPrintableBmp = (char: string) => {
  const codePoint = char.codePointAt(0) ?? -1
  return [...char].length === 1 && codePoint <= 0xffff && PRINTABLE.test(char) && !WIDE_CHAR.test(char)
}
// 用環境的 atob 解 base64（跟模組自己的編碼互相獨立），再依 little-endian 讀回 u32
const decodeWords = (base64: string) => {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  return { byteLength: bytes.length, words: Array.from({ length: bytes.length / 4 }, (_, index) => view.getUint32(index * 4, true)) }
}

test('尺寸：large 7×4、small 7×2，mascotRaster 的 columns／rows 跟 grid 一致', () => {
  expect(MASCOT_COLUMNS).toBe(7)
  for (const look of looks()) {
    for (const state of STATES) {
      const large = grid(look, 'large', state)
      const small = grid(look, 'small', state)
      expect(large).toHaveLength(4)
      expect(small).toHaveLength(2)
      for (const row of [...large, ...small]) expect(row).toHaveLength(MASCOT_COLUMNS)
      // 兩個眼睛在同一列
      for (const cells of [large, small]) {
        const eyeRows = cells.map(row => row.filter(cell => !BLOCK_CHARS.has(cell.char)).length)
        expect(eyeRows.filter(count => count > 0)).toEqual([2])
      }
    }
  }
  const raster = mascotRaster({ look: 0, size: 'large', state: 'running', frame: 0 })
  expect([raster.columns, raster.rows]).toEqual([7, 4])
  const smallRaster = mascotRaster({ look: 0, size: 'small', state: 'done', frame: 0 })
  expect([smallRaster.columns, smallRaster.rows]).toEqual([7, 2])
})

test('編碼：標準 base64，解回 little-endian u32 是每格 [codePoint, 前景, 背景]', () => {
  // d.ts 範例的一格橘色方塊
  expect(encodeRasterCells([[{ char: '█', foreground: 0xff8800, background: TERMINAL_DEFAULT }]])).toBe('iCUAAACI/wAAAAAB')
  for (const size of SIZES) {
    const options = { look: 3, size, state: 'running' as const, frame: 0 }
    const cells = mascotGrid(options)
    const raster = mascotRaster(options)
    expect(raster.cells).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
    const { byteLength, words } = decodeWords(raster.cells)
    expect(byteLength).toBe(raster.columns * raster.rows * 12)
    expect(words).toEqual(cells.flat().flatMap(cell => [cell.char.codePointAt(0), cell.foreground, cell.background]))
    expect(raster.cells).toBe(encodeRasterCells(cells))
  }
})

test('顏色：只用 0x00RRGGBB 或終端機預設色；透明的地方是預設色', () => {
  for (const look of looks()) {
    for (const size of SIZES) {
      for (const state of STATES) {
        const cells = grid(look, size, state).flat()
        for (const cell of cells) {
          for (const color of [cell.foreground, cell.background]) expect(color <= 0xffffff || color === TERMINAL_DEFAULT).toBe(true)
        }
        // 上下都透明是空白，前景背景都是預設色；只有下半有顏色用 ▄，背景是預設色
        for (const cell of cells.filter(cell => cell.char === ' ')) expect([cell.foreground, cell.background]).toEqual([TERMINAL_DEFAULT, TERMINAL_DEFAULT])
        for (const cell of cells.filter(cell => cell.char === '▄')) expect(cell.background).toBe(TERMINAL_DEFAULT)
        expect(cells.some(cell => cell.foreground === TERMINAL_DEFAULT || cell.background === TERMINAL_DEFAULT)).toBe(true)
      }
    }
  }
})

test('字元：全部是寬度 1 的 BMP 可列印字元', () => {
  for (const look of looks()) {
    for (const size of SIZES) {
      for (const state of STATES) {
        for (const frame of [0, 3]) {
          const invalid = grid(look, size, state, frame).flat().filter(cell => !isNarrowPrintableBmp(cell.char))
          expect(invalid).toEqual([])
        }
      }
    }
  }
})

test('造型：至少 6 種，每種的配件形狀與顏色都不同，也不跟身體色撞色', () => {
  expect(LOOK_COUNT).toBeGreaterThanOrEqual(6)
  const shapes = looks().map(look => chars(grid(look, 'large', 'running')).join('\n'))
  expect(new Set(shapes).size).toBe(LOOK_COUNT)
  const palettes = looks().map(look => accessoryColors(grid(look, 'large', 'running')))
  expect(new Set(palettes.map(colors => colors.join(','))).size).toBe(LOOK_COUNT)
  for (const colors of palettes) {
    expect(colors.length).toBeGreaterThan(0)
    for (const bodyColor of [BODY_ORANGE, STALLED_YELLOW, FAILED_GRAY]) expect(colors).not.toContain(bodyColor)
  }
})

test('造型依 look 取餘數：負數、很大的數、非有限數都不會壞', () => {
  const sameAs = (look: number, expected: number) => expect(grid(look, 'large', 'running')).toEqual(grid(expected, 'large', 'running'))
  sameAs(LOOK_COUNT, 0)
  sameAs(LOOK_COUNT + 2, 2)
  sameAs(-1, LOOK_COUNT - 1)
  sameAs(-LOOK_COUNT - 2, LOOK_COUNT - 2)
  sameAs(1_000_000_007, 1_000_000_007 % LOOK_COUNT)
  sameAs(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER % LOOK_COUNT)
  sameAs(2.7, 2)
  for (const look of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) sameAs(look, 0)
})

test('running 依 frame 換腳：每 3 拍（0.6 秒）換一次，只有最下面腳那一列會變', () => {
  for (const look of looks()) {
    const at = (frame: number) => grid(look, 'large', 'running', frame)
    expect(at(1)).toEqual(at(0))
    expect(at(2)).toEqual(at(0))
    expect(at(3)).not.toEqual(at(0))
    expect(at(5)).toEqual(at(3))
    expect(at(6)).toEqual(at(0))
    expect(at(3).slice(0, 3)).toEqual(at(0).slice(0, 3))
  }
})

test('stalled、done、failed 停止走路，small 沒有腳，都不隨 frame 變化', () => {
  for (const look of looks()) {
    for (const size of SIZES) {
      for (const state of STATES) {
        if (size === 'large' && state === 'running') continue
        const first = grid(look, size, state, 0)
        for (const frame of [1, 3, 4, 7, 12]) expect(grid(look, size, state, frame)).toEqual(first)
      }
    }
  }
})

test('狀態：stalled 身體變黃、failed 身體變灰且眼睛 ×、done 的眼睛跟 running 不同', () => {
  for (const look of looks()) {
    for (const size of SIZES) {
      const eyesOf = (state: MascotState) => eyeCells(grid(look, size, state))
      const colorsOf = (state: MascotState) => visibleColors(grid(look, size, state))
      expect(eyesOf('running').map(cell => cell.background)).toEqual([BODY_ORANGE, BODY_ORANGE])
      expect(eyesOf('stalled').map(cell => cell.background)).toEqual([STALLED_YELLOW, STALLED_YELLOW])
      expect(colorsOf('stalled')).not.toContain(BODY_ORANGE)
      expect(eyesOf('failed').map(cell => [cell.char, cell.background])).toEqual([['×', FAILED_GRAY], ['×', FAILED_GRAY]])
      expect(colorsOf('failed')).not.toContain(BODY_ORANGE)
      expect(colorsOf('done')).toContain(BODY_ORANGE)
      const runningEye = eyesOf('running')[0]!.char
      expect(eyesOf('done').map(cell => cell.char)).not.toContain(runningEye)
      expect(eyesOf('done')[0]!.char).not.toBe('×')
      // 眼睛用深色，在身體上看得清楚
      for (const state of STATES) for (const eye of eyesOf(state)) expect(eye.foreground).not.toBe(eye.background)
    }
  }
})

test('small 保留配件顏色：跟 large 的配件色有交集，不同 look 的 small 也分得出來', () => {
  for (const state of STATES) {
    const smallPalettes = looks().map(look => {
      const large = accessoryColors(grid(look, 'large', state))
      const small = accessoryColors(grid(look, 'small', state))
      expect(small.length).toBeGreaterThan(0)
      expect(small.filter(color => large.includes(color)).length).toBeGreaterThan(0)
      return small.join(',')
    })
    expect(new Set(smallPalettes).size).toBe(LOOK_COUNT)
  }
})
