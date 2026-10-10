import { expect, test } from 'claude-code/testing'

import type { MascotState } from '../hooks/mascot'
import { LOOK_COUNT } from '../hooks/mascot'
import { MASCOT_IMAGE_COLUMNS, MASCOT_IMAGE_ROWS, mascotImage } from '../hooks/mascot-image'
import type { DecodedPng } from './png-decoder'
import { base64Bytes, decodePng, readChunks } from './png-decoder'

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
// kitty 圖片序列一段最多 4096 個 base64 字元；超過就得分段送，經過背景 session 的 pty 轉送時會被切斷、像素漏成文字
const KITTY_CHUNK_LIMIT = 4096
// 改成 PNG 之前（9fabdf2）mascotImage 回傳的 64×64 RGBA，每張的 SHA-256。像素一個 byte 都不能變
const RGBA_SHA256_BEFORE_PNG: Record<string, string> = {
  '0|running|0': 'c0aed21de6427e8bbeef390b436234e7f74c2d8e4e082ebda63213ee4ab2ca72',
  '0|running|3': '5d0c76c36f9c32e28105be9c5191d23a93fb184560f24baad0dc89294a938ce9',
  '0|stalled|0': 'deb6c4e13eb3f6ddda0436b5392b953d25c842d2319035096144ddc5589dcdc2',
  '0|done|0': '399d0dad3368fdc3c26a0d5f6092a180d231f360319deae67774e050ab833a79',
  '0|failed|0': '68ceb98431a681b2e2290b8113f3da56861112033df270143191864c6963c973',
  '1|running|0': '2ea8a2a4426cb64e72749c85b9a9ad00c7ac37d6293e11a9362530e83a0ad9bd',
  '1|running|3': '8599c93266bd98a50b8523038ebc1c90a2507802fb7691fb154ae79b7bc84c4f',
  '1|stalled|0': '9e36094d61981efd140f0c32c52bdd2a3b8ca21d4aaa08e751bf9b7e72616f37',
  '1|done|0': 'aa92502442d30d3487a90d575658f180feddd7b926ac54878af3fb5c61c89aa7',
  '1|failed|0': '73b812f17ae52aca0510b6b1ab55a5ac33dfb322e0cd1192a7dbf57575e93bce',
  '2|running|0': '9c6073fac355d604865e46fc902e218d44d8d3e651d8520f590d84a826b7f0ee',
  '2|running|3': '29645ca196b1cb0f9de9da8bd582b506d5d1e0f62c1266ec2b831f0bd31259c0',
  '2|stalled|0': '5a069ae15e6649fe744f5c84cce3526494bcf7d31a8cc32ce8e7eab33b78fba1',
  '2|done|0': '6d17186b7fca038fb999d3fbb1d50e12e0836f278c55f08920fc554e0af2bab6',
  '2|failed|0': 'c9a04613cc58de93bd98d8df68ef8bd5a474a2f94ad5b812679ce5df4459d68d',
  '3|running|0': '8d97e3f4b6b82e42dded7bfbcaf0d989c80e730d19df590c5a2a861f9c0bb968',
  '3|running|3': 'f208c1213e1d84684df60fd513b313655743878f03106a5846522c502dd15c03',
  '3|stalled|0': '7374e167db4f15ec1c1dd7770ad489b6037281a0f481e7d6426f2df85be9ab53',
  '3|done|0': 'f87b19c0e91a657e20e7408dec8891026e854ab2b891038aa26cc8ad005f3c8e',
  '3|failed|0': 'd6d37db2e1501d7465e8a46e3d22c6f764a683a56c178988102f321f0fba14c8',
  '4|running|0': '61803971f0d2c7c1ade10eb07cc951488d2108197907752b0126c8284dea4721',
  '4|running|3': '4e2a89fa8ddf88dfaba16b7fd47ceb7c855627a326a765f46470c75b80c0a925',
  '4|stalled|0': 'd7b9d23fff986c2de2b02f3476e57bd4b37b2ae971a08d2aea0a4d6e8ce66bf6',
  '4|done|0': '963af89ddc34292136342bffc0fe2ceab65ce4c7793932a3bfa8c859f3345a39',
  '4|failed|0': 'a5532ee5a2b345cc0194422afb93b3356bf29304c97e9d14fc25ad91d2dc4313',
  '5|running|0': 'bf0442726d2376308940867ab6b6f9eb4a4d90cd29a12d071ea876576bd99437',
  '5|running|3': 'd645c366754cd6e64d12818d29896cd705a72b9873594f0cd8b3dd7ba61e7d4f',
  '5|stalled|0': '483eac68999233822c01a74665a88776b6e664000e0b0c7e343896bc7de5c4b0',
  '5|done|0': 'a2adca33de6f31a5a1a197ccfea2728afa44f3022cc6b5d6a185375a953ff90e',
  '5|failed|0': 'e3aa2a953af4a72fa5017e7ee4c1e0c276ca57413a5b30c5a7a34850eff9c497',
  '6|running|0': '12277ce3831cba113e6e68bc3d71f803e7faec274fc8da5e1a07d2e22dff3c37',
  '6|running|3': '2b0cc27979c046b4414e8394d2e5b32fec961601b4d0ebc5253205c9a5cb8352',
  '6|stalled|0': '54562318f0620962a6f239bb6d9556c0e3973395533282c499c02cb812d03144',
  '6|done|0': '6f30cb03a8999c098b2d772b641c12d31d82707073b5e0eaeae172dd779a515d',
  '6|failed|0': '13c365110118800bb9b3d34deea68cc5fe4258c1bcc73288bfa66ceb39a5c087',
}
// 每種造型都有的 5 種圖：走路的兩個畫格、卡住、完成、失敗
const VARIANTS: { state: MascotState; frame: number }[] = [
  { state: 'running', frame: 0 },
  { state: 'running', frame: 3 },
  { state: 'stalled', frame: 0 },
  { state: 'done', frame: 0 },
  { state: 'failed', frame: 0 },
]

// 畫布上的一個像素：0xRRGGBB，透明是 null
type Pixel = number | null
type Options = { look: number; state: MascotState; frame?: number }

const looks = () => {
  expect(LOOK_COUNT).toBe(ACCESSORY_COLORS.length)
  return Array.from({ length: LOOK_COUNT }, (_, look) => look)
}
const allImages = () => looks().flatMap(look => VARIANTS.map(variant => ({ look, ...variant })))
const imageOf = ({ look, state, frame = 0 }: Options) => mascotImage({ look, state, frame })
// 用測試自己的解碼器把 PNG 解回 RGBA（嚴格：CRC、Adler-32、filter 不對都會丟例外）；同一張 PNG 只解一次
const decodedCache = new Map<string, DecodedPng>()
const decodedOf = (options: Options): DecodedPng => {
  const { png } = imageOf(options)
  const cached = decodedCache.get(png)
  if (cached) return cached
  const decoded = decodePng(base64Bytes(png))
  decodedCache.set(png, decoded)
  return decoded
}
// 解回來的 RGBA 轉成字串，拿來比兩張圖的像素是否完全相同
const pixelsOf = (options: Options) => Array.from(decodedOf(options).rgba, byte => String.fromCharCode(byte)).join('')
const sha256Of = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')

// 把放大後的圖縮回 16×16 畫布：每個放大方塊取左上角的像素（方塊內是否一致由尺寸測試檢查）
const canvasOf = (options: Options): Pixel[][] => {
  const image = decodedOf(options)
  const bytes = image.rgba
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

test('回傳 { png }：標準 base64，35 張都小於 4096 字元，kitty 一個序列就送完', () => {
  const images = allImages()
  expect(images.length).toBe(35)
  for (const options of images) {
    const image = imageOf(options)
    expect(Object.keys(image)).toEqual(['png'])
    expect(image.png).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
    expect(image.png.length % 4).toBe(0)
    expect({ ...options, fits: image.png.length < KITTY_CHUNK_LIMIT }).toEqual({ ...options, fits: true })
  }
})

test('PNG 結構：簽章、IHDR 是 64×64、bit depth 8、color type 6（RGBA），只有 IHDR、IDAT、IEND，CRC 都對', () => {
  for (const options of allImages()) {
    const bytes = base64Bytes(imageOf(options).png)
    const chunks = readChunks(bytes)
    expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.every(chunk => chunk.crcMatches)).toBe(true)
    const decoded = decodedOf(options)
    expect([decoded.width, decoded.height, decoded.bitDepth, decoded.colorType, decoded.interlace]).toEqual([64, 64, 8, 6, 0])
  }
})

test('解回的像素跟改成 PNG 之前的 RGBA 逐位元組相同（35 張的 SHA-256 都對得上）', async () => {
  const images = allImages()
  expect(images.length).toBe(Object.keys(RGBA_SHA256_BEFORE_PNG).length)
  for (const options of images) {
    const key = `${options.look}|${options.state}|${options.frame}`
    const rgba = decodedOf(options).rgba
    expect(rgba.length).toBe(64 * 64 * 4)
    expect({ key, sha256: await sha256Of(rgba) }).toEqual({ key, sha256: RGBA_SHA256_BEFORE_PNG[key]! })
  }
})

test('尺寸：4 欄 × 2 列；解回的圖是 16×16 畫布用最近鄰放大成整數倍的正方形', () => {
  expect([MASCOT_IMAGE_COLUMNS, MASCOT_IMAGE_ROWS]).toEqual([4, 2])
  for (const look of looks()) {
    for (const state of STATES) {
      for (const frame of [0, 3]) {
        const image = decodedOf({ look, state, frame })
        expect(image.width).toBe(image.height)
        expect(image.width % CANVAS_SIZE).toBe(0)
        const scale = image.width / CANVAS_SIZE
        expect(scale).toBeGreaterThanOrEqual(2)
        const bytes = image.rgba
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
      const bytes = decodedOf({ look, state }).rgba
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
  const sameAs = (look: number, expected: number) => expect(pixelsOf({ look, state: 'running' })).toBe(pixelsOf({ look: expected, state: 'running' }))
  sameAs(LOOK_COUNT, 0)
  sameAs(LOOK_COUNT + 2, 2)
  sameAs(-1, LOOK_COUNT - 1)
  sameAs(-LOOK_COUNT - 2, LOOK_COUNT - 2)
  sameAs(1_000_000_007, 1_000_000_007 % LOOK_COUNT)
  sameAs(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER % LOOK_COUNT)
  sameAs(2.7, 2)
  for (const look of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) sameAs(look, 0)
  // 每種造型的圖都不一樣
  expect(new Set(looks().map(look => pixelsOf({ look, state: 'running' }))).size).toBe(LOOK_COUNT)
})

test('running 依 frame 換腳：每 3 拍（0.6 秒）換一次，只有腳的部分會變；frame 是 NaN、Infinity、負數也不會壞', () => {
  for (const look of looks()) {
    const at = (frame: number) => pixelsOf({ look, state: 'running', frame })
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
      const first = pixelsOf({ look, state, frame: 0 })
      for (const frame of [1, 3, 4, 7, 12, -1, Number.NaN]) expect(pixelsOf({ look, state, frame })).toBe(first)
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
  const all = looks().flatMap(look => [...STATES.map(state => pixelsOf({ look, state })), pixelsOf({ look, state: 'running', frame: 3 })])
  // stalled 的身體色不同，所以 5 種組合（running 兩格、stalled、done、failed）× 7 種造型都不一樣
  expect(new Set(all).size).toBe(LOOK_COUNT * 5)
})
