'use strict';
/**
 * lib/bazi/util.js —— 基础工具（干支拆分 / 十神归一）
 * 规格依据：docs/字段判级表-v1.md（v1.1）A 部分
 */

const PILLAR_KEYS = ['year', 'month', 'day', 'hour'];

/** '乙亥' → { gan:'乙', zhi:'亥' }（严格两字校验） */
function splitPillar(ganZhi) {
  if (typeof ganZhi !== 'string' || ganZhi.length !== 2) {
    throw new Error('splitPillar: 期望两字干支，收到 ' + JSON.stringify(ganZhi));
  }
  return { gan: ganZhi[0], zhi: ganZhi[1] };
}

/** 日柱天干十神：lunar 返回「日主」，旧引擎口径为「比肩」→ 归一 */
function normalizeShiShen(name) {
  return name === '日主' ? '比肩' : name;
}

module.exports = { PILLAR_KEYS, splitPillar, normalizeShiShen };
