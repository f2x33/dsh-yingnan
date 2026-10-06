# NOTICE —— 来源、改动与授权边界

## 一、本项目的血统

`dsh-yingnan` 的**代码**（宿主半侧 `lib/index.js`、浏览器半侧 `lib/client.js`、
桌面模式运行时 `runtime/electron-helper/`）是从 **dsh-redpet** 分叉而来，
而 dsh-redpet 又是从 **dsh-pet `0.3.5`** 的构建产物改造而来。

- 直接父项目：dsh-redpet（红队装桌宠，同一作者的上一只宠物）
- 上游项目：dsh-pet（"吃白饭的蓝色大肥鱼"）
  作者：PC2005-cloud · 仓库：https://github.com/PC2005-cloud/dsh-pet
- 上游授权：**MIT**（见本目录 `LICENSE`，版权行 `Copyright (c) 2026 PC2005-cloud` 原样保留）

MIT 允许修改、再分发与再许可，条件是**保留原版权声明与许可全文**。本目录的 `LICENSE`
即为该原文，未被改动。

## 二、相对上游做了什么改动

| 类别 | 改动 |
|---|---|
| 标识 | 全局把父包标识 `dsh-redpet` / `redpet` / `redchat` 改为 `dsh-yingnan` / `yingnan` / `yingnanchat`：包名、bundle patch 的 id、路由前缀 `/dsh-yingnan-7340`、用户数据目录 `$DSH_HOME/dsh-yingnan`、命令名、CSS 类名前缀与变量 `--dsh-yingnan-size`、settings 槽位键、locale 命名空间、日志前缀；脚本 `tools/_rename-yingnan.mjs` 带 **PROTECT 外部标识保护表**（仓库名/上游署名一处不动，数量不符就中止且不落盘） |
| 插件身份 | Cordis 插件名 `redpet` → `yingnan`（与 dsh-pet、dsh-redpet 三者并存时不撞名） |
| 共存修复 | `lib/client.js` 整个包进 **IIFE**（同级分叉的顶层词法声明会在同批 classic script 里撞名 → 解析期 `SyntaxError`）；回归测试 `tools/verify-coexist.mjs` 两种加载顺序全绿 |
| 动作 | **15 段扩到 18 段剑侠向**（先加到 19，后来弃用「剑指苍穹」）：`assets/config.jsonc` 的 `animations` 段重写（池子、权重、事件档位全部按 15 个素材重排），新增位移动作 `御剑飞行`（`moves.actions`）与 `舞剑` / `拔剑出鞘` / `抱剑而立` |
| 人设 | `whisperPrompt` 与 `workStatusTexts`（6 档）换成蜀山剑侠语境；宠物显示名 `蜀山侠女`（角色本名余英男） |
| 素材 | 包内 15 段目前是**零成本占位素材**（`tools/make-placeholder.mjs` 由定妆图静态抠像生成），真素材按 `docs/02` 自行生成 |
| 新增 | `tools/make-placeholder.mjs`（占位素材 + 抠像质量闸门）、`tools/measure-proportion.mjs`、`tools/find-watermark.mjs`、`tools/verify-coexist.mjs`；另有上游一脉相承的 `selftest.mjs` / `gen-api.mjs` / `keyscreen.mjs` / `pipeline.mjs` / `fix-node-modules.ps1` |
| 移除 | 独立模式 CLI（`bin.dsh-pet-standalone`、`lib/standalone.js`）——本包只做插件 |

## 三、授权边界（重要）

**代码**：MIT，可自由使用、修改、再分发。

**素材**：dsh-pet 的**素材**（角色立绘 / 动作 webm / 表情包 / logo / 字体）与代码**不是同一份授权**，
上游声明为「允许开源使用、禁止商用」。出于谨慎，本仓库**不随包分发任何上游素材**：

- `assets/webm/*.webm` —— 动作素材，由 `.gitignore` 排除，请按 `docs/` 自行生成
- `assets/memes/*.png` —— 表情包，默认关闭，不影响功能
- `assets/logo.png` —— 未在 `package.json` 里声明 `icon`，当前根本没被使用
- `assets/fonts/*.ttf` —— 取不到会回落到系统字体

要向本仓库加入你自己的素材，把 `.gitignore` 里对应的 `!` 例外打开即可。
**请勿**把上游素材直接提交进本仓库后对外发布。

## 四、角色设计

本包角色 **蜀山派余英男**（桌面显示名 **蜀山侠女**）：超变形 Q 版、乌黑长发白玉簪、
**杏黄交领外袍 + 白色内衬中衣**（袖口衣摆淡金云纹、杏黄丝绦、白布云鞋）、手持**赤红长剑**（剑身赤红，剑周围没有火焰与任何发光特效）
（刻意不做火焰与任何发光特效 —— 半透明光晕抠像后会糊，见 `tools/make-placeholder.mjs` 的注释）。

外观设计与全部提示词见 `docs/01-定妆图提示词.md` 与 `docs/04-定妆图改写提示词.md`，
属于本项目原创。角色保留了上游一脉的 Q 版头身比与画风（定妆图实测身高/头宽 3.27，连续段口径），
但**不使用**上游的角色特征（蓝发 / 鲸鱼鳍耳 / 鲸鱼尾巴均已去掉）。
