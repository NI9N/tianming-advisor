// 决策报告渲染: 命盘(chart/astro) + decision.json + 模板 → 单文件 HTML
//
// 用法:
//   node scripts/render-decision.js \
//     --decision=path/to/decision.json \
//     --template=templates/decision-report.html \
//     --output=path/to/output.html \
//     [--chart=path/to/chart.json] [--astro=path/to/astro.json] \
//     [--current-year=2026]
//
// chart.json: scripts/chart.js 的输出 (bazi + ziwei)；不传则由本脚本自动运行 chart.js
// astro.json: scripts/astro.js 的输出 (sun/moon/rising)；不传则由本脚本自动运行 astro.js
// decision.json: 五段式内容 (meta/timing/match/risk/advice/check)
//
// 占位符按前缀分组填充:
//   {{m.*}} 头部  {{c.*}} 命盘背景条  {{t.*}} 时机结论
//   {{f1..f3.*}} 匹配  {{r1..r2.*}} 风险  {{a.*}} 决策建议  {{x.*}} 三检验
// 剩余未匹配占位符 → '-'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJson(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[render-decision] 解析 JSON 失败: ${p} — ${err.message}`);
    process.exit(1);
  }
}

// 未传 --chart/--astro 时，运行 skill 自带 scripts 现场排盘
function runSkillScript(scriptName) {
  const scriptPath = path.join(ROOT, 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`[render-decision] 缺少 ${scriptPath}，无法自动排盘；请先传 --chart/--astro。`);
    process.exit(1);
  }
  try {
    return JSON.parse(execFileSync('node', [scriptPath], { cwd: ROOT, encoding: 'utf8' }));
  } catch (err) {
    console.error(`[render-decision] 运行 ${scriptName} 失败: ${(err.stderr || err.message).toString().slice(0, 400)}`);
    process.exit(1);
  }
}

const PILLAR_KEYS = ['year', 'month', 'day', 'hour'];

// 星曜→人话 简注（渲染层用；与 references/ziwei.md 第二节速查表保持一致，翻译成普通人一眼懂的白话）
const STAR_GLOSS = {
  // 十四主星
  '紫微': '掌控与核心', '天机': '动脑策划', '太阳': '光明付出', '武曲': '实干生财',
  '天同': '平和松弛', '廉贞': '权变驭局', '天府': '库藏守成', '太阴': '内在滋养',
  '贪狼': '才艺·社交·扩张', '巨门': '口才表达', '天相': '辅佐协调',
  '天梁': '荫庇贵人', '七杀': '攻坚破局', '破军': '破旧立新',
  // 辅星
  '文昌': '文书才艺', '文曲': '文书才艺',
  '左辅': '有帮手', '右弼': '有帮手', '天魁': '有贵人', '天钺': '有贵人',
  '禄存': '财库厚', '天马': '奔波流动',
  '火星': '带刺压力', '铃星': '带刺压力', '擎羊': '带刺压力', '陀罗': '带刺压力',
  '地空': '计划易落空', '地劫': '计划易落空',
  '红鸾': '人际喜庆', '天喜': '人际喜庆'
};

function glossStars(stars) {
  if (!stars || !stars.length) return '';
  return stars.map((s) => (STAR_GLOSS[s] ? `${s}=${STAR_GLOSS[s]}` : s)).join('；');
}

// 从 chart + astro 推导命盘背景条 (八卡)
function deriveStrip(chart, astro, currentYear) {
  const out = {};
  // 引擎缺失时不说含糊的「-」，直接说清缺的是什么
  const noEngine = !!(chart && chart.engineAvailable === false);
  const dash = () => (noEngine ? '引擎缺失' : '-');
  const bz = chart?.bazi || {};
  const bi = bz.birthInfo || {};
  const en = bz.enrichment || {};

  const virtualAge = bi.year ? currentYear - bi.year + 1 : null;

  // 四柱
  const siZhu = bz.siZhu || {};
  if (PILLAR_KEYS.every((k) => siZhu[k]?.gan && siZhu[k]?.zhi)) {
    out.pillars = PILLAR_KEYS.map((k) => siZhu[k].gan + siZhu[k].zhi).join(' ');
  } else {
    out.pillars = dash();
  }

  // 日主 · 格局
  const daymaster = siZhu.day?.gan || '';
  const geju = en.格局?.primary || '';
  out.daymaster_geju = daymaster ? (geju ? `${daymaster} · ${geju}` : daymaster) : dash();

  // 十神行
  const shiShen = bz.shiShen || {};
  if (PILLAR_KEYS.every((k) => shiShen[k])) {
    out.shishen_line = PILLAR_KEYS.map((k) => shiShen[k]).join(' ');
  } else {
    out.shishen_line = dash();
  }

  // 旺衰
  out.wangshuai_verdict = en.旺衰?.verdict || dash();
  const wsScore = en.旺衰?.score;
  out.wangshuai_score = wsScore === undefined || wsScore === null ? dash() : String(wsScore);

  // 调候用神
  const tiaohou = en.调候用神 || [];
  out.tiaohou = tiaohou.length ? tiaohou.slice(0, 2).join('、') : dash();

  // 当前大运
  const dayuns = bz.dayun || [];
  let currentDayun = null;
  if (virtualAge) {
    currentDayun = dayuns.find((d) => d.startAge <= virtualAge && virtualAge <= d.endAge) || null;
  }
  if (currentDayun) {
    const gz = currentDayun.ganZhi?.gan + (currentDayun.ganZhi?.zhi || '');
    out.dayun = `${gz} ${currentDayun.startAge}-${currentDayun.endAge}`;
    out.dayun_note = (currentDayun.ganShiShen || '') + (currentDayun.zhiShiShen || '');
  } else {
    out.dayun = dash();
    out.dayun_note = '';
  }

  // 当前流年
  const liunianArr = currentDayun?.liuNian || [];
  const curLiunian = virtualAge ? liunianArr.find((ln) => ln.age === virtualAge) : null;
  out.liunian_label = `${currentYear} 流年`;
  if (curLiunian) {
    out.liunian = (curLiunian.ganZhi?.gan || '') + (curLiunian.ganZhi?.zhi || '');
    out.liunian_note = (curLiunian.ganShiShen || '').slice(0, 1) + ((curLiunian.zhiShiShen || '').slice(0, 1) || '');
  } else {
    out.liunian = dash();
    out.liunian_note = '';
  }

  // 星盘：定盘层(太阳/土星/冥王星/北交点)恒有值；时辰层(月/升)缺时辰时为 null
  const signOf = (x) => (x && x.sign) || '-';
  const degraded = (astro && astro.degraded) || [];
  const noTime = degraded.includes('moon');
  out.sun = signOf(astro?.sun);
  out.saturn = signOf(astro?.saturn);
  out.pluto = signOf(astro?.pluto);
  out.northNode = signOf(astro?.northNode);
  // 缺信息时不显示裸「-」——说清缺的是什么
  out.moon = degraded.includes('moon') ? '需时辰' : signOf(astro?.moon);
  out.rising = degraded.includes('rising') ? (noTime ? '需时辰' : '需地点') : signOf(astro?.rising);

  // 紫微：当前大限 + 流年落宫
  const zw = chart?.ziwei || {};
  const gongs = zw.gongs || [];
  const curDaxianGong = gongs.find((g) => g.daXian && g.daXian.isCurrent === true);
  if (curDaxianGong) {
    const dx = curDaxianGong.daXian || {};
    const main = (curDaxianGong.mainStars || []).join(' ');
    out.daxian = `${dx.startAge}-${dx.endAge}岁 · ${dx.daXianGongName || ''}${main ? ' · ' + main : ''}`;
    out.daxian_note = glossStars(curDaxianGong.mainStars || []);
  } else {
    out.daxian = dash();
    out.daxian_note = '';
  }
  const curGong = gongs.find((g) => g.liuNianYear === currentYear);
  if (curGong) {
    const main = (curGong.mainStars || []).join(' ');
    const aux = (curGong.auxStars || []).slice(0, 2).join('·');
    const ji = (curGong.sihua || []).filter((s) => s.hua === '化忌').map((s) => s.star + '忌').join('');
    out.liunian_gong = `${curGong.gong}(${curGong.dizhi})${main ? ' ' + main : ' —'}${aux ? ' · ' + aux : ''}${ji ? ' · ' + ji : ''}`;
    const noteStars = (curGong.mainStars || []).concat((curGong.auxStars || []).slice(0, 2));
    out.liunian_gong_note = glossStars(noteStars);
  } else {
    out.liunian_gong = dash();
    out.liunian_gong_note = '';
  }

  return out;
}

function genTime() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

function buildFlat(chart, astro, decision, currentYear) {
  const d = decision || {};
  const meta = d.meta || {};
  const strip = deriveStrip(chart, astro, currentYear);

  const data = {};

  // 头部
  data['m.question'] = meta.question || '决策咨询';
  data['m.subtitle'] = meta.subtitle || '';
  data['m.gen_time'] = genTime();
  data['m.verdict'] = meta.verdict || '-';
  data['m.code'] = meta.code || `TM-${currentYear}${new Date().getMonth() + 1 < 10 ? '0' + (new Date().getMonth() + 1) : new Date().getMonth() + 1}`;

  // 命盘背景条
  for (const k of ['pillars', 'daymaster_geju', 'shishen_line', 'wangshuai_verdict', 'wangshuai_score', 'tiaohou', 'dayun', 'dayun_note', 'liunian_label', 'liunian', 'liunian_note', 'sun', 'saturn', 'pluto', 'northNode', 'moon', 'rising', 'daxian', 'daxian_note', 'liunian_gong', 'liunian_gong_note']) {
    data[`c.${k}`] = strip[k];
  }

  // ① 时机结论
  const t = d.timing || {};
  data['t.verdict'] = t.verdict || '-';
  data['t.text'] = t.text || '-';

  // ② 自身匹配度 (最多 3 卡)
  const match = d.match || [];
  for (let i = 0; i < 3; i++) {
    const m = match[i] || {};
    data[`f${i + 1}.label`] = m.label || `维度${i + 1}`;
    data[`f${i + 1}.text`] = m.text || '-';
  }

  // ③ 风险点 (最多 2 卡)
  const risk = d.risk || [];
  for (let i = 0; i < 2; i++) {
    const r = risk[i] || {};
    data[`r${i + 1}.head`] = r.head || `风险${i + 1}`;
    data[`r${i + 1}.tag`] = r.tag || '中';
    data[`r${i + 1}.text`] = r.text || '-';
  }

  // ④ 决策建议
  const adv = d.advice || {};
  data['a.quote_src'] = adv.quote_src || '-';
  data['a.quote_text'] = adv.quote_text || '-';
  const steps = Array.isArray(adv.steps) ? adv.steps : [];
  data['a.steps'] = steps.length
    ? steps.map((s) => `      <li>${escapeHtml(s)}</li>`).join('\n')
    : '';
  data['a.first_step'] = adv.first_step || '-';

  // ⑤ 三检验
  const check = d.check || {};
  data['x.tong'] = check.tong || '-';
  data['x.jian'] = check.jian || '-';
  data['x.huo'] = check.huo || '-';

  return data;
}

function renderTemplate(template, data) {
  let html = template;
  for (const k of Object.keys(data)) {
    const re = new RegExp(`\\{\\{${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
    // a.steps 已是含 <li> 的 HTML, 其余都转义
    const val = k === 'a.steps' ? data[k] : escapeHtml(data[k]);
    html = html.replace(re, String(val));
  }
  html = html.replace(/\{\{[a-zA-Z0-9_.]+\}\}/g, '-');
  return html;
}

function main() {
  const args = parseArgs();
  if (!args.template || !args.decision) {
    console.error('Usage: node render-decision.js --decision=decision.json --template=template.html --output=out.html [--chart=chart.json] [--astro=astro.json] [--current-year=2026]');
    process.exit(1);
  }
  const chart = args.chart ? readJson(args.chart) : runSkillScript('chart.js');
  const astro = args.astro ? readJson(args.astro) : runSkillScript('astro.js');
  const decision = readJson(args.decision);
  const template = fs.readFileSync(args.template, 'utf8');
  const currentYear = args['current-year'] ? +args['current-year'] : new Date().getFullYear();

  const data = buildFlat(chart, astro, decision, currentYear);
  const html = renderTemplate(template, data);

  if (args.output) {
    fs.writeFileSync(args.output, html, 'utf8');
    console.error(`[render-decision] 已生成: ${path.resolve(args.output)}`);
  } else {
    process.stdout.write(html);
  }
}

main();
