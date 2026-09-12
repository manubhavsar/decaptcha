/**
 * Pure-JS CAPTCHA raster renderer.
 *
 * Why hand-rolled instead of an SVG or a text challenge: the whole premise of
 * deCAPTCHA is that the *anonymous* path is genuinely hard for a script. If the
 * challenge shipped as SVG or JSON, a bot could read the answer straight out of
 * the payload and the "blocked" beat would be theatre. Rasterising to PNG means
 * the answer only exists as pixels, so solving it needs OCR — which a plain
 * fetch-loop bot does not have.
 *
 * No native canvas dependency (node-canvas needs a compiler toolchain, which is
 * a bad bet mid-hackathon). zlib is built in, so PNG encoding is ~60 lines.
 */

import zlib from 'node:zlib';

// Confusable characters (I/1, O/0, S/5 at low res) are excluded so a human
// failing the challenge means "bot-grade rendering", not "ambiguous glyph".
export const CHARSET = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';

// 5x7 bitmap font. One entry per CHARSET member.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return out;
}

/**
 * Renders `code` to a PNG buffer.
 *
 * Each glyph gets its own rotation and scale, then the whole field is pushed
 * through a two-axis sine warp and speckled with noise. Rendering is done by
 * inverse-mapping every output pixel back into glyph space, which keeps the
 * warp continuous instead of leaving gaps.
 */
export function renderCaptchaPng(code, opts = {}) {
  const width = opts.width ?? 300;
  const height = opts.height ?? 96;

  const cellW = width / code.length;
  const baseScale = Math.min(cellW / (GLYPH_W + 2), height / (GLYPH_H + 4.5));

  // Per-glyph transform, chosen once so the inverse map stays consistent.
  const transforms = [...code].map((ch, i) => ({
    ch,
    cx: cellW * (i + 0.5) + rand(-cellW * 0.06, cellW * 0.06),
    cy: height / 2 + rand(-height * 0.1, height * 0.1),
    angle: rand(-0.26, 0.26),
    sx: baseScale * rand(0.92, 1.05),
    sy: baseScale * rand(0.92, 1.05),
    shear: rand(-0.14, 0.14),
  }));

  const warp = {
    ax: rand(2, 4), fx: rand(0.02, 0.04), px: rand(0, Math.PI * 2),
    ay: rand(2, 4), fy: rand(0.02, 0.04), py: rand(0, Math.PI * 2),
  };

  // Two distractor strokes crossing the text, as sampled line segments.
  const strokes = Array.from({ length: 2 }, () => ({
    x0: rand(0, width * 0.2), y0: rand(0, height),
    x1: rand(width * 0.8, width), y1: rand(0, height),
    w: rand(1.1, 1.8),
  }));

  const bgR = 246, bgG = 247, bgB = 250;
  const rgb = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Inverse global warp: where in the undistorted field does this pixel come from?
      const u = x + warp.ax * Math.sin(warp.fy * y + warp.px);
      const v = y + warp.ay * Math.sin(warp.fx * x + warp.py);

      let ink = 0;

      for (const t of transforms) {
        const dx = u - t.cx;
        const dy = v - t.cy;
        const cos = Math.cos(-t.angle);
        const sin = Math.sin(-t.angle);
        let gx = (dx * cos - dy * sin) / t.sx;
        const gy = (dx * sin + dy * cos) / t.sy;
        gx -= gy * t.shear;

        const col = Math.floor(gx + GLYPH_W / 2);
        const row = Math.floor(gy + GLYPH_H / 2);
        if (col < 0 || col >= GLYPH_W || row < 0 || row >= GLYPH_H) continue;
        if (FONT[t.ch][row][col] === '#') { ink = 1; break; }
      }

      let r = bgR, g = bgG, b = bgB;

      if (ink) { r = 24; g = 26; b = 34; }

      // Strokes are drawn over the background but under nothing — they cross the
      // glyphs, which is what breaks naive per-glyph segmentation.
      if (!ink) {
        for (const s of strokes) {
          const vx = s.x1 - s.x0;
          const vy = s.y1 - s.y0;
          const len2 = vx * vx + vy * vy;
          const tt = Math.max(0, Math.min(1, ((x - s.x0) * vx + (y - s.y0) * vy) / len2));
          const px = s.x0 + tt * vx;
          const py = s.y0 + tt * vy;
          const d = Math.hypot(x - px, y - py);
          if (d < s.w) { r = 150; g = 157; b = 174; break; }
        }
      }

      // Salt-and-pepper noise defeats template matching on the flat background.
      if (Math.random() < 0.045) {
        const n = Math.random() < 0.5 ? -70 : 60;
        r = Math.max(0, Math.min(255, r + n));
        g = Math.max(0, Math.min(255, g + n));
        b = Math.max(0, Math.min(255, b + n));
      }

      const o = (y * width + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  }

  return encodePng(rgb, width, height);
}

/* ---------- minimal PNG encoder (truecolour, 8-bit, no interlace) ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgb, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
