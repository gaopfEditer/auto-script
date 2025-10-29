@echo off
chcp 65001 >nul
echo ==========================================
echo           一键提交代码工具
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

:: 显示当前分支
echo 当前分支：
git branch --show-current
echo.

:: 检查工作区状态
echo 检查工作区状态...
git status --porcelain > temp_status.txt
set /a file_count=0
for /f %%i in (temp_status.txt) do set /a file_count+=1
del temp_status.txt

if %file_count%==0 (
    echo 工作区干净，没有需要提交的文件。
    echo.
    set /p pull_confirm="是否拉取最新代码？(y/n): "
    if /i "%pull_confirm%"=="y" (
        echo 正在拉取最新代码...
        git pull
        if errorlevel 1 (
            echo 拉取失败，请检查网络连接或解决冲突。
        ) else (
            echo 拉取成功！
        )
    )
    pause
    exit /b 0
)

echo 发现 %file_count% 个文件有变更：
git status --short
echo.

:: 添加所有文件
echo 正在添加所有文件到暂存区...
git add .

:: 检查是否有文件被添加
git diff --cached --quiet
if errorlevel 1 (
    echo 文件已添加到暂存区。
) else (
    echo 没有文件需要提交。
    pause
    exit /b 0
)

echo.
echo 暂存区文件列表：
git diff --cached --name-only
echo.

:: 输入提交信息
set /p commit_msg="请输入提交信息: "
if "%commit_msg%"=="" (
    echo 提交信息不能为空！
    pause
    exit /b 1
)

echo.
echo ==========================================
echo 正在提交代码...
echo 提交信息: %commit_msg%
echo ==========================================

:: 提交代码
git commit -m "%commit_msg%"

if errorlevel 1 (
    echo.
    echo 错误：代码提交失败！
    echo 请检查错误信息。
    pause
    exit /b 1
)

echo.
echo 代码提交成功！
echo.

:: 询问是否推送到远程
set /p push_confirm="是否推送到远程仓库？(y/n): "
if /i "%push_confirm%"=="y" (
    echo.
    echo 正在推送到远程仓库...
    git push
    
    if errorlevel 1 (
        echo.
        echo 错误：推送失败！
        echo 可能的原因：
        echo 1. 网络连接问题
        echo 2. 远程仓库有新的提交需要先拉取
        echo 3. 没有推送权限
        echo.
        echo 建议先运行 pull_code.bat 拉取最新代码。
    ) else (
        echo.
        echo ==========================================
        echo 代码推送成功！
        echo ==========================================
    )
) else (
    echo 代码已提交到本地，但未推送到远程仓库。
    echo 您可以稍后使用 git push 命令推送。
)

echo.
pause
