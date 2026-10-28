'use strict';
/**
 * pkg-root.js —— **包根口径**：包根的**唯一**推法
 *
 * ## 为什么有这个文件
 *
 * 包里三个脚本原本各推各的「包根」：
 *
 * | 脚本 | 原推法 | 在仓内 | **在包里** |
 * |---|---|---|---|
 * | `chart.js`         | 向上搜索 `lib/bazi/index.js` | ✅ | ✅ |
 * | `astro.js`         | `path.resolve(__dirname,'..')` | ✅ | ✅ |
 * | `render-decision.js` | `path.resolve(__dirname,'..','..')` | ✅ | ❌ **＝ 包的上一级** |
 *
 * **⇒ 在包里，渲染器把包根算成 `<包>/..`（包外），而不是包自己。**
 * **⇒ 这不是"某个路径写错"，是三个文件对同一件事有三种理解 —— 改一处会在别处复发。**
 *
 * **这个 bug 的历史**（工单 §四-1 要回答的）：
 *   - 端到端冒烟由端到端冒烟第一次撞出来 —— 当时报了，但 当时的禁做项里没有授权改 ``。
 *   - `87` 单（10-17）禁做项 8 明写「不顺手改」⇒ 又一次报上来、又一次没修。
 *   - `90` 单（10-18）我新写 `astro.js` 时**照抄了开发树的 `'..'`**，等于又引入了一种推法（`90-交付 §二-①` 记了）。
 *   - `94` 单（10-19）：它挡在产品化路上了 ⇒ 现在统一。
 *
 * ## 推法（**顺序有意义**）
 *
 * 1. **含 `PACKAGING-NOTES.md` 的那一级** = 包根（干净包的 MARKER，`build-clean-package.js:38`）
 * 2. 找不到 ⇒ **含 `run-chart.js` ＋ `lib/bazi/index.js` 的那一级**（仓内形态）
 * 3. 都找不到 ⇒ **报错退出**，消息里写明试过哪些目录 —— **不许静默回退到 cwd 或上上级**
 *
 * ⚠️ 为什么不能反过来（先找 `lib/bazi/index.js`）：仓内 `lib/` 在仓根，包里 `lib/` 也在包根，
 *    两种形态都能命中 —— 看起来没问题。但**先找 MARKER 更准**：MARKER 是"这是一个打包产物"的
 *    显式声明，而 `lib/bazi/index.js` 只是"这里有自研链"。**先找后者会在嵌套包/多副本场景下误判。**
 */
const fs = require('node:fs');
const path = require('node:path');

/** 向上最多找几层（与 `chart.js` 的 `findEngineRoot` 一致，防止病态目录死循环） */
const MAX_UP = 12;

/**
 * @param {string} fromDir 起点（通常传 `__dirname`）
 * @returns {string} 包根的绝对路径
 * @throws {Error} 找不到时抛错（消息含试过的目录）
 */
function resolvePkgRoot(fromDir) {
  const tried = [];
  let d = path.resolve(fromDir);

  // ① 包形态：含 PACKAGING-NOTES.md（MARKER）
  for (let i = 0; i < MAX_UP; i++) {
    if (fs.existsSync(path.join(d, 'PACKAGING-NOTES.md'))) return d;
    tried.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }

  // ② 仓内形态：含 run-chart.js ＋ lib/bazi/index.js
  d = path.resolve(fromDir);
  for (let i = 0; i < MAX_UP; i++) {
    if (fs.existsSync(path.join(d, 'run-chart.js')) && fs.existsSync(path.join(d, 'lib', 'bazi', 'index.js'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }

  // ③ 都找不到 ⇒ 报错，不许回退
  throw new Error(
    '包不完整：未找到自研排盘链（resolvePkgRoot 向上 ' + MAX_UP + ' 层都没见到 PACKAGING-NOTES.md，' +
    '也没见到 run-chart.js + lib/bazi/index.js）。请重新解压完整包。\n' +
    '  起点：' + path.resolve(fromDir) + '\n' +
    '  试过的目录（' + tried.length + ' 个）：\n' +
    tried.map((x) => '    - ' + x).join('\n')
  );
}

module.exports = { resolvePkgRoot, MAX_UP };
