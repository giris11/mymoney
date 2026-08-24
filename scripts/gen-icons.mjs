// Generates the PWA/app icons as PNGs with zero dependencies (node:zlib only).
// Run: node scripts/gen-icons.mjs   → writes into public/
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

// ---------- minimal PNG encoder (8-bit RGBA, no filtering) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- drawing ----------
// Signed distance to a rounded rectangle centred at (cx,cy).
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// coverage from SDF with ~1px antialiasing
const cov = (d) => clamp01(0.5 - d);

const TOP = [0x06, 0x5f, 0x46]; // #065f46
const BOT = [0x10, 0xb9, 0x81]; // #10b981

/**
 * Draw the MyMoney mark: gradient (rounded) square + three ascending white bars.
 * inset: fraction of size kept as transparent margin around the tile
 * pad:   fraction of the tile kept clear inside it (maskable safe zone)
 * radius: corner radius as fraction of tile (0 = square, e.g. apple-touch-icon)
 */
function drawIcon(size, { inset = 0, pad = 0, radius = 0.22 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const tile0 = size * inset;
  const tileSize = size - 2 * tile0;
  const c = size / 2;
  const half = tileSize / 2;
  const r = tileSize * radius;
  // bars in tile-relative coords (x, width, height), baseline at 0.78
  const barW = 0.13;
  const bars = [
    [0.22, barW, 0.24],
    [0.435, barW, 0.37],
    [0.65, barW, 0.53],
  ];
  const content = 1 - 2 * pad; // scale bars into the safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const dTile = sdRoundRect(px, py, c, c, half, half, r);
      const aTile = cov(dTile);
      if (aTile <= 0) continue;
      // vertical gradient across the tile
      const t = clamp01((py - tile0) / tileSize);
      let cr = TOP[0] + (BOT[0] - TOP[0]) * t;
      let cg = TOP[1] + (BOT[1] - TOP[1]) * t;
      let cb = TOP[2] + (BOT[2] - TOP[2]) * t;
      // bars (white), positioned in safe zone
      let aBar = 0;
      for (const [bx, bw, bh] of bars) {
        const rx0 = tile0 + tileSize * (0.5 + (bx - 0.5) * content);
        const rw = tileSize * bw * content;
        const baseline = tile0 + tileSize * (0.5 + (0.78 - 0.5) * content);
        const rh = tileSize * bh * content;
        const d = sdRoundRect(px, py, rx0 + rw / 2, baseline - rh / 2, rw / 2, rh / 2, rw * 0.3);
        aBar = Math.max(aBar, cov(d));
      }
      cr = cr + (255 - cr) * aBar;
      cg = cg + (255 - cg) * aBar;
      cb = cb + (255 - cb) * aBar;
      rgba[i] = Math.round(cr);
      rgba[i + 1] = Math.round(cg);
      rgba[i + 2] = Math.round(cb);
      rgba[i + 3] = Math.round(255 * aTile);
    }
  }
  return encodePNG(size, size, rgba);
}

writeFileSync(join(OUT, 'pwa-192.png'), drawIcon(192));
writeFileSync(join(OUT, 'pwa-512.png'), drawIcon(512));
// maskable: full-bleed square, content shrunk into the 80% safe zone
writeFileSync(join(OUT, 'pwa-maskable-512.png'), drawIcon(512, { radius: 0, pad: 0.12 }));
// apple-touch-icon: full-bleed square, iOS rounds it itself
writeFileSync(join(OUT, 'apple-touch-icon.png'), drawIcon(180, { radius: 0, pad: 0.04 }));
console.log('icons written to public/');
