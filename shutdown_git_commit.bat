@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 璁剧疆棰滆壊
color 0A

REM 鏄剧ず鏍囬
echo ========================================
echo        鍏虫満鏃禛it鑷姩鎻愪氦鑴氭湰
echo ========================================
echo.

REM 璁剧疆鐩爣鐩綍
set "TARGET_DIR=D:\frontend\my-journal-planning"

REM 妫€鏌ョ洰褰曟槸鍚﹀瓨鍦?
if not exist "%TARGET_DIR%" (
    echo [閿欒] 鐩綍涓嶅瓨鍦? %TARGET_DIR%
    echo 璇锋鏌ヨ矾寰勬槸鍚︽纭?
    goto :end
)

REM 鍒囨崲鍒扮洰鏍囩洰褰?
cd /d "%TARGET_DIR%"

echo [淇℃伅] 褰撳墠鐩綍: %CD%
echo [淇℃伅] 寮€濮嬫墽琛孏it鎻愪氦鎿嶄綔...
echo.

REM 妫€鏌ユ槸鍚︿负Git浠撳簱
if not exist ".git" (
    echo [閿欒] 褰撳墠鐩綍涓嶆槸Git浠撳簱
    echo 璇峰厛鍒濆鍖朑it浠撳簱: git init
    goto :end
)

REM 鑾峰彇褰撳墠鏃堕棿
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
set "YY=%dt:~2,2%" & set "YYYY=%dt:~0,4%" & set "MM=%dt:~4,2%" & set "DD=%dt:~6,2%"
set "HH=%dt:~8,2%" & set "Min=%dt:~10,2%" & set "Sec=%dt:~12,2%"
set "TIMESTAMP=%YYYY%-%MM%-%DD% %HH%:%Min%:%Sec%"

REM 娣诲姞鎵€鏈夋洿鏀圭殑鏂囦欢
echo [姝ラ1] 娣诲姞鎵€鏈夋洿鏀圭殑鏂囦欢...
git add .
if %errorlevel% neq 0 (
    echo [閿欒] Git add 澶辫触
    goto :end
)
echo [鎴愬姛] 鏂囦欢宸叉坊鍔犲埌鏆傚瓨鍖?

REM 妫€鏌ユ槸鍚︽湁鏇存敼闇€瑕佹彁浜?
git diff --staged --quiet
if %errorlevel% equ 0 (
    echo [淇℃伅] 娌℃湁妫€娴嬪埌闇€瑕佹彁浜ょ殑鏇存敼
    echo 宸ヤ綔鍖烘槸骞插噣鐨勶紝鏃犻渶鎻愪氦
    goto :end
)

REM 鐢熸垚鎻愪氦淇℃伅
set "COMMIT_MSG=鍏虫満鍓嶈嚜鍔ㄦ彁浜?- %TIMESTAMP%"

REM 鎻愪氦鏇存敼
echo [姝ラ2] 鎻愪氦鏇存敼...
echo 鎻愪氦淇℃伅: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"
if %errorlevel% neq 0 (
    echo [閿欒] Git commit 澶辫触
    goto :end
)
echo [鎴愬姛] 鏇存敼宸叉彁浜?

REM 鎺ㄩ€佸埌杩滅▼浠撳簱锛堝鏋滈厤缃簡杩滅▼浠撳簱锛?
echo [姝ラ3] 妫€鏌ヨ繙绋嬩粨搴?..
git remote -v >nul 2>&1
if %errorlevel% equ 0 (
    echo [淇℃伅] 妫€娴嬪埌杩滅▼浠撳簱锛屽皾璇曟帹閫?..
    git push
    if %errorlevel% equ 0 (
        echo [鎴愬姛] 宸叉帹閫佸埌杩滅▼浠撳簱
    ) else (
        echo [璀﹀憡] 鎺ㄩ€佸埌杩滅▼浠撳簱澶辫触锛屼絾鏈湴鎻愪氦鎴愬姛
    )
) else (
    echo [淇℃伅] 鏈厤缃繙绋嬩粨搴擄紝璺宠繃鎺ㄩ€?
)

echo.
echo ========================================
echo          鍏虫満鎻愪氦瀹屾垚锛?
echo ========================================
echo 鎻愪氦鏃堕棿: %TIMESTAMP%
echo 鎻愪氦淇℃伅: %COMMIT_MSG%
echo.

:end
echo 鑴氭湰鎵ц瀹屾垚锛岀郴缁熷嵆灏嗗叧鏈?..

