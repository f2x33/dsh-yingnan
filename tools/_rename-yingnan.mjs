// ============================================================================
// _rename-yingnan.mjs —— 命名空间迁移：dsh-redpet → dsh-yingnan（标识统一用 yingnan）
// ============================================================================
// 本包是 dsh-redpet（而 dsh-redpet 又是 dsh-pet 0.3.5 构建产物的分叉）的分叉。
// 一只宠物一个命名空间，所以要把**父包的标识**整族换成本包的：
//
//   ① dsh-redpet → dsh-yingnan   包名 / entry id / 模块 id / 路由前缀 / 用户数据目录 /
//                                CSS 变量 --dsh-redpet-size / dataset.plugin / 字体路由
//   ② redpet     → yingnan       命令名 /redpet、/redpet-balance、槽位键、locale 命名空间
//                                redpet.config、CSS 类名 redpet-bub-*
//   ③ redchat    → yingnanchat   命令名 /redchat
//
// 顺序不能变：`dsh-redpet` 里含 `redpet`，先做①才不会留下 `dsh-yingnan` 之外的残渣。
// `redchat` 与 `redpet` 无包含关系，但放在②之后便于逐条核对命中数。
//
// 【为什么必须有 PROTECT 保护表】
//   2026-10-05 上一次改名（tools/_rename2.mjs）把 tools/gh-publish.mjs 里的**发布目标
//   仓库名** `f2x33/redteam-pet` 一起改成了当时并不存在的 `f2x33/redpet`，整条发布链路
//   直接作废。事后做的"残留扫描"是**干净**的 —— 因为问题不是"改漏了"，而是"改多了"。
//   **残留扫描在原理上抓不出过度替换**，唯一有效的防线是替换前把不能碰的字符串摘出来。
//   所以：替换前把外部标识换成含 \u0000 的占位符，规则跑完再原样还原，并逐个校验数量
//   必须一字不差；不符就中止且一个文件都不写。
//
// 【再加外部标识时】往 PROTECT 里加一条，别指望残留扫描能发现。
//
// 用法：
//   node tools/_rename-yingnan.mjs --dry     # 只报告会改多少处，不落盘
//   node tools/_rename-yingnan.mjs           # 真正改名
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

/** 只处理文本文件；二进制（webm/png/ttf）直接跳过 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.jsonc', '.yml', '.yaml',
  '.md', '.html', '.css', '.ps1', '.cmd', '.bat', '.txt',
  '.gitignore', '.gitattributes',
]);

/** 相对路径排除表（前缀匹配） */
const SKIP = [
  'node_modules',
  '.git',
  'out',
  'tools/_rename-yingnan.mjs', // 本文件自身
];
const SKIP_PREFIXES = ['tools.bak-'];

const RULES = [
  { from: 'dsh-redpet', to: 'dsh-yingnan' },
  { from: 'redpet', to: 'yingnan' },
  { from: 'redchat', to: 'yingnanchat' },
];

// ============================================================================
// PROTECT —— 绝不能跟着改的「外部标识」
// ============================================================================
// 按长度降序处理，避免短串先替换破坏长串（f2x33/redteam-pet 是
// f2x33/redteam-pet-desktop 的前缀；f2x33/redpet 含 redpet，不加保护会被②吃掉）。
// ============================================================================
const PROTECT = [
  'f2x33/redteam-pet-desktop', // 姊妹项目 redteam-pet-desktop 的 GitHub 仓库
  'f2x33/redpet',              // 父包 dsh-redpet 的 GitHub 仓库（发布目标，本包不得冒用）
  'f2x33/redteam-pet',         // 父包的旧仓库名（历史记录里会提到，保住原样）
  'PC2005-cloud/dsh-pet',      // 上游 dsh-pet 仓库署名
].sort((a, b) => b.length - a.length);

const slot = (i) => `\u0000PROTECT${String(i)}\u0000`;
const protectAll = (text) => {
  let out = text;
  PROTECT.forEach((lit, i) => { out = out.split(lit).join(slot(i)); });
  return out;
};
const restoreAll = (text) => {
  let out = text;
  PROTECT.forEach((lit, i) => { out = out.split(slot(i)).join(lit); });
  return out;
};
const countAll = (text) => PROTECT.map((lit) => text.split(lit).length - 1);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SKIP.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (e.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || e.name.startsWith('.git')) out.push({ full, rel });
  }
  return out;
}

const files = walk(ROOT);
const totals = Object.fromEntries(RULES.map((r) => [r.from, 0]));
const protectTotals = PROTECT.map(() => 0);
const touched = [];
const pending = [];

for (const { full, rel } of files) {
  const before = fs.readFileSync(full, 'utf8');
  const beforeProtect = countAll(before);
  beforeProtect.forEach((n, i) => { protectTotals[i] += n; });

  // ① 先把受保护的字符串摘出来，② 再跑替换规则，③ 最后原样还原
  let after = protectAll(before);
  const hits = {};
  for (const { from, to } of RULES) {
    const n = after.split(from).length - 1;
    if (n > 0) {
      hits[from] = n;
      totals[from] += n;
      after = after.split(from).join(to);
    }
  }
  after = restoreAll(after);

  // ④ 守门：受保护字符串的数量必须一字不差
  const afterProtect = countAll(after);
  const drift = PROTECT.map((lit, i) => ({ lit, was: beforeProtect[i], now: afterProtect[i] })).filter((d) => d.was !== d.now);

  if (Object.keys(hits).length === 0 && drift.length === 0) continue;
  if (drift.length > 0) {
    console.error(`❌ ${rel}: 受保护字符串数量变了！（保护表失效，已中止，未写入任何文件）`);
    for (const d of drift) console.error(`     ${d.lit}: ${d.was} → ${d.now}`);
    process.exit(1);
  }
  touched.push({ rel, hits });
  pending.push({ full, after });
}

// 全部校验通过后才落盘
if (!DRY) for (const { full, after } of pending) fs.writeFileSync(full, after, 'utf8');

touched.sort((a, b) => {
  const sa = Object.values(a.hits).reduce((x, y) => x + y, 0);
  const sb = Object.values(b.hits).reduce((x, y) => x + y, 0);
  return sb - sa;
});

console.log(DRY ? '== 试运行（未落盘）==' : '== 已改名 ==');
for (const { rel, hits } of touched) {
  const desc = Object.entries(hits).map(([k, v]) => `${k}×${v}`).join('  ');
  console.log(`  ${String(Object.values(hits).reduce((x, y) => x + y, 0)).padStart(4)} 处  ${rel.padEnd(48)} ${desc}`);
}
console.log('\n合计：');
for (const { from, to } of RULES) console.log(`  ${from} → ${to}：${totals[from]} 处`);
console.log(`  涉及文件：${touched.length} 个`);

console.log('\n外部标识保护表（这些一处都没动）：');
PROTECT.forEach((lit, i) => console.log(`  ${protectTotals[i] > 0 ? '✅' : '·'} ${lit.padEnd(30)} 共 ${protectTotals[i]} 处`));

if (DRY) console.log('\n（--dry：没有写任何文件）');
