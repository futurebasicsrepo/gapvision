/**
 * A minimal PNG encoder, for images the plugin has to draw at runtime.
 *
 * The mark is generated at build time by `store/make-lens-mark.py`, and that
 * pipeline is right for pixels that never change. The hero rail is not that:
 * it draws *this guest's* sizes, so the pixels exist only once the payload
 * arrives, and the encoding has to happen on the phone.
 *
 * Why not `canvas.toDataURL("image/png")`: the host silently rejects 24-bit
 * RGBA PNGs (observed across the Even Hub community — see the pixel-art notes
 * in aleapc/even-hub-devguide). What it accepts is what the mark already is:
 * an 8-bit greyscale PNG whose values sit on the 4-bit grid (multiples of 17),
 * so the host's own gray-4 reduction has nothing left to take.
 *
 * So this writes exactly that, from a raw pixel buffer, with no dependency:
 * IHDR (8-bit greyscale), one IDAT of *stored* deflate blocks, IEND. Stored
 * blocks cost nothing to write and the images are small — a full 160×96 rail
 * is ~15 KB over a link that already carries PNGs of that order for the mark.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) head[i] = type.charCodeAt(i);
  head.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  out.set(be32(data.length), 0);
  out.set(head, 4);
  out.set(be32(crc32(head)), 8 + data.length);
  return out;
}

/**
 * Encode an 8-bit greyscale PNG from `pixels` (row-major, one byte per pixel).
 *
 * Values are snapped to the 4-bit grid here rather than trusted, for the same
 * reason the mark ships pre-quantised: what the glass draws is gray-4, and a
 * value the host has to round is a value two renderers can disagree about.
 */
export function grayPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height) {
    throw new Error(`grayPng: ${pixels.length} pixels for ${width}x${height}`);
  }
  // Raw scanlines: filter byte 0, then the row, quantised to multiples of 17.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (width + 1);
    raw[at] = 0;
    for (let x = 0; x < width; x++) {
      raw[at + 1 + x] = Math.round(pixels[y * width + x] / 17) * 17;
    }
  }

  // zlib stream: header, stored deflate blocks (≤ 65535 bytes each), adler32.
  const blocks: number[] = [0x78, 0x01];
  for (let at = 0; at < raw.length; at += 65535) {
    const len = Math.min(65535, raw.length - at);
    const last = at + len >= raw.length ? 1 : 0;
    blocks.push(last, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) blocks.push(raw[at + i]);
  }
  const idat = new Uint8Array(blocks.length + 4);
  idat.set(blocks, 0);
  idat.set(be32(adler32(raw)), blocks.length);

  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type: greyscale
  // compression 0, filter 0, interlace 0 — already zero.

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
