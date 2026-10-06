// 量「发色」：取主体上部两侧的头发区域，报告平均 RGB / 亮度 / 饱和度 / 色相
// 判据：真黑发 → 亮度低、三通道差小（<15）、饱和度低；紫发 → B 明显高于 R/G
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from './keyscreen.mjs';

function frame(file, dec = []) {
  const raw = path.join(os.tmpdir(), `hair-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  const r = runFfmpeg(['-hide_banner', '-y', ...dec, '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { capture: true });
  if (!fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return b;
}

const files = process.argv.slice(2);
console.log('文件'.padEnd(38), '平均RGB', '  亮度', ' 通道差', ' 判定');
for (const f of files) {
  const isWebm = f.endsWith('.webm');
  const px = frame(f, isWebm ? ['-c:v', 'libvpx-vp9'] : []);
  if (!px) { console.log(f, '解帧失败'); continue; }
  // 定妆图 1696x2576 / 静帧同尺寸：头发在 主体上部、脸的左右两侧
  const W = 1696, H = 2576;
  const boxes = [
    { x: 320, y: 620, w: 220, h: 420 },   // 左侧鬓发/长发
    { x: 1120, y: 600, w: 240, h: 500 },  // 右侧长发
    { x: 700, y: 330, w: 320, h: 160 },   // 头顶发髻
  ];
  let n = 0, r = 0, g = 0, b = 0;
  for (const bx of boxes) {
    for (let y = bx.y; y < Math.min(H, bx.y + bx.h); y++) {
      for (let x = bx.x; x < Math.min(W, bx.x + bx.w); x++) {
        const i = (y * W + x) * 4;
        if (px[i + 3] < 200) continue;          // 只要不透明的
        const R = px[i], G = px[i + 1], B = px[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (lum > 150) continue;                 // 排掉高光/皮肤
        r += R; g += G; b += B; n++;
      }
    }
  }
  if (!n) { console.log(path.basename(f).padEnd(38), '（没采到暗色像素）'); continue; }
  r /= n; g /= n; b /= n;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const purple = b - (r + g) / 2;               // >0 偏蓝紫
  const verdict = (lum < 70 && spread < 18 && purple < 12) ? '✅ 黑发' : (purple > 12 ? `❌ 偏紫（B 高出 ${purple.toFixed(1)}）` : `⚠ 不够黑（亮度 ${lum.toFixed(0)} / 差 ${spread.toFixed(0)}）`);
  console.log(path.basename(f).padEnd(38), `rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`.padEnd(20), lum.toFixed(0).padEnd(5), spread.toFixed(0).padEnd(7), verdict);
}
