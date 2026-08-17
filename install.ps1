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

# 确保排盘引擎存在（engine/ 不入库，安装时克隆）
$engineScript = Join-Path $src "engine\calculator\dist\run-chart.js"
if (-not (Test-Path $engineScript)) {
  # 有残留的不完整 engine/ 就先清掉，否则 git clone 会被"非空目录"卡死
  $engineDir = Join-Path $src "engine"
  if (Test-Path $engineDir) { Remove-Item -Recurse -Force $engineDir -Confirm:$false }
  Write-Host "排盘引擎缺失，克隆 bazi-ziwei-skill ..."
  Push-Location $src
  git clone --depth 1 https://github.com/dzcmemory-web/bazi-ziwei-skill.git engine
  Pop-Location
  if (-not (Test-Path $engineScript)) { Write-Error "引擎克隆失败：engine/calculator/dist/run-chart.js 仍不存在"; exit 1 }
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
# 引擎依赖（lunar-typescript）
if (-not (Test-Path (Join-Path $dst "engine\calculator\node_modules"))) {
  Invoke-NpmInstall (Join-Path $dst "engine\calculator")
}
Write-Host "已安装到 $dst"
