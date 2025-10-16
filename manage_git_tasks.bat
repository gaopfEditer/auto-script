@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 设置颜色
color 0E

REM 全局变量
set "GIT_PATH="
set "GIT_PATH_VALID=0"

:menu
cls
echo ========================================
echo        Git任务管理工具
echo ========================================
echo.
if "%GIT_PATH_VALID%"=="0" (
    echo [警告] 尚未设置Git路径，请先设置Git路径
    echo.
    echo 请选择操作:
    echo.
    echo 1. 设置Git路径
    echo 0. 退出
    echo.
    set /p choice="请输入选项 (0-1): "
    if "%choice%"=="1" goto set_git_path
    if "%choice%"=="0" goto exit
    goto menu
) else (
    echo [信息] 当前Git路径: %GIT_PATH%
    echo.
    echo 请选择操作:
    echo.
    echo 1. 设置关机提交 + 开机拉取任务
    echo 2. 删除所有Git任务
    echo 3. 手动执行关机提交
    echo 4. 手动执行开机拉取
    echo 5. 查看任务状态
    echo 6. 测试脚本功能
    echo 7. 重新设置Git路径
    echo 0. 退出
    echo.
    set /p choice="请输入选项 (0-7): "
)

if "%choice%"=="1" goto setup_tasks
if "%choice%"=="2" goto remove_tasks
if "%choice%"=="3" goto manual_commit
if "%choice%"=="4" goto manual_pull
if "%choice%"=="5" goto check_status
if "%choice%"=="6" goto test_scripts
if "%choice%"=="7" goto set_git_path
if "%choice%"=="0" goto exit
goto menu

:set_git_path
echo.
echo ========================================
echo        设置Git路径
echo ========================================
echo.
echo 请输入Git仓库的完整路径
echo 例如: D:\frontend\my-journal-planning
echo 或者: C:\Users\eason\Documents\my-project
echo.
set /p GIT_PATH="请输入Git路径: "

REM 去除路径两端的引号
set "GIT_PATH=%GIT_PATH:"=%"

REM 检查路径是否为空
if "%GIT_PATH%"=="" (
    echo [错误] 路径不能为空
    echo.
    pause
    goto menu
)

REM 检查路径是否存在
if not exist "%GIT_PATH%" (
    echo [错误] 路径不存在: %GIT_PATH%
    echo 请检查路径是否正确
    echo.
    pause
    goto menu
)

REM 检查是否为Git仓库
if not exist "%GIT_PATH%\.git" (
    echo [错误] 该目录不是Git仓库: %GIT_PATH%
    echo 请确保目录中包含.git文件夹
    echo.
    pause
    goto menu
)

REM 检查Git是否可用
cd /d "%GIT_PATH%"
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] Git命令不可用，请确保Git已正确安装
    echo.
    pause
    goto menu
)

REM 检查Git仓库状态
git status >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] Git仓库状态异常，请检查仓库是否损坏
    echo.
    pause
    goto menu
)

echo [成功] Git路径验证通过: %GIT_PATH%
set "GIT_PATH_VALID=1"

REM 更新脚本文件中的路径
call :update_script_paths

echo [信息] 已更新所有脚本中的Git路径
echo.
pause
goto menu

:update_script_paths
echo [信息] 正在更新脚本文件中的Git路径...

REM 更新关机提交脚本
if exist "shutdown_git_commit.bat" (
    powershell -Command "(Get-Content 'shutdown_git_commit.bat') -replace 'set \"TARGET_DIR=.*\"', 'set \"TARGET_DIR=%GIT_PATH%\"' | Set-Content 'shutdown_git_commit.bat'"
)

REM 更新开机拉取脚本
if exist "startup_git_pull.bat" (
    powershell -Command "(Get-Content 'startup_git_pull.bat') -replace 'set \"TARGET_DIR=.*\"', 'set \"TARGET_DIR=%GIT_PATH%\"' | Set-Content 'startup_git_pull.bat'"
)

goto :eof

:setup_tasks
echo.
echo 正在设置关机提交和开机拉取任务...
echo 目标路径: %GIT_PATH%
echo 需要管理员权限，请在弹出的窗口中确认...
echo.
powershell -ExecutionPolicy Bypass -File "setup_shutdown_startup_tasks.ps1" -GitPath "%GIT_PATH%"
echo.
pause
goto menu

:remove_tasks
echo.
echo 正在删除所有Git任务...
echo 需要管理员权限，请在弹出的窗口中确认...
echo.
powershell -ExecutionPolicy Bypass -File "setup_shutdown_startup_tasks.ps1" -Remove
echo.
pause
goto menu

:manual_commit
echo.
echo 正在手动执行关机提交...
echo 目标路径: %GIT_PATH%
echo.
call "shutdown_git_commit.bat"
echo.
pause
goto menu

:manual_pull
echo.
echo 正在手动执行开机拉取...
echo 目标路径: %GIT_PATH%
echo.
call "startup_git_pull.bat"
echo.
pause
goto menu

:check_status
echo.
echo 检查任务状态...
echo.
echo === Git路径信息 ===
if "%GIT_PATH_VALID%"=="1" (
    echo 当前Git路径: %GIT_PATH%
    echo 路径状态: 有效
    if exist "%GIT_PATH%\.git" (
        echo Git仓库: 是
    ) else (
        echo Git仓库: 否
    )
) else (
    echo 当前Git路径: 未设置
    echo 路径状态: 无效
)
echo.
echo === 关机提交任务 ===
schtasks /query /tn GitShutdownCommit 2>nul
if %errorlevel% equ 0 (
    echo 状态: 已安装
) else (
    echo 状态: 未安装
)

echo.
echo === 开机拉取任务 ===
schtasks /query /tn GitStartupPull 2>nul
if %errorlevel% equ 0 (
    echo 状态: 已安装
) else (
    echo 状态: 未安装
)

echo.
echo === 脚本文件检查 ===
if exist "shutdown_git_commit.bat" (
    echo ✓ shutdown_git_commit.bat
) else (
    echo ✗ shutdown_git_commit.bat
)

if exist "startup_git_pull.bat" (
    echo ✓ startup_git_pull.bat
) else (
    echo ✗ startup_git_pull.bat
)

if exist "setup_shutdown_startup_tasks.ps1" (
    echo ✓ setup_shutdown_startup_tasks.ps1
) else (
    echo ✗ setup_shutdown_startup_tasks.ps1
)

echo.
pause
goto menu

:test_scripts
echo.
echo 测试脚本功能...
echo 目标路径: %GIT_PATH%
echo.
echo 1. 测试关机提交脚本...
call "shutdown_git_commit.bat"
echo.
echo 2. 测试开机拉取脚本...
call "startup_git_pull.bat"
echo.
echo 测试完成！
echo.
pause
goto menu

:exit
echo.
echo 感谢使用Git任务管理工具！
echo.
exit /b 0
