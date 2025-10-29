@echo off
chcp 65001 >nul
echo ==========================================
echo           代码拉取工具
echo ==========================================
echo.

:: 检查是否在git仓库中
git status >nul 2>&1
if errorlevel 1 (
    echo 错误：当前目录不是git仓库！
    echo 请确保在正确的项目目录中运行此脚本。
    pause
    exit /b 1
)

echo 正在检查当前分支状态...
git branch --show-current
echo.

:: 显示当前状态
echo 当前工作区状态：
git status --porcelain
echo.

:: 询问是否继续
set /p confirm="是否继续拉取代码？(y/n): "
if /i not "%confirm%"=="y" (
    echo 操作已取消。
    pause
    exit /b 0
)

echo.
echo 正在拉取最新代码...
echo ==========================================

:: 拉取代码
git pull

if errorlevel 1 (
    echo.
    echo 错误：代码拉取失败！
    echo 可能的原因：
    echo 1. 网络连接问题
    echo 2. 存在冲突需要解决
    echo 3. 没有权限访问远程仓库
    echo.
    echo 请检查错误信息并手动解决。
) else (
    echo.
    echo ==========================================
    echo 代码拉取成功！
    echo ==========================================
)

echo.
pause
