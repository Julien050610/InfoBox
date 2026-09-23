@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 24 或更新版本。
  pause
  exit /b 1
)
node src\run-once.js
if errorlevel 1 (
  echo.
  echo 处理未能完成，请查看上方提示。
  pause
  exit /b 1
)
exit /b 0
