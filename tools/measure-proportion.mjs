// ============================================================================
// measure-proportion.mjs —— 量「头身比」，别靠眼睛吵
// ============================================================================
// 桌宠是超变形 Q 版（头巨大、腿短），生成模型很容易给你画成"正常少/成年人比例"。
// 这个脚本把主体轮廓量出来，给出可比较的硬数字：
//   · 主体包围盒（上下左右在哪里）
//   · 头宽（主体上半 25% 里最宽的那一行）→ **身高 / 头宽**
//   · 脖子位置估计（头最宽处往下，第一次收窄到 45% 以下的行）→ 身高 / 头高
//   · 逐行宽度 ASCII 轮廓（直接看出头大不大、腿长不长）
//
// 【验收标准】dsh-pet 官方素材实测 身高/头宽 ≈ **1.71**。
//   红队装定妆图应当落在 **1.7 ~ 2.1**；超过 2.5 就是画成正常比例了，必须重生成。
//
// 用法：
//   node tools/measure-proportion.mjs out/定妆图-v1.jpg
//   node tools/measure-proportion.mjs out/style-ref/待机呼吸休闲.png
//   node tools/measure-proportion.mjs 图.jpg --mask 0,1900,1152,148   # 先盖掉水印再量
//   node tools/measure-proportion.mjs 图.jpg --json
//
// 背景判定：alpha<32（透明源）或"够绿"（绿幕源，g 明显大于 r/b）都算背景。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from './keyscreen.mjs';
import { pathToFileURL } from 'node:url';

const FFMPEG = findFfmpeg();

/** ffmpeg 写文件、再读文件（不用管道：沙箱下管道会 EPERM） */
function run(args) {
  const log = path.join(os.tmpdir(), `measure-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const fd = fs.openSync(log, 'w');
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const text = fs.readFileSync(log, 'utf8');
  fs.unlinkSync(log);
  if (r.error) throw r.error;
  return text;
}

function probeSize(file) {
  // webm 显式指定解码器，否则 alpha 会丢（这条已经踩过）
  const isWebm = path.extname(file).toLowerCase() === '.webm';
  const log = run(['-hide_banner', ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []), '-i', file]);
  const m = log.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!m) throw new Error('读不出分辨率：' + log.split('\n').slice(0, 6).join(' '));
  return { w: Number(m[1]), h: Number(m[2]), isWebm };
}

function decodeRgba(file, isWebm) {
  const raw = path.join(os.tmpdir(), `measure-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  run(['-hide_banner', '-y', ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []), '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return buf;
}

/**
 * 量一个文件的主体轮廓。
 * @returns {file,W,H,bbox,headW,headWRow,neckY,headH,ratio_height_over_headW,ratio_height_over_headH,widestRow,rowWidth}
 */
export function measure(file, opts = {}) {
  const { masks = [], xLimit = [0, 1], alphaThreshold = 32, bg = 'auto', bgTolerance = 36 } = opts;
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);

  const { w: W, h: H, isWebm } = probeSize(abs);
  const px = decodeRgba(abs, isWebm);
  if (px.length < W * H * 4) throw new Error(`像素数据不足：期望 ${W * H * 4}，实际 ${px.length}`);

  const isMasked = (x, y) => masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);

  // ---------------- 背景判定：边框取色 + 从画面边缘泛洪 ----------------
  // 为什么不能"颜色接近背景就算背景"：这角色的**鲸鱼鳍耳是白的**，
  // 白底图里会和背景同色，一刀切会把鳍耳挖掉 → 量出来的头宽偏小 → 假"合格"。
  // 所以只把**与画面边缘连通**的背景色区域算背景；被头发围住的白色鳍耳连不到边缘，
  // 仍然是主体。绿幕、白底、灰底、透明底四种情况都适用。
  const colorAt = (x, y) => {
    const i = (y * W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const sampleBorderColor = () => {
    const buckets = new Map();
    const add = (x, y) => {
      const c = colorAt(x, y);
      const k = `${c[0] >> 4},${c[1] >> 4},${c[2] >> 4}`;
      const e = buckets.get(k) || { n: 0, c };
      e.n++;
      buckets.set(k, e);
    };
    for (let x = 0; x < W; x += 2) { add(x, 0); add(x, H - 1); }
    for (let y = 0; y < H; y += 2) { add(0, y); add(W - 1, y); }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    return best.c;
  };

  const parseHex = (s) => {
    const m = String(s).replace('#', '');
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  let bgColor = null;
  if (bg === 'green') bgColor = [0, 255, 0];
  else if (bg === 'white') bgColor = [255, 255, 255];
  else if (bg === 'auto') bgColor = sampleBorderColor();
  else if (bg !== 'none') bgColor = parseHex(bg);

  const tol2 = bgTolerance * bgTolerance;
  const bgLike = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2], al = px[p + 3];
    if (al < alphaThreshold) { bgLike[i] = 1; continue; }
    if (bgColor) {
      const dr = r - bgColor[0], dg = g - bgColor[1], db = b - bgColor[2];
      if (dr * dr + dg * dg + db * db <= tol2) { bgLike[i] = 1; continue; }
    }
    // 平坦浅色（白/浅灰）也算背景：专门用来吃掉白底和脚底那圈投影（实测投影核心
    // 亮度约 170~205、饱和度 < 5，所以阈值给到 150 才吃得掉）。
    // 角色身上的白色（鲸鱼鳍耳内部、键盘键帽）同样满足这条，但它们被深色描边包着、
    // 泛洪进不去 → 仍然算主体，所以不会把鳍耳挖掉。
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > 150 && sat < 32) { bgLike[i] = 1; continue; }
    if (g > 110 && g - r > 45 && g - b > 45) bgLike[i] = 1; // 绿幕兜底
  }

  // 从四条边泛洪（每个像素最多入栈一次，栈容量 = 像素数）
  const reachable = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (x, y) => {
    const i = y * W + x;
    if (!reachable[i] && bgLike[i]) { reachable[i] = 1; stack[sp++] = i; }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  const rowWidth = new Int32Array(H);
  const rowRun = new Int32Array(H);          // 该行**最长连续前景段**的宽度
  const rowMin = new Int32Array(H).fill(-1);
  const rowMax = new Int32Array(H).fill(-1);
  const xLo = Math.floor(W * xLimit[0]);
  const xHi = Math.ceil(W * xLimit[1]);

  let top = -1, bottom = -1, left = W, right = -1;
  for (let y = 0; y < H; y++) {
    let run = 0, best = 0;
    for (let x = xLo; x < xHi; x++) {
      if (reachable[y * W + x] || isMasked(x, y)) { run = 0; continue; }
      run++;
      if (run > best) best = run;
      if (rowMin[y] === -1 || x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
    }
    rowRun[y] = best;
    if (rowMin[y] !== -1) {
      rowWidth[y] = rowMax[y] - rowMin[y] + 1;
      if (top === -1) top = y;
      bottom = y;
      if (rowMin[y] < left) left = rowMin[y];
      if (rowMax[y] > right) right = rowMax[y];
    }
  }
  if (top === -1) throw new Error('没找到主体：背景判定可能不适用（不是绿幕、也不是透明底？）');

  const bodyH = bottom - top + 1;
  const bodyW = right - left + 1;

  let headW = 0, headWRow = top;
  const headZoneEnd = top + Math.floor(bodyH * 0.25);
  for (let y = top; y <= Math.min(headZoneEnd, bottom); y++) {
    if (rowWidth[y] > headW) { headW = rowWidth[y]; headWRow = y; }
  }

  // 「连续段」口径的头宽：只看**最长的一段连续前景**，不把左边那把剑/右边飘带一起量进来。
  // 为什么需要：rowWidth 用的是「本行最左到最右」，斜举的剑与头之间隔着背景也照样被算进去，
  // 于是 头宽 被撑大 → 身高/头宽 假性偏小 → 明明 2.9 正常比例却判成 1.9"合格"（实际踩过：
  // 豆包原图与第一版定妆图都因此假合格，直到 15 张动作静帧量出 2.7~3.4 才暴露）。
  let headRunW = 0, headRunWRow = top;
  for (let y = top; y <= Math.min(headZoneEnd, bottom); y++) {
    if (rowRun[y] > headRunW) { headRunW = rowRun[y]; headRunWRow = y; }
  }

  let neckY = -1;
  for (let y = headWRow; y <= top + Math.floor(bodyH * 0.7); y++) {
    if (rowWidth[y] > 0 && rowWidth[y] < headW * 0.45) { neckY = y; break; }
  }
  const headH = neckY > 0 ? neckY - top : null;

  let maxW = 0, maxWRow = top;
  for (let y = top; y <= bottom; y++) if (rowWidth[y] > maxW) { maxW = rowWidth[y]; maxWRow = y; }

  const r2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    file: path.relative(process.cwd(), abs),
    W, H, bgColor, rowWidth, rowRun, top, bottom, left, right,
    bbox: { x: left, y: top, w: bodyW, h: bodyH },
    headW, headWRow, neckY, headH,
    ratio_height_over_headW: r2(bodyH / headW),
    ratio_height_over_headH: headH ? r2(bodyH / headH) : null,
    headRunW, headRunWRow,
    ratio_height_over_headRunW: r2(bodyH / headRunW),
    // 两种口径差得远 = 画面里有道具（剑/飘带）在头顶附近横向撑开了，原口径不可信
    headMetricSuspect: headRunW > 0 && headW > headRunW * 1.25,
    widestRow: { y: maxWRow, w: maxW },
    bodyAspect: r2(bodyW / bodyH),
  };
}

export function printMeasure(m) {
  console.log(`文件      ${m.file}`);
  console.log(`画布      ${m.W}x${m.H}`);
  console.log(`背景色    ${m.bgColor ? `rgb(${m.bgColor.join(',')})` : '不判定（--bg none）'}（只把与画面边缘连通的背景色算背景）`);
  console.log(`主体      左${m.left} 上${m.top} 宽${m.bbox.w} 高${m.bbox.h}`);
  console.log(`头宽      ${m.headW}px（第 ${m.headWRow} 行）→ 身高/头宽 = ${m.ratio_height_over_headW}`);
  console.log(`头宽(连续) ${m.headRunW}px（第 ${m.headRunWRow} 行）→ 身高/头宽(连续) = ${m.ratio_height_over_headRunW}${m.headMetricSuspect ? '  ⚠ 两种口径差得多，说明头顶附近有道具撑开，**以连续口径为准**' : ''}`);
  console.log(`头高      ${m.headH ? `${m.headH}px（脖子约在第 ${m.neckY} 行）→ 身高/头高 = ${m.ratio_height_over_headH}` : '估不出来（轮廓没有明显收窄）'}`);
  console.log(`最宽      ${m.widestRow.w}px（第 ${m.widestRow.y} 行）`);
  console.log(`判定      ${verdict(m.headMetricSuspect ? m.ratio_height_over_headRunW : m.ratio_height_over_headW)}${m.headMetricSuspect ? '（按连续口径判）' : ''}`);
  console.log('');

  const ROWS = 30, COLS = 56;
  const maxW = m.widestRow.w;
  console.log('轮廓（宽度归一化，每行 = 主体的 1/30 高度）：');
  for (let i = 0; i < ROWS; i++) {
    const y0 = m.top + Math.floor((m.bbox.h * i) / ROWS);
    const y1 = m.top + Math.floor((m.bbox.h * (i + 1)) / ROWS);
    let wmax = 0;
    for (let y = y0; y < y1; y++) if (m.rowWidth[y] > wmax) wmax = m.rowWidth[y];
    const bar = '█'.repeat(Math.max(0, Math.round((wmax / maxW) * COLS)));
    const pct = Math.round((wmax / maxW) * 100);
    const mark = m.neckY > 0 && y0 <= m.neckY && m.neckY < y1 ? '  ← 脖子' : '';
    console.log(`  y=${String(y0).padStart(4)} ${String(pct).padStart(3)}% ${bar}${mark}`);
  }
}

/** 按 dsh-pet 官方基准（1.71）给结论 */
export function verdict(ratio) {
  if (ratio === null) return '量不出来';
  if (ratio <= 2.1) return `✅ Q版比例合格（基准 1.71）`;
  if (ratio <= 2.5) return `⚠️  偏大了些（${ratio}），接近可接受上限 2.1`;
  return `❌ 不是 Q 版比例（${ratio}，基准 1.71，上限 2.1）—— 头要放大、身体要缩短`;
}

function parseArgs(argv) {
  const o = { file: null, masks: [], json: false, xLimit: [0, 1], alphaThreshold: 32, bg: 'auto', bgTolerance: 36 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    if (a === '--mask') {
      const [x, y, w, h] = val().split(',').map(Number);
      if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error('--mask 格式：x,y,w,h');
      o.masks.push({ x, y, w, h });
    } else if (a === '--bg') {
      o.bg = val();                      // auto / white / green / none / #RRGGBB
    } else if (a === '--bg-tolerance') {
      o.bgTolerance = Number(val());
    } else if (a === '--x-limit') {
      const [lo, hi] = val().split(',').map(Number);
      o.xLimit = [lo, hi];
    } else if (a === '--json') o.json = true;
    else if (!o.file) o.file = a;
    else throw new Error(`未知参数：${a}`);
  }
  if (!o.file) throw new Error('用法：node tools/measure-proportion.mjs <图片或webm> [--mask x,y,w,h] [--bg auto|white|green|none|#RRGGBB] [--json]');
  return o;
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  const m = measure(o.file, {
    masks: o.masks,
    xLimit: o.xLimit,
    alphaThreshold: o.alphaThreshold,
    bg: o.bg,
    bgTolerance: o.bgTolerance,
  });
  if (o.json) {
    const { rowWidth, ...rest } = m;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    printMeasure(m);
  }
}
