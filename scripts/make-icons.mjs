// Generates the app icons as PNG files without any image tools:
//   public/icons/icon-192.png, icon-512.png, maskable-512.png  (PWA)
//   build/icon.png (1024)                                       (Electron installers)
// Design: indigo-violet rounded square, white "sheet" with a PDF block and a pen line.
// Replace these files with your own artwork whenever you like.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = pixel((x + ox) / size, (y + oy) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / 4) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

// u, v in 0..1; `pad` shrinks the artwork for maskable icons.
// bg: 'rounded' (normal icon), 'full' (maskable) or 'none' (Android adaptive foreground).
const design = (pad, bg = pad > 0 ? 'full' : 'rounded') => (u, v) => {
  // Brand gradient: indigo (top-left) to violet (bottom-right).
  const t = Math.max(0, Math.min(1, (u + v) / 2));
  const BLUE = bg === 'none' ? [0, 0, 0, 0] : [80 + (139 - 80) * t, 70 + (92 - 70) * t, 229 + (246 - 229) * t, 1];
  const WHITE = [255, 255, 255, 1], PDF = [203, 213, 225, 1], INK = [234, 88, 12, 1];
  if (bg === 'rounded' && !inRoundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.2)) return [0, 0, 0, 0];
  const s = 1 - pad * 2;
  const x = (u - pad) / s, y = (v - pad) / s;
  if (inRoundRect(x, y, 0.2, 0.2, 0.8, 0.8, 0.04)) {
    if (distToSeg(x, y, 0.6, 0.62, 0.72, 0.36) < 0.022 || distToSeg(x, y, 0.6, 0.62, 0.66, 0.5) < 0.022) return INK;
    if (x > 0.25 && x < 0.52 && y > 0.25 && y < 0.75) {
      if (y > 0.3 && y < 0.7 && Math.floor((y - 0.3) / 0.06) % 2 === 0 && x < 0.47 && x > 0.3) return [148, 163, 184, 1];
      return PDF;
    }
    return WHITE;
  }
  return BLUE;
};

mkdirSync('public/icons', { recursive: true });
mkdirSync('build', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, design(0)));
writeFileSync('public/icons/icon-512.png', png(512, design(0)));
writeFileSync('public/icons/maskable-512.png', png(512, design(0.1)));
writeFileSync('build/icon.png', png(1024, design(0)));
console.log('Icons written to public/icons and build/icon.png');

// Android launcher icons (only when the android/ project exists).
const res = 'android/app/src/main/res';
if (existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = `${res}/mipmap-${d}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/ic_launcher.png`, png(48 * k, design(0)));
    writeFileSync(`${dir}/ic_launcher_round.png`, png(48 * k, design(0)));
    writeFileSync(`${dir}/ic_launcher_foreground.png`, png(108 * k, design(0.15, 'none')));
  }
  writeFileSync(`${res}/values/ic_launcher_background.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#6450EE</color>\n</resources>\n');
  console.log('Android launcher icons written to ' + res);
}
