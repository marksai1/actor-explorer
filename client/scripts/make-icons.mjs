/**
 * Draws the home-screen icons from the brand mark — the same ◎ on a warm
 * gradient the nav shows — straight to PNG, so the build needs no image editor
 * and no native dependency. Re-run with `npm run icons` if the brand changes.
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Minimal 8-bit RGBA PNG: one IDAT, no interlacing, "none" row filters. */
function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark --------------------------------------------------------------

const ACCENT_A = [0xff, 0xb3, 0x40];
const ACCENT_B = [0xff, 0x8a, 0x3d];
const INK = [0x1a, 0x12, 0x06];

// Fractions of the icon's width, kept in step with the SVG favicon below.
const RING_R = 0.345;
const RING_W = 0.078;
const DOT_R = 0.135;

const SAMPLES = 4; // supersampling per axis, for smooth circle edges

/**
 * Full-bleed and opaque on purpose: iOS applies its own squircle mask, and a
 * transparent icon would come out with a black backing instead.
 */
function render(size, glyphScale) {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;
  const ringR = size * RING_R * glyphScale;
  const ringW = size * RING_W * glyphScale;
  const dotR = size * DOT_R * glyphScale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const d = Math.hypot(
            x + (sx + 0.5) / SAMPLES - centre,
            y + (sy + 0.5) / SAMPLES - centre,
          );
          if (d <= dotR || Math.abs(d - ringR) <= ringW / 2) hits += 1;
        }
      }

      const ink = hits / (SAMPLES * SAMPLES);
      const along = (x + y) / (2 * size); // diagonal, matching the CSS gradient
      const at = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        const bg = ACCENT_A[ch] + (ACCENT_B[ch] - ACCENT_A[ch]) * along;
        pixels[at + ch] = Math.round(bg + (INK[ch] - bg) * ink);
      }
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

// --- output ----------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

// The maskable icon shrinks the mark so Android's adaptive crop can't clip it.
const targets = [
  ['apple-touch-icon.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.74],
];

for (const [name, size, scale] of targets) {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, render(size, scale)));
  console.log(`  ${name} — ${size}×${size}`);
}

const r = (n) => +(n * 100).toFixed(1);
fs.writeFileSync(
  path.join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffb340"/>
      <stop offset="1" stop-color="#ff8a3d"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <circle cx="50" cy="50" r="${r(RING_R)}" fill="none" stroke="#1a1206" stroke-width="${r(RING_W)}"/>
  <circle cx="50" cy="50" r="${r(DOT_R)}" fill="#1a1206"/>
</svg>
`,
);
console.log('  favicon.svg');
