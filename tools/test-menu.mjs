// 菜单逻辑单测：把 client.js 里的 buildMenuTree / buildGroupNodes / leaf / EVENT_LABELS
// 抽出来在 Node 里跑，用**真实配置**验证菜单契约。
// 契约演进过三版，这版是用户最终要的：
//   · 菜单**保持"按用途自动分组"**（待机/转向/拖拽/点击回应/移动 + 分类 + 事件池）
//   · 只把「剑舞 / 剑气 / 剑阵」这三个**"剑"开头的组并成一个「剑招」**
//   · 分组数因此从 12 变 10（用户最早说的"10 个就好了"）
import fs from 'node:fs';

const SRC = fs.readFileSync('lib/client.js', 'utf8');
function extract(startMarker) {
  const i = SRC.indexOf(startMarker);
  if (i < 0) throw new Error(`抽不到：${startMarker}`);
  if (!startMarker.startsWith('function ')) {
    const end = SRC.indexOf('\n', SRC.indexOf(';', i));
    return SRC.slice(i, end < 0 ? SRC.length : end);
  }
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error(`配平失败：${startMarker}`);
}
const factory = new Function([
  extract('const EVENT_LABELS = '),
  extract('const leaf = '),
  extract('function buildMenuTree('),
  extract('function buildGroupNodes('),
].join('\n') + '\nreturn { buildMenuTree, buildGroupNodes };');
const { buildMenuTree } = factory();

function stripJsonc(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
const cfg = JSON.parse(stripJsonc(fs.readFileSync('assets/config.jsonc', 'utf8')));
const anims = (cfg.main ?? cfg).animations;
const menuCfg = anims.menu ?? {};
const merges = menuCfg.merge ?? [];

const top = buildMenuTree(anims)[0].children;
console.log('=== 菜单实际形状（一级分组） ===');
top.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.label.padEnd(10)} →（${c.children.length} 项：${c.children.map((x) => x.label).join(' / ')}）`));

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };
console.log('\n=== 断言 ===');

// ① 没用 flat 紧凑模式（菜单还是分组形态）
check(!Array.isArray(menuCfg.flat) || menuCfg.flat.length === 0, '菜单保持「按用途自动分组」形态（配置里没有 flat）');

// ② 合并生效：被并掉的组名一个都不剩，且只剩一个"剑"开头的组
const mergedAway = merges.flatMap((m) => m.groups ?? []);
check(mergedAway.length > 0, `配置里有合并规则：${merges.map((m) => `${(m.groups ?? []).join('+')}→${m.label}`).join('；')}`);
const leftover = top.filter((g) => mergedAway.includes(g.label));
check(leftover.length === 0, `被并掉的组名不再单独出现${leftover.length ? `（还剩：${leftover.map((g) => g.label).join(', ')}）` : ''}`);

// ③ 合并后的组内容 = 被并各组内容之和（去重后按原分组顺序）
for (const m of merges) {
  const node = top.find((g) => g.label === m.label);
  check(!!node, `合并后的组「${m.label}」存在`);
  if (!node) continue;
  const expect = [];
  for (const src of m.groups ?? []) {
    const g = (anims.categories ?? []).find((c) => c.id === src);
    for (const n of g?.actions ?? []) if (!expect.includes(n)) expect.push(n);
  }
  const got = node.children.map((x) => x.label);
  check(JSON.stringify(got) === JSON.stringify(expect), `「${m.label}」= ${m.groups.join('+')} 的并集且顺序一致（${got.join(' / ')}）`);
}

// ④ 分组数正好是配置里"12 组并成 10 组"的预期
const catCount = (anims.categories ?? []).length;
const poolCount = ['idle', 'turn', 'drag', 'clicks'].filter((k) => (anims[k] ?? []).length).length
  + ((anims.moves?.actions ?? []).length ? 1 : 0);
const eventCount = Object.keys(anims.events ?? {}).filter((k) => {
  const p = anims.events[k] ?? [];
  return p.some((s) => (Array.isArray(s) ? s.length : s));
}).length;
const expectedGroups = poolCount + catCount + eventCount - merges.reduce((s, m) => s + Math.max(0, (m.groups ?? []).length - 1), 0);
check(top.length === expectedGroups, `一级分组数 = ${expectedGroups}（池 ${poolCount} + 分类 ${catCount} + 事件 ${eventCount} − 合并掉 ${expectedGroups - poolCount - catCount - eventCount < 0 ? merges.reduce((s, m) => s + Math.max(0, (m.groups ?? []).length - 1), 0) : 0}）`);

// ⑤ 合并组的位置：落在被并的第一个组原来的位置
const firstMerged = merges[0]?.groups?.[0];
if (firstMerged) {
  const poolIdx = ['idle', 'turn', 'drag', 'clicks'].filter((k) => (anims[k] ?? []).length).length + ((anims.moves?.actions ?? []).length ? 1 : 0);
  const catIdx = (anims.categories ?? []).findIndex((c) => c.id === firstMerged);
  const expectPos = poolIdx + catIdx;
  check(top[expectPos]?.label === merges[0].label, `「${merges[0].label}」落在原「${firstMerged}」的位置（第 ${expectPos + 1} 个）`);
}

// ⑥ 所有动作名仍然点得到（这版没有 hide，应该一个不少）
const allPoolNames = new Set();
for (const k of ['idle', 'turn', 'drag', 'clicks']) for (const n of anims[k] ?? []) allPoolNames.add(n);
for (const a of anims.moves?.actions ?? []) allPoolNames.add(a.name);
for (const c of anims.categories ?? []) for (const n of c.actions) allPoolNames.add(n);
for (const pool of Object.values(anims.events ?? {})) for (const s of pool) Array.isArray(s) ? s.forEach((n) => allPoolNames.add(n)) : allPoolNames.add(s);
const shown = new Set();
(function walk(nodes) { for (const n of nodes) { if (n.anim) shown.add(n.anim); if (n.children) walk(n.children); } })(top);
const hideList = menuCfg.hide ?? [];
const lost = [...allPoolNames].filter((n) => !shown.has(n) && !hideList.includes(n));
check(lost.length === 0, `配置引用的 ${allPoolNames.size} 个动作名全部点得到${lost.length ? `（漏了：${lost.join(', ')}）` : ''}`);

console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 条断言失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
