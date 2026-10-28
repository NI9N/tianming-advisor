'use strict';
/**
 * lib/bazi/luck.js —— 大运 / 流年组装
 * 规格（实测钉死，见 docs 与 .tmp/probe-align-out.json）：
 *  - lunar getDaYun() 返回 10 条：index0 = 起运前段 → slice(1) 取 9 柱（对齐旧引擎 dayun 条数）
 *  - dayunStart = yun.getStartYear()（起运「整年」口径；c035 = 8 → 起运年 2000+8 = 2008）
 *  - ganShiShen = 大运天干相对日主的十神；zhiShiShen = 地支「本气」（藏干首位）十神
 */
const { LunarUtil } = require('lunar-javascript');
const { splitPillar } = require('./util');

function shiShenFor(dayMaster, otherGan) {
  const v = LunarUtil.SHI_SHEN[dayMaster + otherGan];
  if (!v) throw new Error(`十神表缺失：${dayMaster}${otherGan}`);
  return v;
}

function zhiShiShenFor(dayMaster, zhi) {
  const hidden = LunarUtil.ZHI_HIDE_GAN[zhi] || [];
  if (!hidden.length) throw new Error(`藏干表缺失：${zhi}`);
  return shiShenFor(dayMaster, hidden[0]);
}

/**
 * @param {object} eight lunar EightChar（已 setSect(1)）—— 用于起运（绝对时刻基准）
 * @param {'male'|'female'} gender
 * @param {string} [dayMasterOverride] 可选：日主天干覆盖（校正口径：起运走绝对时刻、日主走真太阳时）
 */
function buildLuck(eight, gender, dayMasterOverride) {
  const yun = eight.getYun(gender === 'male' ? 1 : 0);
  const dayMaster = dayMasterOverride || eight.getDayGan();

  const dayun = yun.getDaYun().slice(1).map((d) => {
    const ganZhi = splitPillar(d.getGanZhi());
    const liuNian = d.getLiuNian().map((ln) => ({
      year: ln.getYear(),
      age: ln.getAge(),
      ganZhi: splitPillar(ln.getGanZhi()),
    }));
    return {
      ganZhi,
      startAge: d.getStartAge(),
      endAge: d.getEndAge(),
      startYear: d.getStartYear(),
      endYear: d.getEndYear(),
      ganShiShen: shiShenFor(dayMaster, ganZhi.gan),
      zhiShiShen: zhiShiShenFor(dayMaster, ganZhi.zhi),
      liuNian,
    };
  });

  return { dayunStart: yun.getStartYear(), dayun };
}

module.exports = { buildLuck, shiShenFor, zhiShiShenFor };
