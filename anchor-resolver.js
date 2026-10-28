'use strict';
/**
 * anchor-resolver.js —— 解读层锚点 resolver（解读层 · P1）
 *
 * ---------------------------------------------------------------------------
 * ★ 它是干什么的
 * ---------------------------------------------------------------------------
 * 解读层（LLM）写正文时会引用引擎字段。本模块让**渲染层**按指针回 `chart.json`
 * 取那个值 —— 值由 `chart.json` 出，LLM 写什么都不影响显示。
 *
 * 这正是 `70-交付 §五` 定的设计：**核实权要在渲染层，不能在 LLM。**
 * 只在 `decision.json` 里加 `echo` 让 LLM 回显原文是不够的 —— LLM 仍然可以编。
 *
 * ---------------------------------------------------------------------------
 * ★★ 本模块的命门：**失败时绝不回退**
 * ---------------------------------------------------------------------------
 * `resolve()` 取不到就返回 `{ok:false, …}`，**没有**默认值参数、**没有**兜底分支、
 * **没有**「取不到就返回空串」这类善意设计。
 *
 * 为什么这条比「取得到时怎么办」重要：
 *   回退到 LLM 写的文本 = 把核实权还回给 LLM（`70 §五-问2` 原话）。
 *   而「静默留空」同样不行 —— 那会让「未核实」看起来像「核实过了」。
 *
 * ⇒ 签名里就没有第三个参数，这是**设计**，不是遗漏。若有人来加 `defaultValue`，
 *   请先读 `anchor-contract.md（随开发树提供）` 的「绝不回退」一节。
 *
 * ---------------------------------------------------------------------------
 * ★ 语法（与 `tools/dump-chart-keys.js` 的键清单**同语法**，省一份维护）
 * ---------------------------------------------------------------------------
 *   指针 := 段 ("." 段)*
 *   段   := 键名 | 键名 "[" 下标 "]"
 *   键名 := 非空，且不含 "."  "["  "]"      （中文键名直接写，实测本仓键名不含点）
 *   下标 := 十进制非负整数                  （必须显式；`[]` 有歧义，运行时拒绝）
 *
 *   合法：bazi.siZhu.day.gan ／ bazi.dayun[3].ganZhi.gan ／ ziwei.gongs[6].mainStars[0]
 *   非法：bazi.dayun[].ganZhi.gan   ← `[]` 是**模板**，见下
 *
 * 模板（template）：语法同上但允许 `[]`，表示「数组，下标待定」。
 *   ⇒ 仅供键清单 / 实例化工具使用（`parseTemplate`），**运行时一律拒绝**。
 *
 * ---------------------------------------------------------------------------
 * ★ 失败码（J14b 的分类依据，共 9 类）
 * ---------------------------------------------------------------------------
 *   NOT_A_STRING      指针不是字符串
 *   EMPTY_POINTER     指针是空字符串
 *   BAD_SYNTAX        语法错（空段 / 前导或尾随点 / 括号不配对 / 段后非法字符 / 空下标 `[]`）
 *   BAD_INDEX         下标不是非负十进制整数（含负数、小数、前导零以外的写法）
 *   UNSAFE_KEY        键名是 `__proto__` / `constructor` / `prototype`（原型污染）
 *   NULL_MIDWAY       中途遇到 null / undefined，无法继续向下取
 *   KEY_MISSING       键不存在（用 hasOwnProperty 判，**不走原型链**）
 *   NOT_AN_ARRAY      用了 `[n]` 但目标不是数组
 *   INDEX_OUT_OF_RANGE 下标越界
 *   EMPTY_ARRAY       空数组取子键（`X[0]` 而 `X.length === 0`）
 *   INTERNAL          resolver 自身抛异常（见下；仍按失败返回，**不吞成成功**）
 *
 * 关于 INTERNAL：本模块被渲染层调用，抛异常会整页崩；故兜住后**返回失败**并写 stderr。
 * 失败依然是失败 —— 不会因为兜住就变成「取到了」。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   const { resolve } = require('./anchor-resolver.js');
 *   const r = resolve(chart, 'bazi.siZhu.day.gan');
 *   if (r.ok) show(r.value); else show('未锚定（' + r.code + '）');
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 模板下标的哨兵值：`X[]` 里的空下标 */
const TEMPLATE_INDEX = -1;

/** 原型污染三件套 —— 属性访问必须挡掉 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 全部失败码（供校验器与文档引用） */
const FAIL_CODES = [
  'NOT_A_STRING', 'EMPTY_POINTER', 'BAD_SYNTAX', 'BAD_INDEX', 'UNSAFE_KEY',
  'NULL_MIDWAY', 'KEY_MISSING', 'NOT_AN_ARRAY', 'INDEX_OUT_OF_RANGE',
  'EMPTY_ARRAY', 'INTERNAL',
];

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 词法 + 语法分析。
 * @param {string} src
 * @param {boolean} allowTemplate true 则允许 `[]`（仅供键清单/实例化工具）
 * @returns {{ok:true, segments:Array<{name:string,index:(number|null)}>}|{ok:false, code:string, reason:string}}
 */
function tokenize(src, allowTemplate) {
  if (typeof src !== 'string') {
    return { ok: false, code: 'NOT_A_STRING', reason: '指针必须是字符串，实得 ' + typeof src };
  }
  if (src === '') {
    return { ok: false, code: 'EMPTY_POINTER', reason: '指针是空字符串' };
  }

  const segments = [];
  let i = 0;
  for (;;) {
    // --- 段名：一直读到 '.' 或 '[' ---
    let j = i;
    while (j < src.length && src[j] !== '.' && src[j] !== '[') j++;
    const name = src.slice(i, j);
    if (name === '') {
      return {
        ok: false, code: 'BAD_SYNTAX',
        reason: '第 ' + (segments.length + 1) + ' 段的键名为空（位置 ' + i + '）—— 可能是前导 "." 或连续 ".."',
      };
    }

    // --- 可选下标 ---
    let index = null;
    if (j < src.length && src[j] === '[') {
      const k = src.indexOf(']', j);
      if (k < 0) {
        return { ok: false, code: 'BAD_SYNTAX', reason: '键名 "' + name + '" 后的 "[" 缺少配对的 "]"' };
      }
      const raw = src.slice(j + 1, k);
      if (raw === '') {
        if (!allowTemplate) {
          return {
            ok: false, code: 'BAD_SYNTAX',
            reason: '空下标 "[]" 有歧义（取第几个？）—— 下标必须显式写出。' +
                    '若你在写键清单模板，请用 parseTemplate() 而不是 resolve()',
          };
        }
        index = TEMPLATE_INDEX;
      } else if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        return { ok: false, code: 'BAD_INDEX', reason: '下标 "[' + raw + ']" 不是非负十进制整数' };
      } else {
        index = Number(raw);
      }
      i = k + 1;
    } else {
      i = j;
    }

    segments.push({ name: name, index: index });

    // --- 段间必须是 '.'，且不能以 '.' 结尾 ---
    if (i >= src.length) break;
    if (src[i] !== '.') {
      return { ok: false, code: 'BAD_SYNTAX', reason: '第 ' + segments.length + ' 段后紧跟 "' + src[i] + '"，期望 "."' };
    }
    i++;
    if (i >= src.length) {
      return { ok: false, code: 'BAD_SYNTAX', reason: '指针以 "." 结尾' };
    }
  }

  return { ok: true, segments: segments };
}

/** 严格解析：只认具体指针，拒绝 `[]` */
function parsePointer(src) {
  return tokenize(src, false);
}

/** 宽松解析：允许 `[]`（模板）。⚠ 仅供键清单 / 实例化工具，运行时不许用。 */
function parseTemplate(src) {
  return tokenize(src, true);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string / number / boolean / object / undefined
}

// ---------------------------------------------------------------------------
// 取值
// ---------------------------------------------------------------------------

function fail(code, reason, pointer, at) {
  return { ok: false, code: code, reason: reason, pointer: pointer, at: at === undefined ? '' : at };
}

/**
 * 按指针从 chart 取值。
 *
 * ★★ 取不到 => {ok:false}，绝不回退、绝不返回 undefined 冒充成功。
 *
 * @param {any} chart  `chart.json` 解析后的对象
 * @param {string} pointer 具体指针（不含 `[]`）
 * @returns {{ok:true, value:any, type:string, pointer:string}
 *          |{ok:false, code:string, reason:string, pointer:string, at:string}}
 */
function resolve(chart, pointer) {
  try {
    const t = parsePointer(pointer);
    if (!t.ok) return fail(t.code, t.reason, typeof pointer === 'string' ? pointer : String(pointer), '');

    let cur = chart;
    let walked = '';

    for (let s = 0; s < t.segments.length; s++) {
      const seg = t.segments[s];

      if (UNSAFE_KEYS.has(seg.name)) {
        return fail('UNSAFE_KEY', '键名 "' + seg.name + '" 是原型链属性，拒绝访问', pointer, walked);
      }
      if (cur === null || cur === undefined) {
        return fail(
          'NULL_MIDWAY',
          '路径 "' + (walked || '<根>') + '" 的值是 ' + (cur === null ? 'null' : 'undefined') +
          '，无法继续取 "' + seg.name + '"',
          pointer, walked);
      }

      // 只用自有属性判存在 —— 不走原型链（否则 `constructor` 之类会"取到"东西）
      if (!Object.prototype.hasOwnProperty.call(cur, seg.name)) {
        return fail('KEY_MISSING', '键 "' + seg.name + '" 不存在于 "' + (walked || '<根>') + '"', pointer, walked);
      }

      let next = cur[seg.name];
      walked = walked ? walked + '.' + seg.name : seg.name;

      if (seg.index !== null) {
        if (!Array.isArray(next)) {
          return fail('NOT_AN_ARRAY', '"' + walked + '" 不是数组，不能用下标', pointer, walked);
        }
        if (next.length === 0) {
          return fail('EMPTY_ARRAY', '"' + walked + '" 是空数组，取 [' + seg.index + '] 无意义', pointer, walked);
        }
        if (seg.index >= next.length) {
          return fail(
            'INDEX_OUT_OF_RANGE',
            '下标 [' + seg.index + '] 越界："' + walked + '" 长度 ' + next.length,
            pointer, walked);
        }
        next = next[seg.index];
        walked += '[' + seg.index + ']';
      }

      cur = next;
    }

    return { ok: true, value: cur, type: typeOf(cur), pointer: pointer };
  } catch (err) {
    // 兜住但不掩饰：仍然是失败，且写 stderr 供排查
    process.stderr.write('[anchor-resolver] INTERNAL 指针=' + String(pointer) + ' 错误=' + err.message + '\n');
    return fail('INTERNAL', 'resolver 内部异常：' + err.message, String(pointer), '');
  }
}

/**
 * 批量取值（顺序保持）。供校验器使用。
 * @returns {Array<{pointer:string, ok:boolean, …}>}
 */
function resolveAll(chart, pointers) {
  return pointers.map((p) => resolve(chart, p));
}

// ---------------------------------------------------------------------------
// 模板实例化（供键清单工具使用 —— 把 `X[]` 变成具体的 `X[0]`）
// ---------------------------------------------------------------------------

/**
 * 把一条模板键（含 `[]`）在给定 chart 上实例化成具体指针。
 *
 * 为什么需要它：`dump-chart-keys.js` 输出的 178 条是**模板**（`X[]` 表示数组），
 * 而 resolver **不接受 `[]`**。要证明「178 条键 resolver 都能取」，必须先实例化。
 *
 * ⚠ 这里又是一处「达标粒度」（见 67/70 的教训）：
 *    「键清单里有这条」≠「这条在某份 chart 上能实例化并取到值」。
 *    特别是 `dump-chart-keys.js:65` —— `X[]` 只在**空数组**时才作为条目产出，
 *    非空时产出的是 `X[].子键` ⇒ 那个 `X[]` 条目在**产生它的那份样本上**永远实例化不了。
 *
 * @returns {{ok:true, pointer:string, value:any}|{ok:false, code:string, reason:string}}
 */
function instantiate(chart, template) {
  const t = parseTemplate(template);
  if (!t.ok) return { ok: false, code: t.code, reason: t.reason };

  // dfs(segIdx, cur, walked) —— 遇到模板下标就试遍所有元素，取第一个走得通的
  function dfs(si, cur, walked) {
    if (si >= t.segments.length) return { ok: true, value: cur, pointer: walked };
    const seg = t.segments[si];

    if (UNSAFE_KEYS.has(seg.name)) return { ok: false, code: 'UNSAFE_KEY', reason: '键名 "' + seg.name + '" 被拒绝' };
    if (cur === null || cur === undefined) {
      return { ok: false, code: 'NULL_MIDWAY', reason: '"' + (walked || '<根>') + '" 是 ' + String(cur) };
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg.name)) {
      return { ok: false, code: 'KEY_MISSING', reason: '键 "' + seg.name + '" 不存在于 "' + (walked || '<根>') + '"' };
    }

    const node = cur[seg.name];
    const base = walked ? walked + '.' + seg.name : seg.name;

    if (seg.index === TEMPLATE_INDEX) {
      if (!Array.isArray(node)) return { ok: false, code: 'NOT_AN_ARRAY', reason: '"' + base + '" 不是数组' };
      if (node.length === 0) {
        return { ok: false, code: 'EMPTY_ARRAY', reason: '"' + base + '" 是空数组（无元素可实例化）' };
      }
      for (let idx = 0; idx < node.length; idx++) {
        const r = dfs(si + 1, node[idx], base + '[' + idx + ']');
        if (r.ok) return r;
      }
      return { ok: false, code: 'NO_INDEX_WORKS', reason: '"' + base + '" 的 ' + node.length + ' 个元素都无法走通后续段' };
    }

    const nbase = seg.index === null ? base : base + '[' + seg.index + ']';
    if (seg.index !== null) {
      if (!Array.isArray(node)) return { ok: false, code: 'NOT_AN_ARRAY', reason: '"' + base + '" 不是数组' };
      if (seg.index >= node.length) {
        return { ok: false, code: 'INDEX_OUT_OF_RANGE', reason: '下标 [' + seg.index + '] 越界：长度 ' + node.length };
      }
      return dfs(si + 1, node[seg.index], nbase);
    }
    return dfs(si + 1, node, nbase);
  }

  const r = dfs(0, chart, '');
  if (!r.ok) return r;
  // 实例化出来的指针，必须能被严格 resolver 取到（自证：两条代码路径一致）
  const back = resolve(chart, r.pointer);
  if (!back.ok) {
    return { ok: false, code: 'INSTANTIATE_INCONSISTENT', reason: '实例化出 "' + r.pointer + '" 但 resolve 失败：' + back.code };
  }
  return { ok: true, pointer: r.pointer, value: back.value, type: back.type };
}

// ---------------------------------------------------------------------------
module.exports = {
  resolve: resolve,
  resolveAll: resolveAll,
  parsePointer: parsePointer,
  parseTemplate: parseTemplate,
  instantiate: instantiate,
  TEMPLATE_INDEX: TEMPLATE_INDEX,
  FAIL_CODES: FAIL_CODES,
  // 显式声明：本模块没有回退能力。供校验器/测试断言。
  NO_FALLBACK: true,
};
