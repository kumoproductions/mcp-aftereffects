// Minimal PNG codec for the color-managed capture path. Zero dependencies:
// node:zlib for the IDAT stream, hand-rolled chunk framing and scanline
// (un)filtering. Scope is deliberately narrow — exactly what
// CompItem.saveFrameToPng emits (8/16-bit, RGB/RGBA/gray, non-interlaced)
// on the way in, and 8-bit RGB with sRGB tags on the way out.

import * as zlib from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGB triples, values normalized to 0..1. Alpha is dropped. */
  rgb: Float64Array;
  bitDepth: 8 | 16;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(buf: Buffer): Chunk[] {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file");
  const chunks: Chunk[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    chunks.push({ type, data: buf.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Channels per pixel for the PNG color types we accept. */
function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 4:
      return 2; // gray + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`unsupported PNG color type ${colorType} (palette images are out of scope)`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG into normalized RGB. Throws on interlaced or palette images. */
export function decodePng(buf: Buffer): DecodedPng {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("PNG missing IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data.readUInt8(8);
  const colorType = ihdr.data.readUInt8(9);
  const interlace = ihdr.data.readUInt8(12);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  const channels = channelsFor(colorType);

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const bytesPerSample = bitDepth / 8;
  const bytesPerPixel = channels * bytesPerSample;
  const stride = width * bytesPerPixel;
  if (raw.length < height * (stride + 1)) throw new Error("PNG pixel data truncated");

  // Unfilter in place into `prev`/`cur` rows.
  const rgb = new Float64Array(width * height * 3);
  const maxVal = bitDepth === 16 ? 65535 : 255;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const grayish = channels <= 2;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    raw.copy(cur, 0, rowStart + 1, rowStart + 1 + stride);
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bytesPerPixel; i < stride; i++)
          cur[i] = (cur[i] + cur[i - bytesPerPixel]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
          cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
          const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
          cur[i] = (cur[i] + paeth(left, prev[i], upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`unknown PNG filter ${filter} at row ${y}`);
    }
    for (let x = 0; x < width; x++) {
      const px = x * bytesPerPixel;
      const out = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const srcCh = grayish ? 0 : ch;
        const off = px + srcCh * bytesPerSample;
        const v = bitDepth === 16 ? cur.readUInt16BE(off) : cur[off];
        rgb[out + ch] = v / maxVal;
      }
    }
    cur.copy(prev);
  }

  return { width, height, rgb, bitDepth: bitDepth as 8 | 16 };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crcBody = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(crcBody) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encode normalized RGB into an 8-bit PNG carrying explicit sRGB tags
 * (sRGB + gAMA), so every viewer agrees on the color space — the untagged
 * output of saveFrameToPng was one of the two sources of "wrong color"
 * reports.
 */
export function encodePngSrgb8(width: number, height: number, rgb: Float64Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none — zlib still compresses flat regions well
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = rowStart + 1 + x * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v = Math.round(Math.min(1, Math.max(0, rgb[src + ch])) * 255);
        raw[dst + ch] = v;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type RGB
  // compression 0, filter 0, interlace 0 already zeroed

  const gama = Buffer.alloc(4);
  gama.writeUInt32BE(45455, 0);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])), // perceptual intent
    chunk("gAMA", gama),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
