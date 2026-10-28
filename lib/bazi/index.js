'use strict';
/**
 * lib/bazi/index.js —— bazi 链主入口（lunar-javascript 接入层）
 *
 * 输出结构 = 旧引擎 bazi 部分（接口不变原则；enrichment 由 M4 自写层 computeEnrich 补充）。
 * 关键口径（实测钉死）：
 *  - 月柱：EightChar.getMonth() 走 Exact（节气精确时刻换月；禁用 non-Exact 口径）
 *  - 晚子时：setSect(1)（日柱取次日；默认 sect=2 为「算当天」，与旧引擎不符）
 *  - ⚠️ lunar.getEightChar() 返回缓存实例，setSect 为实例级状态：每次 compute 新建 Lunar，勿复用
 *  - hour/minute：缺失 / NaN / 非整数 / 越界 → 显式拒绝（产品层契约，比旧链严格）
 */
const { Solar } = require('lunar-javascript');
const { PILLAR_KEYS, splitPillar, normalizeShiShen } = require('./util');
const { buildLuck } = require('./luck');
const { computeEnrich } = require('../enrich');
const { applyCorrection, buildTrueSolarTime } = require('./solar-correction');

const FIELD_LIMITS = {
  year: [1900, 2100],
  month: [1, 12],
  day: [1, 31],
  hour: [0, 23],
  minute: [0, 59],
};

function assertIntField(name, value) {
  if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) {
    if (name === 'hour' || name === 'minute') {
      throw new Error(
        `出生${name === 'hour' ? '时辰' : '分钟'}缺失：请先向用户确认出生时辰（不要用 0 代替未知时辰）`
      );
    }
    throw new Error(`字段 ${name} 缺失`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`字段 ${name} 必须为整数（收到 ${value}）`);
  const [lo, hi] = FIELD_LIMITS[name];
  if (n < lo || n > hi) throw new Error(`字段 ${name} 越界：应在 ${lo}–${hi}（收到 ${n}）`);
  return n;
}

/** 构造 StrictSolar：对不存在的日期（如 2 月 30 日）由 Date 层归一化，需显式校验 */
function assertRealDate(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`日期不存在：${year}-${month}-${day}`);
  }
}

/**
 * ★★ 时序口径 · 「没给时辰」与「给了 0」是两件事
 *
 * `hour` 为 `null` / `undefined` / `''` ⇒ **未给时辰** ⇒ 走三柱模式：
 *   - 前三柱（年/月/日）**照常算**，且与有四柱时**逐值相同**
 *     （内部仍用 `hour=0` 建 `EightChar`，但**一个 `getTime*` 都不调**）
 *   - 时柱、时柱十神、时柱长生/纳音/藏干/藏干十神 —— **一律 `null`**
 *   - 起运照常（走绝对时刻，不依赖时辰）
 *
 * ⚠️ 为什么不能"falsy 就降级"：`hour: 0` 是**显式给了真子时**，必须照常算四柱。
 *    `null`（未给）与 `0`（给了）必须走两条路 —— `92-工单 §一-①` 的命门。
 *
 * ⚠️ 为什么内部仍用 `hour=0` 建对象：lunar-javascript 的 `EightChar` 必须有 hour 才建得起来，
 *    而**年/月/日三柱的值与 hour 无关**（实测 `1992-11-03` 三柱都是 壬申/庚戌/癸未）。
 *    用 0 建但**不读时柱**，既保证前三柱逐值相同，又不会泄露任何假时柱。
 *
 * @param {{year:number,month:number,day:number,hour:number|minute:number,gender:'male'|'female'}} input
 * @returns {object} 旧格式 bazi 对象（不含 enrichment）
 */
function computeBazi(input) {
  const year = assertIntField('year', input.year);
  const month = assertIntField('month', input.month);
  const day = assertIntField('day', input.day);
  // ★ 92：hour/minute 缺失 ⇒ 不抛错，走三柱模式（降级），由上层负责声明
  const hourMissing = input.hour === undefined || input.hour === null || input.hour === '';
  const hour = hourMissing ? 0 : assertIntField('hour', input.hour);
  const minuteMissing = input.minute === undefined || input.minute === null || input.minute === '';
  const minute = minuteMissing ? 0 : assertIntField('minute', input.minute);
  const hasHour = !hourMissing;   // 「给了时辰吗」—— 与 `hour` 的值无关（0 也是给了）
  const gender = input.gender;
  if (gender !== 'male' && gender !== 'female') {
    throw new Error("gender 必须为 'male' 或 'female'（收到 " + JSON.stringify(gender) + '）');
  }
  assertRealDate(year, month, day);

  // —— 输入换算层（校正口径）：可选 tz/longitude，给了就换算，不给走原路径（输出逐字段不变）——
  // 校正口径：入口（run-chart.js）可预先算好并传 input.correction，供 bazi 与 ziwei **共用同一次换算**。
  //   传了就用传入的（不再自算），没传才按 tz/longitude 自算 —— 与 ziwei 侧保持同一个对象的唯一来源。
  const hasParams = input.tz !== undefined || input.longitude !== undefined;
  let correction = input.correction || null;
  let eightYearMonth; // 年月柱 / 起运 基准（绝对时刻＝标准北京时间）
  let eightDayHour; //   日柱 / 时柱 基准（真太阳时）

  if (!correction && !hasParams) {
    const eight = Solar.fromYmdHms(year, month, day, hour, minute, 0).getLunar().getEightChar();
    eight.setSect(1); // 晚子时日柱取次日（对齐旧引擎）
    eightYearMonth = eight;
    eightDayHour = eight;
  } else {
    if (!correction) {
      correction = applyCorrection({ year, month, day, hour, minute, tz: input.tz, longitude: input.longitude });
    }
    const std = Solar.fromYmdHms(correction.stdParts.year, correction.stdParts.month, correction.stdParts.day, correction.stdParts.hour, correction.stdParts.minute, 0).getLunar().getEightChar();
    std.setSect(1);
    const sol = Solar.fromYmdHms(correction.solarParts.year, correction.solarParts.month, correction.solarParts.day, correction.solarParts.hour, correction.solarParts.minute, 0).getLunar().getEightChar();
    sol.setSect(1);
    eightYearMonth = std;
    eightDayHour = sol;
  }

  // ★★ 时序口径：`hasHour=false` ⇒ 时柱系**一个 `getTime*` 都不调**，输出 `null`。
  //   前三柱**照常算**（与有四柱时逐值相同 —— 这是 J92f 回归的保证）。
  const siZhu = {
    year: splitPillar(eightYearMonth.getYear()),
    month: splitPillar(eightYearMonth.getMonth()),
    day: splitPillar(eightDayHour.getDay()),
    hour: hasHour ? splitPillar(eightDayHour.getTime()) : null,
  };
  const dayMaster = eightDayHour.getDayGan();

  const shiShen = {
    year: normalizeShiShen(eightYearMonth.getYearShiShenGan()),
    month: normalizeShiShen(eightYearMonth.getMonthShiShenGan()),
    day: normalizeShiShen(eightDayHour.getDayShiShenGan()),
    hour: hasHour ? normalizeShiShen(eightDayHour.getTimeShiShenGan()) : null,
  };

  const zhangSheng = {
    year: eightYearMonth.getYearDiShi(),
    month: eightYearMonth.getMonthDiShi(),
    day: eightDayHour.getDayDiShi(),
    hour: hasHour ? eightDayHour.getTimeDiShi() : null,
  };

  const naYin = {
    year: eightYearMonth.getYearNaYin(),
    month: eightYearMonth.getMonthNaYin(),
    day: eightDayHour.getDayNaYin(),
    hour: hasHour ? eightDayHour.getTimeNaYin() : null,
  };

  const hiddenStems = {
    year: eightYearMonth.getYearHideGan(),
    month: eightYearMonth.getMonthHideGan(),
    day: eightDayHour.getDayHideGan(),
    hour: hasHour ? eightDayHour.getTimeHideGan() : null,
  };
  const hiddenShiShen = {
    year: eightYearMonth.getYearShiShenZhi(),
    month: eightYearMonth.getMonthShiShenZhi(),
    day: eightDayHour.getDayShiShenZhi(),
    hour: hasHour ? eightDayHour.getTimeShiShenZhi() : null,
  };
  const cangGan = {};
  for (const key of PILLAR_KEYS) {
    // ★ 92：时柱缺失 ⇒ 藏干也缺失（不造假的）。前三柱不受影响。
    cangGan[key] = hiddenStems[key] === null
      ? null
      : hiddenStems[key].map((gan, i) => ({ gan, shiShen: hiddenShiShen[key][i] }));
  }

  // 起运走绝对时刻（年月基准），但大运干支十神相对真太阳时的日主
  const luck = buildLuck(eightYearMonth, gender, dayMaster);

  // ★ 92：birthInfo.hour 在未给时辰时必须是 **null**，不能是 0（0 = 给了真子时）
  const birthInfo = { year, month, day, hour: hasHour ? hour : null, minute: hasHour ? minute : null, isLunar: false, gender, timeZone: 8 };
  if (correction) {
    birthInfo.tz = input.tz;
    birthInfo.longitude = input.longitude;
    birthInfo.trueSolarTime = buildTrueSolarTime(correction);
  }

  const bazi = {
    birthInfo,
    siZhu,
    dayMaster,
    shiShen,
    zhangSheng,
    naYin,
    dayunStart: luck.dayunStart,
    dayun: luck.dayun,
    cangGan,
    // ★★ 时序口径：「有没有时辰」必须**可复核**，不能靠下游猜
    //   `hasHour=false` 时上面所有 `*.hour` 项都是 `null`（不造假的时柱）
    hasHour,
  };
  bazi.enrichment = computeEnrich(bazi);
  return bazi;
}

module.exports = { computeBazi };
