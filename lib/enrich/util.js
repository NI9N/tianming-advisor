'use strict';
/**
 * lib/enrich/util.js —— enrich 基础工具（五行 / 生克 / 合冲刑害 / 暗合拱合拱会）
 *
 * 数据来源：
 *  - 五行、六冲、五合、六合、藏干：lunar-javascript LunarUtil（权威、已验证）
 *  - 三合、三会、六害、刑、暗合、拱合、拱会：命理公共知识（《三命通会》《渊海子平》通例），自写
 *  - 十二长生：复用 computeBazi 的 zhangSheng（lunar 已算），本文件不重算
 */
const { LunarUtil } = require('lunar-javascript');

// —— 天干/地支 五行 ——
const GAN_WX = {};   // 甲→木
for (const [k, v] of Object.entries(LunarUtil.WU_XING_GAN)) {
  if (k.length === 1) GAN_WX[k] = v;
}
const ZHI_WX = {};   // 子→水
for (const [k, v] of Object.entries(LunarUtil.WU_XING_ZHI)) {
  if (k.length === 1) ZHI_WX[k] = v;
}

// —— 五行生克 ——
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };

// —— 地支序 ——
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const ZHI_IDX = Object.fromEntries(ZHI.map((z, i) => [z, i]));

// —— 天干序 ——
const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const GAN_IDX = Object.fromEntries(GAN.map((g, i) => [g, i]));

// —— 十二长生（阴阳顺逆：阳干顺排、阴干逆排）——
// CHANG_SHENG_OFFSET[gan] = 该天干长生之地支在「顺排」下的偏移；CHANG_SHENG = 12 长生名
const CHANG_SHENG_OFFSET = LunarUtil.CHANG_SHENG_OFFSET;
const CHANG_SHENG = LunarUtil.CHANG_SHENG;

/** 天干 gan 在地支 zhi 的十二长生（标准阴阳顺逆口径，对齐旧引擎「自坐」） */
function diShi(gan, zhi) {
  const offset = CHANG_SHENG_OFFSET[gan];
  const zhiIndex = ZHI_IDX[zhi];
  const isYang = GAN_IDX[gan] % 2 === 0;
  let index = offset + (isYang ? zhiIndex : -zhiIndex);
  index = ((index % 12) + 12) % 12;
  return CHANG_SHENG[index];
}

// —— 天干五合（含合化五行）——
const GAN_HE = { 甲: ['己', '土'], 乙: ['庚', '金'], 丙: ['辛', '水'], 丁: ['壬', '木'], 戊: ['癸', '火'] };
// 反向（己→甲）
for (const [a, [b, wx]] of Object.entries({ ...GAN_HE })) {
  GAN_HE[b] = [a, wx];
}

// —— 六合 ——
const ZHI_HE6 = { 子: '丑', 丑: '子', 寅: '亥', 亥: '寅', 卯: '戌', 戌: '卯', 辰: '酉', 酉: '辰', 巳: '申', 申: '巳', 午: '未', 未: '午' };

// —— 六冲 ——
const ZHI_CHONG = { 子: '午', 午: '子', 丑: '未', 未: '丑', 寅: '申', 申: '寅', 卯: '酉', 酉: '卯', 辰: '戌', 戌: '辰', 巳: '亥', 亥: '巳' };

// —— 三合局（[长生, 帝旺, 墓]，中神=帝旺）——
const SAN_HE = {
  水: ['申', '子', '辰'], 木: ['亥', '卯', '未'], 火: ['寅', '午', '戌'], 金: ['巳', '酉', '丑'],
};
const SAN_HE_MAP = {};   // 地支 → {wx, role}
for (const [wx, [zhang, wang, mu]] of Object.entries(SAN_HE)) {
  SAN_HE_MAP[zhang] = { wx, role: '长生' };
  SAN_HE_MAP[wang] = { wx, role: '帝旺' };
  SAN_HE_MAP[mu] = { wx, role: '墓' };
}

// —— 三会方 ——
const SAN_HUI = {
  木: ['寅', '卯', '辰'], 火: ['巳', '午', '未'], 金: ['申', '酉', '戌'], 水: ['亥', '子', '丑'],
};
const SAN_HUI_MAP = {};
for (const [wx, arr] of Object.entries(SAN_HUI)) {
  for (const z of arr) SAN_HUI_MAP[z] = wx;
}

// —— 六害 ——
const ZHI_HAI = { 子: '未', 未: '子', 丑: '午', 午: '丑', 寅: '巳', 巳: '寅', 卯: '辰', 辰: '卯', 申: '亥', 亥: '申', 酉: '戌', 戌: '酉' };

// —— 刑 ——
const XING = {
  无礼之刑: [['子', '卯']],
  无恩之刑: [['寅', '巳'], ['巳', '申'], ['申', '寅']],
  恃势之刑: [['丑', '戌'], ['戌', '未'], ['未', '丑']],
};
const ZI_XING = ['辰', '午', '酉', '亥'];   // 自刑

// —— 天干相克（五行相克；含阳干相冲）——
function ganKe(a, b) {
  return KE[GAN_WX[a]] === GAN_WX[b];
}

module.exports = {
  GAN_WX, ZHI_WX, SHENG, KE, ZHI, ZHI_IDX, GAN, GAN_IDX,
  GAN_HE, ZHI_HE6, ZHI_CHONG, SAN_HE, SAN_HE_MAP, SAN_HUI, SAN_HUI_MAP, ZHI_HAI, XING, ZI_XING,
  ganKe, diShi,
  ZHI_HIDE_GAN: LunarUtil.ZHI_HIDE_GAN,
};
