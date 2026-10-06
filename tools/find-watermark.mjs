// ============================================================================
// find-watermark.mjs —— 自动量出「豆包AI生成」水印的位置，直接给出 --mask 参数
// ============================================================================
// 为什么要专门写一个：
//   豆包的水印是**半透明的浅绿字压在绿底上** —— 它比背景更亮，但饱和度不低，
//   所以「找浅灰色文字」那类规则抓不到它（我试过，抓到的是披风的红发光边）。
//   正确的判据是：**比背景绿更亮、且仍然是绿的**。
//
// 用法：
//   node tools/find-watermark.mjs out/定妆图-v3.jpg
//   node tools/find-watermark.mjs out/raw/待机呼吸休闲.mp4
//   node tools/find-watermark.mjs 图.jpg --quiet      # 只输出 --mask 那一行，方便塞进脚本
//
// 输出的是**原图坐标**，可以直接喂给 keyscreen.mjs --mask。
// 检测不到水印时会明确说"没检测到"，不会瞎给一个框（宁可让你手动量，也别盖掉人物）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from './keyscreen.mjs';
import { measure } from './measure-proportion.mjs';

const FFMPEG = findFfmpeg();

function parseArgs(argv) {
  const o = { file: null, quiet: false, pad: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    if (a === '--quiet') o.quiet = true;
    else if (a === '--pad') o.pad = Number(val());
    else if (!o.file) o.file = a;
    else throw new Error(`未知参数：${a}`);
  }
  if (!o.file) throw new Error('用法：node tools/find-watermark.mjs <图片或视频> [--quiet]');
  return o;
}

const o = parseArgs(process.argv.slice(2));
const file = path.resolve(o.file);
if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);

const m = measure(file);
const { W, H, bgColor } = m;
const bgLum = bgColor ? 0.2126 * bgColor[0] + 0.7152 * bgColor[1] + 0.0722 * bgColor[2] : 166;

// 解码首帧 RGBA
const isWebm = path.extname(file).toLowerCase() === '.webm';
const raw = path.join(os.tmpdir(), `wm-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
  ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []), '-i', file,
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { stdio: 'ignore' });
const px = fs.readFileSync(raw);
fs.unlinkSync(raw);

// 只在「人物右侧 + 画面下方」这片区域找，避免碰到人物本体
const xFrom = Math.max(m.bbox.x + m.bbox.w, Math.round(W * 0.5));
const yFrom = Math.max(m.bbox.y, Math.round(H * 0.6));

// 先按行统计命中数，再只保留「成行」的行。
// 为什么：人物边缘的 JPEG 振铃会在绿底上造出少量偏亮的绿像素（实测尾巴右侧就有），
// 逐像素判定会被这些孤立噪点带偏，把框一路撑到人物边上。
const rowHits = new Int32Array(H);
const hits = [];
for (let y = yFrom; y < H; y++) {
  for (let x = xFrom; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 判据：仍然是绿的（压过红蓝），但比背景更亮 —— 半透明白字压在绿底上的特征
    if (g - r > 30 && g - b > 30 && lum > bgLum + 22) {
      rowHits[y]++;
      hits.push([x, y]);
    }
  }
}
const minRowHits = Math.max(5, Math.round(W * 0.004)); // 一行里至少这么多像素才算文字行

let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
for (const [x, y] of hits) {
  if (rowHits[y] < minRowHits) continue;
  if (x < x0) x0 = x;
  if (x > x1) x1 = x;
  if (y < y0) y0 = y;
  if (y > y1) y1 = y;
  n++;
}

const rel = path.relative(process.cwd(), file);
if (n < 40) {
  console.log(`${rel}：没检测到水印（有效像素 ${n}）`);
  console.log('  可能水印已经关掉了，或者水印位置/颜色与预期不同 —— 那就手动量一个框。');
  process.exitCode = 0;
} else {
  // 框不许越过人物右边界，否则会削掉尾巴尖之类的部件
  const subjectRight = m.bbox.x + m.bbox.w;
  let mx = Math.max(0, x0 - o.pad);
  const clipped = mx <= subjectRight;
  if (clipped) mx = subjectRight + 2;
  const my = Math.max(0, y0 - o.pad);
  const mw = Math.min(W, x1 + o.pad) - mx + 1;
  const mh = Math.min(H, y1 + o.pad) - my + 1;
  if (!o.quiet) {
    console.log(`${rel}  ${W}x${H}  背景亮度 ${Math.round(bgLum)}`);
    console.log(`水印像素 ${n} 个（已滤掉不成行的噪点），包围盒 ${x0},${y0} - ${x1},${y1}`);
    console.log(`人物右边界 x=${subjectRight}${clipped ? ' —— 框的左边界被顶到人物右侧，避免削到人物' : ''}`);
  }
  console.log(`--mask ${mx},${my},${mw},${mh}`);
}
