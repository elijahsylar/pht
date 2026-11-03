// Generates the home-screen icons: a Windows 98 checkbox, ticked, on the teal
// desktop. Pure Node (zlib for the PNG deflate), no image libraries.
//
//   node scripts/make-icons.mjs        → public/icons/*.png
//
// The glyph is drawn on a 16×16 grid and scaled by a whole number with
// nearest-neighbour, so every edge stays a crisp 98-style pixel. When the size
// is not a multiple of 16 (180), the leftover is split evenly as a margin.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

// 98.css palette.
const C = {
  t: [0x00, 0x80, 0x80], // desktop teal
  w: [0xff, 0xff, 0xff], // box face, outer highlight
  g: [0x80, 0x80, 0x80], // outer shadow
  k: [0x0a, 0x0a, 0x0a], // inner shadow, the tick
  l: [0xdf, 0xdf, 0xdf], // inner highlight
};

// The 98 sunken checkbox (as 98.css draws it: grey/black top-left, white/light
// bottom-right) with its 7×7 tick, centred on the grid.
const GRID = [
  'tttttttttttttttt',
  'tttttttttttttttt',
  'ttggggggggggggwt',
  'ttgkkkkkkkkkklwt',
  'ttgkwwwwwwwwwlwt',
  'ttgkwwwwwwwkwlwt',
  'ttgkwwwwwwkkwlwt',
  'ttgkwkwwwkkkwlwt',
  'ttgkwkkwkkkwwlwt',
  'ttgkwkkkkkwwwlwt',
  'ttgkwwkkkwwwwlwt',
  'ttgkwwwkwwwwwlwt',
  'ttgkwwwwwwwwwlwt',
  'ttglllllllllllwt',
  'ttwwwwwwwwwwwwwt',
  'tttttttttttttttt',
];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const scale = Math.floor(size / 16);
  const pad = Math.floor((size - scale * 16) / 2);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let x = 0; x < size; x += 1) {
      const gx = Math.floor((x - pad) / scale);
      const gy = Math.floor((y - pad) / scale);
      const key = gx >= 0 && gx < 16 && gy >= 0 && gy < 16 ? GRID[gy][gx] : 't';
      C[key].forEach((v, i) => (row[1 + x * 3 + i] = v));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB (opaque — iOS fills transparency with black)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of SIZES) {
  const file = join(OUT, name);
  writeFileSync(file, png(size));
  console.log(`${file}  ${size}×${size}`);
}
