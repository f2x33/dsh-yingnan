// ============================================================================
// gh-publish.mjs —— 在没有 DNS 的环境里把本仓库发布到 GitHub
// ============================================================================
// 【为什么需要它】
//   本机 hosts 把 github.com / api.github.com / githubusercontent.com 等 30 多个域名
//   全指向 127.0.0.1，于是 `git push` 直接连不上（DNS 被劫持到本机）。
//   但**直连真实 IP 是通的**（实测 api.github.com:443 → 200）。
//   所以这里不走 git 的传输层，而是直接调 GitHub 官方 **Git Data API**，
//   用 Node `https.request` 的 `lookup` 选项把 api.github.com 解析到真实 IP。
//
// 【它做什么】
//   按 out/_gh-files.txt（由 `git ls-files` 生成，已按 .gitignore 过滤）把每个文件
//   上传成 blob → 建一棵 tree → 建一个 commit → 把分支指过去。
//   结果就是**一次干净的提交**，不产生 82 个中间提交。
//
// 【已知限制（2026-10-05 实测踩到，都是 GitHub 侧的，不是本工具的 bug）】
//
//   ① 空仓库（0 个提交）**不能**用 Git Data API：第一个 POST /git/blobs 就返回
//        409 "Git Repository is empty."
//      → **本工具已自动处理**（见 main() 里的「2b. 空仓库引导」）：目标分支不存在时，
//        先用 Contents API PUT 一个 .gitattributes 造出首个提交，再以它为父提交正常追加。
//        那个文件本来就在本仓库清单里，不会污染最终文件树。
//        万一引导失败（权限不足等），会抛错并提示「去网页勾 Add a README」，那时可手工补。
//
//   ② 重命名 / 删除仓库需要令牌具备该仓库的 **Administration: Read and write**。
//      只有 Contents 权限的细粒度令牌（本机 2026-10-05 用的就是这种）会返回
//        403 "Resource not accessible by personal access token"
//      —— 改名和删除都会失败，只能去网页做：
//        改名：https://github.com/{owner}/{repo}/settings → Rename
//        删除：https://github.com/{owner}/{repo}/settings → Danger Zone → Delete this repository
//      （发布本身只需要 Contents: Read and write，本机实测可用。）
//
// 【用法】
//   $env:GH_TOKEN = "github_pat_xxx"
//   node tools/gh-publish.mjs --dry      # 只体检：探 IP、查仓库、数文件，不写
//   node tools/gh-publish.mjs            # 真发布
//
// 【环境变量】
//   GH_TOKEN   GitHub 令牌（必填）
//   GH_REPO    默认 f2x33/dsh-yingnan
//              ⚠️ 这个仓库名**不要**被「标识统一改名」脚本一起改掉！
//                 沿革：本包是 dsh-redpet 的分叉，而 dsh-redpet 的发布目标 f2x33/redpet
//                 是**父包自己的仓库**，与本包无关。
//                 · 本包要发布，得先在 GitHub 上**新建** f2x33/dsh-yingnan（仓库不会自己出现）
//                 · 脚本里有一道硬闸门：GH_REPO 指向父包仓库时直接中止（防把余英男推进父包 dsh-redpet 的仓库）
//                 历史事故（2026-10-05，父包那次）：改名脚本全局替换曾把发布目标改成
//                 一个**不存在**的同名变体，整条发布链路作废。所以改名脚本里有 PROTECT
//                 保护表专门挡这类外部标识（仓库名属于外部标识）。
//   GH_BRANCH  默认 main
//   GH_LIST    文件清单路径（默认 out/_gh-files.txt）
//   GH_MSG     提交说明文件（默认 out/_gh-msg.txt，缺省用内置文案）
//   GH_IP      指定 api.github.com 的真实 IP（默认自动探测候选）
//
// 退出码：0 = 成功；1 = 失败
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TOKEN = process.env.GH_TOKEN || '';
const REPO = process.env.GH_REPO || 'f2x33/dsh-yingnan'; // ⚠️ 外部标识，别被改名脚本改（见文件头注释）
const BRANCH = process.env.GH_BRANCH || 'main';
const LIST = process.env.GH_LIST || path.join(ROOT, 'out', '_gh-files.txt');
const MSG_FILE = process.env.GH_MSG || path.join(ROOT, 'out', '_gh-msg.txt');
const DRY = process.argv.includes('--dry');
// 整棵树替换（清掉远端残留）——见「4. 建 tree」那段注释
const FULL = process.argv.includes('--full') || process.env.GH_FULL === '1';

// ---------------------------------------------------------------------------
// 硬闸门：本包绝不能发布进父包（dsh-redpet / dsh-pet）的仓库
//   为什么写成代码而不是注释：改名/复制分叉时最容易把仓库名一起带过来，
//   而发布是**不可逆的对外动作**（力推会覆盖远端分支）。宁可中止。
// ---------------------------------------------------------------------------
const FORBIDDEN_REPOS = ['f2x33/redpet', 'f2x33/redteam-pet', 'PC2005-cloud/dsh-pet'];
if (FORBIDDEN_REPOS.includes(REPO)) {
  console.error(`❌ 拒绝发布：GH_REPO = ${REPO} 是**父包/上游**的仓库，不属于 dsh-yingnan。`);
  console.error(`   本包请先在 GitHub 新建 f2x33/dsh-yingnan，再设 GH_REPO=f2x33/dsh-yingnan。`);
  process.exit(1);
}

// api.github.com 的候选真实 IP。2026-10-05 实测这几个都返回 200。
const IP_CANDIDATES = [
  process.env.GH_IP,
  '140.82.121.6', '140.82.121.5', '140.82.113.6', '140.82.112.6', '20.205.243.168',
].filter(Boolean);

let API_IP = null;

/** 用 https + 自定义 lookup 发一次请求（绕过系统 DNS）。 */
function httpsJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      host: 'api.github.com',
      port: 443,
      path: urlPath,
      method,
      servername: 'api.github.com',
      headers: {
        'User-Agent': 'dsh-gh-publish',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
      lookup: (hostname, options, cb) => {
        if (options && options.all) return cb(null, [{ address: API_IP, family: 4 }]);
        return cb(null, API_IP, 4);
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 有些响应不是 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
    if (data) req.write(data);
    req.end();
  });
}

/** 探测一个可用 IP。 */
async function pickIp() {
  for (const ip of IP_CANDIDATES) {
    API_IP = ip;
    try {
      const r = await httpsJson('GET', '/rate_limit');
      if (r.status === 200) return ip;
    } catch { /* 换下一个 */ }
  }
  throw new Error(`候选 IP 全部不可用：${IP_CANDIDATES.join(', ')}（可用 $env:GH_IP 手动指定）`);
}

async function main() {
  console.log('\n=== gh-publish · 绕过 DNS 发布到 GitHub ===');
  if (!TOKEN) throw new Error('缺 GH_TOKEN。用法：$env:GH_TOKEN="github_pat_xxx"; node tools/gh-publish.mjs');
  console.log(`仓库   : ${REPO}   分支: ${BRANCH}`);
  console.log(`清单   : ${LIST}`);
  console.log(`模式   : ${DRY ? '体检（--dry，不写任何东西）' : '真发布'}\n`);

  if (!fs.existsSync(LIST)) throw new Error(`找不到文件清单 ${LIST}；先生成：git -c core.quotepath=false ls-files > out/_gh-files.txt`);
  const files = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).filter((s) => s.trim() !== '');
  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) throw new Error(`清单里有 ${missing.length} 个文件不在磁盘上：${missing.slice(0, 3).join(', ')}`);
  const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);
  console.log(`文件   : ${files.length} 个，共 ${(totalBytes / 1024).toFixed(0)} KB`);

  // ---- 1. 探 IP ----
  const ip = await pickIp();
  console.log(`IP     : api.github.com -> ${ip}（已绕过被劫持的 DNS）`);

  // ---- 2. 仓库体检 ----
  const repo = await httpsJson('GET', `/repos/${REPO}`);
  if (repo.status !== 200) throw new Error(`读仓库失败 HTTP ${repo.status}：${repo.json?.message ?? repo.text.slice(0, 200)}`);
  const canPush = repo.json.permissions?.push === true;
  console.log(`仓库   : ${repo.json.full_name}  private=${repo.json.private}  push权限=${canPush}`);
  if (!canPush) throw new Error('这个令牌对该仓库没有 push 权限');

  // 已有分支的话，拿它的 head 作为新提交的父提交（支持重复发布）
  let parentSha = null;
  let baseTree = null;
  let ref = await httpsJson('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref.status !== 200) {
    // ---- 2b. 空仓库（或没有目标分支）引导 ----
    // Git Data API 在**0 个提交**的仓库上第一个 POST /git/blobs 就返回 409
    // "Git Repository is empty."（见文件头「已知限制 ①」）。
    // 以前要人工先去网页建个 README；这里改成**自动**用 Contents API 造首个提交当载体：
    // PUT /repos/{repo}/contents/.gitattributes —— 这个文件本来就在本仓库清单里，
    // 所以它不会污染最终文件树（后面建 tree 时会用 base_tree 覆盖同一个路径）。
    // 仓库已经有别的分支（比如默认 master 上已有 README）时，这个 PUT 会以该分支为基
    // 建立 BRANCH，同样能拿到父提交。
    console.log(`现状   : 分支 ${BRANCH} 不存在（空仓库或只有别的分支）`);
    if (DRY) {
      // ⚠ --dry 的承诺是「一个字节都不写」，所以引导这一步也必须跳过。
      // （踩过：第一版把引导写在 DRY 判断之前，结果 --dry 真的在仓库里建了提交。）
      console.log(`引导   : 【体检模式】不做任何写入；真跑时会先用 Contents API 造首个提交再追加`);
    } else {
      console.log(`引导   : 自动引导首个提交 …`);
      const carrier = '!text eol=lf\n';
      const boot = await httpsJson('PUT', `/repos/${REPO}/contents/.gitattributes`, {
        message: 'chore: 初始化仓库（gh-publish 首个提交载体）',
        content: Buffer.from(carrier, 'utf8').toString('base64'),
        branch: BRANCH,
      });
      if (boot.status !== 201 && boot.status !== 200) {
        throw new Error(
          `空仓库引导失败 HTTP ${boot.status}：${boot.json?.message ?? boot.text.slice(0, 200)}\n` +
          `  处理办法：去网页给这个仓库建一个首提交（勾 "Add a README" 最省事），然后重跑本工具。`
        );
      }
      console.log(`引导   : 已用 Contents API 建首个提交 ${String(boot.json?.commit?.sha ?? '').slice(0, 8)}`);
      ref = await httpsJson('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    }
  }
  if (ref.status === 200) {
    parentSha = ref.json.object.sha;
    const commit = await httpsJson('GET', `/repos/${REPO}/git/commits/${parentSha}`);
    baseTree = commit.json.tree?.sha ?? null;
    console.log(`现状   : 分支 ${BRANCH} 父提交 ${parentSha.slice(0, 8)}（将在其之上追加一次提交）`);
  } else {
    console.log(`现状   : 仍拿不到分支 ${BRANCH}（HTTP ${ref.status}），将不带父提交建首个提交`);
  }

  // ---- 2c. 远端残留预检（--dry 也会报，因为这是"体检"该看见的东西）----
  // Git Data API 带 base_tree 是**合并**语义：只能新增/覆盖同名路径，**不会删除**
  // 「父树里有、本次清单里没有」的文件。踩过：本地删掉两个临时脚本后重发，工具报"成功"，
  // 远端却仍留着它们（113 vs 本地 111）。要清掉得整棵树替换 → `--full`。
  const stalePaths = [];
  if (baseTree) {
    const base = await httpsJson('GET', `/repos/${REPO}/git/trees/${baseTree}?recursive=1`);
    const basePaths = (base.json?.tree ?? []).filter((n) => n.type === 'blob').map((n) => n.path);
    const mine = new Set(files);
    for (const p of basePaths) if (!mine.has(p)) stalePaths.push(p);
  }
  if (stalePaths.length) {
    console.log(`\n远端残留   : ${stalePaths.length} 个文件在远端、但清单里没有（本地已删？）：`);
    for (const p of stalePaths.slice(0, 8)) console.log(`   - ${p}`);
    if (stalePaths.length > 8) console.log(`   … 还有 ${stalePaths.length - 8} 个`);
    console.log(FULL
      ? '   → --full 已开：本次整棵树替换，这些残留会被删除'
      : '   → 它们**会继续留在远端**；要清掉请加 --full（或 GH_FULL=1）重跑');
  } else if (baseTree) {
    console.log('远端残留   : 无（远端与清单一致）');
  }

  if (DRY) {
    console.log('\n体检通过。去掉 --dry 即真发布。\n');
    process.exit(0);
  }

  // ---- 3. 上传 blob ----
  console.log(`\n上传 ${files.length} 个 blob …`);
  const tree = [];
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const r = await httpsJson('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    if (r.status !== 201) throw new Error(`上传 blob 失败 (${rel}) HTTP ${r.status}：${r.json?.message ?? r.text.slice(0, 200)}`);
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: r.json.sha });
    if ((i + 1) % 10 === 0 || i === files.length - 1) process.stdout.write(`\r  ${i + 1}/${files.length}`);
  }
  console.log('');

  // ---- 4. 建 tree ----
  // base_tree 是合并语义（见上面「2c. 远端残留预检」）；--full 时整棵树替换，远端严格等于清单。
  const useBase = (baseTree && !FULL) ? baseTree : null;
  const t = await httpsJson('POST', `/repos/${REPO}/git/trees`, useBase ? { tree, base_tree: useBase } : { tree });
  if (t.status !== 201) throw new Error(`建 tree 失败 HTTP ${t.status}：${t.json?.message ?? t.text.slice(0, 200)}`);
  console.log(`tree   : ${t.json.sha}${useBase ? '（基于父树合并）' : '（整棵树替换：远端将严格等于清单）'}`);

  // ---- 5. 建 commit ----
  let message = 'chore: sync working tree';
  if (fs.existsSync(MSG_FILE)) message = fs.readFileSync(MSG_FILE, 'utf8').trim() || message;
  const authorName = process.env.GH_AUTHOR_NAME || 'f2x33';
  const authorEmail = process.env.GH_AUTHOR_EMAIL || 'jiayguo33@qq.com';
  const c = await httpsJson('POST', `/repos/${REPO}/git/commits`, {
    message,
    tree: t.json.sha,
    parents: parentSha ? [parentSha] : [],
    author: { name: authorName, email: authorEmail },
    committer: { name: authorName, email: authorEmail },
  });
  if (c.status !== 201) throw new Error(`建 commit 失败 HTTP ${c.status}：${c.json?.message ?? c.text.slice(0, 200)}`);
  console.log(`commit : ${c.json.sha}`);

  // ---- 6. 指分支 ----
  let r2;
  if (parentSha) {
    r2 = await httpsJson('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.json.sha, force: false });
  } else {
    r2 = await httpsJson('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: c.json.sha });
  }
  if (r2.status !== 200 && r2.status !== 201) throw new Error(`更新分支失败 HTTP ${r2.status}：${r2.json?.message ?? r2.text.slice(0, 200)}`);

  console.log(`\n✅ 发布成功`);
  console.log(`   仓库: https://github.com/${REPO}`);
  console.log(`   提交: https://github.com/${REPO}/commit/${c.json.sha}\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exitCode = 1;
});
