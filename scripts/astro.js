// 读取 config.yaml → 计算星盘 → 输出 JSON
// 引擎: astronomia v4.2.0 (MIT, 无依赖)
//   太阳   solar.apparentLongitude(T)          视黄经(含章动/光行差, 真春分点)
//   月亮   moonposition.position(jde).lon      地心黄经(平春分点 of date)
//   上升   LST = GMST + 东经 → RAMC → atan2 公式 (Meeus ch.13)
//   土星   VSOP87D(date 平黄道) + 地球位置 → 地心化 → 地心黄经
//   冥王星 pluto.heliocentric(J2000 黄经) → 地心化 → 补黄经岁差 → date
//   北交点 Meeus ch.47 平均交点公式 (mean node, 非 true node)
//
// ★★ 时区接线 · 本文件是 `tianming-advisor\scripts\astro.js` 的**时区接线版**
//
// ┌─ 改了什么（相对开发树那份）───────────────────────────────────────────┐
// │ 1. **接 IANA 时区解析** —— 规则与 `scripts/chart.js:139-152`    │
// │    逐字同源：显式 `birth.timezone` → 校验合法性后用；                   │
// │    没给但 `timezone_offset === 8` → `Asia/Shanghai`；                   │
// │    其余 → **报错退出，不猜**（照抄 chart.js:149 的措辞与退出码语义）。   │
// │ 2. **UTC 换算改迭代收敛** —— 用 `lib/bazi/solar-correction.js` 导出的     │
// │    `getTzOffsetMinutes(utcMs, tz)`，按 `applyCorrection`（`:190-199`）  │
// │    的同款迭代（1–2 次收敛，硬上限 6 次）。                              │
// │ 3. **`timezone_offset` 与真实 offset 冲突时必须声明**（不许静默二选一）  │
// │ 4. **钟表时间不存在时必须声明**（`isNonexistentLocalTime`）              │
// │ 5. 新增可复核字段：`birth.timezone` / `birth.utcOffsetMinutes` /        │
// │    `birth.offsetResolved` / `degradedNote`                             │
// └──────────────────────────────────────────────────────────────────────┘
//
// ┌─ ★★ 禁做项 2（本单最大的坑）：不许把「真太阳时」套到星盘上 ────────────┐
// │ 八字的时柱要**真太阳时**（钟表时 ＋ 夏令时 ＋ 经度修正 ＋ 均时差）         │
// │ 星盘的上升点**公式里已经含经度**（`ramcDeg = gmstDeg + loc.longitude`），│
// │ 恒星时基于 **UT**（`A.sidereal.apparent(jd)`）。                        │
// │ ⇒ 星盘只吃「**绝对时刻（UTC）＋ 经纬度**」。                             │
// │ ⇒ 再套 `dst + lonMin + eotMin` 会把**经度算两遍**（上升约 15°/度）。      │
// │ ⇒ 本文件**只接时区**；`equationOfTime` / 经度修正**一个都不进这里**。      │
// └──────────────────────────────────────────────────────────────────────┘
//
// 分层（决定没有出生时辰时给什么）:
//   定盘层 — 太阳 / 土星 / 冥王星 / 北交点: 公转慢, 不吃时辰, 任何情况都输出
//   时辰层 — 月亮 / 上升: 吃时辰, 无时辰时输出 null 并记入 degraded
//   无时辰绝不静默按 0 点算 —— 那会给出一个从输出上根本看不出是假的上升/月亮。
// 时间: 本地钟表时间 → 经 IANA 时区迭代还原 → UTC 时刻;
//       行星位置用 JDE(力学时 TT, 已加 ΔT), 恒星时用 UT 的 JD。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const A = require('astronomia');
// data 是独立子路径, 且外层包了一层 default(ESM→CJS 转译)
const _data = require('astronomia/data');
const DATA = _data.default || _data;
// ★ 时区接线：只**调用**自研链已导出的两个函数，不改 `lib/bazi/solar-correction.js`（禁做项 5）
// ★★ 包根口径：包根推法统一到 `./pkg-root`（`resolvePkgRoot`）—— 三个脚本同一个 helper。
//   改前：本文件自己实现了一段「向上找 `lib/bazi/index.js`」，与 `chart.js` 的 `findEngineRoot` 重复，
//   而 `render-decision.js` 又是第三种（硬编码 `'..','..'`）⇒ 三个脚本三种理解。
const { resolvePkgRoot } = require('./pkg-root');
// ⚠️⚠️ 路径必须用**运行时定位**，不能写死 `../../lib` ——
//   本文件在仓内是 `scripts/astro.js`（`../../lib` = 仓根的 `lib/` ✅），
//   但入包后被重定向到 `tianming-advisor-clean/scripts/astro.js`（`../../lib` = **包外的兄弟目录** ❌）。
//   **这正是 `77` 单抓到的 `PKG_ROOT` 同款坑**（文件在不在 ≠ 路径能不能解析）。
// ⚠️ `TIANMING_ENGINE_ROOT` 环境变量仍然优先（那是 `chart.js` 既有的逃生口，保留）。
const ENGINE_ROOT = process.env.TIANMING_ENGINE_ROOT
  ? path.resolve(process.env.TIANMING_ENGINE_ROOT)
  : resolvePkgRoot(__dirname);
const { getTzOffsetMinutes, isNonexistentLocalTime } =
  require(path.join(ENGINE_ROOT, 'lib', 'bazi', 'solar-correction'));

// ★ 默认 config 的查找根 = 包根（与 `ENGINE_ROOT` 同源，**不再有两套理解**）。
//
//   ⚠️⚠️ 90 单曾在这里写过一大段警告：不能写成 `'..','..'`，因为 `verify-astro.js` 靠
//      「不传 `--config` 时 astro.js 自己去 `ROOT/config.yaml` 找」这个**隐式契约**，
//      而它的 `ROOT = resolve(__dirname,'..')`（= 包根）。
//      ⇒ 那时用 `'..'` 是为了**在仓内**也对齐"scripts/ 的上一级"。
//   ⇒ 94 单统一之后：`resolvePkgRoot()` 在包里 = 包根、在仓里 = 仓根，
//      **与 verify-astro 自己的 `resolve(__dirname,'..')` 在包里完全一致**（都是包根）。
//      在仓内两者不同（verify 在开发树 `scripts/` 下 ⇒ 开发树根；本文件在仓内 ⇒ 仓根）——
//      但 verify-astro 只随开发树跑，不随  跑，所以那条隐式契约不受影响（实测）。
const ROOT = resolvePkgRoot(__dirname);
const EXIT_CONFIG = 2;                               // 与 chart.js 的用法/配置错同一套语义
const fail = (msg) => { console.error(msg); process.exit(EXIT_CONFIG); };

// 配置路径优先级：--config=<path> > TIANMING_CONFIG 环境变量 > ROOT/config.yaml
//   · --config 最高：verify-astro.js 靠它复现降级路径，不能被环境变量顶掉
//   · TIANMING_CONFIG 次之：与 scripts/chart.js 的 loadConfig 对齐。
//     否则 render-decision.js 自动排盘时 chart 读 env、astro 读包根，
//     两个引擎拿到两份不同配置，同一份报告里紫微说「无时辰」、星盘却有月亮上升。
//   · 都无则回落 ROOT/config.yaml（粉丝常态：配置就在包根）
const configArg = process.argv.find((a) => a.startsWith('--config='));
const envConfig = process.env.TIANMING_CONFIG;
const configPath = configArg
  ? configArg.slice('--config='.length)
  : (envConfig || path.join(ROOT, 'config.yaml'));
let config;
try {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('读取配置文件失败：' + err.message + '\n路径：' + configPath);
  process.exit(1);
}
const b = config.birth;
const loc = config.location || {};
if (!b || b.year === undefined || b.month === undefined || b.day === undefined) {
  console.error('config.yaml 缺少必要字段：需要 birth{year,month,day}（时区见下方规则）。');
  process.exit(EXIT_CONFIG);
}

// ---------------------------------------------------------------------------
// ★ IANA 时区解析（规则与 `scripts/chart.js` 的 `resolveTz` 同源）
//   显式 `birth.timezone` 优先；`timezone_offset === 8` 才允许默认成 Asia/Shanghai；
//   其余整数 offset → 映射成固定偏移时区名 `Etc/GMT∓N`（`'literal'`，`117` 单恢复）
//
// ★★ `offsetResolved` 三个可达值：**`'iana'`** ／ **`'default-8'`** ／ **`'literal'`**
//   `'literal'` 曾被 `90` 单当死值删掉（当时 offset≠8 直接报错，产不出来）。
//   `117` 单恢复它，理由变了：老配置只写 `timezone_offset: 9` 的海外用户，
//   升级后会直接报错跑不了 —— 这是破坏性变更，不该让用户自己改配置来适配。
//   ⇒ 现在按字面 offset 算，但**必给 warning**（固定偏移不含夏令时，可能差 1 小时）
//   ⇒ `'literal'` 与 `'iana'` 的区别就是「有没有夏令时规则」，用户据此知道该不该补字段。
// ---------------------------------------------------------------------------
function resolveTz(birth) {
  if (birth && typeof birth.timezone === 'string' && birth.timezone.trim()) {
    const tz = birth.timezone.trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
    catch (e) { fail('birth.timezone="' + tz + '" 不是有效 IANA 时区名：' + e.message); }
    return { tz, resolved: 'iana' };
  }
  const off = Number(birth && birth.timezone_offset);
  if (off === 8) return { tz: 'Asia/Shanghai', resolved: 'default-8' };
  if (Number.isFinite(off)) {
    // 兼容旧配置：字面 offset → 固定偏移时区名（Etc/GMT∓N，符号与直觉相反）
    // 固定偏移不含夏令时，故 resolved 标成 'literal'，与 'iana' / 'default-8' 区分
    if (Number.isInteger(off) && off >= -14 && off <= 14) {
      const tzName = 'Etc/GMT' + (off > 0 ? '-' : '+') + Math.abs(off);
      console.warn('[时区] 未声明 birth.timezone，按 timezone_offset=' + off + ' 使用固定偏移 ' + tzName + '（不含夏令时）。若出生地实行夏令时，建议显式写 birth.timezone。');
      return { tz: tzName, resolved: 'literal' };
    }
    fail('birth.timezone_offset=' + off + ' 不是整数，无法映射到固定偏移时区。请显式写 birth.timezone（如 Asia/Kolkata）。');
  }
  fail('缺少 birth.timezone / birth.timezone_offset。');
}
const { tz, resolved: offsetResolved } = resolveTz(b);

// 时辰与出生地都是「可缺」的 —— 缺了走降级, 不报错退出
const isBlank = (v) => v === undefined || v === null || v === '';
const hasTime = !isBlank(b.hour);
const hasLocation = !isBlank(loc.latitude) && !isBlank(loc.longitude);
const hour = hasTime ? b.hour : 0;              // 仅用于定盘层的太阳近似
const minute = isBlank(b.minute) ? 0 : b.minute;

const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// 归一化到 [0,360)
function pmodDeg(deg) {
  return A.base.pmod(deg, 360);
}

// 由黄道经度(度)取星座 + 星座内度数
function signOf(lonDeg) {
  const d = pmodDeg(lonDeg);
  const idx = Math.floor(d / 30) % 12;
  return {
    sign: SIGNS[idx],
    longitude: d,
    signDegree: d - idx * 30,
  };
}

const warnings = [];

// ---------------------------------------------------------------------------
// ★ UTC 换算：迭代收敛（`lib/bazi/solar-correction.js` `applyCorrection` 同款）
//   夏令时切换边界需 1–2 次收敛；硬上限 6 次（与 lib 一致，防止病态配置死循环）。
//   ★ 这里**只**做时区还原 —— 不加 dst/lonMin/eotMin（禁做项 2：那会把经度算两遍）
// ---------------------------------------------------------------------------
const wallMs = Date.UTC(b.year, b.month - 1, b.day, hour, minute, 0);
let offsetMin = 480;                              // 初始假设 UTC+8（与 lib 的起手式一致）
let utcMs = wallMs - offsetMin * 60000;
for (let i = 0; i < 6; i++) {
  const nextOffset = getTzOffsetMinutes(utcMs, tz);
  const nextUtc = wallMs - nextOffset * 60000;
  if (nextUtc === utcMs && nextOffset === offsetMin) break;
  utcMs = nextUtc;
  offsetMin = nextOffset;
}
const utcDate = new Date(utcMs);

// ★ 时区接线 J90c：配置写的 offset 与当日真实 offset 冲突时**必须喊出来**，
//   不许静默二选一。仍按**真实值**算（94 单删掉 `'literal'` 后，没有"按字面值算"这条路可走）。
const declaredOffset = Number(b.timezone_offset);
if (Number.isFinite(declaredOffset) && declaredOffset * 60 !== offsetMin) {
  warnings.push(
    '时区偏移不一致：配置写 timezone_offset=' + declaredOffset +
    '，而 ' + b.year + '-' + String(b.month).padStart(2, '0') + '-' + String(b.day).padStart(2, '0') +
    ' 当日 ' + tz + ' 的真实偏移为 UTC' + (offsetMin >= 0 ? '+' : '') + (offsetMin / 60) +
    ' 小时（' + offsetMin + ' 分钟）。已按真实值计算。'
  );
}

// ★ 时区接线 J90d：钟表时间在 tz 下不存在（夏令时春季跳变被跳过的那一小时）
//   ⇒ **不许报错退出**，但必须 warning。
if (hasTime && isNonexistentLocalTime(b.year, b.month, b.day, hour, minute, tz)) {
  warnings.push(
    '钟表时间不存在：' + b.year + '-' + String(b.month).padStart(2, '0') + '-' + String(b.day).padStart(2, '0') +
    ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') +
    ' 在 ' + tz + ' 下不存在（夏令时春季跳变跳过该小时）。已按收敛后的时刻计算。'
  );
}

const jd = A.julian.DateToJD(utcDate);     // UT 儒略日 → 用于恒星时
const jde = A.julian.DateToJDE(utcDate);   // 力学时儒略日 → 用于行星位置
const T = A.base.J2000Century(jde);        // 距 J2000 的儒略世纪

// ---- 太阳（定盘层；一天仅走约 1°, 无时辰时按当日 0 点算）----
const sunLon = A.solar.apparentLongitude(T) * R2D;
const sun = signOf(sunLon);

if (!hasTime) {
  // 无时辰时太阳按 0 点算。若出生当日太阳跨了星座边界, 结论可能落到前一个星座 —— 必须说破
  const jdeEnd = A.julian.DateToJDE(new Date(utcMs + 24 * 3600 * 1000));
  const sunEndLon = A.solar.apparentLongitude(A.base.J2000Century(jdeEnd)) * R2D;
  if (Math.floor(pmodDeg(sunLon) / 30) !== Math.floor(pmodDeg(sunEndLon) / 30)) {
    warnings.push('出生当日太阳跨越星座边界：无时辰时按 0 点计算，太阳星座可能落在前一个星座，请谨慎采信。');
  }
}

// ---- 月亮（时辰层；约 2.2 天换一个星座）----
let moon = null;
if (hasTime) {
  moon = signOf(A.moonposition.position(jde).lon * R2D);
}

// ---- 上升（时辰层；约 2 小时换一个星座，最吃时辰）----
// ★ 公式一个字不许动（90 禁做项 7：Meeus ch.13 那组 atan2）
let rising = null;
if (hasTime && hasLocation) {
  // 视恒星时(格林尼治) 秒 → 度 (86400s = 360°, 1° = 240s)
  const gmstSec = A.sidereal.apparent(jd);
  const gmstDeg = (gmstSec / 240) % 360;
  // RAMC = 地方恒星时 = GMST + 东经
  const ramcDeg = pmodDeg(gmstDeg + loc.longitude);
  // 真黄赤交角 ε = 平黄赤交角 + 章动 Δε
  const eps = A.nutation.meanObliquity(jde) + A.nutation.nutation(jde)[1];
  const phi = loc.latitude * D2R;
  const ramc = ramcDeg * D2R;
  // Meeus ch.13: 上升点 = atan2( cos(RAMC), -(sin(RAMC)cosε + tanφ sinε) )
  const ascRad = Math.atan2(
    Math.cos(ramc),
    -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))
  );
  rising = signOf(ascRad * R2D);
}

// ---- 定盘层：地心化外行星（都不吃时辰）----
const earthP = new A.planetposition.Planet(DATA.vsop87Dearth);
const saturnP = new A.planetposition.Planet(DATA.vsop87Dsaturn);
const earthPos = earthP.position(jde);

// 行星日心球坐标 → 直角坐标 → 减地球 → 地心黄经
function geoLon(planetPos, earthPosition) {
  const toXYZ = (p) => [
    p.range * Math.cos(p.lat) * Math.cos(p.lon),
    p.range * Math.cos(p.lat) * Math.sin(p.lon),
    p.range * Math.sin(p.lat),
  ];
  const [px, py, pz] = toXYZ(planetPos);
  const [ex, ey, ez] = toXYZ(earthPosition);
  return Math.atan2(py - ey, px - ex) * R2D;
}

// 土星：VSOP87D 已是 date 平黄道, 与月亮同基准, 无需岁差修正
const saturn = signOf(geoLon(saturnP.position(jde), earthPos));

// 冥王星：pluto.heliocentric 给的是 J2000 黄经, 必须补黄经岁差对齐到 date(与太阳同基准)。
// 若不补, 2026 年会差约 0.36°, 足以在星座边界上翻盘。
// 黄经岁差 p = 5029.0966"·T + 1.11113"·T² (Meeus ch.21)
const precessionDeg = 1.39697128 * T + 0.000308647 * T * T;
const pluto = signOf(geoLon(A.pluto.heliocentric(jde), earthPos) + precessionDeg);

// 北交点：Meeus ch.47 平均交点公式(平春分点 of date)。
// 注意 astronomia 的 moonnode 模块算的是「月亮过交点的日期」, 不是交点黄经, 别误用。
const northNode = signOf(
  125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 - (T * T * T * T) / 60616000
);

// 哪些维度因缺信息而不可用
const degraded = [];
if (!hasTime) degraded.push('moon', 'rising');
else if (!hasLocation) degraded.push('rising');

// ★ 时区接线 J90e / User 2026-10-18 裁定「不给就降级，但一定要声明」：
//   `degraded` 是 JSON 数组，**渲染层不一定显示** ⇒ 另给一句人话，让渲染层能直接显示。
const degradedNote = degraded.length === 0 ? '' :
  (degraded.length === 2
    ? '本次未提供出生时辰，月亮与上升星座不可用（已按缺失处理，未按 0 点推算）。'
    : '本次未提供出生地经纬度，上升星座不可用（月亮可用）。');

const out = {
  birth: {
    year: b.year,
    month: b.month,
    day: b.day,
    hour: hasTime ? hour : null,
    minute: hasTime ? minute : null,
    timezone_offset: b.timezone_offset,
    // ★ 时区接线新增的三个可复核字段
    timezone: tz,                          // 实际使用的 IANA 时区名
    utcOffsetMinutes: offsetMin,           // 当日该时区的真实偏移（分钟）
    offsetResolved,                        // 'iana' | 'default-8' | 'literal'（literal = 按字面 offset，不含夏令时）
    utc: utcDate.toISOString(),
  },
  hasTime,
  hasLocation,
  degraded,
  degradedNote,   // ★ 给人看的声明位（J90e）
  sun,
  saturn,
  pluto,
  northNode,
  moon,    // 无时辰 → null
  rising,  // 无时辰或缺经纬度 → null
  warnings,
  note: '黄道经度 0°=白羊, 每 30°一宫。太阳用视黄经(真春分点), 月亮用地心黄经(平春分点), 上升按 Meeus ch.13 atan2 公式; 土星用 VSOP87D(date 平黄道), 冥王星取 J2000 黄经后补黄经岁差对齐到 date, 北交点为 Meeus 平均交点(mean node, 非 true node); 行星位置基于力学时 JDE, 恒星时基于 UT。degraded 列出因缺出生时辰/出生地而不可用的维度(其值为 null)。★ 时区接线：UTC 时刻由 IANA 时区经迭代收敛还原（夏令时切换边界 1–2 次收敛，上限 6 次）；本文件只接时区，不做真太阳时的经度/均时差修正（上升公式已含经度，再套会把经度算两遍）。',
};

// 四舍五入 longitude/signDegree 到 4 位小数, 便于阅读
for (const k of ['sun', 'moon', 'rising', 'saturn', 'pluto', 'northNode']) {
  if (!out[k]) continue;
  out[k].longitude = Math.round(out[k].longitude * 10000) / 10000;
  out[k].signDegree = Math.round(out[k].signDegree * 10000) / 10000;
}

console.log(JSON.stringify(out, null, 2));
