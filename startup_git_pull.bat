@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 设置颜色
color 0B

REM 显示标题
echo ========================================
echo        开机时Git自动拉取脚本
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
echo [信息] 开始执行Git拉取操作...
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

REM 检查远程仓库配置
echo [步骤1] 检查远程仓库配置...
git remote -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未配置远程仓库
    echo 请先添加远程仓库: git remote add origin <url>
    goto :end
)
echo [成功] 远程仓库配置正常

REM 获取远程分支信息
echo [步骤2] 获取远程分支信息...
git fetch origin
if %errorlevel% neq 0 (
    echo [错误] 获取远程分支信息失败
    echo 请检查网络连接和远程仓库地址
    goto :end
)
echo [成功] 远程分支信息获取完成

REM 检查当前分支
echo [步骤3] 检查当前分支...
for /f "tokens=*" %%i in ('git branch --show-current') do set "CURRENT_BRANCH=%%i"
echo 当前分支: %CURRENT_BRANCH%

REM 检查是否有未提交的更改
echo [步骤4] 检查工作区状态...
git status --porcelain >nul 2>&1
if %errorlevel% equ 0 (
    for /f %%i in ('git status --porcelain ^| find /c /v ""') do set "UNCOMMITTED_COUNT=%%i"
    if !UNCOMMITTED_COUNT! gtr 0 (
        echo [警告] 检测到未提交的更改，正在暂存...
        git stash push -m "开机前自动暂存 - %TIMESTAMP%"
        if %errorlevel% equ 0 (
            echo [成功] 未提交的更改已暂存
        ) else (
            echo [错误] 暂存失败
            goto :end
        )
    ) else (
        echo [信息] 工作区干净，无需暂存
    )
)

REM 拉取最新代码
echo [步骤5] 拉取最新代码...
git pull origin %CURRENT_BRANCH%
if %errorlevel% neq 0 (
    echo [错误] Git pull 失败
    echo 请检查网络连接和分支状态
    goto :end
)
echo [成功] 代码拉取完成

REM 恢复暂存的更改（如果有）
if defined UNCOMMITTED_COUNT if !UNCOMMITTED_COUNT! gtr 0 (
    echo [步骤6] 恢复暂存的更改...
    git stash pop
    if %errorlevel% equ 0 (
        echo [成功] 暂存的更改已恢复
    ) else (
        echo [警告] 恢复暂存更改时出现冲突，请手动处理
    )
)

REM 显示最新提交信息
echo [步骤7] 显示最新提交信息...
echo 最新提交:
git log --oneline -1

echo.
echo ========================================
echo          开机拉取完成！
echo ========================================
echo 拉取时间: %TIMESTAMP%
echo 当前分支: %CURRENT_BRANCH%
echo.

:end
echo 脚本执行完成
