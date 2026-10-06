// ============================================================================
// measure-material-fit.mjs —— 量每段素材里「人物的大小与站位」（本地解 alpha，零成本）
// ============================================================================
// 为什么需要：19 段是**分别生成**的，模型不会自己保持同一景别 ——
//   实拍表现为：切动画时人物会「忽大忽小 / 忽高忽低」，看着像换了个角色。
//
// 量的口径（都在 640×360 的成品上、alpha>200 才算人物）：
//   · 头顶 top / 脚底 bottom / 身高 height   —— 站位与大小
//   · 头宽 headW（顶部 25% 区间内**最长连续段**）—— 用来当缩放基准
//     （为什么不用整体 bbox 宽：举剑/剑气/环绕剑影这些道具会把 bbox 撑开，
//       姐妹工具 measure-proportion 就是被斜举的剑骗过，这里不重蹈覆辙）
//   · 横向中心 cx
//   逐帧取中位数，避免空气泡之类只在一两帧出现的元素干扰。
//
// 用法：node tools\measure-material-fit.mjs [目录，默认 out/webm]
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from './keyscreen.mjs';

const DIR = process.argv[2] || 'out/webm';
const W = 640, H = 360, STEP = 8, SOLID = 200;
// 预期"脚应该踩在哪一行"（成品画布 640×360，人物脚下留一点边）
const GROUND = 348;

function alphaFrames(file) {
  const raw = path.join(os.tmpdir(), `fit-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  runFfmpeg(['-hide_banner', '-y', '-c:v', 'libvpx-vp9', '-i', file,
    '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { capture: true });
  if (!fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return b;
}

/** 单帧：bbox + 顶部 25% 内的最长连续段宽（头宽） */
function oneFrame(buf, off) {
  let top = -1, bottom = -1, left = W, right = -1;
  const rowBest = new Int32Array(H).fill(0);
  const rowMin = new Int32Array(H).fill(-1);
  const rowMax = new Int32Array(H).fill(-1);
  for (let y = 0; y < H; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < W; x++) {
      if (buf[off + y * W + x] > SOLID) {
        run++; if (run > best) best = run;
        if (rowMin[y] < 0) rowMin[y] = x;
        rowMax[y] = x;
      } else run = 0;
    }
    rowBest[y] = best;
    if (rowMax[y] >= 0) {
      if (top < 0) top = y;
      bottom = y;
      if (rowMin[y] < left) left = rowMin[y];
      if (rowMax[y] > right) right = rowMax[y];
    }
  }
  if (top < 0) return null;
  const zoneEnd = top + Math.floor((bottom - top + 1) * 0.25);
  let headW = 0;
  for (let y = top; y <= zoneEnd; y++) if (rowBest[y] > headW) headW = rowBest[y];
  return { top, bottom, height: bottom - top + 1, headW, cx: Math.round((left + right) / 2) };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.webm')).sort();
console.log(`目录 ${DIR}：${files.length} 段   口径：alpha>${SOLID}，逐 ${STEP} 帧取中位数\n`);
console.log('动作'.padEnd(22), '头顶', ' 脚底', ' 身高', ' 头宽', ' 横心');
const rows = [];
for (const f of files) {
  const buf = alphaFrames(path.join(DIR, f));
  if (!buf) { console.log(f.padEnd(22), '解帧失败'); continue; }
  const n = Math.floor(buf.length / (W * H));
  const acc = { top: [], bottom: [], height: [], headW: [], cx: [] };
  for (let i = 0; i < n; i += STEP) {
    const r = oneFrame(buf, i * W * H);
    if (!r) continue;
    acc.top.push(r.top); acc.bottom.push(r.bottom); acc.height.push(r.height); acc.headW.push(r.headW); acc.cx.push(r.cx);
  }
  const row = { name: f.replace(/\.webm$/, ''), top: median(acc.top), bottom: median(acc.bottom), height: median(acc.height), headW: median(acc.headW), cx: median(acc.cx), frames: n };
  rows.push(row);
  console.log(row.name.padEnd(22), String(row.top).padEnd(5), String(row.bottom).padEnd(6), String(row.height).padEnd(6), String(row.headW).padEnd(6), String(row.cx));
}

if (rows.length) {
  const med = (k) => median(rows.map((r) => r[k]));
  const g = { top: med('top'), bottom: med('bottom'), height: med('height'), headW: med('headW'), cx: med('cx') };
  console.log(`\n全体中位数：头顶 ${g.top} / 脚底 ${g.bottom} / 身高 ${g.height} / 头宽 ${g.headW} / 横心 ${g.cx}`);
  const spread = (k) => {
    const a = rows.map((r) => r[k]);
    const m = median(a);
    return { min: Math.min(...a), max: Math.max(...a), pct: ((Math.max(...a) - Math.min(...a)) / m * 100) };
  };
  for (const k of ['height', 'headW', 'bottom', 'top']) {
    const s = spread(k);
    console.log(`  ${k.padEnd(7)} 范围 ${s.min}~${s.max}（相对中位数波动 ${s.pct.toFixed(1)}%）`);
  }
  console.log(`\n相对"脚底应落在 ${GROUND} 行"的偏差：`);
  for (const r of rows) {
    const d = r.bottom - GROUND;
    if (Math.abs(d) >= 6) console.log(`  ${r.name.padEnd(22)} 脚底 ${r.bottom}（${d > 0 ? '低了' : '高了'} ${Math.abs(d)}px）`);
  }
}
