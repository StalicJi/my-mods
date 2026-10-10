import { expect, test } from 'claude-code/testing'

import { encodePng } from '../hooks/png'
import type { RgbaImage } from '../hooks/png'
import { base64Bytes, decodePng, hasPngSignature, inflateZlib, readChunks } from './png-decoder'

// kitty 圖片序列一段最多 4096 個 base64 字元；超過就得分段送，經過背景 session 的 pty 轉送時會被切斷、像素漏成文字
const KITTY_CHUNK_LIMIT = 4096
const RGBA_BYTES = 4

const pixelsOf = (width: number, height: number, colorAt: (x: number, y: number) => readonly number[]): RgbaImage => {
  const pixels = new Uint8Array(width * height * RGBA_BYTES)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(colorAt(x, y), (y * width + x) * RGBA_BYTES)
  return { pixels, width, height }
}
const solid = (width: number, height: number, color: readonly number[]) => pixelsOf(width, height, () => color)
// 固定種子的線性同餘亂數：每次跑都一樣，而且 0～255 每種 byte 值都會出現
const noise = (width: number, height: number, seed: number): RgbaImage => {
  let state = seed
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 24
  return pixelsOf(width, height, () => [next(), next(), next(), next()])
}
// 16×16 畫布、每格隨機挑一種顏色（有透明），再用最近鄰放大 4 倍：跟小人一樣是大色塊，但沒有大片透明，比小人難壓
const blocky = (seed: number): RgbaImage => {
  const colors = Array.from({ length: 12 }, (_, index) => (index === 0 ? [0, 0, 0, 0] : [index * 20, 255 - index * 17, (index * 73) % 256, 255]))
  let state = seed
  const canvas = Array.from({ length: 16 * 16 }, () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % colors.length)
  return pixelsOf(64, 64, (x, y) => colors[canvas[Math.floor(y / 4) * 16 + Math.floor(x / 4)]!]!)
}
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
// 第一個不同的位置，相同回傳 -1；直接 toEqual 幾萬個 byte 的陣列，失敗時訊息會長到看不懂
const firstDifference = (actual: Uint8Array, expected: Uint8Array) => {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length)
  return actual.findIndex((byte, index) => byte !== expected[index])
}

const SAMPLES: Record<string, RgbaImage> = {
  '1×1 透明': solid(1, 1, [0, 0, 0, 0]),
  '3×2 各點不同色': pixelsOf(3, 2, (x, y) => [x * 80, y * 120, 200, x === 1 ? 0 : 255]),
  '300×1 單色長串（重複超過 258 bytes）': solid(300, 1, [0xd9, 0x77, 0x57, 0xff]),
  '100×100 單色': solid(100, 100, [0x1f, 0x1f, 0x24, 0xff]),
  '16×16 雜訊': noise(16, 16, 7),
  '37×23 雜訊': noise(37, 23, 2024),
  '64×64 放大的色塊': blocky(1),
  // 一列 32801 bytes，超過 deflate 最遠 32768 的回頭距離，不能整列照抄上一列
  '8200×2 一列超過 32K 視窗': pixelsOf(8200, 2, (x, y) => [x & 0xff, (x >> 8) & 0xff, y, 255]),
}

test('測試用解碼器先對過標準 zlib（python）：未壓縮、固定 Huffman、動態 Huffman 三種區塊，以及一張標準 PNG', () => {
  const fixtures = [
    ['YWdlbnQtcGFuZWwgc3RvcmVkIGJsb2Nr', 'eAEBGADn/2FnZW50LXBhbmVsIHN0b3JlZCBibG9ja3KkCSk='],
    ['YWJjYWJjYWJjYWJjYWJjYWJjIGhlbGxvIGhlbGxvIGhlbGxv', 'eNpLTEpOREUKGak5OfnIJAD58w2B'],
    [
      'VGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4gVGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4gVGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4gUGFjayBteSBib3ggd2l0aCBmaXZlIGRvemVuIGxpcXVvciBqdWdzISAwMTIzNDU2Nzg5',
      'eNq1y9kVQDAURdFWrgYs89CFDw0EQUyPkCDVe034PvvUo8RhVDuj0XRv6OnBZNb9BFmpcXFehHvR0eCj/g1Xgt36omF0q2tEr6zk5OSGRR2GNL/D6SEIozhJs7woP3RwQS0=',
    ],
  ]
  for (const [plain, compressed] of fixtures) {
    const inflated = inflateZlib(base64Bytes(compressed!))
    expect(toBase64(inflated.output)).toBe(plain!)
    expect([inflated.adlerMatches, inflated.trailingBytes]).toEqual([true, 0])
  }
  const reference = decodePng(base64Bytes('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR42mO4WR7+nwEE5OVV/vtfe9EAADaoBpUSwPytAAAAAElFTkSuQmCC'))
  expect([reference.width, reference.height]).toEqual([2, 2])
  expect([...reference.rgba]).toEqual([0xd9, 0x77, 0x57, 0xff, 0, 0, 0, 0, 0x1f, 0x1f, 0x24, 0xff, 0x4f, 0xd6, 0xe8, 0x80])
})

test('PNG 結構：簽章、IHDR（寬高、bit depth 8、color type 6、壓縮／filter／交錯都是 0），每個 chunk 的 CRC 都對，最後是空的 IEND', () => {
  for (const [name, image] of Object.entries(SAMPLES)) {
    const png = encodePng(image)
    expect({ name, signature: hasPngSignature(png) }).toEqual({ name, signature: true })
    const chunks = readChunks(png)
    expect({ name, types: chunks.map(chunk => chunk.type) }).toEqual({ name, types: ['IHDR', 'IDAT', 'IEND'] })
    expect({ name, crc: chunks.map(chunk => chunk.crcMatches) }).toEqual({ name, crc: [true, true, true] })
    const header = chunks[0]!.data
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    expect({ name, width: view.getUint32(0), height: view.getUint32(4), rest: [...header.subarray(8)] }).toEqual({
      name,
      width: image.width,
      height: image.height,
      rest: [8, 6, 0, 0, 0],
    })
    expect(chunks[2]!.data.length).toBe(0)
  }
})

test('IDAT 是合法的 zlib：標頭 CM 8、視窗不超過 32K、可被 31 整除、沒有預設字典；Adler-32 對、後面沒有多餘的資料', () => {
  for (const [name, image] of Object.entries(SAMPLES)) {
    const data = readChunks(encodePng(image))[1]!.data
    const [cmf, flg] = data
    expect({ name, method: cmf! & 0x0f, window: cmf! >> 4, check: ((cmf! << 8) | flg!) % 31, dictionary: flg! & 0x20 }).toEqual({
      name,
      method: 8,
      window: 7,
      check: 0,
      dictionary: 0,
    })
    const inflated = inflateZlib(data)
    expect({ name, adler: inflated.adlerMatches, trailing: inflated.trailingBytes }).toEqual({ name, adler: true, trailing: 0 })
  }
})

test('解壓後跟輸入逐位元組相同：每列前面 filter 0，透明、單色長串、雜訊、放大的色塊、超過 32K 視窗的寬圖都對', () => {
  for (const [name, image] of Object.entries(SAMPLES)) {
    const decoded = decodePng(encodePng(image))
    expect({ name, width: decoded.width, height: decoded.height }).toEqual({ name, width: image.width, height: image.height })
    expect({ name, difference: firstDifference(decoded.rgba, image.pixels) }).toEqual({ name, difference: -1 })
  }
})

test('放大 4 倍的 16×16 色塊圖壓得夠小：base64 小於 4096 字元，kitty 一個序列就送完', () => {
  for (const seed of [1, 2, 3, 42, 2024]) {
    const length = toBase64(encodePng(blocky(seed))).length
    expect({ seed, fits: length < KITTY_CHUNK_LIMIT }).toEqual({ seed, fits: true })
  }
  // 單色的大圖幾乎全是重複：100×100 的四萬 bytes 壓到 2% 以下
  const solidImage = SAMPLES['100×100 單色']!
  expect(encodePng(solidImage).length).toBeLessThan(solidImage.pixels.length / 50)
})

test('同樣的輸入每次產生一樣的 bytes，不改動傳入的像素', () => {
  for (const image of Object.values(SAMPLES)) {
    const before = Uint8Array.from(image.pixels)
    const first = encodePng(image)
    expect(firstDifference(encodePng(image), first)).toBe(-1)
    expect(firstDifference(image.pixels, before)).toBe(-1)
  }
})

test('尺寸不合理或像素數量對不上就丟例外', () => {
  const pixels = new Uint8Array(4 * 4 * RGBA_BYTES)
  expect(() => encodePng({ pixels, width: 4, height: 3 })).toThrow()
  expect(() => encodePng({ pixels, width: 0, height: 0 })).toThrow()
  expect(() => encodePng({ pixels, width: 2.5, height: 6.4 })).toThrow()
  expect(() => encodePng({ pixels: new Uint8Array(0), width: 0, height: 5 })).toThrow()
  expect(() => encodePng({ pixels, width: 4, height: 4 })).not.toThrow()
})
