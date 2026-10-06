// 同比例对照图：19 段各取同一时刻的一帧，**不做任何缩放对齐**，纯拼在一起 ——
// 大小差多少一眼可见。修完归一化后再跑一次，两张对比就是验收依据。
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from './keyscreen.mjs';

const DIR = process.argv[2] || 'out/webm';
const OUT = process.argv[3] || 'out/_fit/before.png';
const FRAME = 60;
const CW = 300, CH = 200;   // 每格：640×360 等比缩到 300×169 + 底部留白放编号

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.webm')).sort();
const cells = [];
names.forEach((f, i) => {
  const src = path.join(DIR, f);
  const png = path.join(path.dirname(OUT), `c${String(i + 1).padStart(2, '0')}.png`);
  // 取第 FRAME 帧，缩到统一格子（等比），铺在深灰底上 —— 不做别的处理
  const vf = `select=eq(n\\,${FRAME}),scale=${CW - 6}:${CH - 40}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${CW}:${CH}:(ow-iw)/2:8:color=0x202020`;
  const r = runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src,
    '-vf', vf, '-frames:v', '1', png], { capture: true });
  if (r.status === 0 && fs.existsSync(png)) cells.push(png);
});
const cols = 5;
const layout = cells.map((_, i) => `${(i % cols) * CW}_${Math.floor(i / cols) * CH}`).join('|');
const rowsN = Math.ceil(cells.length / cols);
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
for (const c of cells) args.push('-i', c);
args.push('-filter_complex', `xstack=inputs=${cells.length}:layout=${layout}:fill=0x0A0A0A`, '-frames:v', '1', OUT);
const res = runFfmpeg(args, { capture: true });
console.log(res.status === 0 ? `✅ ${OUT}（${cells.length} 格 / ${cols} 列 → 顺序见下方清单）` : `❌ ${res.log}`);
console.log('格子顺序：');
names.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n.replace(/\.webm$/, '')}`));
