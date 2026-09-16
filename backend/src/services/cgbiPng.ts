import zlib from "zlib";

/**
 * Apple repacks iOS app icons with `pngcrush -iphone`, which produces a PNG
 * flavour the rest of the world calls CgBI. Compared with a standard PNG:
 *
 * - a `CgBI` chunk sits between the signature and IHDR,
 * - IDAT holds a **raw** deflate stream (no zlib header, no Adler-32),
 * - pixels are **BGRA with premultiplied alpha** rather than RGBA.
 *
 * Safari reads them; Chrome, Firefox and Node do not, so an icon served
 * untouched simply fails to decode and the UI falls back to a placeholder. This
 * module turns one back into an ordinary PNG.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Chunks that describe colour rather than pixels, so they survive the rewrite. */
const PASSTHROUGH_CHUNKS = new Set(["gAMA", "cHRM", "sRGB", "pHYs"]);

export function isCgbiPng(data: Buffer): boolean {
  return (
    data.length > 16 &&
    data.subarray(0, 8).equals(PNG_SIGNATURE) &&
    data.subarray(12, 16).toString("latin1") === "CgBI"
  );
}

/**
 * Rewrites a CgBI PNG as a standard one. Returns null when the input is not
 * CgBI, or is a shape this does not handle (only 8-bit truecolour is produced
 * by Apple's packer, and interlaced data is not worth supporting).
 */
export function convertCgbiToPng(data: Buffer): Buffer | null {
  if (!isCgbiPng(data)) return null;

  const chunks = readChunks(data);
  if (!chunks) return null;

  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || interlace !== 0 || channels === 0) return null;
  if (width === 0 || height === 0) return null;

  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );

  let raw: Buffer;
  try {
    raw = zlib.inflateRawSync(idat);
  } catch {
    return null;
  }

  const pixels = decodeRows(raw, width, height, channels);
  if (!pixels) return null;

  unpremultiplyAndSwapChannels(pixels, channels);

  const out: Buffer[] = [PNG_SIGNATURE, encodeChunk("IHDR", ihdr.data)];
  for (const chunk of chunks) {
    if (PASSTHROUGH_CHUNKS.has(chunk.type)) {
      out.push(encodeChunk(chunk.type, chunk.data));
    }
  }
  out.push(
    encodeChunk(
      "IDAT",
      zlib.deflateSync(encodeRows(pixels, width * channels, height)),
    ),
  );
  out.push(encodeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(out);
}

/**
 * Re-emits the pixels with the per-row filter byte a standard PNG expects. Every
 * row is written unfiltered, which is what makes this the easy direction.
 */
function encodeRows(pixels: Buffer, stride: number, height: number): Buffer {
  const out = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 0;
    pixels.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return out;
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function readChunks(data: Buffer): PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let offset = 8;

  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (offset + 12 + length > data.length) return null;

    const type = data.subarray(offset + 4, offset + 8).toString("latin1");
    if (type !== "CgBI") {
      chunks.push({ type, data: data.subarray(offset + 8, offset + 8 + length) });
    }

    offset += 12 + length;
    if (type === "IEND") break;
  }

  return chunks.length > 0 ? chunks : null;
}

/**
 * Reverses the per-scanline filters, which CgBI keeps as they are. The result is
 * the raw pixel buffer the rest of the conversion works on.
 */
function decodeRows(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer | null {
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const source = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const above = previous ? previous[i] : 0;
      const aboveLeft = previous && i >= channels ? previous[i - channels] : 0;

      switch (filter) {
        case 0:
          row[i] = source[i];
          break;
        case 1:
          row[i] = source[i] + left;
          break;
        case 2:
          row[i] = source[i] + above;
          break;
        case 3:
          row[i] = source[i] + ((left + above) >> 1);
          break;
        case 4:
          row[i] = source[i] + paeth(left, above, aboveLeft);
          break;
        default:
          return null;
      }
    }
  }

  return pixels;
}

/** CgBI stores BGRA premultiplied; standard PNG wants RGBA straight. */
function unpremultiplyAndSwapChannels(pixels: Buffer, channels: number): void {
  for (let i = 0; i + channels <= pixels.length; i += channels) {
    const alpha = channels === 4 ? pixels[i + 3] : 255;
    const blue = pixels[i];
    const green = pixels[i + 1];
    const red = pixels[i + 2];

    pixels[i] = unpremultiply(red, alpha);
    pixels[i + 1] = unpremultiply(green, alpha);
    pixels[i + 2] = unpremultiply(blue, alpha);
  }
}

function unpremultiply(value: number, alpha: number): number {
  if (alpha === 255) return value;
  if (alpha === 0) return 0;
  return Math.min(255, Math.round((value * 255) / alpha));
}

function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const distanceA = Math.abs(estimate - a);
  const distanceB = Math.abs(estimate - b);
  const distanceC = Math.abs(estimate - c);

  if (distanceA <= distanceB && distanceA <= distanceC) return a;
  return distanceB <= distanceC ? b : c;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function encodeChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);

  const typeAndBody = Buffer.concat([Buffer.from(type, "latin1"), body]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);

  return Buffer.concat([length, typeAndBody, crc]);
}
