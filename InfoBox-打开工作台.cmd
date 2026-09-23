@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 24 或更新版本。
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\launch-workbench.ps1"
if errorlevel 1 (
  echo.
  echo 工作台启动失败，请查看上方提示。
  pause
  exit /b 1
)
