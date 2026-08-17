# 天命顾问（tianming-advisor）

> 个人决策咨询 Claude Code Skill — 八字十神 + 大运流年 + 西洋星盘 + 健壮性认知系统 + 国学框架

当你想评估一个决定（该不该做 X / 现在适不适合 / 这个方向对不对 / 时机判断）时，skill 综合命理时机、个人方法论、人格档案三条线，输出结构化参考建议。

**注意：非娱乐算命。** 定位是「命理时机 + 方法论 + 人格」的决策参考工具，不替代医疗、法律等专业意见（输出自带免责声明）。

## 决策管线

全是确定性计算，不靠 LLM 猜：

```
config.yaml（出生信息/人格基线）
   ├─ scripts/chart.js  → 八字排盘（四柱/十神/大运流年/格局旺衰）
   └─ scripts/astro.js   → 西洋星盘（太阳/月亮/上升）
        ↓
references/ 五份解读规则（shishen / dayun-liunian / jianzhuang / guoxue / xingzuo）
        ↓
SKILL.md 编排五段式输出（①时机 ②自身匹配 ③风险 ④建议+国学原文 ⑤三检验 + 免责）
```

## 目录结构

```
tianming-advisor/
├── SKILL.md           Skill 定义：触发条件、执行流程、输出模板
├── install.ps1        安装脚本（装依赖 + 克隆排盘引擎 + 部署到 ~/.claude/skills/）
├── package.json       依赖：astronomia（星盘）+ js-yaml
├── scripts/
│   ├── chart.js       八字排盘（调排盘引擎，字段实测 camelCase）
│   └── astro.js       西洋星盘（太阳/月亮/上升，依赖 config.yaml 经纬度）
├── references/        五份解读规则（十神/大运流年/健壮性/国学/星盘）
├── config.yaml        个人信息（被 .gitignore 排除，不入库）
└── engine/            排盘引擎（install 时克隆，不入库）
```

## 安装

1. 克隆本仓库：`git clone https://github.com/NI9N/tianming-advisor.git`
2. 补一份 `config.yaml`（出生日期/时辰/地点/人格基线，见下方「隐私」说明）
3. 运行 `.\install.ps1`：
   - `npm install`（astronomia + js-yaml）
   - 自动克隆排盘引擎 `bazi-ziwei-skill`（MIT）到 `engine/`
   - 部署到 `~/.claude/skills/tianming-advisor/`

安装后，在新会话里说「用天命顾问看看该不该…」即可触发。

## 隐私

`config.yaml` 包含个人出生信息（日期/时辰/地点）和人格档案，已被 `.gitignore` 排除，**不进任何 git 仓库**，仅本地保留供 skill 运行。重装/迁移需手动补这份文件。

## 依赖

- [astronomia](https://www.npmjs.com/package/astronomia) ^4.2.0 — 西洋占星计算
- js-yaml ^4.1.0 — 读取 config.yaml
- [bazi-ziwei-skill](https://github.com/dzcmemory-web/bazi-ziwei-skill)（MIT）— 八字排盘引擎，安装时克隆到 `engine/`，不入库

## 时辰边界

八字排盘用钟表时间（引擎默认，不做真太阳时校正）。出生地经度来自 `config.yaml`，真太阳时相对钟表时的偏移由出生地经度决定。默认跟随引擎用钟表时；是否启用真太阳时校正见 SKILL.md「时辰边界说明」。
