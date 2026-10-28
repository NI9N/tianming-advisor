#!/usr/bin/env node
'use strict';
/**
 * run-chart.js —— 排盘链入口（八字 + 紫微 + 解读层编排）
 *
 * 契约：
 *  - 6 个命令行参数，--k=v 形式：--year --month --day --hour --minute --gender
 *  - 不接受 isLunar / timeZone（产品从不传）
 *  - stdout 只输出一个 JSON 对象 { bazi, ziwei }；任何诊断走 stderr
 *  - 调用 lib/bazi（computeBazi，已含 enrichment）+ lib/ziwei（computeZiwei）
 *
 * 参照年：refYear 固定 2026（与 tools/collect-new-ziwei.js 一致）。isCurrent / liuNianYear
 *   属「参照年口径」差异（判级表挂 M6 F7，不计不一致），本单不解决。
 */
const { computeBazi } = require('./lib/bazi');
const { computeZiwei } = require('./lib/ziwei');
const { applyCorrection } = require('./lib/bazi/solar-correction');

const REF_YEAR = 2026;
const NUM_FIELDS = ['year', 'month', 'day', 'hour', 'minute'];

function parseArgs(argv) {
  const input = {};
  for (const a of argv) {
    const m = /^--([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(a);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (NUM_FIELDS.includes(key)) {
      input[key] = parseInt(val, 10);
    } else if (key === 'gender') {
      input.gender = val;
    } else if (key === 'tz') {
      input.tz = val; // IANA 时区名（校正口径 #4）
    } else if (key === 'lon') {
      input.longitude = parseFloat(val); // 出生地经度（度，东正）
    }
    // 其余参数（含 isLunar / timeZone）一律忽略——不接受。
  }
  return input;
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  // 校正口径：--tz / --lon 必须成对（都传或都不传），传一个不传另一个 = 报错退出
  const hasTz = input.tz !== undefined;
  const hasLon = input.longitude !== undefined;
  if (hasTz !== hasLon) {
    process.stderr.write('run-chart: --tz 与 --lon 必须成对传入（都传，或都不传）\n');
    process.exit(1);
  }
  // 校正口径：**换算只做一次**，同一个 correction 对象同时喂给 bazi 与 ziwei。
  // 两边各算各的会出现「八字走真太阳时、紫微走钟表时间」的自相矛盾盘（计划方复核实测：
  // 1987-07-15 14:00 → 八字壬午、紫微命宫却按子排，十二宫整体错位一宫）。
  let correction = null;
  if (hasTz) {
  // ★★ 时序口径 · 缺时辰时 `applyCorrection` 的 hour/minute 用 **0 做算术载体**
  //
  // 为什么可以：`applyCorrection` 的 dst/经度/均时差三项修正**都与 hour 无关**
  //   （夏令时看日期、经度是常量、均时差按 UT 瞬时求值），而 `stdParts`/`solarParts`
  //   的 hour 字段在这个模式下**根本不会被读** —— `lib/bazi` 与 `lib/ziwei` 在
  //   `hasHour=false` 时把所有 `*.hour` 项置 `null`，一个 `getTime*` 都不调。
  //   ⇒ 用 0 只是让 `Date.UTC` 不产出 NaN，不会泄露任何假时柱。
  //
  // ⚠️ 为什么不改 `solar-correction.js`：那文件是 `90` 单刚碰过的换算层核心，
  //    本单（`92`）的范围是「缺时辰降级」，不该顺手改它（工单禁做项 7）。
  const corrHour = input.hour === undefined ? 0 : input.hour;
  const corrMinute = input.minute === undefined ? 0 : input.minute;
  correction = applyCorrection({
    year: input.year, month: input.month, day: input.day,
    hour: corrHour, minute: corrMinute,
    tz: input.tz, longitude: input.longitude,
  });
  }
  const bazi = computeBazi({ ...input, correction });
  const ziwei = computeZiwei({ ...input, refYear: REF_YEAR, correction });
  process.stdout.write(JSON.stringify({ bazi, ziwei }));
}

try {
  main();
} catch (e) {
  process.stderr.write('run-chart: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
