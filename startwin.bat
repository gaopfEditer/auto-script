@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ========================================
echo        Windows 一键启动
echo ========================================
echo 配置文件: %~dp0startwin.config.json
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0startwin.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [错误] 启动脚本退出码 %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

exit /b 0
