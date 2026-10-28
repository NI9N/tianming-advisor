'use strict';
/**
 * lib/ziwei/index.js —— ziwei 链主入口（iztro 接入层）
 *
 * 输出结构 = 旧引擎 ziwei 部分（接口不变原则）。
 * 关键口径（据判级表 v1.4 + M3 探查）：
 *  - 静态（宫序/地支/天干/十四主星/辅星/四化/五行局/命宫身宫）：与旧引擎逐宫一致，直接映射
 *  - 辅星 = iztro minorStars + 4 个旧引擎认识的杂曜（天刑/天喜/天姚/红鸾）
 *  - 🔴 大限方向（v1.4 定论）：iztro decadal.range **已正确**（阳男阴女顺行=命宫→父母、阴男阳女逆行=命宫→兄弟，
 *      经《紫微斗数全书》定大限诀 + 96 例全量实测 0 反例确认）。旧引擎方向实现本身也正确，唯一 bug 是
 *      yinYang 用**公历年干**（非农历）→ 立春前出生约 13 例阴阳判错、方向随之反（属「连锁」档——不计不一致）。
 *      ⚠️ 历史纠错：M3 初稿曾写「旧引擎恒顺行 96/96」，系判方向脚本 `gongs[0]<gongs[11]` 恒真 bug 所致（命宫
 *      startAge 恒最小），已废（见 docs/17/18 回应）。仅此一条错误，无"顺逆理解颠倒"第二重。
 *  - daXianGongName：旧引擎自造缩写（大夫/大子…）且错位 → 新链重建标准宫名（= gong，非映射）
 *  - yinYang：农历年干阴阳 + gender（旧引擎错用公历年干）
 *  - liuNianYear：流年命宫（iztro horoscope.yearly.earthlyBranch），参照年字段
 *  - 闰月口径（v1.5，User 2026-10-10 拍板）：**A 折半法**——闰月前 15 天算上月、第 16 天起算下月。
 *      实现 = 显式传 `astro.bySolar(..., fixLeap=true)`（**禁止依赖 iztro 默认值**：库升级改默认会静默改行为）。
 *      依据：`node_modules/iztro/lib/astro/astro.d.ts:59`「fixLeap 是否调整闰月情况【默认 true】…前半个月算上个月，后半个月算下个月」。
 *  - 🔴 真太阳时（校正口径，User 2026-10-13 拍板）：**一个开关，两边联动**。
 *      `input.correction`（由入口算好的同一次换算）有传 ⇒ 本侧用 `correction.solarParts` 作为生辰；
 *      没传 ⇒ 走钟表时间（老行为，逐字段不变）。
 *      **本函数不接受 tz/longitude 自行换算** —— 那是入口的职责。若收到 tz/longitude 却没有
 *      correction，直接抛错：宁可吵，不要「八字已校正、紫微没有」这种静默的自相矛盾盘。
 */
const { astro } = require('iztro');
const { Solar } = require('lunar-javascript');
const { buildTrueSolarTime } = require('../bazi/solar-correction');

const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const BRANCH_INDEX = Object.fromEntries(BRANCHES.map((b, i) => [b, i]));
const GONG_ORDER = ['命宫', '兄弟', '夫妻', '子女', '财帛', '疾厄', '迁移', '交友', '官禄', '田宅', '福德', '父母'];
const ADJ_KNOWN = new Set(['天刑', '天喜', '天姚', '红鸾']);   // 旧引擎认识的杂曜子集（金标准实测）
const JU_NUM = { '水二局': 2, '木三局': 3, '金四局': 4, '土五局': 5, '火六局': 6 };
const GAN_YY = { '甲': 1, '丙': 1, '戊': 1, '庚': 1, '壬': 1, '乙': 0, '丁': 0, '己': 0, '辛': 0, '癸': 0 };

const FIELD_LIMITS = {
  year: [1900, 2100], month: [1, 12], day: [1, 31], hour: [0, 23], minute: [0, 59],
};

function assertIntField(name, value) {
  if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) {
    if (name === 'hour' || name === 'minute') {
      throw new Error(`出生${name === 'hour' ? '时辰' : '分钟'}缺失：请先向用户确认出生时辰（不要用 0 代替未知时辰）`);
    }
    throw new Error(`字段 ${name} 缺失`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`字段 ${name} 必须为整数（收到 ${value}）`);
  const [lo, hi] = FIELD_LIMITS[name];
  if (n < lo || n > hi) throw new Error(`字段 ${name} 越界：应在 ${lo}–${hi}（收到 ${n}）`);
  return n;
}

function prevBranch(b) {
  return BRANCHES[(BRANCH_INDEX[b] - 1 + 12) % 12];
}

/**
 * 十二宫：命宫起序（地支递减），映射 iztro palaces（地支序）。
 * ★ 缺时辰口径：只在**有时辰**时才调（`hasHour=false` ⇒ `gongs = null`）。
 */
function buildGongs(a, refYear, year, liuNianBranch) {
  const byBranch = {};
  for (const p of a.palaces) byBranch[p.earthlyBranch] = p;

  const age = refYear - year;   // 周岁（与旧引擎 isCurrent 口径一致）
  const gongs = [];
  let b = a.earthlyBranchOfSoulPalace;
  for (let i = 0; i < 12; i++) {
    const p = byBranch[b];
    const gongName = GONG_ORDER[i];
    const startAge = p.decadal.range[0];
    const endAge = p.decadal.range[1];
    const major = (p.majorStars || []).map((s) => s.name);
    const minor = (p.minorStars || []).map((s) => s.name);
    const adj = (p.adjectiveStars || []).filter((s) => ADJ_KNOWN.has(s.name)).map((s) => s.name);
    const sihua = []
      .concat((p.majorStars || []).filter((s) => s.mutagen).map((s) => ({ star: s.name, hua: '化' + s.mutagen })))
      .concat((p.minorStars || []).filter((s) => s.mutagen).map((s) => ({ star: s.name, hua: '化' + s.mutagen })));

    gongs.push({
      gong: gongName,
      dizhi: p.earthlyBranch,
      tiangan: p.heavenlyStem,
      mainStars: major,
      auxStars: minor.concat(adj),
      sihua,
      daXian: {
        startAge,
        endAge,
        isCurrent: age >= startAge && age <= endAge,
        daXianGongName: gongName,   // 适配：标准宫名（旧引擎自造缩写已弃）
      },
      liuNian: Array.from({ length: endAge - startAge + 1 }, (_, j) => startAge + j),
      liuNianYear: b === liuNianBranch ? refYear : null,
    });
    b = prevBranch(b);
  }
  return gongs;
}

/** "己卯 丙子 戊午 戊午" → {year:{gan,zhi}, month:{...}, day:{...}, hour:{...}} */
function parseSiZhu(s) {
  const parts = s.trim().split(/\s+/);
  const keys = ['year', 'month', 'day', 'hour'];
  const out = {};
  keys.forEach((k, i) => { out[k] = { gan: parts[i][0], zhi: parts[i][1] }; });
  return out;
}

/** 农历年干阴阳 + gender → "阳男"/"阴男"/"阳女"/"阴女"（正确规则） */
function computeYinYang(yearGan, gender) {
  const yy = GAN_YY[yearGan] ? '阳' : '阴';
  return yy + (gender === 'male' ? '男' : '女');
}

/**
 * @param {{year,month,day,hour,minute,gender,refYear?,correction?}} input
 *   correction —— 入口算好的换算结果（applyCorrection 返回）。有传则本侧按真太阳时排盘，
 *                 并与 bazi 侧回显同一个 adjustedBirth / correctionId。
 * @returns {object} 旧格式 ziwei 对象
 */
function computeZiwei(input) {
  // 防静默分叉：给了 tz/longitude 却没给同一次换算结果 —— 说明调用方想校正但接错了线
  if (!input.correction && (input.tz !== undefined || input.longitude !== undefined)) {
    throw new Error(
      'computeZiwei 不接受 tz/longitude 自行换算：请由入口算好一次 applyCorrection，' +
        '再把同一个 correction 同时传给 computeBazi 与 computeZiwei'
    );
  }
  const correction = input.correction || null;
  // 真太阳时口径下，紫微与八字共用同一个「校正后时刻」—— 这是 J7a 的执行点
  const birth = correction ? correction.solarParts : input;
  const year = assertIntField('year', birth.year);
  const month = assertIntField('month', birth.month);
  const day = assertIntField('day', birth.day);
  // ★★ 时序口径：「没给时辰」≠「给了 0」。
  //   `hour` 缺失 ⇒ 走三柱模式：**命宫/身宫/时柱/由时辰推导的四化一律 `null`**，
  //   但年/月/日三柱与农历信息照常（与有四柱时逐值相同）。
  //   ⚠️ 内部仍用 `timeIndex=0`（子时）建 iztro 对象 —— 否则库建不起来；
  //     但**所有由时辰推导的字段都不读**，所以不会泄露假命宫。
  // ★★ 时序口径：「有没有时辰」必须看**用户原始输入**（`input`），不能看校正后的
  //   `correction.solarParts` —— 那里面 hour 一定是数字（`run-chart` 用 0 做算术载体），
  //   拿它判「给了没给」会恒等于 true ⇒ 这正是本单第二处「同一字段两个定义」的坑
  //   （首版实测：`hourMissing` 恒 false ⇒ 去读 `input.hour`（undefined）⇒ 抛
  //    "Cannot read properties of null (reading 'gan')" 同类错误）。
  const userHourMissing = input.hour === undefined || input.hour === null || input.hour === '';
  const userMinuteMissing = input.minute === undefined || input.minute === null || input.minute === '';
  const hasHour = !userHourMissing;
  // 算术用的 hour/minute：校正后（`birth`）优先，缺则兜 0 —— **只作算术载体**，
  // 不参与「给了没给」的判定（那是 `hasHour` 的事）。
  const hour = birth.hour === undefined || birth.hour === null || birth.hour === ''
    ? 0 : assertIntField('hour', birth.hour);
  const minute = birth.minute === undefined || birth.minute === null || birth.minute === ''
    ? 0 : assertIntField('minute', birth.minute);
  const gender = input.gender;
  if (gender !== 'male' && gender !== 'female') {
    throw new Error("gender 必须为 'male' 或 'female'（收到 " + JSON.stringify(gender) + '）');
  }
  const refYear = input.refYear || new Date().getFullYear();

  const timeIndex = Math.floor((hour + 1) / 2) % 12;
  const g = gender === 'male' ? '男' : '女';
  // fixLeap=true 显式传（闰月口径 A 折半，User 拍板；禁止依赖库默认值）
  const a = astro.bySolar(`${year}-${month}-${day}`, timeIndex, g, true).toJSON();

  // —— 农历（复用 lunar-javascript；数字 + 汉字）——
  const lunar = Solar.fromYmdHms(year, month, day, hour, minute, 0).getLunar();
  const lunarDate = {
    year: lunar.getYear(), month: lunar.getMonth(), day: lunar.getDay(),
    monthCn: lunar.getMonthInChinese(), dayCn: lunar.getDayInChinese(),
  };

  // —— 四柱（紫微口径 = 农历；年/月/日/时皆用 lunar 农历方法，非 iztro chineseDate 的节气口径）——
  const siZhu = {
    year: { gan: lunar.getYearGan(), zhi: lunar.getYearZhi() },
    month: { gan: lunar.getMonthGan(), zhi: lunar.getMonthZhi() },
    day: { gan: lunar.getDayGan(), zhi: lunar.getDayZhi() },
    hour: hasHour ? { gan: lunar.getTimeGan(), zhi: lunar.getTimeZhi() } : null,
  };
  const yinYang = computeYinYang(siZhu.year.gan, gender);

  // ★★ 缺时辰口径：五行局由「命宫天干 ＋ 年干」定 —— **命宫没了就没有五行局**。
  //    `92` 只把 `mingGongIndex` 置 null，没动 `wuXingJu` ⇒ 用户会读到「金四局」这个假结论。
  const wuXingJu = hasHour ? { name: a.fiveElementsClass, number: JU_NUM[a.fiveElementsClass] } : null;
  // ★ 92：命宫/身宫由时辰推导 ⇒ 缺时辰时一律 null（不拿子时的假命宫顶替）
  const mingGongIndex = hasHour ? BRANCH_INDEX[a.earthlyBranchOfSoulPalace] : null;
  const shenGongIndex = hasHour ? BRANCH_INDEX[a.earthlyBranchOfBodyPalace] : null;

  // —— 流年命宫（参照年，iztro horoscope）——
  // ★ 92：流年命宫同样由时辰推导 ⇒ 缺时辰时不建（建了也是假的）
  const horo = astro.bySolar(`${year}-${month}-${day}`, timeIndex, g, true)
    .horoscope(`${refYear}-10-09`, timeIndex).toJSON();
  const liuNianBranch = horo.yearly.earthlyBranch;

  // —— 十二宫：命宫起序（地支递减），映射 iztro palaces（地支序）——
  // ★★ 缺时辰口径：**十二宫的排布起点就是命宫 ⇒ 命宫没有，十二宫就没有。**
  //    `92` 只把 `mingGongIndex` 置 null，没动 `gongs` ⇒ 十二宫齐全、**还明确标着一个错命宫**
  //    （实测：`gongs[0].gong='命宫', dizhi='亥', daXian={4,13}` 全是子时推出来的）。
  //    ⇒ 这比"gongs 还是子时的值"更重一层：**它标着一个错的命宫**。
  //    ⇒ 选 **null** 而不是 `[]`：与 `92` 对 `siZhu.hour` 的处理一致 ——
  //      都表示"这个东西没排出来"，**不是**"排出来是空的"。
  //      （下游 `render-decision.js:234` 写的是 `zw.gongs || []`，null 与 [] 都安全。）
  const gongs = hasHour ? buildGongs(a, refYear, year, liuNianBranch) : null;

  // birthInfo 回显**用户填的原始钟表时间**（与 bazi 侧同口径），校正结果另挂在 trueSolarTime 上显式标注
  // ★ 92：未给时辰时 hour/minute 回显 **null**（不是 0）—— 与 bazi 侧同口径
  const wall = correction
    ? {
        year: assertIntField('year', input.year),
        month: assertIntField('month', input.month),
        day: assertIntField('day', input.day),
        hour: userHourMissing ? null : assertIntField('hour', input.hour),
        minute: userMinuteMissing ? null : assertIntField('minute', input.minute),
      }
    : { year, month, day, hour: hasHour ? hour : null, minute: hasHour ? minute : null };

  const birthInfo = {
    year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute,
    isLunar: false, gender, timeZone: 8,
  };
  if (correction) {
    birthInfo.tz = input.tz;
    birthInfo.longitude = input.longitude;
    birthInfo.trueSolarTime = buildTrueSolarTime(correction);
  }

  return {
    birthInfo, lunarDate, siZhu, yinYang, mingGongIndex, shenGongIndex, wuXingJu, gongs,
    // ★★ 时序口径：「有没有时辰」可复核。`hasHour=false` 时
    //   `siZhu.hour` / `mingGongIndex` / `shenGongIndex` 都是 `null`（不造假）。
    hasHour,
  };
}

module.exports = { computeZiwei, computeYinYang };
