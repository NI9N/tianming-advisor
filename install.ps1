# 安装 天命顾问 到 ~/.claude/skills/tianming-advisor/
$src = $PSScriptRoot          # 就是 tianming-advisor/ 目录本身
$dst = Join-Path "$HOME\.claude\skills" "tianming-advisor"

# 装依赖（失败即退出，避免假成功）
function Invoke-NpmInstall([string]$dir) {
  Push-Location $dir
  npm install
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    Write-Error "npm install 失败（exit $code）：$dir"
    exit 1
  }
}

# 检测排盘引擎（engine/ 不入库、不分发 —— 其上游仓库已下架，本仓库不含其代码）
# 缺失不阻断安装：skill 会走降级（八字轨不可用，星盘轨照常），详见 README「排盘引擎」
$engineScript = Join-Path $src "engine\calculator\dist\run-chart.js"
if (-not (Test-Path $engineScript)) {
  Write-Warning "未检测到排盘引擎（engine\calculator\dist\run-chart.js）"
  Write-Host "  安装会继续，但八字轨（四柱/十神/大运流年/紫微）不可用 —— skill 会自动降级，只走星盘轨。"
  Write-Host "  引擎为第三方组件，其上游仓库已下架，本仓库不分发；如需完整功能请自备并放入 engine\。"
}

# 复制整个 skill 目录到目标（失败即报错退出，不留半成品）
try {
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst -Confirm:$false }
  Copy-Item -Recurse -Force $src $dst
} catch {
  Write-Error "部署失败：$($_.Exception.Message)"
  exit 1
}
# 目标里不保留引擎的 .git（体积 + 无必要）
$dstGit = Join-Path $dst "engine\.git"
if (Test-Path $dstGit) { Remove-Item -Recurse -Force $dstGit -Confirm:$false }
# 根依赖（astronomia + js-yaml）
if (-not (Test-Path (Join-Path $dst "node_modules"))) {
  Invoke-NpmInstall $dst
}
# 引擎依赖（lunar-typescript）—— 仅在引擎存在时安装
$dstEngineCalc = Join-Path $dst "engine\calculator"
if ((Test-Path $dstEngineCalc) -and (-not (Test-Path (Join-Path $dstEngineCalc "node_modules")))) {
  Invoke-NpmInstall $dstEngineCalc
}
Write-Host "已安装到 $dst"
