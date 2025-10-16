@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo        Git路径测试工具
echo ========================================
echo.

set /p TEST_PATH="请输入要测试的Git路径: "

REM 去除路径两端的引号
set "TEST_PATH=%TEST_PATH:"=%"

echo.
echo 正在验证Git路径: %TEST_PATH%
echo.

REM 检查路径是否为空
if "%TEST_PATH%"=="" (
    echo [错误] 路径不能为空
    goto :end
)

REM 检查路径是否存在
if not exist "%TEST_PATH%" (
    echo [错误] 路径不存在: %TEST_PATH%
    goto :end
)

echo [成功] 路径存在

REM 检查是否为Git仓库
if not exist "%TEST_PATH%\.git" (
    echo [错误] 该目录不是Git仓库: %TEST_PATH%
    echo 请确保目录中包含.git文件夹
    goto :end
)

echo [成功] 是Git仓库

REM 检查Git是否可用
cd /d "%TEST_PATH%"
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] Git命令不可用，请确保Git已正确安装
    goto :end
)

echo [成功] Git命令可用

REM 检查Git仓库状态
git status >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] Git仓库状态异常，请检查仓库是否损坏
    goto :end
)

echo [成功] Git仓库状态正常

REM 显示仓库信息
echo.
echo === Git仓库信息 ===
echo 路径: %TEST_PATH%
echo 分支: 
git branch --show-current
echo 最新提交:
git log --oneline -1
echo 状态:
git status --short

echo.
echo [完成] Git路径验证通过！

:end
echo.
pause
