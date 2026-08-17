// 读取 config.yaml → 用 astronomia 计算 太阳/月亮/上升 星座 → 输出 JSON
// 引擎: astronomia v4.2.0 (MIT, 无依赖)
//   - 太阳: solar.apparentLongitude(T)  apparent longitude(含章动/光行差, 真春分点) → 回归黄道
//   - 月亮: moonposition.position(jde).lon  geocentric longitude(mean equinox of date)
//   - 上升: 地方恒星时 LST = GMST + 东经 → RAMC → atan2 公式 (Meeus ch.13)
// 时间: config.birth.timezone_offset 为 UTC+ 小时数, 本地钟表时间 → UTC 时刻;
//       行星位置用 JDE(力学时 TT, 已加 ΔT), 恒星时用 UT 的 JD。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const A = require('astronomia');

const ROOT = path.resolve(__dirname, '..');
let config;
try {
  config = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
} catch (err) {
  console.error('读取 config.yaml 失败：' + err.message + '\n路径：' + path.join(ROOT, 'config.yaml'));
  process.exit(1);
}
const b = config.birth;
const loc = config.location;
if (!b || b.timezone_offset === undefined || !loc || loc.latitude === undefined || loc.longitude === undefined) {
  console.error('config.yaml 缺少必要字段：需要 birth{year,month,day,hour,minute,timezone_offset} 和 location{latitude,longitude}。');
  process.exit(1);
}

const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];

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
const localMs = Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, 0);
// 减掉时区偏移(小时×3600s)得到真实的 UTC 时刻
const utcMs = localMs - b.timezone_offset * 3600 * 1000;
const utcDate = new Date(utcMs);

const jd = A.julian.DateToJD(utcDate);     // UT 儒略日 → 用于恒星时
const jde = A.julian.DateToJDE(utcDate);   // 力学时儒略日 → 用于行星位置

// ---- 太阳 (T = 距 J2000 的儒略世纪) ----
const T = A.base.J2000Century(jde);
const sunLonRad = A.solar.apparentLongitude(T);
const sun = signOf(sunLonRad * 180 / Math.PI);

// ---- 月亮 (geocentric ecliptic longitude, mean equinox of date) ----
const moonPos = A.moonposition.position(jde);
const moon = signOf(moonPos.lon * 180 / Math.PI);

// ---- 上升 ----
// 视恒星时(格林尼治) 秒 → 度 (86400s = 360°, 1° = 240s)
const gmstSec = A.sidereal.apparent(jd);
const gmstDeg = (gmstSec / 240) % 360;
// RAMC = 地方恒星时 = GMST + 东经
const ramcDeg = pmodDeg(gmstDeg + loc.longitude);
// 真黄赤交角 ε = 平黄赤交角 + 章动 Δε
const eps = A.nutation.meanObliquity(jde) + A.nutation.nutation(jde)[1];
const phi = loc.latitude * Math.PI / 180;
const ramc = ramcDeg * Math.PI / 180;
// Meeus ch.13: 上升点 = atan2( cos(RAMC), -(sin(RAMC)cosε + tanφ sinε) )
const ascRad = Math.atan2(
  Math.cos(ramc),
  -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))
);
const rising = signOf(ascRad * 180 / Math.PI);

const out = {
  birth: {
    year: b.year,
    month: b.month,
    day: b.day,
    hour: b.hour,
    minute: b.minute,
    timezone_offset: b.timezone_offset,
    utc: utcDate.toISOString(),
  },
  sun,
  moon,
  rising,
  note: '黄道经度 0°=白羊, 每 30°一宫; 太阳用视黄经(真春分点), 月亮用地心黄经(平春分点), 上升按 Meeus ch.13 atan2 公式; 行星位置基于力学时 JDE, 恒星时基于 UT。',
};

// 四舍五入 longitude/signDegree 到 4 位小数, 便于阅读
for (const k of ['sun', 'moon', 'rising']) {
  out[k].longitude = Math.round(out[k].longitude * 10000) / 10000;
  out[k].signDegree = Math.round(out[k].signDegree * 10000) / 10000;
}

console.log(JSON.stringify(out, null, 2));
