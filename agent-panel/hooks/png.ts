// 把 RGBA 像素編成一個完整的 PNG（bytes），給 Image 的 { png } 來源用。
//
// 為什麼不直接給 { rgba }：64×64 的 RGBA 是 16384 bytes、base64 兩萬多字元，kitty 圖片序列一段最多 4096 個字元，
// 得切成好幾段送；背景 session 的畫面要經過背景服務的 pty 轉送，序列中途被切斷，後面的像素就被當成文字印出來。
// 壓成 PNG 後小人每張只剩幾百個字元，一個序列就送完。
//
// 為什麼自己寫壓縮：hooks 的執行環境沒有 Node、沒有 CompressionStream（claude plugin validate 也不讓 import node:zlib），
// 只好自己做 zlib／deflate（RFC 1950／1951）。只用一個固定 Huffman 碼的區塊（不必附碼表），加上簡單的 LZ77：
// 只找呼叫端給的幾種回頭距離。小人是最近鄰放大的大色塊，幾乎每個像素都跟「左邊那個像素」或「上一列同位置」一樣，
// 找這兩種距離就壓得很小，不需要一般壓縮器的雜湊表搜尋。
//
// 每列前面的 filter byte 一律是 0（None），重複交給 LZ77 處理。純函式、同步，同樣的輸入產生一樣的 bytes。

export type RgbaImage = { readonly pixels: Uint8Array; readonly width: number; readonly height: number }

const RGBA_BYTES = 4
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const BIT_DEPTH = 8
const COLOR_TYPE_RGBA = 6
const FILTER_NONE = 0

export function encodePng({ pixels, width, height }: RgbaImage): Uint8Array {
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || pixels.length !== width * height * RGBA_BYTES) {
    throw new Error(`像素數量對不上尺寸：${width}×${height} 需要 ${width * height * RGBA_BYTES} bytes，拿到 ${pixels.length}`)
  }
  const stride = width * RGBA_BYTES
  const scanlineLength = stride + 1
  const scanlines = new Uint8Array(scanlineLength * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * scanlineLength] = FILTER_NONE
    scanlines.set(pixels.subarray(y * stride, (y + 1) * stride), y * scanlineLength + 1)
  }
  const header = concatBytes([uint32BigEndian(width), uint32BigEndian(height), Uint8Array.of(BIT_DEPTH, COLOR_TYPE_RGBA, 0, 0, 0)])
  return concatBytes([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    // 回頭找的距離：前一個像素、上一列同一個位置
    chunk('IDAT', zlibCompress(scanlines, [RGBA_BYTES, scanlineLength])),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

// PNG chunk：長度、類型、資料，最後是類型＋資料的 CRC-32
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concatBytes([Uint8Array.from(type, char => char.charCodeAt(0)), data])
  return concatBytes([uint32BigEndian(data.length), typeAndData, uint32BigEndian(crc32(typeAndData))])
}

// ---- zlib／deflate ----

// CMF 0x78：deflate、32K 視窗；FLG 0x01：沒有預設字典，讓 (CMF × 256 + FLG) 可被 31 整除
const ZLIB_HEADER = Uint8Array.of(0x78, 0x01)
const MIN_MATCH = 3
const MAX_MATCH = 258
const MAX_DISTANCE = 32768
const END_OF_BLOCK = 256
const FIRST_LENGTH_SYMBOL = 257
// RFC 1951 3.2.5：長度碼 257～285、距離碼 0～29 各自的起始值與額外 bits
const LENGTH_BASES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASES = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DISTANCE_EXTRA_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const DISTANCE_CODE_BITS = 5

type Match = { length: number; distance: number }

function zlibCompress(data: Uint8Array, matchDistances: readonly number[]): Uint8Array {
  return concatBytes([ZLIB_HEADER, deflate(data, matchDistances), uint32BigEndian(adler32(data))])
}

// 整份資料放進一個最後區塊（BFINAL 1、BTYPE 01 固定 Huffman）；每個位置貪婪地取最長的重複，沒有就寫原字元
function deflate(data: Uint8Array, matchDistances: readonly number[]): Uint8Array {
  // deflate 最遠只能回頭 32768 bytes，超過的距離（很寬的圖的「上一列」）不能用
  const distances = matchDistances.filter(distance => distance >= 1 && distance <= MAX_DISTANCE)
  const writer = new BitWriter()
  writer.writeBits(1, 1)
  writer.writeBits(1, 2)
  let position = 0
  while (position < data.length) {
    const match = longestMatch(data, position, distances)
    if (match === null) {
      writeSymbol(writer, data[position]!)
      position++
      continue
    }
    writeMatch(writer, match)
    position += match.length
  }
  writeSymbol(writer, END_OF_BLOCK)
  return writer.finish()
}

// 一樣長時取先列的距離（呼叫端由近到遠排），近的距離碼比較短
function longestMatch(data: Uint8Array, position: number, distances: readonly number[]): Match | null {
  const limit = Math.min(MAX_MATCH, data.length - position)
  let best: Match | null = null
  for (const distance of distances) {
    if (distance > position) continue
    let length = 0
    while (length < limit && data[position + length] === data[position + length - distance]) length++
    if (length >= MIN_MATCH && (best === null || length > best.length)) best = { length, distance }
  }
  return best
}

function writeMatch(writer: BitWriter, { length, distance }: Match): void {
  const lengthIndex = lastIndexAtMost(LENGTH_BASES, length)
  writeSymbol(writer, FIRST_LENGTH_SYMBOL + lengthIndex)
  writer.writeBits(length - LENGTH_BASES[lengthIndex]!, LENGTH_EXTRA_BITS[lengthIndex]!)
  const distanceIndex = lastIndexAtMost(DISTANCE_BASES, distance)
  writer.writeCode(distanceIndex, DISTANCE_CODE_BITS)
  writer.writeBits(distance - DISTANCE_BASES[distanceIndex]!, DISTANCE_EXTRA_BITS[distanceIndex]!)
}

// 起始值由小到大排；找最後一個不超過 value 的（長度 258 要用專屬的 285，不能用 284 加額外 bits）
function lastIndexAtMost(bases: readonly number[], value: number): number {
  let index = bases.length - 1
  while (bases[index]! > value) index--
  return index
}

// RFC 1951 3.2.6 的固定 Huffman 碼：0～143 8 bits、144～255 9 bits、256～279 7 bits、280～287 8 bits
function writeSymbol(writer: BitWriter, symbol: number): void {
  if (symbol < 144) writer.writeCode(0x30 + symbol, 8)
  else if (symbol < 256) writer.writeCode(0x190 + symbol - 144, 9)
  else if (symbol < 280) writer.writeCode(symbol - 256, 7)
  else writer.writeCode(0xc0 + symbol - 280, 8)
}

// deflate 從每個 byte 的最低位開始填；一般數值（額外 bits）低位先寫，Huffman 碼則是最高位先寫
class BitWriter {
  private readonly bytes: number[] = []
  private buffer = 0
  private bufferedBits = 0

  writeBits(value: number, count: number): void {
    this.buffer |= value << this.bufferedBits
    this.bufferedBits += count
    while (this.bufferedBits >= 8) {
      this.bytes.push(this.buffer & 0xff)
      this.buffer >>>= 8
      this.bufferedBits -= 8
    }
  }

  writeCode(code: number, length: number): void {
    let reversed = 0
    for (let bit = 0; bit < length; bit++) reversed |= ((code >> bit) & 1) << (length - 1 - bit)
    this.writeBits(reversed, length)
  }

  finish(): Uint8Array {
    if (this.bufferedBits > 0) this.bytes.push(this.buffer & 0xff)
    this.buffer = 0
    this.bufferedBits = 0
    return Uint8Array.from(this.bytes)
  }
}

// ---- 校驗碼與 bytes 小工具 ----

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const ADLER_MODULUS = 65521

function adler32(bytes: Uint8Array): number {
  let low = 1
  let high = 0
  for (const byte of bytes) {
    low = (low + byte) % ADLER_MODULUS
    high = (high + low) % ADLER_MODULUS
  }
  return ((high << 16) | low) >>> 0
}

function uint32BigEndian(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
