import { describe, it, expect } from "vitest";
import zlib from "zlib";
import { convertCgbiToPng, isCgbiPng } from "../src/services/cgbiPng.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BPP = 4;

// --- A minimal CgBI writer, so the decoder is checked against something built
// --- the other way round rather than against itself.

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const da = Math.abs(estimate - a);
  const db = Math.abs(estimate - b);
  const dc = Math.abs(estimate - c);
  if (da <= db && da <= dc) return a;
  return db <= dc ? b : c;
}

/** Premultiplies and swaps to the BGRA CgBI stores, then applies PNG filtering. */
function encodeCgbi(
  width: number,
  height: number,
  rgba: Buffer,
  filterTypes: number[] = [],
  colorType = 6,
): Buffer {
  const stored = Buffer.from(rgba);
  for (let i = 0; i + BPP <= stored.length; i += BPP) {
    const red = stored[i];
    const green = stored[i + 1];
    const blue = stored[i + 2];
    const alpha = stored[i + 3];
    stored[i] = Math.round((blue * alpha) / 255);
    stored[i + 1] = Math.round((green * alpha) / 255);
    stored[i + 2] = Math.round((red * alpha) / 255);
  }

  const stride = width * BPP;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filterTypes[y] ?? 0;
    filtered[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const above = y > 0 ? stored[index - stride] : 0;
      const left = x >= BPP ? stored[index - BPP] : 0;
      const aboveLeft = y > 0 && x >= BPP ? stored[index - stride - BPP] : 0;

      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = (left + above) >> 1;
      else if (filter === 4) predictor = paeth(left, above, aboveLeft);

      filtered[y * (stride + 1) + 1 + x] = (stored[index] - predictor) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("CgBI", Buffer.alloc(4)),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateRawSync(filtered)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Reading a converted file the way a standard decoder would ---

function idatOf(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

/** Standard inflate plus the scanline filters, i.e. what a browser does. */
function decodeStandardPng(png: Buffer): Buffer {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const raw = zlib.inflateSync(idatOf(png));
  const stride = width * BPP;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const left = i >= BPP ? row[i - BPP] : 0;
      const above = previous ? previous[i] : 0;
      const aboveLeft = previous && i >= BPP ? previous[i - BPP] : 0;

      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = (left + above) >> 1;
      else if (filter === 4) predictor = paeth(left, above, aboveLeft);

      row[i] = raw[start + 1 + i] + predictor;
    }
  }

  return pixels;
}

const ORIGINAL = Buffer.from([
  200, 100, 50, 255,
  10, 20, 30, 128,
  255, 0, 0, 64,
  0, 0, 0, 0,
]);

describe("isCgbiPng", () => {
  it("recognizes the marker chunk Apple's packer inserts", () => {
    expect(isCgbiPng(encodeCgbi(2, 2, ORIGINAL))).toBe(true);
  });

  it("does not claim a standard PNG", () => {
    const standard = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", Buffer.alloc(13)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(isCgbiPng(standard)).toBe(false);
    expect(convertCgbiToPng(standard)).toBeNull();
  });
});

describe("convertCgbiToPng", () => {
  it("makes the image readable by a standard decoder", () => {
    // This is the whole point: Chrome and Firefox inflate IDAT with a zlib
    // decoder, and a CgBI stream has no zlib wrapper, so the image fails.
    const converted = convertCgbiToPng(encodeCgbi(2, 2, ORIGINAL));

    expect(converted).not.toBeNull();
    expect(() => zlib.inflateSync(idatOf(converted!))).not.toThrow();
    expect(converted!.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(converted!.subarray(12, 16).toString("latin1")).toBe("IHDR");
    // No CgBI chunk survives.
    expect(isCgbiPng(converted!)).toBe(false);
  });

  it("keeps the dimensions and colour type", () => {
    const converted = convertCgbiToPng(encodeCgbi(2, 2, ORIGINAL))!;

    expect(converted.readUInt32BE(16)).toBe(2);
    expect(converted.readUInt32BE(20)).toBe(2);
    expect(converted[24]).toBe(8);
    expect(converted[25]).toBe(6);
  });

  it("restores straight RGBA through mixed scanline filters", () => {
    const converted = convertCgbiToPng(
      encodeCgbi(2, 2, ORIGINAL, [1, 2]),
    )!;

    expect(decodeStandardPng(converted)).toEqual(ORIGINAL);
  });

  it("handles a half-transparent pixel without washing out its colour", () => {
    // Premultiplied 64/255 red: the decoder has to scale it back to full red.
    const pixels = Buffer.from([255, 0, 0, 64]);
    const converted = convertCgbiToPng(encodeCgbi(1, 1, pixels))!;

    expect(decodeStandardPng(converted)).toEqual(pixels);
  });

  it("declines a colour type it does not handle", () => {
    // Grayscale, so the byte layout is not the BGRA this knows about.
    expect(convertCgbiToPng(encodeCgbi(2, 2, ORIGINAL, [], 0))).toBeNull();
  });

  it("declines data that is not a CgBI PNG at all", () => {
    expect(convertCgbiToPng(Buffer.from("not a png"))).toBeNull();
  });
});
