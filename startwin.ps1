#Requires -Version 5.1
<#
.SYNOPSIS
  Windows 一键启动：按 startwin.config.json 顺序启动 VPN、文件管理器、日志、Chrome 等。

.EXAMPLE
  .\startwin.ps1
  .\startwin.ps1 -ConfigPath D:\my\startwin.config.json
#>
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "startwin.config.json"),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$ts][$Level] $Message"
}

function Split-ArgsString {
  param([string]$Raw)
  if ([string]::IsNullOrWhiteSpace($Raw)) { return @() }

  $parts = New-Object System.Collections.Generic.List[string]
  $current = New-Object System.Text.StringBuilder
  $inQuotes = $false

  for ($i = 0; $i -lt $Raw.Length; $i++) {
    $ch = $Raw[$i]
    if ($ch -eq '"') {
      $inQuotes = -not $inQuotes
      continue
    }
    if (-not $inQuotes -and $ch -eq ' ') {
      if ($current.Length -gt 0) {
        $parts.Add($current.ToString())
        $current.Clear() | Out-Null
      }
      continue
    }
    [void]$current.Append($ch)
  }

  if ($current.Length -gt 0) {
    $parts.Add($current.ToString())
  }

  return $parts.ToArray()
}

function Start-ConfiguredApp {
  param(
    [string]$Id,
    [object]$App
  )

  $enabled = $true
  if ($App.PSObject.Properties.Name -contains "enabled") {
    $enabled = [bool]$App.enabled
  }
  if (-not $enabled) {
    Write-Log "跳过 $Id（已禁用）" "SKIP"
    return
  }

  $label = if ($App.label) { [string]$App.label } else { $Id }
  $delay = 0
  if ($App.PSObject.Properties.Name -contains "delay") {
    $delay = [int]$App.delay
  }
  if ($delay -gt 0) {
    Write-Log "等待 ${delay}ms 后启动: $label"
    Start-Sleep -Milliseconds $delay
  }

  $exePath = [string]$App.path
  if ([string]::IsNullOrWhiteSpace($exePath)) {
    Write-Log "$label 未配置 path" "WARN"
    return
  }

  $argList = @()
  if ($App.PSObject.Properties.Name -contains "args") {
    $rawArgs = [string]$App.args
    if ($rawArgs -match '^\s*\[') {
      try {
        $parsed = $rawArgs | ConvertFrom-Json
        if ($parsed -is [System.Array]) {
          $argList = @($parsed | ForEach-Object { [string]$_ })
        }
      } catch {
        $argList = Split-ArgsString $rawArgs
      }
    } else {
      $argList = Split-ArgsString $rawArgs
    }
  }

  if ($App.PSObject.Properties.Name -contains "url") {
    $url = [string]$App.url
    if (-not [string]::IsNullOrWhiteSpace($url)) {
      $argList += $url
    }
  }

  $isSystemCmd = ($exePath -notmatch '[\\/]')
  if (-not $isSystemCmd -and -not (Test-Path -LiteralPath $exePath)) {
    Write-Log "$label 路径不存在: $exePath" "ERROR"
    return
  }

  $quotedExe = if ($exePath -match '\s') { "`"$exePath`"" } else { $exePath }
  $quotedArgs = ($argList | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
  }) -join ' '
  $cmdPreview = if ($quotedArgs) { "$quotedExe $quotedArgs" } else { $quotedExe }
  Write-Log "启动 $label → $cmdPreview"

  if ($DryRun) {
    Write-Log "$label [DryRun] 跳过实际启动" "SKIP"
    return
  }

  try {
    if (@($argList).Length -gt 0) {
      Start-Process -FilePath $exePath -ArgumentList $argList -WindowStyle Normal | Out-Null
    } else {
      Start-Process -FilePath $exePath -WindowStyle Normal | Out-Null
    }
    Write-Log "$label 已启动" "OK"
  } catch {
    Write-Log "$label 启动失败: $($_.Exception.Message)" "ERROR"
  }
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Log "配置文件不存在: $ConfigPath" "ERROR"
  exit 1
}

Write-Log "读取配置: $ConfigPath"
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$order = @()
if ($config.PSObject.Properties.Name -contains "order" -and $config.order) {
  $order = @($config.order | ForEach-Object { [string]$_ })
}

$apps = $null
if ($config.PSObject.Properties.Name -contains "apps") {
  $apps = $config.apps
} else {
  # 兼容顶层直接写 vpn/chrome 等键
  $apps = $config
}

if ($order.Count -eq 0) {
  $order = @($apps.PSObject.Properties.Name)
}

Write-Log "启动顺序: $($order -join ' → ')"
Write-Log "========================================"

foreach ($id in $order) {
  if (-not ($apps.PSObject.Properties.Name -contains $id)) {
    Write-Log "配置中无应用: $id" "WARN"
    continue
  }
  Start-ConfiguredApp -Id $id -App $apps.$id
}

Write-Log "========================================"
Write-Log "一键启动完成"
