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

# 校验自研排盘链完整性（lib/ + run-chart.js 随包内置，缺失说明包不完整）
$chainEntry = Join-Path $src "run-chart.js"
$baziCore   = Join-Path $src "lib\bazi\index.js"
if ((-not (Test-Path $chainEntry)) -or (-not (Test-Path $baziCore))) {
  Write-Error "包不完整：未找到自研排盘链（应有 run-chart.js + lib\bazi\index.js）。请重新解压完整包后再安装。"
  exit 1
}

# 复制整个 skill 目录到目标（失败即报错退出，不留半成品）
try {
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst -Confirm:$false }
  Copy-Item -Recurse -Force $src $dst
} catch {
  Write-Error "部署失败：$($_.Exception.Message)"
  exit 1
}
# 根依赖（astronomia + js-yaml + iztro + lunar-javascript）
# 逐个校验，而不是只看 node_modules 目录在不在：
# 若上次装到一半中断，目录还在但包不全，此时跳过安装会导致运行时「找不到模块」
$pkgJson = [System.IO.File]::ReadAllText((Join-Path $dst "package.json"), [System.Text.Encoding]::UTF8)
$requiredDeps = ($pkgJson | ConvertFrom-Json).dependencies.PSObject.Properties.Name
$missing = @()
foreach ($dep in $requiredDeps) {
  if (-not (Test-Path (Join-Path $dst "node_modules\$dep") -PathType Container)) {
    $missing += $dep
  }
}
if ($missing.Count -gt 0) {
  Write-Host "检测到缺失依赖：$($missing -join ', ') —— 开始安装"
  Invoke-NpmInstall $dst
}
Write-Host "已安装到 $dst"
