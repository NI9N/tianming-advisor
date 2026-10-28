'use strict';
/**
 * lib/bazi/solar-correction.js —— 输入换算层（夏令时 / 经度 / 均时差）
 *
 * 去程三步（校正口径 §一①）：
 *   ① IANA 时区还原（含历史夏令时，用运行时 Intl/ICU，禁止手写年份表）
 *   ② 经度修正（每度 4 分钟，东经 120° 为基准经线）
 *   ③ 均时差 —— 均时差口径起改用**精确版** E = L0 − α，
 *      α 由 lunar-javascript 的 ShouXingUtil.saLon(T, −1)（视黄经，VSOP 全项 + 章动 + 光行差）换算。
 *      ⚠️ 66 号之前的 NOAA 229.18 近似**保留不删**，改名为 equationOfTimeNoaa，只作对照物，不参与换算。
 *
 * ★ 66 号实测（_crosscheck/verify-j10a.py，434 天；verify-j10b-abs.py 全域铺开）：
 *     精度 ≤3 秒（对「日晷正午」这个绝对锚，DE421 root-find）
 *     其中：实现差（saLon vs DE421 视位置）最大 0.67 秒
 *           约定差（Meeus 的 E=L0−α vs 严格定义「视太阳时−平太阳时」）最大 2.72 秒
 *           后者是**约定**而非误差 —— 65 单 T1 已把它分解成两个可命名项，残差 0.000000 秒。
 *
 * ★ 求值粒度：均时差是**时刻**的函数，不是日期的函数。
 *     按「日期 UT 12:00」求值最坏会偏 15.035 秒（tools/eot-salon-intraday.js，1900-12-22 UT 24:00，
 *     日内振幅最大 30.064 秒）。故本文件一律按**钟表时间对应的 UT 瞬时**求值。
 *
 * 回程三项分解（§一②）：
 *   breakdown = { dst, longitude, equationOfTime }  —— 三项都是「加到钟表时间上」的增量（分钟）
 *   totalMinutes = dst + longitude + equationOfTime  —— 恰好等于钟表时间 → 真太阳时的总偏移
 *
 * 符号约定（本文件唯一权威，注释不可漂移）：
 *   - 钟表时间 T_wall：用户看到的钟表时间（本地，可能含夏令时）
 *   - dst：夏令时修正量 = 480 − offset(分钟)。夏令时期间 offset=+540 → dst=−60（钟表拨快了 60 分钟，
 *     还原成标准北京时间要「减 60」）；非夏令时 offset=+480 → dst=0
 *   - longitude：经度修正 = (经度 − 120) × 4 分钟。东经 120° 为 UTC+8 基准经线；偏西为负
 *     （乌鲁木齐 87.6°E → −129.6 分钟；深圳 114°E → −23.8 分钟）
 *   - equationOfTime：均时差（真太阳时 − 平太阳时），范围约 −14.6 ~ +16.5 分钟
 *   - 真太阳时 T_solar = T_wall + dst + longitude + equationOfTime（用于日柱/时柱）
 *   - 标准北京时间 T_std = T_wall + dst（用于年柱/月柱/起运 —— 节气是绝对天文事件，按北京时间）
 *
 * 校正口径新增：换算**只做一次**，bazi 与 ziwei 共用同一个 correction 对象。
 *   - correctionId(c)：由换算结果算出的确定性短指纹。两边回显同一个 id，即可证明「同一个值」
 *     （而非各算各的再比结果 —— 那是 J7a 明确不许的做法）。
 *   - buildTrueSolarTime(c)：统一构造 birthInfo.trueSolarTime 块，避免两处各写一遍而漂移。
 */
const crypto = require('crypto');
const { ShouXingUtil } = require('lunar-javascript');

// 校正口径 J6：距时辰边界 N 分钟以内 → 标记「时柱不确定」。
// N=5 的取值理由（User 2026-10-13 已拍维持，66 号不改动这个数）：
//   真太阳时取整到分钟（<60s）+ 用户输入分钟级精度（±60s）≈ ±2 分钟总不确定性，留 3 分钟余量 = 5 分钟。
// ⚠️ 64 号实测修正：NOAA 相对 DE421 的**真实**最大偏差为 55.7s（1900–2050，434 例），
//   不是 62 交付里写的 ±80s（那是基准被岁差污染后的数字）。预算结论不变。
// ⚠️ 66 号再次变动：均时差换成 saLon 精确版后，这项误差从 55.7 秒降到 ≤2.93 秒
//   （对日晷绝对锚，_crosscheck/verify-j10a.py）。N=5 相对新的不确定性预算**更宽松**了，
//   但 User 已拍板维持 5，故不动数、只更新理由。
const SOLAR_BOUNDARY_N = 5;

/** 年积日（1–365/366） */
function dayOfYear(year, month, day) {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let n = 0;
  for (let m = 0; m < month - 1; m++) n += daysInMonth[m];
  return n + day;
}

/**
 * 均时差（分钟）· **NOAA 229.18 近似**。
 * ⚠️ 均时差口径起**只作对照物**：它是「平均年」单年近似，不参与换算（见文件头实测数据）。
 *    保留的原因：① 历史交付里的数字要对得上；② 换算前后差异的对照基准。
 * 范围 ≈ −14.257 ~ +16.379 分钟（1900–2050 逐日实测）。
 */
function equationOfTimeNoaa(year, month, day) {
  const N = dayOfYear(year, month, day);
  const gamma = (2 * Math.PI * (N - 1)) / 365;
  const eot =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  return eot;
}

/** 1970-01-01 00:00 UT 的儒略日 —— Unix 毫秒 → JD 的换算常数 */
const JD_UNIX_EPOCH = 2440587.5;

/**
 * 均时差（分钟）· **精确版**，按 UT 毫秒瞬时求值。
 *
 *   E = L0 − α        （度 → 分钟：×4）
 *     L0 = 太阳平黄经（Meeus 25.2，当日平春分点）
 *     α  = 太阳视赤经 = atan2(sinλ·cosε, cosλ)
 *     λ  = ShouXingUtil.saLon(T, −1) 视黄经（寿星 VSOP 全项 + 章动 Δψ + 光行差）
 *     ε  = 黄赤交角（Meeus 22.3 平值，不含章动 Δε）
 *
 * ★ 与 DE421 裁判**同约定**（都是 E = L0 − α），所以 65 单那套历史数字不用作废。
 * ★ 换成严格定义（视太阳时 − 平太阳时）会整体平移 ≤2.72 秒 —— 那是**换尺子**，65 单已论证不该换。
 *
 * ⚠️ **时间尺度：我们传 UT（`utcMs` 直接算 T），不传 TT。**
 *    实测（`_crosscheck/verify-j10a.py` 的 D 项，434 天）：T 用 UT 的 JD 还是 TT 的 JD，
 *    对结果影响最大 **0.0010 秒**；67 单在 2051–2100 的 141 个探针日上复测为 **0.0013 秒**。
 *    机理：L0 与 λ 同步随 T 变化，ΔT ≈70 秒带来的净影响互相抵消。
 *    ⚠️ 但**没查到寿星库 `saLon(t)` 内部期望 UT 还是 TT 的一手说明** —— 这是「未坐实」而非「已验证」。
 *    影响量级 ≤0.0013 秒，远小于本实现的误差预算（≤3.41 秒），故不引入 ΔT 表。
 *
 * @param {number} utcMs 求值瞬间的 UT 毫秒（Date.UTC 语义）
 */
function equationOfTimeAt(utcMs) {
  const T = (utcMs / 86400000 + JD_UNIX_EPOCH - 2451545.0) / 36525.0;
  const lambdaApp = ShouXingUtil.saLon(T, -1); // 弧度
  const u = T / 100;
  const eps = (((23 * 3600 + 26 * 60 + 21.448) - 46.815 * u - 0.00059 * u * u + 0.001813 * u * u * u) / 3600) * (Math.PI / 180);
  const alpha = Math.atan2(Math.sin(lambdaApp) * Math.cos(eps), Math.cos(lambdaApp));
  const L0 = (280.46645 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  const alphaDeg = ((alpha * 180) / Math.PI + 360) % 360;
  let diff = L0 - alphaDeg;
  diff = ((diff + 180) % 360 + 360) % 360 - 180; // 归一到 (−180, 180]
  return diff * 4; // 度 → 分钟
}

/**
 * 均时差（分钟）· 精确版，按**日期**求值（取当日 UT 12:00）。
 * ⚠️ 均时差是时刻的函数：按日期求最坏偏 15.035 秒（tools/eot-salon-intraday.js）。
 *    换算主路径走 equationOfTimeAt(utcMs)；本函数只用于对照、测试与历史数字复现。
 */
function equationOfTime(year, month, day) {
  return equationOfTimeAt(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * 某 UTC 毫秒时刻在 tz（IANA 名）下的 offset（分钟，东为正）。
 * 用 Intl.DateTimeFormat 的 timeZoneName:'longOffset' 拿「GMT±HH:MM」，再解析。
 */
function getTzOffsetMinutes(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0; // 理论上不会发生（longOffset 必有 GMT± 形式）
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
}

/** 毫秒值 → {year,month,day,hour,minute}（毫秒值按 UTC 存字面时间，故用 getUTC*） */
function msToParts(ms) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/**
 * 某时刻（hour:minute，真太阳时）距最近「时辰边界」的分钟数。
 * 时辰边界 = 奇数点 1:00、3:00、…、23:00（子丑/丑寅/…/亥子交界，晚子时 23:00 换日）。
 */
function minutesToHourBoundary(hour, minute) {
  const totalMin = hour * 60 + minute;
  let minDist = Infinity;
  for (let b = 1; b <= 23; b += 2) {
    const dist = Math.abs(totalMin - b * 60);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

/**
 * 去程换算核心：钟表时间 + tz + 经度 → 标准北京时间 / 真太阳时 / breakdown。
 * @param {{year:number,month:number,day:number,hour:number,minute:number,tz:string,longitude:number}} input
 */
function applyCorrection(input) {
  const { year, month, day, hour, minute } = input;
  const tz = input.tz;
  const longitude = input.longitude;

  // 钟表时间当字面时间存为毫秒（UTC 语义，仅作数值载体）
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // ① IANA 时区还原：迭代求钟表时间在 tz 下的 offset（夏令时切换边界需 1–2 次收敛）
  let offsetMin = 480; // 初始假设 UTC+8
  let utcMs = wallMs - offsetMin * 60000;
  for (let i = 0; i < 6; i++) {
    const nextOffset = getTzOffsetMinutes(utcMs, tz);
    const nextUtc = wallMs - nextOffset * 60000;
    if (nextUtc === utcMs && nextOffset === offsetMin) break;
    utcMs = nextUtc;
    offsetMin = nextOffset;
  }

  // dst 修正（钟表 → 标准北京时间 的增量）
  const dst = 480 - offsetMin;
  // ② 经度修正
  const lonMin = (longitude - 120) * 4;
  // ③ 均时差：按钟表时间对应的 **UT 瞬时** 求值（均时差是时刻的函数，不是日期的函数）。
  //    —— 均时差口径：由 NOAA 近似换成 saLon 精确版；改的是实现，口径不变（仍是 E = L0 − α）。
  const eotMin = equationOfTimeAt(utcMs);

  const totalMinutes = dst + lonMin + eotMin;

  const stdMs = wallMs + dst * 60000; // 标准北京时间（年月柱/起运）
  const solarMs = wallMs + totalMinutes * 60000; // 真太阳时（日柱/时柱）

  return {
    breakdown: { dst, longitude: lonMin, equationOfTime: eotMin },
    totalMinutes,
    offsetMin,
    stdParts: msToParts(stdMs),
    solarParts: msToParts(solarMs),
  };
}

/**
 * 换算结果的确定性短指纹（sha256 前 12 位）。
 * 两边（bazi / ziwei）回显同一个 correctionId ⇒ 它们消费的是同一次换算的结果。
 * 只吃「值」不吃「对象身份」，因此也防得住「两边各算一遍、恰好相等」之外的真实分叉。
 */
function correctionId(c) {
  const canon = JSON.stringify({
    std: c.stdParts,
    solar: c.solarParts,
    total: c.totalMinutes,
    offset: c.offsetMin,
  });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

/**
 * 统一构造 birthInfo.trueSolarTime 块（bazi 与 ziwei 共用，杜绝两处各写一遍而漂移）。
 * @param {object} c applyCorrection 的返回
 */
function buildTrueSolarTime(c) {
  const boundaryMin = minutesToHourBoundary(c.solarParts.hour, c.solarParts.minute);
  return {
    applied: true,
    dst: c.breakdown.dst,
    longitude: c.breakdown.longitude,
    equationOfTime: c.breakdown.equationOfTime,
    totalMinutes: c.totalMinutes,
    adjustedBirth: c.solarParts,
    correctionId: correctionId(c),
    boundary: {
      nearBoundary: boundaryMin < SOLAR_BOUNDARY_N,
      minutesToBoundary: boundaryMin,
      thresholdMinutes: SOLAR_BOUNDARY_N,
    },
  };
}

/**
 * 检测钟表时间在 tz 下是否「不存在」（夏令时春季切换日的 02:00–03:00 被跳过）。
 * 原理：用最终 offset 反推该钟表时间对应的 UTC，再格式化为 tz 本地时间；若与原始不一致，即不存在。
 */
function isNonexistentLocalTime(year, month, day, hour, minute, tz) {
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offsetMin = 480;
  let utcMs = wallMs - offsetMin * 60000;
  for (let i = 0; i < 6; i++) {
    const nextOffset = getTzOffsetMinutes(utcMs, tz);
    const nextUtc = wallMs - nextOffset * 60000;
    if (nextUtc === utcMs && nextOffset === offsetMin) break;
    utcMs = nextUtc;
    offsetMin = nextOffset;
  }
  // 反查：该 UTC 时刻在 tz 下的本地时间
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const g = (t) => parseInt((parts.find((p) => p.type === t) || {}).value, 10);
  const h = g('hour') % 24;
  return !(g('year') === year && g('month') === month && g('day') === day && h === hour && g('minute') === minute);
}

module.exports = {
  applyCorrection,
  isNonexistentLocalTime,
  equationOfTime, // 精确版（saLon），按日期 UT 12:00 —— 主口径，仅用于对照/测试
  equationOfTimeAt, // 精确版（saLon），按 UT 瞬时 —— 换算主路径用它
  equationOfTimeNoaa, // 66 号起退为对照物，不参与换算
  dayOfYear,
  getTzOffsetMinutes,
  minutesToHourBoundary,
  correctionId,
  buildTrueSolarTime,
  SOLAR_BOUNDARY_N,
};
