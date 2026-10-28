'use strict';
/**
 * lib/enrich/modules.js —— enrich 报告级模块（五行旺相/自坐/天干关系/地支关系/整柱）
 *
 * 输出结构 = 旧引擎 enrichment 对应字段（接口不变原则）。
 * 判级（判级表 §B）：本文件 5 个模块均为「报告」级（差异清单化，不定裁）。
 * 规则依据：五行旺相休囚死 / 十二长生 / 天干五合与相克 / 地支六冲六合六害刑 + 暗合拱合拱会 / 干支生克 —— 均为命理公共知识。
 */
const U = require('./util');
const { PILLAR_KEYS } = require('../bazi/util');

// 旧引擎 enrichment 内部的 pillar 标识用中文（年/月/日/时），而 bazi.siZhu 用英文 key
const PILLAR_CN = { year: '年', month: '月', day: '日', hour: '时' };

// ============ 1. 五行旺相（月令旺相休囚死）============
function wuXingWangXiang(monthZhi) {
  const wx = U.ZHI_WX[monthZhi];   // 月令五行 = 旺
  const out = {};
  for (const w of ['木', '火', '土', '金', '水']) {
    if (w === wx) out[w] = '旺';
    else if (U.SHENG[wx] === w) out[w] = '相';   // 月令生的
    else if (U.SHENG[w] === wx) out[w] = '休';   // 生月令的
    else if (U.KE[wx] === w) out[w] = '死';      // 月令克的
    else out[w] = '囚';                          // 克月令的
  }
  return out;
}

// ============ 2. 自坐（各柱天干在自己坐支的十二长生，阴阳顺逆）============
function ziZuo(siZhu) {
  const out = {};
  for (const k of PILLAR_KEYS) {
    // ★ 92：时柱缺失 ⇒ 该项为 null（不造假的）。
    //   ⚠️ 这里判 `== null`（宽松相等）而不是 `=== null` —— `computeEnrich` 在缺时辰时
    //     会把 `hour` 键**整个 delete 掉**（见 `lib/enrich/index.js` 的 `drop()`），
    //     所以这里收到的是 `undefined` 而不是 `null`。两者都要防。
    if (siZhu[k] === null || siZhu[k] === undefined) { out[PILLAR_CN[k]] = null; continue; }
    out[PILLAR_CN[k]] = U.diShi(siZhu[k].gan, siZhu[k].zhi);
  }
  return out;
}

// ============ 3. 天干关系（五合 + 相克；合优先于克）============
function tianGanGuanXi(siZhu) {
  const result = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      // ★ 92：任一回合缺柱 ⇒ 该对不判（缺时辰时"时干"不参与天干关系）
      if (siZhu[PILLAR_KEYS[i]] == null || siZhu[PILLAR_KEYS[j]] == null) continue;
      const a = siZhu[PILLAR_KEYS[i]].gan;
      const b = siZhu[PILLAR_KEYS[j]].gan;
      if (U.GAN_HE[a] && U.GAN_HE[a][0] === b) {
        result.push({ type: '天干合', gans: [a, b], pillars: [PILLAR_CN[PILLAR_KEYS[i]], PILLAR_CN[PILLAR_KEYS[j]]] });
      } else if (U.ganKe(a, b) || U.ganKe(b, a)) {   // 五行相克，双向
        result.push({ type: '天干相克', gans: [a, b], pillars: [PILLAR_CN[PILLAR_KEYS[i]], PILLAR_CN[PILLAR_KEYS[j]]] });
      }
    }
  }
  return result;
}

// ============ 4. 整柱（干支五行生克五判）============
function zhengZhu(siZhu) {
  return PILLAR_KEYS.map((k) => {
    // ★ 92：缺柱 ⇒ 整柱判 null
    if (siZhu[k] == null) return null;
    const { gan, zhi } = siZhu[k];
    const gw = U.GAN_WX[gan], zw = U.ZHI_WX[zhi];
    let verdict;
    if (gw === zw) verdict = '天地同气';
    else if (U.KE[gw] === zw) verdict = '盖头';        // 干克支
    else if (U.KE[zw] === gw) verdict = '截脚';        // 支克干
    else if (U.SHENG[gw] === zw) verdict = '天干生地支'; // 干生支
    else verdict = '地支生天干';                        // 支生干
    return { pillar: PILLAR_CN[k], gan, zhi, verdict };
  });
}

// ============ 5. 地支关系（六冲/六合/六害/相刑/自刑/暗合 + 三合/三会/拱合/拱会）============
function getXing(a, b) {
  if (a === b) return null;   // 自刑单独处理
  if ((a === '子' && b === '卯') || (a === '卯' && b === '子')) return '无礼之刑';
  if (['寅', '巳', '申'].includes(a) && ['寅', '巳', '申'].includes(b)) return '无恩之刑';
  if (['丑', '戌', '未'].includes(a) && ['丑', '戌', '未'].includes(b)) return '恃势之刑';
  return null;
}

function getAnHe(a, b) {
  const ha = U.ZHI_HIDE_GAN[a], hb = U.ZHI_HIDE_GAN[b];
  const pairs = [];
  for (const x of ha) {
    for (const y of hb) {
      if (U.GAN_HE[x] && U.GAN_HE[x][0] === y) pairs.push(x + y + '合');
    }
  }
  return pairs.length ? pairs.join('、') : null;
}

function diZhiGuanXi(siZhu) {
  // ★ 92：缺柱时 `zhis[i]` 为 null；下面所有两两/聚合判定都要跳过它
  const zhis = PILLAR_KEYS.map((k) => (siZhu[k] == null ? null : siZhu[k].zhi));
  const result = [];

  const zhiSet = new Set(zhis);
  // 三合局/三会方里「已出现」的地支，按柱序取 zhi（去重）与 pillar
  const presentInfo = (tri) => {
    const ks = PILLAR_KEYS.filter((k, idx) => tri.includes(zhis[idx]));
    return { zhi: [...new Set(ks.map((k) => zhis[PILLAR_KEYS.indexOf(k)]))], pillars: ks.map((k) => PILLAR_CN[k]) };
  };

  // —— 两两判定（6 对）——
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      // ★ 92：任一合缺柱 ⇒ 该对不判
      if (zhis[i] == null || zhis[j] == null) continue;
      const a = zhis[i], b = zhis[j];
      const pillars = [PILLAR_CN[PILLAR_KEYS[i]], PILLAR_CN[PILLAR_KEYS[j]]];
      if (U.ZHI_CHONG[a] === b) result.push({ type: '六冲', zhi: [a, b], pillars });
      if (U.ZHI_HE6[a] === b) result.push({ type: '六合', zhi: [a, b], pillars });
      if (U.ZHI_HAI[a] === b) result.push({ type: '六害', zhi: [a, b], pillars });
    }
  }

  // —— 相刑：按刑类聚合（非两两）；三刑组（寅巳申/丑戌未）加 (半)/(全) 后缀，保留「三刑齐不齐」信息 ——
  const XING_GROUPS = [
    { name: '无礼之刑', zhis: ['子', '卯'] },
    { name: '无恩之刑', zhis: ['寅', '巳', '申'] },
    { name: '恃势之刑', zhis: ['丑', '戌', '未'] },
  ];
  for (const g of XING_GROUPS) {
    const present = g.zhis.filter((z) => zhiSet.has(z));
    if (present.length >= 2) {
      const { zhi, pillars } = presentInfo(g.zhis);
      // 三刑组（3 个地支）区分齐/不齐；两两组（子卯）无后缀
      const detail = g.zhis.length === 3 ? (present.length === 3 ? g.name + '(全)' : g.name + '(半)') : g.name;
      result.push({ type: '相刑', zhi, pillars, detail });
    }
  }

  // —— 自刑：聚合同支（辰/午/酉/亥）出现的所有柱为一条（非两两）——
  for (const z of U.ZI_XING) {
    const pillars = PILLAR_KEYS.filter((k, idx) => zhis[idx] === z).map((k) => PILLAR_CN[k]);
    if (pillars.length >= 2) result.push({ type: '自刑', zhi: [z, z], pillars });
  }

  // —— 三合/三会/拱合/拱会（基于地支集合，去重）——
  for (const [wx, tri] of Object.entries(U.SAN_HE)) {
    const present = tri.filter((z) => zhiSet.has(z));
    if (present.length === 3) {
      const { zhi, pillars } = presentInfo(tri);
      result.push({ type: '三合', zhi, pillars, detail: '三合' + wx + '局' });
    } else if (present.length === 2) {
      const missing = tri.find((z) => !zhiSet.has(z));
      const { zhi, pillars } = presentInfo(tri);
      result.push({ type: '拱合', zhi, pillars, detail: '拱合' + missing + '(' + wx + '局)' });
    }
  }
  for (const [wx, trio] of Object.entries(U.SAN_HUI)) {
    const present = trio.filter((z) => zhiSet.has(z));
    if (present.length === 3) {
      const { zhi, pillars } = presentInfo(trio);
      result.push({ type: '三会', zhi, pillars, detail: '三会' + wx + '方' });
    } else if (present.length === 2) {
      const missing = trio.find((z) => !zhiSet.has(z));
      const { zhi, pillars } = presentInfo(trio);
      result.push({ type: '拱会', zhi, pillars, detail: '拱会' + missing + '(' + wx + '方)' });
    }
  }

  // —— 暗合：兜底关系，仅当该对无任何其他明确关系（冲/合/害/刑/同三合局/同三会方）时判 ——
  const hasExplicit = (a, b) =>
    U.ZHI_CHONG[a] === b || U.ZHI_HE6[a] === b || U.ZHI_HAI[a] === b || !!getXing(a, b) ||
    (U.SAN_HE_MAP[a] && U.SAN_HE_MAP[b] && U.SAN_HE_MAP[a].wx === U.SAN_HE_MAP[b].wx) ||
    (U.SAN_HUI_MAP[a] && U.SAN_HUI_MAP[b] && U.SAN_HUI_MAP[a] === U.SAN_HUI_MAP[b]);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      // ★ 92：任一合缺柱 ⇒ 该对不判（否则 getAnHe(null) 会拿 undefined 做 for...of）
      if (zhis[i] == null || zhis[j] == null) continue;
      const a = zhis[i], b = zhis[j];
      const anhe = getAnHe(a, b);
      if (anhe && !hasExplicit(a, b)) {
        result.push({ type: '暗合', zhi: [a, b], pillars: [PILLAR_CN[PILLAR_KEYS[i]], PILLAR_CN[PILLAR_KEYS[j]]], detail: anhe });
      }
    }
  }

  // —— 按旧引擎固定类型顺序稳定排序（同类型内部保持添加序：两两=柱序、拱合/三合=局序、拱会/三会=方序）——
  const TYPE_ORDER = { 六冲: 0, 六合: 1, 六害: 2, 相刑: 3, 自刑: 4, 拱合: 5, 三合: 6, 拱会: 7, 三会: 8, 暗合: 9 };
  result.sort((x, y) => TYPE_ORDER[x.type] - TYPE_ORDER[y.type]);

  return result;
}

// ============ 6. 五行统计（surface / withCangGan / missing / strongest / shiShenGroups）============
// 藏干加权：本气 1.0 / 中气 0.5 / 余气 0.3（实测 c001/c020 反推确认）
const HIDE_W = [1.0, 0.5, 0.3];
const WX_LIST = ['木', '火', '土', '金', '水'];

function shiShenClass(dmWx, wx) {
  if (wx === dmWx) return '比劫';
  if (U.KE[dmWx] === wx) return '财';
  if (U.SHENG[dmWx] === wx) return '食伤';
  if (U.SHENG[wx] === dmWx) return '印';
  return '官杀';   // KE[wx] === dmWx
}

function wuXingTongJi(siZhu, dayMaster) {
  const dmWx = U.GAN_WX[dayMaster];
  const surface = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  const withCangGan = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  for (const k of PILLAR_KEYS) {
    // ★ 92：缺柱不计入五行统计（不掺假）
    if (siZhu[k] == null) continue;
    const { gan, zhi } = siZhu[k];
    const gw = U.GAN_WX[gan], zw = U.ZHI_WX[zhi];
    surface[gw] += 1;          // 天干明字
    surface[zw] += 1;          // 地支明字
    withCangGan[gw] += 1;      // 天干
    const hides = U.ZHI_HIDE_GAN[zhi];
    hides.forEach((h, i) => { withCangGan[U.GAN_WX[h]] += HIDE_W[i]; });   // 藏干加权
  }
  const missing = WX_LIST.filter((wx) => surface[wx] === 0);
  const maxV = Math.max(...WX_LIST.map((wx) => surface[wx]));
  const strongest = WX_LIST.filter((wx) => surface[wx] === maxV);
  const shiShenGroups = {};
  for (const wx of WX_LIST) shiShenGroups[wx] = { 十神类: shiShenClass(dmWx, wx), 实例数: surface[wx] };
  return { surface, withCangGan, missing, strongest, shiShenGroups };
}

// ============ 7. 格局（子平真诠月令取格）============
// 十神 → 格局名
const GE_JU_NAME = {
  比肩: '比肩格', 劫财: '劫财格', 正官: '正官格', 七杀: '七杀格', 正财: '正财格',
  偏财: '偏财格', 正印: '正印格', 偏印: '偏印格', 食神: '食神格', 伤官: '伤官格',
};

/**
 * 取格（子平真诠月令取格，实测对齐旧引擎）：
 *  - 比劫月令（本气=比肩/劫财）→ 直接本气立格（比肩格/劫财格），不看透干
 *  - 本气透（年/月/时干，不含日干）→ 本气格
 *  - 本气未透、中/余气透（非比劫）→ 透出者格
 *  - 均不透 → 本气格
 * confidence：纯气月支（子午卯酉）或比劫月令或本气透 = 高；否则 = 中。
 */
function geJu(siZhu, cangGan) {
  const monthHides = cangGan.month;              // [{gan, shiShen}, ...]
  const tianGan = PILLAR_KEYS.map((k) => (siZhu[k] == null ? null : siZhu[k].gan));
  // ★ 92：时干缺失 ⇒ 透干只在年/月干里找（不含那个不存在的时干）
  const feiRiGan = [tianGan[0], tianGan[1], tianGan[3]].filter((x) => x != null);
  const monthZhi = siZhu.month.zhi;
  const benQi = monthHides[0];
  const isBieJie = benQi.shiShen === '比肩' || benQi.shiShen === '劫财';
  const isPure = ['子', '午', '卯', '酉'].includes(monthZhi);
  const benQiTou = feiRiGan.includes(benQi.gan);

  // 透干字段：月支藏干透在年/月/时干（不含日干），去重
  const touGan = [];
  for (const h of monthHides) {
    if (feiRiGan.includes(h.gan) && !touGan.includes(h.gan)) touGan.push(h.gan);
  }

  let primary, confidence, basis;
  if (isBieJie) {
    primary = GE_JU_NAME[benQi.shiShen];
    basis = '月支本气' + benQi.gan + '=日主' + (benQi.shiShen === '比肩' ? '同行(比肩)' : '劫财') + ' — ' + primary;
    confidence = '高';
  } else if (isPure) {
    // 纯气月支（子午卯酉）直接本气立格，不看透干
    primary = GE_JU_NAME[benQi.shiShen];
    basis = '月支' + monthZhi + '本气' + benQi.gan + '(' + benQi.shiShen + ') — 纯气月支直接立格';
    confidence = '高';
  } else if (benQiTou) {
    primary = GE_JU_NAME[benQi.shiShen];
    basis = '月支本气' + benQi.gan + '(' + benQi.shiShen + ') — 本气透干立格';
    confidence = '高';
  } else {
    const touChu = monthHides.slice(1).filter((h) => feiRiGan.includes(h.gan) && h.shiShen !== '比肩' && h.shiShen !== '劫财');
    if (touChu.length) {
      const h = touChu[0];
      primary = GE_JU_NAME[h.shiShen];
      basis = '月支藏干' + h.gan + '透干 (' + h.shiShen + ')';
      confidence = '中';
    } else {
      primary = GE_JU_NAME[benQi.shiShen];
      basis = '月支本气' + benQi.gan + '(' + benQi.shiShen + ') — 本气未透,以本气论格';
      confidence = '中';
    }
  }

  // notes（报告级）
  const notes = [];
  if (primary === '比肩格') notes.push('日干' + tianGan[2] + '在月支' + monthZhi + '为临官 — 传统称"建禄格"');
  if (primary === '劫财格') notes.push('日干' + tianGan[2] + '在月支' + monthZhi + '为帝旺 — 传统称"羊刃格"');

  return { primary, basis, 透干: touGan, confidence, notes };
}

module.exports = { wuXingWangXiang, ziZuo, tianGanGuanXi, zhengZhu, diZhiGuanXi, wuXingTongJi, geJu, getXing, getAnHe };
