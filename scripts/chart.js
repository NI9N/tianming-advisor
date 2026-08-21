// 读取 config.yaml → 真太阳时校正 → 调 engine 排盘 → 输出 bazi JSON
// 引擎版本: dzcmemory-web/bazi-ziwei-skill @ 8fd7dfa
// 真太阳时校正：包装层基于 location.longitude 计算偏移（每经度 4 分钟），手动调整 hour/minute/day
//   - 有 location.longitude：做校正
//   - 无 location.longitude：保持原钟表时间（向后兼容）
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

const tst = applyTrueSolarTime(b, loc.longitude);
const adj = tst.birth;

const calculatorDir = path.join(ROOT, 'engine', 'calculator');
const engineScript = path.join(calculatorDir, 'dist', 'run-chart.js');
if (!fs.existsSync(engineScript)) {
  console.error('排盘引擎缺失：' + engineScript + '\n请先运行 install.ps1 拉取引擎（git clone bazi-ziwei-skill）。');
  process.exit(1);
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
  trueSolarTime: {
    applied: tst.applied,
    longitude: loc.longitude,
    offsetMinutes: tst.offsetMinutes,
    dayDelta: tst.dayDelta,
    adjustedBirth: tst.applied ? { year: adj.year, month: adj.month, day: adj.day, hour: adj.hour, minute: adj.minute } : null,
  },
  bazi: chart.bazi,
  ziwei: chart.ziwei || null,
}, null, 2));