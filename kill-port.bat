@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

title 结束占用端口的进程

echo.
echo ========================================
echo   按端口号结束本机占用该端口的进程
echo ========================================
echo.

set /p PORT=请输入端口号: 

if "%PORT%"=="" (
    echo [错误] 未输入端口。
    goto :end
)

echo %PORT%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo [错误] 端口必须是正整数。
    goto :end
)

if %PORT% LSS 1 (
    echo [错误] 端口范围无效。
    goto :end
)
if %PORT% GTR 65535 (
    echo [错误] 端口不能超过 65535。
    goto :end
)

set FOUND=0
set KILLED=0

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% " /C:".%PORT% " 2^>nul') do (
    set PID=%%a
    if not "!PID!"=="0" (
        echo !PID!| findstr /r "^[0-9][0-9]*$" >nul
        if not errorlevel 1 (
            set FOUND=1
            echo.
            echo 发现 PID !PID! 占用端口 %PORT%
            tasklist /FI "PID eq !PID!" 2>nul | findstr /I "!PID!"
            taskkill /PID !PID! /F >nul 2>&1
            if !errorlevel! equ 0 (
                echo [成功] 已结束 PID !PID!
                set /a KILLED+=1
            ) else (
                echo [失败] 无法结束 PID !PID! — 请右键「以管理员身份运行」本脚本后重试。
            )
        )
    )
)

if %FOUND% equ 0 (
    echo.
    echo 未找到监听/占用端口 %PORT% 的进程。
) else if %KILLED% equ 0 (
    echo.
    echo 找到进程但均未成功结束。
) else (
  echo.
  echo 已结束 %KILLED% 个进程。
)

:end
echo.
pause