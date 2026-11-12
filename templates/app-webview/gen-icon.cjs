const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const S = 192;
const img = Buffer.alloc(S * S * 4);
const R = 40; // 圆角半径
const BLUE = [27, 118, 239]; // primary-500
function insideRounded(x, y) {
  const cx = Math.min(Math.max(x, R), S - R);
  const cy = Math.min(Math.max(y, R), S - R);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}
function insideCross(x, y) {
  const t = 22, L = 120, c = S / 2;
  const h = Math.abs(y - c) <= t / 2 && Math.abs(x - c) <= L / 2;
  const v = Math.abs(x - c) <= t / 2 && Math.abs(y - c) <= L / 2;
  return h || v;
}
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!insideRounded(x, y)) { img[i + 3] = 0; continue; }
    if (insideCross(x, y)) { img[i] = img[i + 1] = img[i + 2] = 255; img[i + 3] = 255; }
    else { img[i] = BLUE[0]; img[i + 1] = BLUE[1]; img[i + 2] = BLUE[2]; img[i + 3] = 255; }
  }
}
function downscale(size) {
  const out = Buffer.alloc(size * size * 4);
  const f = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) {
        for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
          const i = (sy * S + sx) * 4;
          const al = img[i + 3] / 255;
          r += img[i] * al; g += img[i + 1] * al; b += img[i + 2] * al; a += img[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const alpha = a / n;
      out[o + 3] = Math.round(alpha);
      if (alpha > 0) {
        out[o] = Math.round(r / (a / 255));
        out[o + 1] = Math.round(g / (a / 255));
        out[o + 2] = Math.round(b / (a / 255));
      }
    }
  }
  return png(size, size, out);
}
const out = process.argv[2] || '.';
for (const [dir, size] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  fs.mkdirSync(`${out}/${dir}`, { recursive: true });
  fs.writeFileSync(`${out}/${dir}/ic_launcher.png`, downscale(size));
}
fs.writeFileSync('/tmp/opencode/icon-192.png', png(S, S, img));
console.log('icons generated');
