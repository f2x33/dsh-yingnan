// 菜单逻辑单测：把 client.js 里的 buildMenuTree / buildGroupNodes / leaf / EVENT_LABELS
// 抽出来在 Node 里跑一遍，用真实配置验证紧凑菜单确实只列 10 项 + 一个「更多」兜底。
import fs from 'node:fs';

const SRC = fs.readFileSync('lib/client.js', 'utf8');

/** 用花括号配平从源码里抽一个函数/常量的定义 */
function extract(startMarker) {
  const i = SRC.indexOf(startMarker);
  if (i < 0) throw new Error(`抽不到：${startMarker}`);
  // 函数：抽到配平的右花括号；常量/箭头函数：抽到该语句的 `;`
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

const parts = [
  extract('const EVENT_LABELS = '),
  extract('const leaf = '),
  extract('function buildMenuTree('),
  extract('function buildGroupNodes('),
];
const factory = new Function(`${parts.join('\n')}\nreturn { buildMenuTree, buildGroupNodes };`);
const { buildMenuTree } = factory();

// 真实配置（JSONC → JSON：逐字符处理，避免把字符串里的 // 也当注释）
function stripJsonc(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');   // 去掉尾逗号
}
const cfg = JSON.parse(stripJsonc(fs.readFileSync('assets/config.jsonc', 'utf8')));
const anims = (cfg.main ?? cfg).animations;   // 包内默认配置可能不带 main 外壳，两种都兼容

const tree = buildMenuTree(anims);
console.log('=== 紧凑菜单（animations.menu.flat 生效时）===');
if (tree.length !== 1 || tree[0].label !== '动作') throw new Error('顶层结构不对');
const top = tree[0].children;
top.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.label}${c.children ? `  →（${c.children.length} 项）` : ''}`));

const flatExpected = anims.menu.flat;
const leafLabels = top.filter((c) => !c.children).map((c) => c.label);
const more = top.find((c) => c.children);
let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

console.log('\n=== 断言 ===');
check(leafLabels.length === 10, `一级直接列出的动作恰好 10 个（实际 ${leafLabels.length}）`);
check(JSON.stringify(leafLabels) === JSON.stringify(flatExpected), '一级列出的就是 config 里 menu.flat 那 10 个、顺序一致');
check(!!more, '末尾挂了「更多」兜底子菜单');
check(more && more.children.length === (anims.idle.length ? 5 : 4) + anims.categories.length + Object.keys(anims.events).length - 1 + 1,
  `「更多」里是完整的分组结构（${more ? more.children.length : 0} 组）`);

// 兜底完整性：所有池子里的动作名，要么在一级、要么在「更多」里，一个都不能漏
const allPoolNames = new Set();
for (const k of ['idle', 'turn', 'drag', 'clicks']) for (const n of anims[k] ?? []) allPoolNames.add(n);
for (const a of anims.moves?.actions ?? []) allPoolNames.add(a.name);
for (const c of anims.categories ?? []) for (const n of c.actions) allPoolNames.add(n);
for (const pool of Object.values(anims.events ?? {})) for (const s of pool) Array.isArray(s) ? s.forEach((n) => allPoolNames.add(n)) : allPoolNames.add(s);

const reachable = new Set();
const walk = (nodes) => nodes.forEach((n) => { if (n.anim) reachable.add(n.anim); if (n.children) walk(n.children); });
walk(tree);
const lost = [...allPoolNames].filter((n) => !reachable.has(n));
check(lost.length === 0, `菜单里点得到全部 ${allPoolNames.size} 个动作名${lost.length ? `（漏了：${lost.join(', ')}）` : ''}`);

// 对照：不写 menu.flat 时的老行为（用来证明兼容）
const oldTree = buildMenuTree({ ...anims, menu: undefined });
const oldTop = oldTree[0].children;
check(oldTop.length > 10, `不写 menu.flat 时仍是老的分组行为（${oldTop.length} 组），向后兼容`);

console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 条断言失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
