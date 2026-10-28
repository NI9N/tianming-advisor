'use strict';
/**
 * lib/enrich/index.js —— enrich 组装（9 模块，自写重写层）
 *
 * 输入 = computeBazi 的输出（siZhu/dayMaster/cangGan/shiShen）。
 * 输出结构 = 旧引擎 bazi.enrichment（接口不变原则）。
 * 规则依据：命理公共知识（子平真诠/穷通宝鉴/三命通会），无同族库依赖。
 */
const M = require('./modules');
const { tiaoHou } = require('./tiaohou');
const { wangShuai } = require('./wangshuai');

/**
 * ★★ 时序口径 · 缺时辰时，enrich 只看**已给的柱**
 *
 * 背景：`92` 让 `lib/bazi` 在未给时辰时把所有 `*.hour` 项置 `null`（不造假时柱）。
 *       但 enrich 的 9 个模块里有 **9 处**会 `siZhu[k].gan` 这样解构四柱
 *       （实测枚举：`modules.js` 8 处 ＋ `wangshuai.js` 1 处）——
 *       直接喂 null 会抛 `Cannot read properties of null (reading 'gan')`。
 *
 * 为什么用「剔除该柱」而不是「补个假值」：
 *   - 补假值 ⇒ 五行统计/天干关系/地支关系里会掺进一个**子时的推导**，
 *     那正是 `92` 要消灭的东西（用户不知道时辰，引擎不能替他编一个）。
 *   - 剔除该柱 ⇒ 前三柱的统计**一个数都不变**（少算一个柱子，但那个柱子本来就没给）。
 *
 * ⚠️ 为什么不在 9 处各自加 `if (siZhu[k] === null) continue`：
 *   那 9 处语义不同（两两配对 / 三合局 / 透干 / 统计），逐个改容易漏也容易改错。
 *   **在唯一的入口收窄输入**，比在 9 个出口各设一道闸靠谱。
 *   ⇒ 这就是「先枚举再修」（`AGENTS.md §八-2`）：N=9 处同类，M=1 处入口修，K=0 处逐个改。
 *
 * @param {object} bazi computeBazi 的输出
 */
function computeEnrich(bazi) {
  const { siZhu, dayMaster, cangGan, shiShen } = bazi;

  // ★ 92：把缺失的柱从 enrich 的输入里**置 null**（不删键！）。
  //   ⚠️ 不能 `delete`：那 8 处写的是 `PILLAR_KEYS.map(k => siZhu[k].gan)`，
  //     删键会让它们拿到 `undefined` 而抛错；置 null 则各处只需判 `== null` 跳过。
  //   ⚠️ 只影响 enrich 内部，不影响 bazi 顶层输出（那里 hour 本来就是 null）。
  const nullifyHour = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const o = {};
    for (const k of Object.keys(obj)) o[k] = obj[k];
    if (o.hour === null || o.hour === undefined) o.hour = null;
    return o;
  };
  const siZhuV = nullifyHour(siZhu);
  const cangGanV = nullifyHour(cangGan);
  const shiShenV = nullifyHour(shiShen);

  return {
    自坐: M.ziZuo(siZhuV),
    五行旺相: M.wuXingWangXiang(siZhuV.month.zhi),
    五行统计: M.wuXingTongJi(siZhuV, dayMaster),
    调候用神: tiaoHou(dayMaster, siZhuV.month.zhi),
    格局: M.geJu(siZhuV, cangGanV),
    旺衰: wangShuai(siZhuV, dayMaster, cangGanV, shiShenV),
    天干关系: M.tianGanGuanXi(siZhuV),
    地支关系: M.diZhiGuanXi(siZhuV),
    整柱: M.zhengZhu(siZhuV),
  };
}

module.exports = { computeEnrich };
