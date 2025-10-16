@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 璁剧疆棰滆壊
color 0B

REM 鏄剧ず鏍囬
echo ========================================
echo        寮€鏈烘椂Git鑷姩鎷夊彇鑴氭湰
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
echo [淇℃伅] 寮€濮嬫墽琛孏it鎷夊彇鎿嶄綔...
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

REM 妫€鏌ヨ繙绋嬩粨搴撻厤缃?
echo [姝ラ1] 妫€鏌ヨ繙绋嬩粨搴撻厤缃?..
git remote -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [閿欒] 鏈厤缃繙绋嬩粨搴?
    echo 璇峰厛娣诲姞杩滅▼浠撳簱: git remote add origin <url>
    goto :end
)
echo [鎴愬姛] 杩滅▼浠撳簱閰嶇疆姝ｅ父

REM 鑾峰彇杩滅▼鍒嗘敮淇℃伅
echo [姝ラ2] 鑾峰彇杩滅▼鍒嗘敮淇℃伅...
git fetch origin
if %errorlevel% neq 0 (
    echo [閿欒] 鑾峰彇杩滅▼鍒嗘敮淇℃伅澶辫触
    echo 璇锋鏌ョ綉缁滆繛鎺ュ拰杩滅▼浠撳簱鍦板潃
    goto :end
)
echo [鎴愬姛] 杩滅▼鍒嗘敮淇℃伅鑾峰彇瀹屾垚

REM 妫€鏌ュ綋鍓嶅垎鏀?
echo [姝ラ3] 妫€鏌ュ綋鍓嶅垎鏀?..
for /f "tokens=*" %%i in ('git branch --show-current') do set "CURRENT_BRANCH=%%i"
echo 褰撳墠鍒嗘敮: %CURRENT_BRANCH%

REM 妫€鏌ユ槸鍚︽湁鏈彁浜ょ殑鏇存敼
echo [姝ラ4] 妫€鏌ュ伐浣滃尯鐘舵€?..
git status --porcelain >nul 2>&1
if %errorlevel% equ 0 (
    for /f %%i in ('git status --porcelain ^| find /c /v ""') do set "UNCOMMITTED_COUNT=%%i"
    if !UNCOMMITTED_COUNT! gtr 0 (
        echo [璀﹀憡] 妫€娴嬪埌鏈彁浜ょ殑鏇存敼锛屾鍦ㄦ殏瀛?..
        git stash push -m "寮€鏈哄墠鑷姩鏆傚瓨 - %TIMESTAMP%"
        if %errorlevel% equ 0 (
            echo [鎴愬姛] 鏈彁浜ょ殑鏇存敼宸叉殏瀛?
        ) else (
            echo [閿欒] 鏆傚瓨澶辫触
            goto :end
        )
    ) else (
        echo [淇℃伅] 宸ヤ綔鍖哄共鍑€锛屾棤闇€鏆傚瓨
    )
)

REM 鎷夊彇鏈€鏂颁唬鐮?
echo [姝ラ5] 鎷夊彇鏈€鏂颁唬鐮?..
git pull origin %CURRENT_BRANCH%
if %errorlevel% neq 0 (
    echo [閿欒] Git pull 澶辫触
    echo 璇锋鏌ョ綉缁滆繛鎺ュ拰鍒嗘敮鐘舵€?
    goto :end
)
echo [鎴愬姛] 浠ｇ爜鎷夊彇瀹屾垚

REM 鎭㈠鏆傚瓨鐨勬洿鏀癸紙濡傛灉鏈夛級
if defined UNCOMMITTED_COUNT if !UNCOMMITTED_COUNT! gtr 0 (
    echo [姝ラ6] 鎭㈠鏆傚瓨鐨勬洿鏀?..
    git stash pop
    if %errorlevel% equ 0 (
        echo [鎴愬姛] 鏆傚瓨鐨勬洿鏀瑰凡鎭㈠
    ) else (
        echo [璀﹀憡] 鎭㈠鏆傚瓨鏇存敼鏃跺嚭鐜板啿绐侊紝璇锋墜鍔ㄥ鐞?
    )
)

REM 鏄剧ず鏈€鏂版彁浜や俊鎭?
echo [姝ラ7] 鏄剧ず鏈€鏂版彁浜や俊鎭?..
echo 鏈€鏂版彁浜?
git log --oneline -1

echo.
echo ========================================
echo          寮€鏈烘媺鍙栧畬鎴愶紒
echo ========================================
echo 鎷夊彇鏃堕棿: %TIMESTAMP%
echo 褰撳墠鍒嗘敮: %CURRENT_BRANCH%
echo.

:end
echo 鑴氭湰鎵ц瀹屾垚

