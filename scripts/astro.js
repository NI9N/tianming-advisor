// 读取 config.yaml → 计算星盘 → 输出 JSON
// 引擎: astronomia v4.2.0 (MIT, 无依赖)
//   太阳   solar.apparentLongitude(T)          视黄经(含章动/光行差, 真春分点)
//   月亮   moonposition.position(jde).lon      地心黄经(平春分点 of date)
//   上升   LST = GMST + 东经 → RAMC → atan2 公式 (Meeus ch.13)
//   土星   VSOP87D(date 平黄道) + 地球位置 → 地心化 → 地心黄经
//   冥王星 pluto.heliocentric(J2000 黄经) → 地心化 → 补黄经岁差 → date
//   北交点 Meeus ch.47 平均交点公式 (mean node, 非 true node)
// 时间: config.birth.timezone_offset 为 UTC+ 小时数, 本地钟表时间 → UTC 时刻;
//       行星位置用 JDE(力学时 TT, 已加 ΔT), 恒星时用 UT 的 JD。
//
// 分层（决定没有出生时辰时给什么）:
//   定盘层 — 太阳 / 土星 / 冥王星 / 北交点: 公转慢, 不吃时辰, 任何情况都输出
//   时辰层 — 月亮 / 上升: 吃时辰, 无时辰时输出 null 并记入 degraded
//   无时辰绝不静默按 0 点算 —— 那会给出一个从输出上根本看不出是假的上升/月亮。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const A = require('astronomia');
// data 是独立子路径, 且外层包了一层 default(ESM→CJS 转译)
const _data = require('astronomia/data');
const DATA = _data.default || _data;

const ROOT = path.resolve(__dirname, '..');
// --config=<path> 指定配置文件(默认 ROOT/config.yaml); verify-astro.js 用它复现降级路径
const configArg = process.argv.find((a) => a.startsWith('--config='));
const configPath = configArg ? configArg.slice('--config='.length) : path.join(ROOT, 'config.yaml');
let config;
try {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('读取 config.yaml 失败：' + err.message + '\n路径：' + configPath);
  process.exit(1);
}
const b = config.birth;
const loc = config.location || {};
if (!b || b.year === undefined || b.month === undefined || b.day === undefined || b.timezone_offset === undefined) {
  console.error('config.yaml 缺少必要字段：需要 birth{year,month,day,timezone_offset}。');
  process.exit(1);
}

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

// ---- 时间处理 ----
// localMs: 本地钟表时间 (当作 UTC 毫秒来算)
const localMs = Date.UTC(b.year, b.month - 1, b.day, hour, minute, 0);
// 减掉时区偏移(小时×3600s)得到真实的 UTC 时刻
const utcMs = localMs - b.timezone_offset * 3600 * 1000;
const utcDate = new Date(utcMs);

const jd = A.julian.DateToJD(utcDate);     // UT 儒略日 → 用于恒星时
const jde = A.julian.DateToJDE(utcDate);   // 力学时儒略日 → 用于行星位置
const T = A.base.J2000Century(jde);        // 距 J2000 的儒略世纪

const warnings = [];

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

const out = {
  birth: {
    year: b.year,
    month: b.month,
    day: b.day,
    hour: hasTime ? hour : null,
    minute: hasTime ? minute : null,
    timezone_offset: b.timezone_offset,
    utc: utcDate.toISOString(),
  },
  hasTime,
  hasLocation,
  degraded,
  sun,
  saturn,
  pluto,
  northNode,
  moon,    // 无时辰 → null
  rising,  // 无时辰或缺经纬度 → null
  warnings,
  note: '黄道经度 0°=白羊, 每 30°一宫。太阳用视黄经(真春分点), 月亮用地心黄经(平春分点), 上升按 Meeus ch.13 atan2 公式; 土星用 VSOP87D(date 平黄道), 冥王星取 J2000 黄经后补黄经岁差对齐到 date, 北交点为 Meeus 平均交点(mean node, 非 true node); 行星位置基于力学时 JDE, 恒星时基于 UT。degraded 列出因缺出生时辰/出生地而不可用的维度(其值为 null)。',
};

// 四舍五入 longitude/signDegree 到 4 位小数, 便于阅读
for (const k of ['sun', 'moon', 'rising', 'saturn', 'pluto', 'northNode']) {
  if (!out[k]) continue;
  out[k].longitude = Math.round(out[k].longitude * 10000) / 10000;
  out[k].signDegree = Math.round(out[k].signDegree * 10000) / 10000;
}

console.log(JSON.stringify(out, null, 2));
