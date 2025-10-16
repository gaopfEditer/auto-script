@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 设置颜色
color 0A

REM 显示标题
echo ========================================
echo        关机时Git自动提交脚本
echo ========================================
echo.

REM 设置目标目录
set "TARGET_DIR=D:\frontend\my-journal-planning"

REM 检查目录是否存在
if not exist "%TARGET_DIR%" (
    echo [错误] 目录不存在: %TARGET_DIR%
    echo 请检查路径是否正确
    goto :end
)

REM 切换到目标目录
cd /d "%TARGET_DIR%"

echo [信息] 当前目录: %CD%
echo [信息] 开始执行Git提交操作...
echo.

REM 检查是否为Git仓库
if not exist ".git" (
    echo [错误] 当前目录不是Git仓库
    echo 请先初始化Git仓库: git init
    goto :end
)

REM 获取当前时间
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
set "YY=%dt:~2,2%" & set "YYYY=%dt:~0,4%" & set "MM=%dt:~4,2%" & set "DD=%dt:~6,2%"
set "HH=%dt:~8,2%" & set "Min=%dt:~10,2%" & set "Sec=%dt:~12,2%"
set "TIMESTAMP=%YYYY%-%MM%-%DD% %HH%:%Min%:%Sec%"

REM 添加所有更改的文件
echo [步骤1] 添加所有更改的文件...
git add .
if %errorlevel% neq 0 (
    echo [错误] Git add 失败
    goto :end
)
echo [成功] 文件已添加到暂存区

REM 检查是否有更改需要提交
git diff --staged --quiet
if %errorlevel% equ 0 (
    echo [信息] 没有检测到需要提交的更改
    echo 工作区是干净的，无需提交
    goto :end
)

REM 生成提交信息
set "COMMIT_MSG=关机前自动提交 - %TIMESTAMP%"

REM 提交更改
echo [步骤2] 提交更改...
echo 提交信息: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"
if %errorlevel% neq 0 (
    echo [错误] Git commit 失败
    goto :end
)
echo [成功] 更改已提交

REM 推送到远程仓库（如果配置了远程仓库）
echo [步骤3] 检查远程仓库...
git remote -v >nul 2>&1
if %errorlevel% equ 0 (
    echo [信息] 检测到远程仓库，尝试推送...
    git push
    if %errorlevel% equ 0 (
        echo [成功] 已推送到远程仓库
    ) else (
        echo [警告] 推送到远程仓库失败，但本地提交成功
    )
) else (
    echo [信息] 未配置远程仓库，跳过推送
)

echo.
echo ========================================
echo          关机提交完成！
echo ========================================
echo 提交时间: %TIMESTAMP%
echo 提交信息: %COMMIT_MSG%
echo.

:end
echo 脚本执行完成，系统即将关机...
