// 读取 config.yaml → 调 engine 排盘 → 输出 bazi JSON（只取需要的字段，省 token）
// 引擎版本: dzcmemory-web/bazi-ziwei-skill @ 8fd7dfa（排盘基于钟表时间，不做真太阳时校正）
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const config = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
const b = config.birth;

const calculatorDir = path.join(ROOT, 'engine', 'calculator');
const engineScript = path.join(calculatorDir, 'dist', 'run-chart.js');
if (!fs.existsSync(engineScript)) {
  console.error('排盘引擎缺失：' + engineScript + '\n请先运行 install.ps1 拉取引擎（git clone bazi-ziwei-skill）。');
  process.exit(1);
}
const args = [
  engineScript,
  `--year=${b.year}`, `--month=${b.month}`, `--day=${b.day}`,
  `--hour=${b.hour}`, `--minute=${b.minute}`, `--gender=${b.gender}`,
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
  bazi: chart.bazi,
  ziwei: chart.ziwei || null,
}, null, 2));
