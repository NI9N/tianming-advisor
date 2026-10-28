'use strict';
/**
 * scripts/chart.js —— **本包入口 · 组装**：产品侧新入口
 *
 * ---------------------------------------------------------------------------
 * ★ 它是什么 / 不是什么
 * ---------------------------------------------------------------------------
 * **是**：`tianming-advisor\scripts\chart.js` 的**同名等价件**（不同位置）。
 *        接口不变（`--year --month --day --hour --minute --gender`），
 *        产品侧调用方一个字都不用改。
 * **不是**：`tianming-advisor\scripts\chart.js` 的修改版 —— **那份一字不动**（禁做项 3，
 *        它是证据 ＋ 现有行为）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 本文件唯一要紧的设计：**换算只做一次，且不由本文件做**
 * ---------------------------------------------------------------------------
 * `68 §四 (c)` 判了「两段都算 = 双重校正 = 灾难」。本文件的结构性保证：
 *
 *   ① **`full` 档下本文件不做任何"加到钟表时间上的偏移"运算**。
 *      它只把**原始钟表时间** ＋ `--tz/--lon` 交给 `run-chart.js`，
 *      由 `lib/bazi/solar-correction.js` 的 `applyCorrection()` 算那一次。
 *   ② **唯一例外是 `longitude` 档** —— 那一档的**定义**就是"复现早期版本盘面"
 *      （`round((lon−120)×4)` ＋ 平移整个出生时间），这是它存在的唯一目的。
 *      但**那个数仍然来自自研链**：本文件调 `applyCorrection()` 取
 *      `breakdown.longitude`，只做"取整 ＋ 平移"这两步**装配**。
 *      并且该档**不传** `--tz/--lon` ⇒ `run-chart.js` 那侧不再校正。
 *   ③ 本文件也调 `applyCorrection()` 拿 `totalMinutes/breakdown` ——
 *      **那个结果只进 `trueSolarTime` 报告块，永远不进 spawn 参数。**
 *      想把它"顺手"传下去就会变成双重校正 ⇒ 见 `docs/76-交付` 的 J16c。
 *
 * ---------------------------------------------------------------------------
 * ★ 三档（`config.yaml` 的 `solarCorrection` 键；默认 `full`）
 * ---------------------------------------------------------------------------
 *   `none`      纯钟表时间，不校正
 *   `longitude` 只做经度（**= 早期版本的经度档**，给需要复现旧盘的人）
 *   `full`      三项齐全（夏令时 ＋ 经度 ＋ 均时差）＋ 年月柱走绝对时刻 ＋ ziwei 联动
 *
 *   ⚠️ `full` 是本文件的默认档（User 2026-10-14 口径 ＋ `74` 裁定三项全是运算缺陷）。
 *
 * ★ 没填经度 ⇒ **退化到钟表时间 ＋ 显式标注**，不做 120°E 兜底
 *   （`75` 实测：兜底会把情形② 的影响面从 `40.6%` 藏到 `~13%`，
 *     而那是"以为校了、其实按错经度校了" —— 比不校更糟）。
 *
 * ---------------------------------------------------------------------------
 * 退出码：0 = 成功 ／ 1 = 排盘失败 ／ 2 = 配置或用法错误
 * 环境变量（仅测试用，不进 CLI 接口）：
 *   TIANMING_ENGINE_ROOT  自研链根目录（含 run-chart.js + lib/）
 *   TIANMING_CONFIG       配置文件路径（默认 <引擎根>/config.yaml，回退 config.yaml.example）
 * ---------------------------------------------------------------------------
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
/** 定位 `口径声明-解读层.md`（开发树在  下，干净包在根下）—— 报**真实**路径，不报猜的路径 */
function findStatement(root) {
  for (const rel of ['口径声明-解读层.md', 'product/口径声明-解读层.md']) {
    if (fs.existsSync(path.join(root, rel))) return rel;
  }
  return null;
}

// 退出码（与 既有约定一致：2 不是"通过"）
// ---------------------------------------------------------------------------
const EXIT_OK = 0;
const EXIT_CHART_FAIL = 1;
const EXIT_CONFIG = 2;

function fail(code, msg) {
  process.stderr.write('chart: ' + msg + '\n');
  process.exit(code);
}

// ---------------------------------------------------------------------------
// ① 定位自研链根（含 run-chart.js 与 lib/bazi/index.js 的那个目录）
//    从本文件所在目录逐级向上找 ⇒ 开发树（scripts/）与干净包（scripts/）都能用。
// ---------------------------------------------------------------------------
// ★★ 包根口径 · 包根的**唯一**推法 —— 与 `astro.js` / `render-decision.js` 同一个 helper。
//   改前：本文件自己有一段 `findEngineRoot()`（向上找 `run-chart.js` + `lib/bazi/index.js`），
//   `astro.js` 有一段几乎一样的，`render-decision.js` 又是硬编码 `'..','..'` ⇒ 三种理解。
//   ⇒ 现在三处都调 `./pkg-root` 的 `resolvePkgRoot()`。
//   ⚠️ `TIANMING_ENGINE_ROOT` 环境变量仍然优先（既有的逃生口，保留）。
const { resolvePkgRoot } = require('./pkg-root');

// ---------------------------------------------------------------------------
// ② 配置
// ---------------------------------------------------------------------------
const GEARS = ['none', 'longitude', 'full'];
const DEFAULT_GEAR = 'full';           // ★ User 2026-10-14 口径
const CONFIG_NAMES = ['config.yaml', 'config.yaml.example'];
const NO_LON_NOTICE =
  '未提供出生地经度（location.longitude）⇒ 无法计算真太阳时。本次按钟表时间排盘，未做任何校正。';
const LONGITUDE_GEAR_NOTICE =
  '当前档位 solarCorrection=longitude（只做经度修正的兼容档）。' +
  '该档不含均时差与夏令时，且经度平移会改年月柱。' +
  '它仅用于复现早期版本的盘面，建议改用 full。';

function loadConfig(root) {
  // ⚠️ YAML 解析失败**必须**报 exit 2（配置错误），不能落到最外层 catch 变成 exit 1（排盘失败）
  //    —— 首跑实测：`printf` 写出字面 `\n` 的坏 YAML，js-yaml 抛错未被捕获 ⇒ exit 1。
  const override = process.env.TIANMING_CONFIG;
  if (override) {
    if (!fs.existsSync(override)) fail(EXIT_CONFIG, 'TIANMING_CONFIG 指向的文件不存在：' + override);
    return { path: override, source: 'TIANMING_CONFIG', data: parseYamlFile(override) };
  }
  for (const name of CONFIG_NAMES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return { path: p, source: name, data: parseYamlFile(p) };
  }
  fail(EXIT_CONFIG, '找不到配置文件（试过 ' + CONFIG_NAMES.join(' / ') + '）。请从 config.yaml.example 复制一份。');
}

function parseYamlFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { fail(EXIT_CONFIG, '读不了配置文件 ' + p + '：' + e.message); }
  try { return yaml.load(raw) || {}; }
  catch (e) { fail(EXIT_CONFIG, '配置文件不是合法 YAML：' + p + '\n    ' + e.message.split('\n')[0]); }
}

function readGear(cfg) {
  const raw = cfg.solarCorrection === undefined ? DEFAULT_GEAR : String(cfg.solarCorrection).trim();
  if (!GEARS.includes(raw)) {
    fail(EXIT_CONFIG, 'solarCorrection="' + raw + '" 不合法。三选一：none | longitude | full');
  }
  return raw;
}

/** IANA 时区名：显式 `birth.timezone` 优先；`timezone_offset=8` 才允许默认成 Asia/Shanghai；其余不猜。 */
function resolveTz(birth) {
  if (birth && typeof birth.timezone === 'string' && birth.timezone.trim()) {
    const tz = birth.timezone.trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
    catch (e) { fail(EXIT_CONFIG, 'birth.timezone="' + tz + '" 不是有效 IANA 时区名：' + e.message); }
    return tz;
  }
  const off = Number(birth && birth.timezone_offset);
  if (off === 8) return 'Asia/Shanghai';
  if (Number.isFinite(off)) {
    // 兼容旧配置：把字面 offset 映射成固定偏移时区名（Etc/GMT∓N，符号与直觉相反）
    // 固定偏移不含夏令时；若出生地实行夏令时，时刻可能差 1 小时 —— 所以给警告，不静默
    if (Number.isInteger(off) && off >= -14 && off <= 14) {
      const tzName = 'Etc/GMT' + (off > 0 ? '-' : '+') + Math.abs(off);
      console.warn('[时区] 未声明 birth.timezone，按 timezone_offset=' + off + ' 使用固定偏移 ' + tzName + '（不含夏令时）。若出生地实行夏令时，建议显式写 birth.timezone。');
      return tzName;
    }
    fail(EXIT_CONFIG, 'birth.timezone_offset=' + off + ' 不是整数，无法映射到固定偏移时区。请显式写 birth.timezone（如 Asia/Kolkata）。');
  }
  fail(EXIT_CONFIG, '缺少 birth.timezone / birth.timezone_offset。');
}

function readLongitude(loc) {
  const v = loc && loc.longitude;
  if (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  if (!(n >= -180 && n <= 180)) fail(EXIT_CONFIG, 'location.longitude=' + v + ' 超出 [-180, 180]。');
  return n;
}

/**
 * ★★ 时序口径：「没给」与「给了 0」必须走两条路
 *
 * | 输入形态 | 判定 |
 * |---|---|
 * | 键不存在（`birth` 里没有 `hour`） | **未给** |
 * | 值为 `null`（`hour:` 后什么都不写） | **未给** |
 * | 值为空串 `''` | **未给** |
 * | 值为 `0` | **给了**（真子时，照常算四柱）|
 * | 值为非数字（`'abc'`、`{}`） | **非法** ⇒ 报错退出 |
 *
 * ⚠️ 旧实现是 `const n = Number(b[k])` —— **`Number(null) === 0`** ⇒ YAML 的 `hour:`（空）
 *    解析成 `null` ⇒ 变 `0` ⇒ `Number.isFinite(0)` 为真 ⇒ **过检** ⇒ 用户填「我不知道」，
 *    引擎读到的是「子时」，而且一个字都不说。
 *    ⇒ 这是 `92-工单 §零` 记的那个 bug。
 *
 * ⚠️ 为什么不能"falsy 就降级"：`hour: 0` 是**显式给了真子时**。
 *    用 `!b[k]` 判定会把显式填 0 的用户也降级 —— 那正是工单的命门 `J92b`。
 *
 * @returns {{year:number,month:number,day:number,hour:number|null,minute:number|null,gender:string,hasHour:boolean}}
 */
function readBirth(cfg) {
  const b = cfg.birth;
  if (!b) fail(EXIT_CONFIG, 'config 缺少 birth 段。');
  const out = {};
  // 年月日：不许降级（缺了排不了盘）
  for (const k of ['year', 'month', 'day']) {
    const n = Number(b[k]);
    if (!Number.isFinite(n)) fail(EXIT_CONFIG, 'birth.' + k + ' 不是数字：' + JSON.stringify(b[k]));
    out[k] = n;
  }
  // 时辰/分钟：区分「没给」与「给了 0」
  const hourGiven = b.hour !== undefined && b.hour !== null && b.hour !== '';
  const minuteGiven = b.minute !== undefined && b.minute !== null && b.minute !== '';
  if (hourGiven) {
    const n = Number(b.hour);
    if (!Number.isFinite(n)) fail(EXIT_CONFIG, 'birth.hour 不是数字：' + JSON.stringify(b.hour));
    out.hour = n;
  } else {
    out.hour = null;    // ★ 未给 ⇒ null（**不是 0**）
  }
  if (minuteGiven) {
    const n = Number(b.minute);
    if (!Number.isFinite(n)) fail(EXIT_CONFIG, 'birth.minute 不是数字：' + JSON.stringify(b.minute));
    out.minute = n;
  } else {
    // ★ 92：给了 hour 没给 minute ⇒ minute=0（不降级，分钟不影响时辰）。
    //   没给 hour 却给了 minute ⇒ minute 一并作废（没有时辰就没有分钟）。
    out.minute = hourGiven ? 0 : null;
  }
  out.hasHour = hourGiven;
  if (b.gender !== 'male' && b.gender !== 'female') {
    fail(EXIT_CONFIG, 'birth.gender 必须是 male 或 female，当前是 ' + JSON.stringify(b.gender));
  }
  out.gender = b.gender;
  return out;
}

// ---------------------------------------------------------------------------
// ③ 平移整个出生时间（UTC 算术，跨日自动处理）
//    ⚠️⚠️ **本函数只被 `longitude` 档调用** —— 它是
//       「**为复现早期版本盘面而存在的专用件，不是产品校正路径**」。详见下方 `longitude` 分支的注释。
//       `full` 档**不碰这个函数**（它一个偏移字节都不算）。
//    用 UTC 而非本地 `new Date(y,m,d)`：本机 TZ 若带 DST，本地算术会漂一小时。
// ---------------------------------------------------------------------------
function shiftBirth(b, offsetMinutes) {
  // ★ 92：`hour`/`minute` 可能是 `null`（未给时辰）。`Date.UTC(...,null,...)` 会把 null 当 0
  //   ⇒ **又一个「未给变子时」的坑**。这里显式兜成 0（仅供 `longitude` 档做整份平移的算术载体），
  //   并在下游 `runChart` 处靠 `hasHour` 不传 `--hour`，所以不会泄露假时柱。
  const h = b.hour === null || b.hour === undefined ? 0 : b.hour;
  const mi = b.minute === null || b.minute === undefined ? 0 : b.minute;
  const ms = Date.UTC(b.year, b.month - 1, b.day, h, mi, 0) + offsetMinutes * 60000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), gender: b.gender,
    // ★ 92：平移只是算术载体，「有没有时辰」必须原样带下去（不能被平移结果伪造）
    hasHour: b.hasHour === true,
  };
}

// ---------------------------------------------------------------------------
// ④ 调自研链排盘（**这是本文件唯一碰引擎的地方**）
//    tz/lon 都传 ⇒ 由 run-chart 调 applyCorrection 做那唯一一次换算；
//    都不传 ⇒ 用传入的钟表时间原样排盘。
// ---------------------------------------------------------------------------
function runChart(engineRoot, birth, tz, lon) {
  const script = path.join(engineRoot, 'run-chart.js');
  if (!fs.existsSync(script)) fail(EXIT_CONFIG, '自研链入口不存在：' + script);
  const args = [
    script,
    '--year=' + birth.year, '--month=' + birth.month, '--day=' + birth.day,
    '--gender=' + birth.gender,
  ];
  // ★★ 时序口径：**没时辰就整个不传 `--hour` / `--minute`**。
  //   若传 `--hour=0`，下游会把「未给」当成「子时」—— 那正是本单要修的 bug。
  //   有时辰才传（`hour: 0` 是显式给了真子时，照常传 0）。
  if (birth.hasHour) { args.push('--hour=' + birth.hour, '--minute=' + birth.minute); }
  if (tz !== null && lon !== null) { args.push('--tz=' + tz, '--lon=' + lon); }
  let stdout;
  try {
    stdout = execFileSync(process.execPath, args, { cwd: engineRoot, encoding: 'utf8' });
  } catch (err) {
    fail(EXIT_CHART_FAIL, '排盘失败：' + ((err.stderr && err.stderr.toString().slice(0, 500)) || err.message));
  }
  try {
    const chart = JSON.parse(stdout);
    if (!chart || !chart.bazi) fail(EXIT_CHART_FAIL, '引擎未返回有效 bazi 数据。stdout=' + stdout.slice(0, 500));
    return chart;
  } catch (e) {
    fail(EXIT_CHART_FAIL, '引擎输出不是有效 JSON：' + e.message);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write([
      '用法：node chart.js --year=YYYY --month=M --day=D --hour=H --minute=Mi --gender=male|female',
      '',
      '  接口与本包 scripts/chart.js 相同；本文件是较新的入口，',
      '  内部走本包自研排盘链（lib/ + run-chart.js）。',
      '',
      '  三档由 config.yaml 的 solarCorrection 决定（默认 full）：',
      '    none       纯钟表时间',
      '    longitude  只做经度（兼容档，用于复现早期版本的盘面）',
      '    full       三项齐全（默认）',
      '',
      '  没填 location.longitude ⇒ 退化到钟表时间并在输出里显式标注（不做 120°E 兜底）。',
      '',
      '退出码：0=成功 1=排盘失败 2=配置或用法错误',
      '',
    ].join('\n'));
    process.exit(EXIT_OK);
  }

  // —— 参数（接口不变：只认这 6 个，其余忽略）——
  const cli = {};
  for (const a of argv) {
    const m = /^--([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(a);
    if (!m) continue;
    if (['year', 'month', 'day', 'hour', 'minute'].includes(m[1])) {
      const n = parseInt(m[2], 10);
      if (!Number.isFinite(n)) fail(EXIT_CONFIG, '--' + m[1] + ' 不是数字：' + m[2]);
      cli[m[1]] = n;
    } else if (m[1] === 'gender') {
      cli.gender = m[2];
    }
  }

  // ★ 94：`resolvePkgRoot` 找不到时**抛错**（而不是返回 null 让人自己判），
  //   消息里已含"试过哪些目录" —— 这里补上退出码语义即可。
  let ENGINE_ROOT;
  try {
    ENGINE_ROOT = process.env.TIANMING_ENGINE_ROOT
      ? path.resolve(process.env.TIANMING_ENGINE_ROOT)
      : resolvePkgRoot(__dirname);
  } catch (e) {
    fail(EXIT_CONFIG, String(e && e.message ? e.message : e));
  }

  const conf = loadConfig(ENGINE_ROOT);
  const cfg = conf.data || {};
  const gear = readGear(cfg);
  const birth = readBirth(cfg);
  const lon = readLongitude(cfg.location);

  // —— 命令行可覆盖 birth（接口不变，但方便产品侧传参）——
  const eff = Object.assign({}, birth, cli);
  if (eff.gender !== undefined && eff.gender !== 'male' && eff.gender !== 'female') {
    fail(EXIT_CONFIG, '--gender 必须是 male 或 female');
  }

  // —— 换算层：只有 longitude / full 两档、且填了经度时才需要它 ——
  //     ⚠️ resolveTz 吃的是**配置里的 birth 原文**（要读 timezone/timezone_offset），
  //        不是 readBirth 归一化后的那六个字段 —— 否则会把时区信息丢掉。
  let tz = null;
  let corr = null;
  if (gear !== 'none' && lon !== null) {
    tz = resolveTz(cfg.birth);
    const { applyCorrection } = require(path.join(ENGINE_ROOT, 'lib', 'bazi', 'solar-correction'));
    corr = applyCorrection({
      year: eff.year, month: eff.month, day: eff.day, hour: eff.hour, minute: eff.minute,
      tz: tz, longitude: lon,
    });
  }

  // —— 决定喂给 run-chart 的时刻 + 是否带 --tz/--lon ——
  let chartBirth = eff;
  let passTzLon = false;
  let notice = null;
  let offsetMinutes = 0;
  let totalMinutes = 0;
  let breakdown = null;
  let dayDelta = 0;
  let adjustedBirth = null;

  if (gear === 'none') {
    // 纯钟表时间
  } else if (lon === null) {
    // ★ 没填经度 ⇒ 退化到钟表时间 ＋ 显式标注（不做 120°E 兜底）
    notice = NO_LON_NOTICE;
  } else if (gear === 'full') {
    passTzLon = true;                        // ★ 全部交给自研链算，本文件不加任何偏移
    offsetMinutes = Math.round(corr.totalMinutes);
    totalMinutes = corr.totalMinutes;
    breakdown = corr.breakdown;
    adjustedBirth = corr.solarParts;
    dayDelta = dayDeltaOf(eff, corr.solarParts);
  } else if (gear === 'longitude') {
    // ★★★★★ 【专用件 · 不是产品校正路径】★★★★★
    //
    // 读到这里的人，请注意三件事：
    //   ① 下面这段**只服务 `longitude` 档**，而 `longitude` 档**只有一个用途：复现早期版本的盘面**
    //      （该档不带均时差与夏令时，且经度平移会改年月柱）。
    //   ② **它不是"简版 full"** —— `full` 档在本文件里**一个偏移字节都不算**，
    //      完整校正完全由 `lib/bazi/solar-correction.js` 的 `applyCorrection()` 做。
    //   ③ 这段存在的理由：**只有它能产出与早期版本逐位一致的盘**，
    //      那是"证据可比对"的能力。
    //      **正常产品使用请用 `full`（默认档）。**
    //
    // 数只有一处来源：`corr.breakdown.longitude`（来自 `applyCorrection()`）。
    // "取整"与"整份平移"是**装配**，不是换算；且本档**不传** `--tz/--lon`
    // ⇒ `run-chart.js` 那侧不再校正 ⇒ 不可能双重校正（`J16c` 三路对账已证）。
    offsetMinutes = Math.round(corr.breakdown.longitude);
    totalMinutes = offsetMinutes;
    chartBirth = shiftBirth(eff, offsetMinutes);
    adjustedBirth = chartBirth;
    dayDelta = dayDeltaOf(eff, chartBirth);
    notice = LONGITUDE_GEAR_NOTICE;
  }

  const chart = runChart(ENGINE_ROOT, chartBirth, passTzLon ? tz : null, passTzLon ? lon : null);

  // ★★ 时序口径 · 缺时辰的三件套（与 `astro.js` 的 `degraded`/`degradedNote` **同一种口吻**，
  //   因为报告上这两句会同时出现，口径不一致会显得是两个产品）
  //   `hasHour=false` ⇒ 时柱/时柱十神/命宫/身宫/由时辰推导的四化**全部为 null**（lib 已保证），
  //   这里只负责**声明**，不负责造值。
  const hasHour = !!chartBirth.hasHour;
  // ★★ 缺时辰口径 · ④「三柱所出」必须声明（**口径，不是补洞**）
  //    `92` 之后 `enrichment`（格局/旺衰/调候/五行统计）都是在**3 个柱**上算的。
  //    那不是错（三柱也有它的读法），但**必须说破** —— 否则用户会以为是全盘结论。
  //    ⚠️ 工单明令：**不许把 `enrichment` 整个置空**，只声明。
  const degraded93 = hasHour
    ? []
    : ['hour', 'mingGong', 'shenGong', 'wuXingJu', 'gongs', 'enrichment-partial'];
  const degradedNote93 = hasHour ? '' :
    '本次未提供出生时辰：时柱、命宫/身宫、五行局与十二宫均不可用（已按缺失处理，未按 0 点推算）；' +
    '格局与旺衰等按年/月/日三柱推得，属部分口径，非全盘结论。';

  const applied = gear !== 'none' && lon !== null;
  const out = {
    engineAvailable: true,
    degraded: degraded93,
    // ★ 92/93：给人看的声明位（渲染层可直接显示）—— 「声明」不能只存在于 JSON 数组里
    degradedNote: degradedNote93,
    hasHour,
    chain: 'tianming-advisor',             // ★ 标明盘来自本包自研排盘链
    solarCorrection: gear,
    // ★ 本包口径声明：`#6 口径声明` 落地。全文见 口径声明-解读层.md；
    //   这里只放用户可见的短版 —— 渲染层/LLM 拿到的每一份输出都带着它，
    //   不依赖"有人记得去读那个文件"。
    口径声明: {
      均时差精度: '≤3.5 秒（对日晷真值）',
      三项修正: ['缺均时差', '缺夏令时', '经度平移会改年月柱'],
      校正后时间标注: '本次校正量与校正后时刻见 trueSolarTime 块',
      详见: findStatement(ENGINE_ROOT) || null,
    },
    trueSolarTime: {
      applied: applied,
      mode: applied ? 'traditional' : 'clock',   // 保留旧键名（render-decision.js 不读它，但下游可能读）
      gear: gear,
      longitude: lon,
      timezone: tz,
      offsetMinutes: offsetMinutes,
      totalMinutes: totalMinutes,
      breakdown: breakdown,
      dayDelta: dayDelta,
      adjustedBirth: adjustedBirth,
      notice: notice,
    },
    configSource: conf.source,
    bazi: chart.bazi,
    ziwei: chart.ziwei || null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function dayDeltaOf(a, b) {
  const da = Date.UTC(a.year, a.month - 1, a.day);
  const db = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((db - da) / 86400000);
}

try {
  main();
} catch (e) {
  fail(EXIT_CHART_FAIL, (e && e.message) ? e.message : String(e));
}
