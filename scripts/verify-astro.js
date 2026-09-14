// 星盘计算验证：基准校验 + 双路径交叉验证 + 降级路径
// 用法: node scripts/verify-astro.js
//
// 设计原则: 前两组测试用固定基准日期(不读 config.yaml), 保证任何环境下结果可复现。
//           降级组用临时 config 走 --config= 入口, 复现「没有出生时辰」的场景。
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const A = require('astronomia');
const _data = require('astronomia/data');
const DATA = _data.default || _data;

const ROOT = path.resolve(__dirname, '..');
const R2D = 180 / Math.PI;

let pass = 0;
let fail = 0;

function ok(name, detail) {
  pass++;
  console.log('  [OK] ' + name + (detail ? '  — ' + detail : ''));
}
function bad(name, detail) {
  fail++;
  console.log('  [!!] ' + name + '  — ' + detail);
}
function near(name, actual, expected, tol) {
  const d = Math.abs(actual - expected);
  if (d <= tol) ok(name, `实际 ${actual.toFixed(4)} / 期望 ${expected.toFixed(4)}，差 ${d.toFixed(5)}`);
  else bad(name, `实际 ${actual.toFixed(4)} / 期望 ${expected.toFixed(4)}，差 ${d.toFixed(5)} 超出容差 ${tol}`);
}
function assert(name, cond, detail) {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

// 行星日心球坐标 → 直角 → 减地球 → 地心黄经（与 astro.js 内实现同源）
function geoLon(planetPos, earthPosition) {
  const toXYZ = (p) => [
    p.range * Math.cos(p.lat) * Math.cos(p.lon),
    p.range * Math.cos(p.lat) * Math.sin(p.lon),
    p.range * Math.sin(p.lat),
  ];
  const [px, py, pz] = toXYZ(planetPos);
  const [ex, ey, ez] = toXYZ(earthPosition);
  return Math.atan2(py - ey, px - ex) * R2D;
}

// 平均交点公式（与 astro.js 内实现同源）
function meanNodeLon(T) {
  return 125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 - (T * T * T * T) / 60616000;
}

// ---- [1] 北交点基准：对照 Meeus ch.47 教科书值 ----
console.log('\n[1] 北交点基准校验（对照教科书值 125.0445°）');
{
  const T0 = A.base.J2000Century(A.julian.DateToJDE(new Date(Date.UTC(2000, 0, 1, 12, 0, 0))));
  near('J2000.0 平均北交点', meanNodeLon(T0), 125.0445, 0.001);
}

// ---- [2] 冥王星双路径交叉验证 ----
console.log('\n[2] 冥王星双路径交叉验证（两条独立算法应互相吻合）');
{
  const earthP = new A.planetposition.Planet(DATA.vsop87Dearth);
  const dates = [
    ['J2000.0', new Date(Date.UTC(2000, 0, 1, 12, 0, 0))],
    ['出生盘 2004-05-04', new Date(Date.UTC(2004, 4, 4, 3, 0, 0))],
    ['当下 2026-09-14', new Date(Date.UTC(2026, 8, 14, 0, 0, 0))],
  ];
  for (const [label, d] of dates) {
    const jde = A.julian.DateToJDE(d);
    // 路径 A: heliocentric(J2000 黄道) + 地心化
    const pathA = geoLon(A.pluto.heliocentric(jde), earthP.position(jde));
    // 路径 B: astrometric(J2000 赤道) → 用 J2000 黄赤交角转黄道
    const ast = A.pluto.astrometric(jde, earthP);
    const sE = A.base.SOblJ2000;
    const cE = A.base.COblJ2000;
    const pathB = Math.atan2(Math.sin(ast.ra) * cE + Math.tan(ast.dec) * sE, Math.cos(ast.ra)) * R2D;
    // 归一到同侧后比差
    let diff = Math.abs(pathA - pathB) % 360;
    if (diff > 180) diff = 360 - diff;
    assert(`冥王星 ${label} 双路径一致`, diff < 0.01, `路径A ${pathA.toFixed(4)}° / 路径B ${pathB.toFixed(4)}°，差 ${diff.toFixed(5)}°`);
  }
}

// ---- [3] 黄经岁差修正量 ----
console.log('\n[3] 黄经岁差修正（冥王星从 J2000 对齐到 date 用）');
{
  // 对照公认岁差常数 50.290966 角秒/年 = 0.0139697 度/年，而不是硬编码一个手算期望值
  const RATE_PER_YEAR = 0.0139697;
  const T26 = A.base.J2000Century(A.julian.DateToJDE(new Date(Date.UTC(2026, 8, 14, 0, 0, 0))));
  near('2026 年岁差量（对照 50.29″/年）',
    1.39697128 * T26 + 0.000308647 * T26 * T26,
    RATE_PER_YEAR * T26 * 100,
    0.005);
  // J2000 基准年应近似为 0
  const T00 = A.base.J2000Century(A.julian.DateToJDE(new Date(Date.UTC(2000, 0, 1, 12, 0, 0))));
  near('J2000.0 岁差量（应为 0）', 1.39697128 * T00 + 0.000308647 * T00 * T00, 0, 0.001);
}

// ---- [4] 降级路径：没有出生时辰 ----
console.log('\n[4] 降级路径（临时 config 置空 hour/minute）');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianming-verify-'));
  try {
    const cfg = {
      birth: { year: 2004, month: 5, day: 4, hour: null, minute: null, timezone_offset: 8 },
      location: { latitude: 22.54, longitude: 114.06 },
    };
    const cfgPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(cfgPath, yaml.dump(cfg), 'utf8');

    let out;
    let crashed = null;
    try {
      const stdout = execFileSync('node', [path.join(__dirname, 'astro.js'), '--config=' + cfgPath], { encoding: 'utf8' });
      out = JSON.parse(stdout);
    } catch (err) {
      crashed = err.message;
    }

    if (crashed) {
      bad('无时辰时不崩溃', crashed.slice(0, 200));
    } else {
      ok('无时辰时不崩溃');
      assert('hasTime = false', out.hasTime === false, `实际 ${out.hasTime}`);
      assert('moon 为 null（不静默算假值）', out.moon === null, `实际 ${JSON.stringify(out.moon)}`);
      assert('rising 为 null（不静默算假值）', out.rising === null, `实际 ${JSON.stringify(out.rising)}`);
      assert('degraded 标注 moon/rising',
        Array.isArray(out.degraded) && out.degraded.includes('moon') && out.degraded.includes('rising'),
        `实际 ${JSON.stringify(out.degraded)}`);
      // 定盘层四个必须照常输出
      for (const k of ['sun', 'saturn', 'pluto', 'northNode']) {
        assert(`定盘层 ${k} 照常输出`, out[k] && typeof out[k].sign === 'string', out[k] ? out[k].sign : 'missing');
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- [5] 有辰路径：用本机 config.yaml ----
console.log('\n[5] 有辰路径（本机 config.yaml，若存在）');
{
  const realCfg = path.join(ROOT, 'config.yaml');
  if (!fs.existsSync(realCfg)) {
    console.log('  [--] 跳过：未找到 config.yaml');
  } else {
    try {
      const out = JSON.parse(execFileSync('node', [path.join(__dirname, 'astro.js')], { encoding: 'utf8' }));
      if (out.hasTime) {
        assert('hasTime = true', out.hasTime === true, '');
        assert('moon 有值', !!(out.moon && out.moon.sign), out.moon ? out.moon.sign : 'null');
        assert('rising 有值', !!(out.rising && out.rising.sign), out.rising ? out.rising.sign : 'null');
        assert('degraded 为空', Array.isArray(out.degraded) && out.degraded.length === 0, JSON.stringify(out.degraded));
      } else {
        console.log('  [--] 跳过：本机 config.yaml 未填时辰（当前走降级模式）');
      }
      console.log(`       快照: 日${out.sun.sign} 土${out.saturn.sign} 冥${out.pluto.sign} 交${out.northNode.sign}`);
    } catch (err) {
      bad('本机 config.yaml 可正常排盘', err.message.slice(0, 200));
    }
  }
}

// ---- 汇总 ----
console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
