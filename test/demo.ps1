# Full auth demo for Windows PowerShell
# 1) try fixed CamBridge JWT
# 2) then local issue / expire / refresh flow
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File test/demo.ps1

$ErrorActionPreference = "Stop"
$base = if ($env:TOKEN_TEST_BASE) { $env:TOKEN_TEST_BASE } else { "http://127.0.0.1:3981" }

$authToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiQ2FtYnJpZGdlLVNjcmVlbi0wMDAwMDAwMSIsImlzcyI6IkNhbUJyaWRnZSIsInN1YiI6IkNhbWJyaWRnZS1TY3JlZW4tMDAwMDAwMDEiLCJuYmYiOjE3NjQ1NzA0NTIsImlhdCI6MTc2NDU3MDQ1Mn0.yrB3NK_w2xjI8V5jAeNWDmW5I417NB2YVzimjiNxEHs"

function Show-Json($obj) {
  $obj | ConvertTo-Json -Depth 6
}

Write-Host "BASE = $base"
Write-Host ""

Write-Host "======== A) fixed JWT => /api/protected ========"
try {
  $fixed = Invoke-RestMethod -Method GET -Uri "$base/api/protected" `
    -Headers @{ Authorization = "Bearer $authToken" }
  Show-Json $fixed
} catch {
  $resp = $_.ErrorDetails.Message
  if (-not $resp -and $_.Exception.Response) {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $resp = $reader.ReadToEnd()
  }
  if (-not $resp) { $resp = $_.Exception.Message }
  Write-Host $resp
}
Write-Host "Note: this JWT is signed by CamBridge; local test server uses another secret, so it is usually INVALID."
Write-Host ""

Write-Host "======== B1) issue token ========"
$issue = Invoke-RestMethod -Method POST -Uri "$base/api/token" `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ ttlSeconds = 120; sub = "demo" } | ConvertTo-Json)
$token = [string]$issue.token
if (-not $token) { throw "issue failed: $(Show-Json $issue)" }
Write-Host "token len=$($token.Length)"
Write-Host $token
Write-Host ""

Write-Host "======== B2) valid token => OK ========"
$ok = Invoke-RestMethod -Method GET -Uri "$base/api/protected" `
  -Headers @{ Authorization = "Bearer $token" }
Show-Json $ok
Write-Host ""

Write-Host "======== B3) issue expired token ========"
$exp = Invoke-RestMethod -Method POST -Uri "$base/api/token/expired" `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ sub = "demo" } | ConvertTo-Json)
$bad = [string]$exp.token
if (-not $bad) { throw "expired issue failed: $(Show-Json $exp)" }
Write-Host "expired len=$($bad.Length)"
Write-Host $bad
Write-Host ""

Write-Host "======== B4) expired token => FAIL ========"
try {
  Invoke-RestMethod -Method GET -Uri "$base/api/protected" `
    -Headers @{ Authorization = "Bearer $bad" }
  throw "expected 401 but succeeded"
} catch {
  $resp = $_.ErrorDetails.Message
  if (-not $resp -and $_.Exception.Response) {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $resp = $reader.ReadToEnd()
  }
  if (-not $resp) { $resp = $_.Exception.Message }
  Write-Host $resp
}
Write-Host ""

Write-Host "======== B5) refresh token ========"
$ref = Invoke-RestMethod -Method POST -Uri "$base/api/token/refresh" `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ token = $bad } | ConvertTo-Json)
$new = [string]$ref.token
if (-not $new) { throw "refresh failed, empty token: $(Show-Json $ref)" }
Write-Host "new token len=$($new.Length)"
Write-Host $new
Show-Json $ref
Write-Host ""

Write-Host "======== B6) new token => OK ========"
$ok2 = Invoke-RestMethod -Method GET -Uri "$base/api/protected" `
  -Headers @{ Authorization = "Bearer $new" }
Show-Json $ok2
Write-Host ""
Write-Host "ALL PASSED"
