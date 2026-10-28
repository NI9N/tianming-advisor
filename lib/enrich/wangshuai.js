'use strict';
/**
 * lib/enrich/wangshuai.js —— 旺衰（四要素：得令/长生/得地/得势）
 *
 * 规则依据：「得令/得地/得势/得助」四要素（《子平真诠》）。
 * ⚠️ 权重＝黑盒反推旧引擎输出（无古典出处，见判级表 v1.6 §B-1 #1）；score 与旧链逐位相等，但判级仍为「产品可见」、不升硬级。
 * verdict 五档：极旺(可能从强)/偏旺/中和/偏弱/极弱(可能从弱)，阈值 ±8、±2.5~3。
 */
const U = require('./util');
const { PILLAR_KEYS } = require('../bazi/util');

// 月支本气十神 → 得令权重（实测反推：比劫+5/印+3/官杀-4/财-5/食伤-3）
const DE_LING = { 比肩: 5, 劫财: 5, 正印: 3, 偏印: 3, 正官: -4, 七杀: -4, 正财: -5, 偏财: -5, 食神: -3, 伤官: -3 };
// 月支长生态 → 长生权重（实测反推）
const DI_SHI = { 长生: 2, 沐浴: 0, 冠带: 1, 临官: 1, 帝旺: 2, 衰: 0, 病: -1, 死: -1, 墓: -3, 绝: -3, 胎: -3, 养: -3 };
// 藏干生扶权重（本气/中气/余气）
const HIDE_SHENG = { 正印: [1, 0.5, 0.3], 偏印: [1, 0.5, 0.3], 比肩: [2, 0.8, 0.5], 劫财: [2, 0.8, 0.5] };
// 天干权重（生扶+，克泄耗-）
const GAN_W = { 比肩: 1, 劫财: 1, 正印: 0.7, 偏印: 0.7, 正官: -1.5, 七杀: -1.5, 正财: -1, 偏财: -1, 食神: -0.5, 伤官: -0.5 };

function wangShuai(siZhu, dayMaster, cangGan, shiShen) {
  // ★ 92：缺柱 ⇒ 该柱不参与旺衰加权（不掺假）
  const keys = PILLAR_KEYS.filter((k) => siZhu[k] != null);
  const tianGan = keys.map((k) => siZhu[k].gan);
  const zhis = keys.map((k) => siZhu[k].zhi);

  const breakdown = { 得令: 0, 长生: 0, 得地: 0, 得势: 0 };
  const details = [];

  // —— 得令：月支本气十神 + 月支中/余气生扶（比劫+1/印+0.7）——
  const monthBenQi = cangGan.month[0];
  breakdown.得令 = DE_LING[monthBenQi.shiShen] || 0;
  let dlDetail = '月支本气' + monthBenQi.gan + '=' + monthBenQi.shiShen + ' ' + breakdown.得令;
  cangGan.month.slice(1).forEach((h) => {
    const w = GAN_W[h.shiShen];
    if (w && w > 0) {
      breakdown.得令 += w;
      dlDetail += '; 月余气' + h.gan + (h.shiShen === '比肩' || h.shiShen === '劫财' ? '比劫' : '印') + '+' + w;
    }
  });
  breakdown.得令 = +breakdown.得令.toFixed(1);
  details.push(dlDetail);

  // —— 长生：日主在月支的长生态 ——
  const monthDiShi = U.diShi(dayMaster, zhis[1]);
  breakdown.长生 = DI_SHI[monthDiShi] || 0;
  details.push('日主' + dayMaster + '在月支' + zhis[1] + '为' + monthDiShi + ' (' + (breakdown.长生 >= 0 ? '+' : '') + breakdown.长生 + ')');

  // —— 得地：年/日/时支藏干生扶（印比劫）——
  for (const idx of [0, 2, 3]) {
    // ★ 92：缺柱（时柱）不参与得地（不掺假）
    if (cangGan[PILLAR_KEYS[idx]] == null) continue;
    cangGan[PILLAR_KEYS[idx]].forEach((h, i) => {
      const w = HIDE_SHENG[h.shiShen];
      if (w) {
        breakdown.得地 += w[i];
        details.push(PILLAR_CN(idx) + '支' + zhis[idx] + '藏' + h.gan + '(' + h.shiShen + ', ' + ['本气', '中气', '余气'][i] + ') +' + w[i]);
      }
    });
  }
  breakdown.得地 = +breakdown.得地.toFixed(1);

  // —— 得势：天干（年/月/时干）生扶+克泄耗 ——
  for (const idx of [0, 1, 3]) {
    const ss = shiShen[PILLAR_KEYS[idx]];
    const w = GAN_W[ss];
    if (w) {
      breakdown.得势 += w;
      details.push(PILLAR_CN(idx) + '干' + tianGan[idx] + '(' + ss + ') ' + (w >= 0 ? '+' : '') + w);
    }
  }
  breakdown.得势 = +breakdown.得势.toFixed(1);

  const score = +(breakdown.得令 + breakdown.长生 + breakdown.得地 + breakdown.得势).toFixed(1);

  const verdict = verdictOf(score);

  return { score, verdict, confidence: '低', breakdown: { ...breakdown, details } };
}

/** verdict 五档判定（独立纯函数，便于阈值边界单测）。阈值 = 判级表 v1.6 口径 #2。 */
function verdictOf(score) {
  if (score >= 8) return '极旺(可能从强)';
  if (score >= 3) return '偏旺';
  if (score > -2.5) return '中和';
  if (score > -8) return '偏弱';
  return '极弱(可能从弱)';
}

function PILLAR_CN(idx) {
  return ['年', '月', '日', '时'][idx];
}

module.exports = { wangShuai, verdictOf };
