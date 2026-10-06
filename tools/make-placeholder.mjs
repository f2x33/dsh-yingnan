// ============================================================================
// make-placeholder.mjs —— 零成本占位素材：从定妆图造 15 段 640×360 VP9-alpha webm
// ============================================================================
// 【为什么要有这个脚本】
//   宠物骨架（插件 / 路由 / 动作池 / 渲染）要能先跑起来，而真素材要花钱（方舟 API
//   480p/5s ≈ ¥4.4/段 × 15 ≈ ¥66）。占位素材让**整条链先通**：
//     · 素材名、尺寸、alpha、动作池 1:1 对齐 —— 与真素材完全同规格
//     · 真素材生成后**同名覆盖**，配置文件一个字都不用改
//
// 【做什么】
//   定妆图（绿幕）→ 抠出主体 → 缩放到与父包红队素材**同框比例** → 放到 640×360 画布
//   → 绿幕转 alpha → VP9-alpha webm。附带：
//     · 自动找并盖掉生成器水印（豆包/即梦那行字）—— 不盖就永远留一块白字
//     · 每段给一点不同的轻微上下浮动（正弦，周期整除时长 → 无缝循环），看起来不像死图
//
// 【同框比例怎么定的】
//   实测父包 dsh-redpet 的成品素材首帧：640×360 画布上主体 高 321px、底边距画布底 2px、
//   水平居中。本脚本按同一口径放置，所以两只宠物在页面上**一样大**。
//
// 【用法】
//   node tools/make-placeholder.mjs --ref out/定妆图.png            # 造全部（写 out/webm）
//   node tools/make-placeholder.mjs --ref ... --names 待机呼吸休闲   # 只造一段
//   node tools/make-placeholder.mjs --ref ... --install             # 再装进用户素材目录 + 包内
//   node tools/make-placeholder.mjs --ref ... --no-motion           # 静态（不浮动）
//   node tools/make-placeholder.mjs --ref ... --probe-only          # 只体检已有素材
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ROOT, CONFIG_FILE, configActionNames, findFfmpeg, ffmpegCapabilities,
  runFfmpeg, probeAlphaPixels, probeFringe, probeInfo,
} from './keyscreen.mjs';
import { measure } from './measure-proportion.mjs';

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${f} 缺参数值`);
  return v;
};

const REF = path.resolve(val('--ref', path.join(ROOT, 'out', '定妆图.png')));
const OUT_DIR = path.resolve(val('--out', path.join(ROOT, 'out', 'webm')));
const CANVAS_W = 640;
const CANVAS_H = 360;
const SUBJ_H = Number(val('--subj-h', '321'));   // 主体在画布里的高度（父包实测口径）
const SUBJ_BOTTOM_GAP = Number(val('--bottom-gap', '2'));
const DUR_BASE = Number(val('--duration', '4'));
// ⚠ 抠像阈值不能照抄父包（父包默认 sim=0.3 / blend=0.1）。
//   为什么：colorkey 是在 **YUV 空间按欧氏距离**判定的。父包素材的绿幕是**亮纯绿**，
//   而这张定妆图的背景是 rgb(33,171,75)（暗且不饱和的绿），跟**黑发**在 YUV 里的距离很近。
//   实测（同一张图，只改阈值，量 640×360 首帧）：
//     sim 0.28 / blend 0.10（照抄父包）→ 不透明 23393、半透明 9498 → **28.9% 前景是半透明**
//        → 深色头发被判成半透明，浅色页面上看起来就是"黑发少女变成白发"（用户实际看到的 bug）
//     sim 0.12 / blend 0.02           → 不透明 36897、半透明  474 →  1.3%（与父包成品 3.0% 同档）
//   chromakey 不能用来替代：实测 sim 0.30 就把整个人抠没了（它只比色度，阈值尺度完全不同）。
//   父包成品对照：同带 42996 不透明 / 1351 半透明 = 3.0%。
const SIM = Number(val('--similarity', '0.12'));
const BLEND = Number(val('--blend', '0.02'));
const CRF = Number(val('--crf', '12'));
/** 质量闸门：前景里半透明像素占比超过这个百分比就判失败（默认 8%）。 */
const MAX_SEMI_PCT = Number(val('--max-semi-pct', '8'));
const FORCE = has('--force');
const INSTALL = has('--install');
const NO_MOTION = has('--no-motion');
const PROBE_ONLY = has('--probe-only');
const DESPILL = !has('--no-despill');
const DRY = has('--dry');

// 用户素材目录：$DSH_HOME/dsh-yingnan/main-animation/webm
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const USER_WEBM = path.join(DSH_HOME, 'dsh-yingnan', 'main-animation', 'webm');
const PKG_WEBM = path.join(ROOT, 'assets', 'webm');

// ---------------------------------------------------------------- 小工具
const hex = (r, g, b) => '0x' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

function dumpRgba(file) {
  const raw = path.join(os.tmpdir(), `placeholder-${process.pid}-${crypto.randomBytes(4).toString('hex')}.raw`);
  const r = runFfmpeg(['-hide_banner', '-y', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { capture: true });
  if (!fs.existsSync(raw)) throw new Error(`ffmpeg 没能导出像素：${r.log.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return buf;
}

/**
 * 抠像质量实测（**这是本脚本唯一能挡住"黑发变白发"的闸门**）。
 *
 * 为什么不能只看 probeAlphaPixels 的 min/max：那只能证明"有全透明也有全不透明"，
 * 上一版就是靠它判 ✅ 的，而当时 28.9% 的前景（主要是头发）其实只有 alpha≈128 ——
 * 在浅色页面上就是一头白发。所以这里必须**数半透明像素的比例**。
 *
 * 区域口径：主体带 = 放置位置外扩 3px（x ∈ [OX-3, OX+SW+3]，y ≥ OY-3）；
 *   带内 = 前景（不透明 + 半透明），带外 = 必须是背景（残留必须为 0）。
 */
function probeMatte(file, ox, oy, sw, subjH) {
  const px = dumpRgbaWebm(file);
  if (!px) return null;
  const hasBand = Number.isFinite(ox);
  const bandX0 = hasBand ? Math.max(0, ox - 3) : 0;
  const bandX1 = hasBand ? Math.min(CANVAS_W - 1, ox + sw + 3) : CANVAS_W - 1;
  const bandY0 = hasBand ? Math.max(0, oy - 3) : 0;
  let solid = 0, semi = 0, clearIn = 0, residue = 0;
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const a = px[(y * CANVAS_W + x) * 4 + 3];
      const inBand = x >= bandX0 && x <= bandX1 && y >= bandY0;
      if (inBand) {
        if (a >= 248) solid++;
        else if (a > 8) semi++;
        else clearIn++;
      } else if (a > 8) residue++;
    }
  }
  const fg = solid + semi;
  return { solid, semi, clearIn, residue: hasBand ? residue : null, semiPct: fg ? (semi / fg) * 100 : 100 };
}

function dumpRgbaWebm(file) {
  const raw = path.join(os.tmpdir(), `matte-${process.pid}-${crypto.randomBytes(4).toString('hex')}.raw`);
  const r = runFfmpeg(['-hide_banner', '-y', '-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { capture: true });
  if (!fs.existsSync(raw)) return null;
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return buf.length >= CANVAS_W * CANVAS_H * 4 ? buf : null;
}

/**
 * 找生成器水印：右下角那块「亮、几乎无彩」的文字（豆包/即梦都印在右下角）。
 *
 * 为什么不能简单按「主体包围盒右侧」找：包围盒是**整张图**的并集，衣摆甩到最右边那一行
 * 会把 right 撑到 1623，而水印所在的行（y≈2441..2501）主体其实只到 x≈1300 ——
 * 用整图 right 去卡，正好把水印整块排除掉（实测踩到）。
 * 所以改成**逐行**：从右往左取第一段「非背景」像素，它右边没有别的东西，
 * 就是水印这一行的笔画；再用「亮 + 低饱和」确认是浅色文字而不是脚下的绿影。
 */
function findWatermark(px, W, H, bg) {
  const y0 = Math.floor(H * 0.88);
  const bgLike = (i) => {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
    if (dr * dr + dg * dg + db * db <= 85 * 85) return true;   // 采样到的背景色附近
    // 绿幕兜底。⚠ 必须带 `r < 110`：豆包那行水印是**淡青绿**（实测 rgb(150,217,167)），
    // 它满足 g-r>45 且 g-b>45，不加红色约束就会被当成"背景"整行跳过（实测踩到）。
    return g > 110 && g - r > 45 && g - b > 45 && r < 110;
  };
  let left = W, top = H, right = -1, bottom = -1, n = 0, rows = 0;
  for (let y = y0; y < H; y++) {
    // ⚠ 必须把**这一行所有的** run 都过一遍，不能只看最右边那一段：
    //   水印是「豆包 AI 生成」六个字形，字间有绿缝，最右边那一段永远只是最后一笔
    //   （实测只看最右段 → 检测框缩到 x1615..1656，左边五个字一个都没盖住）。
    let x = W - 1;
    while (x >= 0) {
      while (x >= 0 && bgLike((y * W + x) * 4)) x--;
      if (x < 0) break;
      const runRight = x;
      while (x >= 0 && !bgLike((y * W + x) * 4)) x--;
      const runLeft = x + 1;
      const w = runRight - runLeft + 1;
      // 太宽 → 主体/衣摆。衣摆同样是「亮 + 低饱和」，光靠颜色分不开，只能用宽度和位置分。
      if (w > W * 0.2) continue;
      // 水印永远印在最右下角：runLeft 落在右 20% 以外的一律不算（衣摆的细边会落在那儿）
      if (runLeft < W * 0.8) continue;
      let bright = 0;
      for (let xx = runLeft; xx <= runRight; xx++) {
        const i = (y * W + xx) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum > 150 && sat < 90) bright++;                    // 淡青绿文字：lum≈199 / sat≈67
      }
      if (bright < w * 0.3) continue;                           // 脚下那团绿影：够亮但饱和度高
      rows++; n += bright;
      if (runLeft < left) left = runLeft;
      if (runRight > right) right = runRight;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (n < 60 || right < 0) return null;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1, pixels: n, rows };
}

// ---------------------------------------------------------------- 主流程
const names = (() => {
  const picked = val('--names', null);
  if (picked) return picked.split(',').map((s) => s.trim()).filter(Boolean);
  return configActionNames(CONFIG_FILE);
})();

console.log('== dsh-yingnan 占位素材 ==');
console.log(`ffmpeg   : ${findFfmpeg()}`);
const cap = ffmpegCapabilities();
console.log(`能力     : libvpx-vp9 编码=${cap.encVp9 ? '✅' : '❌'} 解码=${cap.decVp9 ? '✅' : '❌'} colorkey=${cap.filterColorkey ? '✅' : '❌'} despill=${cap.filterDespill ? '✅' : '❌'}`);
if (!cap.ok) {
  console.error('❌ 这个 ffmpeg 编不出带 alpha 的 webm（缺 libvpx-vp9 / colorkey）。');
  console.error('   本机已知坑：火绒给 Desktop\\1\\...\\ffmpeg-static\\ffmpeg.exe 下过只许写 Desktop\\1 的规则；');
  console.error('   把同一份 ffmpeg 复制到工作区，再设 $env:FFMPEG 指过去即可。');
  process.exit(1);
}
console.log(`动作数   : ${names.length}`);
console.log(`输出     : ${OUT_DIR}`);
console.log(`装包目标 : ${USER_WEBM}`);
console.log('');

if (PROBE_ONLY) {
  let bad = 0;
  for (const n of names) {
    const f = path.join(OUT_DIR, `${n}.webm`);
    if (!fs.existsSync(f)) { console.log(`  ✗ ${n.padEnd(24)} 缺文件`); bad++; continue; }
    const info = probeInfo(f);
    const a = probeAlphaPixels(f);
    const fr = probeFringe(f);
    const m = probeMatte(f, NaN);
    const reasons = [];
    if (info.w !== CANVAS_W || info.h !== CANVAS_H) reasons.push(`尺寸 ${info.w}x${info.h}`);
    if (!a || !a.has0 || !a.has255) reasons.push('alpha 不完整');
    if (m && m.semiPct > MAX_SEMI_PCT) reasons.push(`前景半透明 ${m.semiPct.toFixed(1)}% > ${MAX_SEMI_PCT}%`);
    if (m && m.solid + m.semi < CANVAS_W * CANVAS_H * 0.02) reasons.push('前景太少');
    if ((fr?.fringe ?? 0) > 0) reasons.push(`绿边 ${fr.fringe}px`);
    const ok = reasons.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} ${n.padEnd(24)} ${info.w}x${info.h} ${info.sec}s  前景 不透明 ${m?.solid ?? '?'} / 半透明 ${m?.semi ?? '?'}（${m ? m.semiPct.toFixed(1) : '?'}%） 绿边=${fr?.fringe ?? '?'}px${ok ? '' : '  ← ' + reasons.join('；')}`);
  }
  console.log(bad === 0 ? '\n全部合格。' : `\n${bad} 段不合格。`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!fs.existsSync(REF)) {
  console.error(`❌ 定妆图不存在：${REF}`);
  process.exit(1);
}

// ① 量主体（复用父包工具，口径一致）
const m = measure(REF);
const subj = { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
const bg = m.bgColor ?? [0, 255, 0];
console.log(`定妆图   : ${REF}`);
console.log(`画布     : ${m.W}x${m.H}  背景色 rgb(${bg.join(',')})`);
console.log(`主体     : x ${subj.left}..${subj.right}  y ${subj.top}..${subj.bottom}  (${m.bbox.w}×${m.bbox.h})`);
console.log(`头身比   : 身高/头宽 = ${m.ratio_height_over_headW}  ${m.ratio_height_over_headW <= 2.1 ? '✅ 过闸门' : '❌ 未过闸门（≤2.1）'}`);

// ② 找水印
const px = dumpRgba(REF);
const wm = findWatermark(px, m.W, m.H, bg);
if (wm) console.log(`水印     : x ${wm.x}..${wm.x + wm.w - 1}  y ${wm.y}..${wm.y + wm.h - 1}（${wm.pixels} px）→ 会被盖成背景色`);
else console.log('水印     : 没找到（若画面里有生成器水印，用 --mask 手填）');

// ③ 裁主体 + 盖水印（盖水印必须在缩放前、坐标是原图像素 —— 与 keyscreen 同一口径）
const CW = subj.right - subj.left + 1;
const CH = subj.bottom - subj.top + 1;
const SW = Math.max(2, Math.round((CW / CH) * SUBJ_H / 2) * 2);   // 偶数宽（VP9 要求）
const OX = Math.round((CANVAS_W - SW) / 2);
const OY = CANVAS_H - SUBJ_BOTTOM_GAP - SUBJ_H;

const boxes = [];
if (wm) {
  const pad = 12;
  const bx = Math.max(0, wm.x - pad - subj.left);
  const by = Math.max(0, wm.y - pad - subj.top);
  boxes.push({ x: bx, y: by, w: CW - bx, h: Math.min(CH - by, wm.h + pad * 2) });
}
const extra = val('--mask', null);
if (extra) for (const spec of extra.split(';')) {
  const [x, y, w, h] = spec.split(',').map(Number);
  boxes.push({ x: x - subj.left, y: y - subj.top, w, h });
}

console.log(`放置     : 主体 ${SW}×${SUBJ_H} @ (${OX},${OY})  —— 画布 ${CANVAS_W}×${CANVAS_H}（父包口径：高 ${SUBJ_H}、底边距 ${SUBJ_BOTTOM_GAP}、水平居中）`);
console.log(`抠像     : colorkey ${hex(...bg)} sim=${SIM} blend=${BLEND}${DESPILL ? ' + despill' : ''}`);
console.log('');

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (let idx = 0; idx < names.length; idx++) {
  const name = names[idx];
  const target = path.join(OUT_DIR, `${name}.webm`);
  if (fs.existsSync(target) && !FORCE) {
    console.log(`- ${name}：已存在，跳过（--force 可重做）`);
    results.push({ name, ok: true, skipped: true });
    continue;
  }

  // 每段一点不同的浮动：周期 2.0~3.0s，时长 = 周期的整数倍（无缝循环）
  const period = NO_MOTION ? 0 : 2 + (idx % 5) * 0.25;
  const amp = NO_MOTION ? 0 : 2 + (idx % 3);
  const dur = period === 0 ? DUR_BASE : Math.max(DUR_BASE, Math.round(period * 2 * 10) / 10);

  const vf = [`crop=${CW}:${CH}:${subj.left}:${subj.top}`];
  for (const b of boxes) vf.push(`drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${hex(...bg)}@1:t=fill`);
  vf.push(`scale=${SW}:-2:flags=lanczos`);
  // 浮动做法：先 pad 出一块比画布高的绿底画布（绿底等下会被抠掉），再用 crop 的**逐帧**
  // y 表达式在竖直方向滑动 —— 这样连颜色空间都不用换，alpha 全程不丢。
  // （不能用 overlay + format=rgba：ffmpeg 6.1 的 overlay 不接受 rgba 这个 format 值，
  //   实测报 "Unable to parse option value rgba"。）
  const padH = CANVAS_H + amp * 2;
  vf.push(`pad=${CANVAS_W}:${padH}:${OX}:${OY + amp}:color=${hex(...bg)}`);
  if (amp > 0) vf.push(`crop=${CANVAS_W}:${CANVAS_H}:0:'${amp}+${amp}*sin(2*PI*t/${period})'`);
  vf.push(`colorkey=${hex(...bg)}:${SIM}:${BLEND}`);
  if (DESPILL) vf.push('despill=type=green');
  vf.push('format=yuva420p');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', '24', '-i', REF,
    '-vf', vf.join(','),
    '-t', String(dur),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-crf', String(CRF), '-b:v', '0',
    '-auto-alt-ref', '0',        // 必须 0：开 alt-ref 会把 alpha 吃掉
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
    '-an', target,
  ];

  if (DRY) { console.log(`- ${name}：--dry，命令已生成（未执行）`); results.push({ name, ok: true, dry: true }); continue; }

  process.stdout.write(`- ${name}：转码中… `);
  const r = runFfmpeg(args, { capture: true });
  if (r.status !== 0 || !fs.existsSync(target)) {
    console.log('失败');
    console.log('    ' + r.log.split('\n').filter(Boolean).slice(-4).join('\n    '));
    results.push({ name, ok: false });
    continue;
  }
  const a = probeAlphaPixels(target);
  const fr = probeFringe(target);
  const m = probeMatte(target, OX, OY, SW, SUBJ_H);
  const reasons = [];
  if (!a || !a.has0 || !a.has255) reasons.push('alpha 不是"既有全透明又有全不透明"');
  if (!m) reasons.push('解不出帧');
  else {
    if (m.semiPct > MAX_SEMI_PCT) reasons.push(`前景半透明 ${m.semiPct.toFixed(1)}% > ${MAX_SEMI_PCT}%（头发/深色部分会被抠成半透明 → 浅色页面上看着像白发）`);
    if (m.residue > 0) reasons.push(`背景残留 ${m.residue} px（阈值太松）`);
    if (m.solid + m.semi < CANVAS_W * CANVAS_H * 0.02) reasons.push(`前景太少（${m.solid + m.semi} px，可能整个人被抠没了）`);
  }
  if ((fr?.fringe ?? 0) > 0) reasons.push(`绿边残留 ${fr.fringe} px`);
  const ok = reasons.length === 0;
  console.log(`${(fs.statSync(target).size / 1024).toFixed(0)} KB  前景 不透明 ${m?.solid ?? '?'} / 半透明 ${m?.semi ?? '?'}（${m ? m.semiPct.toFixed(1) : '?'}%）  残留 ${m?.residue ?? '?'}  绿边 ${fr?.fringe ?? '?'}px  ${ok ? '✅' : '❌ ' + reasons.join('；')}`);
  results.push({ name, ok, reasons });
}

const bad = results.filter((r) => !r.ok);
console.log('');
console.log(`完成：${results.length - bad.length}/${results.length} 段${bad.length ? `，失败 ${bad.map((b) => b.name).join(' / ')}` : ''}`);

if (INSTALL && !DRY) {
  console.log('');
  for (const dir of [USER_WEBM, PKG_WEBM]) {
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const r of results) {
      if (!r.ok) continue;
      const src = path.join(OUT_DIR, `${r.name}.webm`);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(dir, `${r.name}.webm`));
      n++;
    }
    console.log(`装包：${dir}  ← ${n} 段`);
  }
  console.log('\n提示：素材路由带 cache-control max-age=3600，但客户端已给 URL 加时间戳 —— 刷新页面即可看到。');
}
