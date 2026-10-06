// ============================================================================
// normalize-materials.mjs —— 把 19 段素材的「人物大小 / 站位」归一化（本地，零成本）
// ============================================================================
// 背景：19 段是分别生成的，模型不保证同一景别 —— 实测人物身高 235~345px（波动 ±36.5%）、
//   脚底 320~358px。切动画时她会忽大忽小、忽高忽低。**这不需要重新生成视频**：
//   素材是本地 VP9-alpha，逐段 scale + 平移 重新编码即可。
//
// 量什么（抗道具是关键，姐妹工具 measure-proportion 就被斜举的剑骗过）：
//   ① 对身体做**腐蚀**（binary erosion）—— 细长道具（光柱、剑气弧、悬浮剑影、脚下的剑）
//      在腐蚀后消失，剩下的大块就是身体；
//   ② 取腐蚀图的**最大连通域**，它的高度 + 2r 复原 ≈ 人物真实身高 bodyH；
//   ③ 站位用**原始 alpha 的 bbox 底边** bboxBottom（对飞行段来说那是脚下的剑，正好一致）。
//
// 然后逐段算：scale = 目标bodyH / bodyH，位移 dy = 目标底边 − bboxBottom×scale；
//   横向把中位数中心对回画布中心（御剑飞行是"真位移"段，但整体平移不破坏它的滑行）。
//
// 用法：
//   node tools\normalize-materials.mjs --dry                 # 只出换算表，不写文件
//   node tools\normalize-materials.mjs --apply               # 写 out\webm-normalized\
//   node tools\normalize-materials.mjs --apply --install     # 再覆盖装进包内与用户目录
// 参数：--r 6（腐蚀半径）、--target-body 300、--target-bottom 352、--clamp 0.75,1.35
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFfmpeg, probeAlphaMode, probeFringe } from './keyscreen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const numOf = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : d; };
const argOf = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const SRC = path.resolve(ROOT, argOf('--in', 'out/webm'));
const OUT = path.resolve(ROOT, argOf('--out', 'out/webm-normalized'));
const APPLY = argv.includes('--apply');
const INSTALL = argv.includes('--install');
const R = numOf('--r', 6);
const TARGET_BODY = numOf('--target-body', 0);      // 0 = 自动取中位数
const TARGET_BOTTOM = numOf('--target-bottom', 352);
const [CLAMP_LO, CLAMP_HI] = String(argOf('--clamp', '0.75,1.35')).split(',').map(Number);
const STEP = 8, SOLID = 200, W = 640, H = 360;

// ---------- 读 alpha ----------
function alphaFrames(file) {
  const raw = path.join(os.tmpdir(), `nm-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  runFfmpeg(['-hide_banner', '-y', '-c:v', 'libvpx-vp9', '-i', file, '-vf', 'alphaextract',
    '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { capture: true });
  if (!fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return b;
}

// ---------- 腐蚀 + 最大连通域 ----------
function erode(mask) {
  const out = new Uint8Array(W * H);
  for (let y = R; y < H - R; y++) {
    for (let x = R; x < W - R; x++) {
      let all = 1;
      for (let dy = -R; dy <= R && all; dy += R) {
        for (let dx = -R; dx <= R; dx += R) {
          if (!mask[(y + dy) * W + (x + dx)]) { all = 0; break; }
        }
      }
      out[y * W + x] = all;
    }
  }
  return out;
}
function largestComponentBox(mask) {
  const seen = new Uint8Array(W * H);
  let best = null;
  const stack = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let n = 0, minX = W, maxX = -1, minY = H, maxY = -1;
    while (sp > 0) {
      const p = stack[--sp]; n++;
      const x = p % W, y = (p - x) / W;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    if (!best || n > best.n) best = { n, minX, maxX, minY, maxY };
  }
  return best;
}

function measure(file) {
  const buf = alphaFrames(file);
  if (!buf) return null;
  const n = Math.floor(buf.length / (W * H));
  const bodyHs = [], bottoms = [], centers = [];
  for (let f = 0; f < n; f += STEP) {
    const off = f * W * H;
    const mask = new Uint8Array(W * H);
    let top = -1, bottom = -1, left = W, right = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (buf[off + y * W + x] > SOLID) {
          mask[y * W + x] = 1;
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (top < 0) continue;
    const box = largestComponentBox(erode(mask));
    if (!box) continue;
    bodyHs.push(box.maxY - box.minY + 1 + 2 * R);    // 腐蚀掉了一圈，补回来
    bottoms.push(bottom);
    centers.push(Math.round((left + right) / 2));
  }
  if (!bodyHs.length) return null;
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { bodyH: med(bodyHs), bottom: med(bottoms), cx: med(centers), frames: n };
}

// ---------- 主流程 ----------
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.webm')).sort();
console.log(`源目录 ${SRC}`);
console.log(`参数：腐蚀半径 r=${R}  目标身高 ${TARGET_BODY || '（自动=中位数）'}  目标底边 ${TARGET_BOTTOM}  缩放夹取 [${CLAMP_LO}, ${CLAMP_HI}]\n`);
console.log('动作'.padEnd(22), '身体高', ' 底边', ' 中心');
const rows = [];
for (const f of files) {
  const m = measure(path.join(SRC, f));
  if (!m) { console.log(f.padEnd(22), '测量失败'); continue; }
  rows.push({ file: f, name: f.replace(/\.webm$/, ''), ...m });
  console.log(m ? m.bodyH.toString().padEnd(6) : '', String(m.bottom).padEnd(5), String(m.cx).padEnd(6), ' ', f.replace(/\.webm$/, ''));
}
const medOf = (k) => [...rows.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const tBody = TARGET_BODY || medOf('bodyH');
const tCx = medOf('cx');
console.log(`\n自动目标：身体高 ${tBody}（中位数）、底边 ${TARGET_BOTTOM}、横向中心 ${tCx}`);
console.log('\n逐段换算表：');
console.log('动作'.padEnd(22), 'scale', ' dy', ' dx', '  说明');
const plan = [];
for (const r of rows) {
  let s = tBody / r.bodyH;
  const raw = s;
  s = Math.min(CLAMP_HI, Math.max(CLAMP_LO, s));
  const dy = Math.round(TARGET_BOTTOM - r.bottom * s);
  const dx = Math.round(tCx - r.cx * s);
  plan.push({ ...r, s: Math.round(s * 1000) / 1000, dx, dy, raw: Math.round(raw * 1000) / 1000 });
  console.log(r.name.padEnd(22), s.toFixed(3).padEnd(6), String(dy).padEnd(4), String(dx).padEnd(4),
    raw !== s ? `（原始 ${raw.toFixed(3)} 被夹取）` : '');
}

if (!APPLY) {
  console.log('\n（这是 --dry：没有写任何文件。加 --apply 才真转码）');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`\n开始归一化转码 → ${OUT}`);
let ok = 0, bad = 0;
for (const p of plan) {
  const target = path.join(OUT, p.file);
  // **单次编码**：缩放与"放到透明底上"放进同一个滤镜图 —— 省一遍 VP9 编解码（快一倍、少掉一次画质）。
  // ⚠ 三个踩过的坑：
  //   ① lavfi 的 color 源默认**无限长**，直接 overlay 会让 ffmpeg 永远不结束（第一次跑就卡死在这，
  //      留下 0 字节输出）。必须给 color 加 `d=` 时长并配 `-shortest`。
  //   ② `color=c=black@0` **不会真的输出 alpha 通道**（color 源出的是 yuv420p），
  //      后面 `format=yuva420p` 一转换就把透明补成**不透明黑底** —— 结果整幅 640×360 全不透明。
  //      必须再显式 `colorchannelmixer=aa=0` 把 alpha 乘成 0。
  //   ③ scale>1 时整体比画布大，用不了 pad，只能用 overlay 落到透明底上。
  const dur = Math.max(1, (p.frames || 120) / 24 + 0.5);
  const r = runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y',
    '-c:v', 'libvpx-vp9', '-i', path.join(SRC, p.file),
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=24:d=${dur.toFixed(2)}`,
    '-filter_complex',
    `[0:v]scale=iw*${p.s}:ih*${p.s}:flags=lanczos,format=yuva420p[fg];` +
    `[1:v]format=yuva420p,colorchannelmixer=aa=0[bg];[bg][fg]overlay=x=${p.dx}:y=${p.dy}:format=auto,format=yuva420p`,
    '-shortest',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '10', '-b:v', '0', '-auto-alt-ref', '0',
    '-row-mt', '1', '-cpu-used', '4', '-an', target], { capture: true });
  if (r.status !== 0) { console.log(`  ✗ ${p.name} 失败：${r.log.split('\n').filter(Boolean).slice(-1)[0]}`); bad++; continue; }
  const am = probeAlphaMode(target);
  const fr = probeFringe(target);
  console.log(`  ✓ ${p.name.padEnd(22)} scale=${p.s} dy=${p.dy} dx=${p.dx}   alpha=${am}  绿边=${fr?.fringe ?? '?'}px`);
  ok++;
}
console.log(`\n完成：成功 ${ok} / 失败 ${bad}`);

if (INSTALL) {
  const userDir = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'),
    'dsh-yingnan', 'main-animation', 'webm');
  const pkgDir = path.join(ROOT, 'assets', 'webm');
  let n = 0;
  for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.webm'))) {
    fs.copyFileSync(path.join(OUT, f), path.join(pkgDir, f));
    if (fs.existsSync(userDir)) fs.copyFileSync(path.join(OUT, f), path.join(userDir, f));
    n++;
  }
  console.log(`已装包：包内 ${n} 段${fs.existsSync(userDir) ? ` + 用户目录 ${n} 段` : ''}`);
}
