// 读取 config.yaml → 真太阳时校正(可选) → 调 engine 排盘 → 输出 bazi JSON
// 引擎版本: dzcmemory-web/bazi-ziwei-skill @ 8fd7dfa
// 真太阳时校正：包装层基于 location.longitude 计算偏移（每经度 4 分钟），手动调整 hour/minute/day
//   - useTraditionalSolar=true（默认）: 做校正
//   - useTraditionalSolar=false: 保持原钟表时间
//   - 无 location.longitude: 不管 useTraditionalSolar，都不校正
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const config = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
const b = config.birth;
const loc = config.location || {};

// 真太阳时校正函数
function applyTrueSolarTime(birth, longitude) {
  if (longitude === undefined || longitude === null || longitude === '') {
    return { birth, offsetMinutes: 0, dayDelta: 0, applied: false };
  }
  const TZ_BASE_LON = 120; // UTC+8 基准经度（北京时对应的中央经线）
  const offsetMinutes = Math.round((longitude - TZ_BASE_LON) * 4); // 每度 4 分钟
  let totalMin = birth.hour * 60 + birth.minute + offsetMinutes;
  let dayDelta = 0;
  while (totalMin < 0) { totalMin += 1440; dayDelta -= 1; }
  while (totalMin >= 1440) { totalMin -= 1440; dayDelta += 1; }
  const base = new Date(birth.year, birth.month - 1, birth.day);
  base.setDate(base.getDate() + dayDelta);
  return {
    birth: {
      year: base.getFullYear(),
      month: base.getMonth() + 1,
      day: base.getDate(),
      hour: Math.floor(totalMin / 60),
      minute: totalMin % 60,
      gender: birth.gender,
    },
    offsetMinutes,
    dayDelta,
    applied: true,
  };
}

// useTraditionalSolar 默认 true（传统命理主流做法）。关闭校正见 SKILL.md 第六节：config.yaml 设 useTraditionalSolar: false。
const useTraditionalSolar = config.useTraditionalSolar !== false;
const tst = useTraditionalSolar ? applyTrueSolarTime(b, loc.longitude) : { birth: b, offsetMinutes: 0, dayDelta: 0, applied: false };
const adj = tst.birth;

const calculatorDir = path.join(ROOT, 'engine', 'calculator');
const engineScript = path.join(calculatorDir, 'dist', 'run-chart.js');
if (!fs.existsSync(engineScript)) {
  // 引擎缺失 —— 降级而非退出：星盘轨/国学/健壮性认知系统仍可用，只是八字轨算不了。
  // 输出合法 JSON 并以 0 退出，调用方(render-decision.js)不会崩。
  console.log(JSON.stringify({
    engineAvailable: false,
    degraded: ['bazi', 'ziwei'],
    reason: '排盘引擎缺失：' + engineScript,
    hint: '八字轨（四柱/十神/大运流年/紫微）在本机不可用。引擎是第三方组件，其上游仓库已下架，本 skill 不分发其代码；需自行准备并放入 engine/，使其包含 engine/calculator/dist/run-chart.js。',
  }, null, 2));
  process.exit(0);
}
const args = [
  engineScript,
  `--year=${adj.year}`, `--month=${adj.month}`, `--day=${adj.day}`,
  `--hour=${adj.hour}`, `--minute=${adj.minute}`, `--gender=${adj.gender}`,
];
let stdout;
try {
  stdout = execFileSync('node', args, { cwd: calculatorDir, encoding: 'utf8' });
} catch (err) {
  console.error('排盘失败：' + (err.stderr ? err.stderr.toString().slice(0, 500) : err.message));
  process.exit(1);
}
let chart;
try {
  chart = JSON.parse(stdout);
} catch (err) {
  console.error('引擎输出不是有效 JSON。stdout=' + stdout.slice(0, 500));
  process.exit(1);
}
if (!chart || !chart.bazi) {
  console.error('引擎未返回有效 bazi 数据。stdout=' + stdout.slice(0, 500));
  process.exit(1);
}
console.log(JSON.stringify({
  engineAvailable: true,
  degraded: [],
  trueSolarTime: {
    applied: tst.applied,
    mode: useTraditionalSolar ? 'traditional' : 'clock',
    longitude: loc.longitude,
    offsetMinutes: tst.offsetMinutes,
    dayDelta: tst.dayDelta,
    adjustedBirth: tst.applied ? { year: adj.year, month: adj.month, day: adj.day, hour: adj.hour, minute: adj.minute } : null,
  },
  bazi: chart.bazi,
  ziwei: chart.ziwei || null,
}, null, 2));