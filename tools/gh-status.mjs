// ============================================================================
// gh-status.mjs —— 远端仓库体检（只读，不改任何东西）
// ============================================================================
// 为什么需要它：发布是"绕过 DNS 直连 GitHub API"的，命令行 `git`/浏览器都不方便核对，
//   于是每次发完都得手写一段脚本去读远端。这个工具把那些检查固化下来：
//     ① 仓库在不在（还没建 / 建了但没提交）
//     ② 远端文件树 vs 本地 out/_gh-files.txt 清单：是否**严格一致**（多/少都报出来）
//        —— 这一条专门用来抓「base_tree 是合并语义、删掉的文件不会从远端消失」那个坑
//     ③ 最近几条提交、默认分支、可见性
//
// 用法：
//   $env:GH_TOKEN = "github_pat_xxx"
//   node tools\gh-status.mjs                          # 体检默认仓库（f2x33/dsh-yingnan）
//   node tools\gh-status.mjs --repo f2x33/yingnan-pet-desktop
//   node tools\gh-status.mjs --repo f2x33/yingnan-pet-desktop --list ../yingnan-pet-desktop/out/_gh-files.txt
//
// 环境变量：GH_TOKEN（必填，Contents 只读就够）、GH_IP（可选，指定 api.github.com 真实 IP）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TOKEN = process.env.GH_TOKEN || '';
const REPO = argOf('--repo', process.env.GH_REPO || 'f2x33/dsh-yingnan');
const LIST = path.resolve(ROOT, argOf('--list', 'out/_gh-files.txt'));
const IP_CANDIDATES = (process.env.GH_IP ? [process.env.GH_IP] : ['140.82.121.6', '140.82.121.5', '140.82.113.6']);

let GOOD = null;
function request(method, apiPath, ip) {
  return new Promise((resolve) => {
    const r = https.request({
      method, host: 'api.github.com', path: apiPath, servername: 'api.github.com',
      lookup: (h, o, cb) => (o && o.all) ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4),
      headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'gh-status', Accept: 'application/vnd.github+json' },
    }, (res) => {
      // ⚠ 必须先把 Buffer 收齐再一次性按 UTF-8 解码。
      // 踩过：写成 `let d=''; res.on('data', c => d += c)` 时，每个 chunk 会各自 toString()，
      // 一旦**多字节 UTF-8 字符被切在 chunk 边界上**就会被解成替换字符 —— 于是中文文件名
      // 会假报"远端与本地不一致"（实测 `assets/webm/御剑飞行.webm` 就被误报过，
      // 追了半天发现码点完全相同，纯粹是这里解码坏了）。
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: `${e.code ?? e.name}` }));
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
async function api(method, apiPath) {
  if (GOOD) return request(method, apiPath, GOOD);
  for (const ip of IP_CANDIDATES) {
    const r = await request(method, apiPath, ip);
    if (r.status > 0) { GOOD = ip; return r; }
  }
  throw new Error(`连不上 api.github.com（试过 ${IP_CANDIDATES.join(', ')}）`);
}

if (!TOKEN) { console.error('缺 GH_TOKEN。用法：$env:GH_TOKEN="github_pat_xxx"; node tools\\gh-status.mjs --repo owner/name'); process.exit(1); }

console.log(`\n=== gh-status · ${REPO} ===`);
const repo = await api('GET', `/repos/${REPO}`);
if (repo.status === 404) {
  console.log('仓库       : ✗ 不存在（404）—— 先去 GitHub 网页建一个空仓库（勾 Add a README 最省事）');
  process.exit(2);
}
if (repo.status !== 200) { console.error(`读仓库失败 HTTP ${repo.status}：${repo.json?.message ?? ''}`); process.exit(1); }

const j = repo.json;
console.log(`仓库       : ${j.full_name} | ${j.private ? 'private' : 'public'} | 默认分支 ${j.default_branch} | push权限=${j.permissions?.push === true}`);
console.log(`描述       : ${j.description ?? '（无）'}`);
console.log(`推送时间   : ${j.pushed_at}`);

const commits = await api('GET', `/repos/${REPO}/commits?per_page=5`);
const list = commits.json ?? [];
console.log(`提交数(近) : ${list.length}`);
for (const c of list) console.log(`   ${c.sha.slice(0, 7)}  ${c.commit.message.split('\n')[0]}`);

const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${j.default_branch}`);
if (ref.status !== 200) { console.log('分支       : ✗ 还没有任何提交（空仓库，Git Data API 会 409）'); process.exit(3); }
const tree = await api('GET', `/repos/${REPO}/git/trees/${ref.json.object.sha}?recursive=1`);
const remote = (tree.json?.tree ?? []).filter((n) => n.type === 'blob').map((n) => n.path);
const remoteBytes = (tree.json?.tree ?? []).filter((n) => n.type === 'blob').reduce((s, n) => s + (n.size ?? 0), 0);
console.log(`远端文件   : ${remote.length} 个 / ${(remoteBytes / 1048576).toFixed(1)} MB`);

if (!fs.existsSync(LIST)) {
  console.log(`本地清单   : （没有 ${path.relative(ROOT, LIST)}，跳过一致性比对）`);
  console.log(`             生成：git -c core.quotepath=false ls-files > out/_gh-files.txt（注意要 UTF-8 无 BOM）`);
} else {
  const local = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const onlyLocal = local.filter((p) => !remote.includes(p));
  const onlyRemote = remote.filter((p) => !local.includes(p));
  console.log(`本地清单   : ${local.length} 个`);
  if (!onlyLocal.length && !onlyRemote.length) console.log('一致性     : ✅ 严格一致（远端 = 清单）');
  else {
    console.log('一致性     : ❌ 不一致');
    if (onlyLocal.length) console.log(`   本地有、远端没有（漏发 ${onlyLocal.length}）：${onlyLocal.slice(0, 5).join(' , ')}${onlyLocal.length > 5 ? ' …' : ''}`);
    if (onlyRemote.length) console.log(`   远端有、本地没有（残留 ${onlyRemote.length}）：${onlyRemote.slice(0, 5).join(' , ')}${onlyRemote.length > 5 ? ' …' : ''}`);
    if (onlyRemote.length) console.log('   → 清残留要整棵树替换：gh-publish.mjs --full（base_tree 是合并语义，删文件不会自己消失）');
  }
}
console.log('');
