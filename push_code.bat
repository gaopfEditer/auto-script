@echo off
chcp 65001 >nul
cd /d "%~dp0"
python git_repos.py -p --auto-commit --message "all auto push"
pause
