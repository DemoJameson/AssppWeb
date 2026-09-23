/**
 * MD5 (RFC 1321) over the UTF-8 bytes of the input. Gravatar addresses
 * avatars by the MD5 of the lowercase email, and the Web Crypto API has no
 * MD5 — hence this small digest.
 */

// Per-round left-rotation amounts (RFC 1321).
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

// K[i] = floor(2^32 * abs(sin(i + 1)))
const SINES = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  SINES[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (bytes.length + 9 + 63) & ~63;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const word = view.getUint32(offset + g * 4, true);
      const rotated = rotateLeft((a + f + SINES[i] + word) >>> 0, SHIFTS[i]);
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(wordToLittleEndianHex).join("");
}

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function wordToLittleEndianHex(word: number): string {
  let hex = "";
  for (let i = 0; i < 4; i += 1) {
    hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The gravatar image URL for an email — null for anything that is not one.
 * Gravatars are keyed by address, so a phone-number Apple ID has no avatar to
 * find, and hashing the number to ask for one would hand a third party a
 * value derived from it. Callers probe the URL first (gravatar answers 404
 * when the address has no avatar) and fall back to the initial-letter
 * placeholder.
 */
export function gravatarUrl(email: string, size = 96): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;
  return `https://www.gravatar.com/avatar/${md5(normalized)}?s=${size}&d=404`;
}
