// 測試用的 PNG 解碼器：claude plugin test 的環境跟 hooks 一樣沒有 DecompressionStream、node:zlib，只好照
// RFC 1950（zlib）、RFC 1951（deflate）與 PNG 規格自己解。刻意跟 hooks/png.ts 分開寫，而且 inflate 支援全部三種區塊
// （未壓縮、固定 Huffman、動態 Huffman），才是獨立檢查編碼器，不是拿同一套邏輯自己驗自己；
// png.test.ts 另外用 python 標準 zlib 產生的資料確認這個解碼器本身是對的

export type PngChunk = { type: string; data: Uint8Array; crcMatches: boolean }
export type DecodedPng = { width: number; height: number; bitDepth: number; colorType: number; interlace: number; rgba: Uint8Array }
export type InflatedZlib = { output: Uint8Array; adlerMatches: boolean; trailingBytes: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CHUNK_OVERHEAD = 12
const RGBA_BYTES = 4

// 用環境的 atob 解 base64，跟模組自己的編碼互相獨立
export const base64Bytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))

export const hasPngSignature = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)

// 簽章之後一個接一個的 chunk：長度（4 bytes）、類型（4 bytes）、資料、CRC（類型＋資料算出來的 CRC-32）
export function readChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset < bytes.length) {
    if (offset + CHUNK_OVERHEAD > bytes.length) throw new Error(`第 ${offset} byte 的 chunk 不完整`)
    const length = readUint32(bytes, offset)
    const end = offset + CHUNK_OVERHEAD + length
    if (end > bytes.length) throw new Error(`第 ${offset} byte 的 chunk 長度 ${length} 超出檔案`)
    const typeAndData = bytes.subarray(offset + 4, offset + 8 + length)
    chunks.push({
      type: String.fromCharCode(...typeAndData.subarray(0, 4)),
      data: typeAndData.subarray(4),
      crcMatches: crc32(typeAndData) === readUint32(bytes, offset + 8 + length),
    })
    offset = end
  }
  return chunks
}

// 嚴格解碼：簽章、CRC、zlib 標頭、Adler-32、每列 filter 有任何不對就丟例外。只收 8 bit RGBA、不交錯、filter 都是 0（None）的 PNG
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!hasPngSignature(bytes)) throw new Error('開頭不是 PNG 簽章')
  const chunks = readChunks(bytes)
  for (const chunk of chunks) if (!chunk.crcMatches) throw new Error(`${chunk.type} 的 CRC 不對`)
  const header = chunks[0]
  if (header?.type !== 'IHDR' || header.data.length !== 13) throw new Error('第一個 chunk 不是 13 bytes 的 IHDR')
  if (chunks.at(-1)?.type !== 'IEND') throw new Error('最後一個 chunk 不是 IEND')
  const width = readUint32(header.data, 0)
  const height = readUint32(header.data, 4)
  const [bitDepth, colorType, compression, filterMethod, interlace] = header.data.subarray(8)
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(`只解 8 bit RGBA、不交錯的 PNG：${[bitDepth, colorType, compression, filterMethod, interlace].join(',')}`)
  }
  const inflated = inflateZlib(concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)))
  if (!inflated.adlerMatches) throw new Error('zlib 的 Adler-32 不對')
  if (inflated.trailingBytes !== 0) throw new Error(`zlib 資料後面多了 ${inflated.trailingBytes} bytes`)
  const stride = width * RGBA_BYTES
  if (inflated.output.length !== (stride + 1) * height) throw new Error(`解壓後 ${inflated.output.length} bytes，應該是 ${(stride + 1) * height}`)
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filterType = inflated.output[rowStart]
    if (filterType !== 0) throw new Error(`第 ${y} 列的 filter 是 ${filterType}，預期 0`)
    rgba.set(inflated.output.subarray(rowStart + 1, rowStart + 1 + stride), y * stride)
  }
  return { width, height, bitDepth, colorType, interlace, rgba }
}

// zlib：2 bytes 標頭（CM 是 8、整個標頭可被 31 整除、沒有預設字典）＋ deflate ＋ 大端序 Adler-32
export function inflateZlib(data: Uint8Array): InflatedZlib {
  const cmf = data[0] ?? 0
  const flg = data[1] ?? 0
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
    throw new Error(`zlib 標頭不對：${cmf.toString(16)} ${flg.toString(16)}`)
  }
  const { output, consumed } = inflate(data.subarray(2))
  const adlerOffset = 2 + consumed
  if (adlerOffset + 4 > data.length) throw new Error('zlib 資料少了 Adler-32')
  return { output, adlerMatches: adler32(output) === readUint32(data, adlerOffset), trailingBytes: data.length - adlerOffset - 4 }
}

// ---- inflate（RFC 1951），解碼方式參考 zlib 附的 puff.c：一個 bit 一個 bit 走正規 Huffman 碼 ----

const LENGTH_BASES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASES = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DISTANCE_EXTRA_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
const MAX_CODE_BITS = 15
const END_OF_BLOCK = 256

type Huffman = { counts: number[]; symbols: number[] }

class BitReader {
  private byteOffset = 0
  private buffer = 0
  private bufferedBits = 0

  constructor(private readonly data: Uint8Array) {}

  bits(count: number): number {
    while (this.bufferedBits < count) {
      const byte = this.data[this.byteOffset++]
      if (byte === undefined) throw new Error('deflate 資料提早結束')
      this.buffer |= byte << this.bufferedBits
      this.bufferedBits += 8
    }
    const value = this.buffer & ((1 << count) - 1)
    this.buffer >>>= count
    this.bufferedBits -= count
    return value
  }

  // 未壓縮區塊從下一個整數 byte 開始，丟掉這個 byte 剩下的 bits
  alignToByte(): void {
    this.buffer = 0
    this.bufferedBits = 0
  }

  takeBytes(count: number): Uint8Array {
    if (this.byteOffset + count > this.data.length) throw new Error('未壓縮區塊超出資料')
    const bytes = this.data.subarray(this.byteOffset, this.byteOffset + count)
    this.byteOffset += count
    return bytes
  }

  get consumedBytes(): number {
    return this.byteOffset
  }
}

function inflate(data: Uint8Array): { output: Uint8Array; consumed: number } {
  const reader = new BitReader(data)
  const output: number[] = []
  let isFinal = false
  while (!isFinal) {
    isFinal = reader.bits(1) === 1
    const blockType = reader.bits(2)
    if (blockType === 0) copyStoredBlock(reader, output)
    else if (blockType === 1) inflateBlock(reader, output, FIXED_LITERALS, FIXED_DISTANCES)
    else if (blockType === 2) inflateBlock(reader, output, ...readDynamicTables(reader))
    else throw new Error('區塊類型 3 是保留值')
  }
  return { output: Uint8Array.from(output), consumed: reader.consumedBytes }
}

function copyStoredBlock(reader: BitReader, output: number[]): void {
  reader.alignToByte()
  const [lengthLow, lengthHigh, complementLow, complementHigh] = reader.takeBytes(4)
  const length = lengthLow! | (lengthHigh! << 8)
  if ((length ^ 0xffff) !== (complementLow! | (complementHigh! << 8))) throw new Error('未壓縮區塊的 LEN 與 NLEN 不互補')
  output.push(...reader.takeBytes(length))
}

function inflateBlock(reader: BitReader, output: number[], literals: Huffman, distances: Huffman): void {
  for (;;) {
    const symbol = decodeSymbol(reader, literals)
    if (symbol < END_OF_BLOCK) {
      output.push(symbol)
      continue
    }
    if (symbol === END_OF_BLOCK) return
    const lengthIndex = symbol - END_OF_BLOCK - 1
    if (lengthIndex >= LENGTH_BASES.length) throw new Error(`長度碼 ${symbol} 不存在`)
    const length = LENGTH_BASES[lengthIndex]! + reader.bits(LENGTH_EXTRA_BITS[lengthIndex]!)
    const distanceIndex = decodeSymbol(reader, distances)
    if (distanceIndex >= DISTANCE_BASES.length) throw new Error(`距離碼 ${distanceIndex} 不存在`)
    const distance = DISTANCE_BASES[distanceIndex]! + reader.bits(DISTANCE_EXTRA_BITS[distanceIndex]!)
    if (distance > output.length) throw new Error(`距離 ${distance} 超過已解出的 ${output.length} bytes`)
    // 長度可以比距離長（重複最近的幾個 byte），所以一個一個複製
    for (let index = 0; index < length; index++) output.push(output[output.length - distance]!)
  }
}

function readDynamicTables(reader: BitReader): [Huffman, Huffman] {
  const literalCount = reader.bits(5) + 257
  const distanceCount = reader.bits(5) + 1
  const codeLengthCount = reader.bits(4) + 4
  const codeLengthLengths = new Array<number>(CODE_LENGTH_ORDER.length).fill(0)
  for (let index = 0; index < codeLengthCount; index++) codeLengthLengths[CODE_LENGTH_ORDER[index]!] = reader.bits(3)
  const codeLengthCode = buildHuffman(codeLengthLengths)
  const lengths: number[] = []
  while (lengths.length < literalCount + distanceCount) {
    const symbol = decodeSymbol(reader, codeLengthCode)
    if (symbol < 16) lengths.push(symbol)
    else if (symbol === 16) {
      const previous = lengths.at(-1)
      if (previous === undefined) throw new Error('重複碼 16 前面沒有長度')
      lengths.push(...new Array<number>(3 + reader.bits(2)).fill(previous))
    } else if (symbol === 17) lengths.push(...new Array<number>(3 + reader.bits(3)).fill(0))
    else lengths.push(...new Array<number>(11 + reader.bits(7)).fill(0))
  }
  if (lengths.length !== literalCount + distanceCount) throw new Error('碼長重複超出範圍')
  if (lengths[END_OF_BLOCK] === 0) throw new Error('動態區塊沒有結束碼')
  return [buildHuffman(lengths.slice(0, literalCount)), buildHuffman(lengths.slice(literalCount))]
}

// 正規 Huffman 碼：同長度的碼依符號順序連號，所以只要記每種長度幾個碼、依（長度, 符號）排好的符號
function buildHuffman(lengths: readonly number[]): Huffman {
  const counts = new Array<number>(MAX_CODE_BITS + 1).fill(0)
  for (const length of lengths) counts[length]!++
  counts[0] = 0
  const symbols = lengths.flatMap((length, symbol) => (length > 0 ? [{ length, symbol }] : []))
  symbols.sort((a, b) => a.length - b.length || a.symbol - b.symbol)
  return { counts, symbols: symbols.map(entry => entry.symbol) }
}

function decodeSymbol(reader: BitReader, huffman: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length <= MAX_CODE_BITS; length++) {
    code |= reader.bits(1)
    const count = huffman.counts[length]!
    if (code - first < count) return huffman.symbols[index + code - first]!
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('讀到不存在的 Huffman 碼')
}

const FIXED_LITERALS = buildHuffman([
  ...new Array<number>(144).fill(8),
  ...new Array<number>(112).fill(9),
  ...new Array<number>(24).fill(7),
  ...new Array<number>(8).fill(8),
])
const FIXED_DISTANCES = buildHuffman(new Array<number>(30).fill(5))

// ---- 校驗碼 ----

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function adler32(bytes: Uint8Array): number {
  let low = 1
  let high = 0
  for (const byte of bytes) {
    low = (low + byte) % 65521
    high = (high + low) % 65521
  }
  return ((high << 16) | low) >>> 0
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
