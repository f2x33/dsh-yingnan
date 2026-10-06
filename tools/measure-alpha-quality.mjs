// ============================================================================
// measure-alpha-quality.mjs —— 抠像/后处理产物的 alpha 质量闸门
// ============================================================================
// 为什么需要它：keyscreen 自带的检查只看 alpha 的 min/max 和绿边，**看不出**这两类真事故：
//   ① 整幅变不透明（背景没抠掉）—— 实测踩过：后处理用了 `color=c=black@0` 当底图，
//      而 color 源根本不输出 alpha，`format=yuva420p` 一转就把透明补成不透明黑底；
//   ② 前景一半透明（黑发被抠成半透明 = 看着像白发）—— 只有数**半透明像素的比例**才看得出。
//
// 判据（对 640×360 的成品素材）：
//   · 画面边框带（上下左右各 4px）应当是**全透明**的 —— 素材都是"人物居中、脚下留边"；
//     （这条能抓住"整幅变不透明/背景没抠净"的事故）
//   · **内部半透明**占比要低（>4% 判 ❌）。阈值 4% 的来历：原素材实测 0.75~0.97%，关键在于「内部」怎么算对：
//     ① 先只看 alpha>8 的**可见区域**（人物剪影）；
//     ② 把它**腐蚀 4px** —— 去掉整圈轮廓（抗锯齿/插值软边本来就有好几个像素宽，
//        直接数"孤岛"会把正常的软边也算进去：实测那样每段都 3~5%，白底合成却完全干净）；
//     ③ 数腐蚀后剩下的**内部**里还有多少半透明像素 —— 干净的素材这里应当几乎为 0，
//        而"黑发被抠成半透明 / 一层脏 alpha"这类事故会在这里暴露。
//     做过放大归一化的（normalize-materials.mjs）放大后边缘更软，实测 1.5~2.8%；
//     而真正的事故（黑发被抠成半透明 28.9%、整幅不透明）都是 15% 起 —— 阈值取中间偏严的 4%。
//     教训：这个指标调了两轮才调对 —— **判据写错会把好东西判成坏的**，比不量更贵。
//   · 透明像素占比过低（<30%）通常意味着背景没抠净。
//
// 用法：node tools\measure-alpha-quality.mjs [目录默认 out/webm]
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from './keyscreen.mjs';

const DIR = process.argv[2] || 'out/webm';
const W = 640, H = 360, BAND = 4, MAX_INNER_SEMI = 4;

function alphaFrame(file, frame) {
  const raw = path.join(os.tmpdir(), `aq-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  runFfmpeg(['-hide_banner', '-y', '-c:v', 'libvpx-vp9', '-i', file,
    '-vf', `select=eq(n\\,${frame}),alphaextract`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { capture: true });
  if (!fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return b.length >= W * H ? b : null;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.webm')).sort();
console.log(`${DIR}：${files.length} 段   判据：边框带全透明 / **内部**半透明 ≤${MAX_INNER_SEMI}% / 透明占比 ≥30%\n`);
console.log('动作'.padEnd(22), '透明%', ' 半透明%', ' 内部半透明%', ' 边框透明%', ' 判定');
let bad = 0;
for (const f of files) {
  const a = alphaFrame(path.join(DIR, f), 0) ?? alphaFrame(path.join(DIR, f), 30);
  if (!a) { console.log(f.padEnd(22), '解帧失败'); bad++; continue; }
  let zero = 0, mid = 0, full = 0;
  for (let i = 0; i < W * H; i++) { const v = a[i]; if (v === 0) zero++; else if (v === 255) full++; else mid++; }
  // 内部 = 可见区域(alpha>8) 腐蚀 4px
  let vis = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) vis[i] = a[i] > 8 ? 1 : 0;
  for (let pass = 0; pass < 4; pass++) {
    const next = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!vis[i]) continue;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
        if (vis[i - 1] && vis[i + 1] && vis[i - W] && vis[i + W]) next[i] = 1;
      }
    }
    vis = next;
  }
  let interior = 0, innerSemi = 0;
  for (let i = 0; i < W * H; i++) {
    if (!vis[i]) continue;
    interior++;
    if (a[i] > 8 && a[i] < 250) innerSemi++;
  }
  let borderZero = 0, borderN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y < BAND || y >= H - BAND || x < BAND || x >= W - BAND) { borderN++; if (a[y * W + x] === 0) borderZero++; }
    }
  }
  const pct = (n) => n / (W * H) * 100;
  const fg = full + mid;
  const innerPct = interior ? innerSemi / interior * 100 : 0;
  const borderPct = borderZero / borderN * 100;
  const ok = borderPct > 99 && innerPct <= MAX_INNER_SEMI && pct(zero) >= 30;
  if (!ok) bad++;
  console.log(f.replace(/\.webm$/, '').padEnd(22),
    pct(zero).toFixed(1).padEnd(6), (fg ? mid / fg * 100 : 0).toFixed(1).padEnd(8),
    innerPct.toFixed(2).padEnd(13), borderPct.toFixed(1).padEnd(10),
    ok ? '✅' : (borderPct <= 99 ? '❌ 边框不透明（背景没抠净）' : innerPct > MAX_INNER_SEMI ? '❌ 内部半透明（脏 alpha）' : '❌ 透明占比过低'));
}
console.log(bad === 0 ? `\n全部合格 ✅（${files.length} 段）` : `\n${bad} / ${files.length} 段不合格 ❌`);
process.exit(bad === 0 ? 0 : 1);
