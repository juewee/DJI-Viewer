@echo off
if "%~1"=="" goto usage
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto run
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if defined PY goto run
echo [错误] 没有找到 Python，请先安装 Python 3.9 以上版本。
pause
exit /b 1

:run
echo 正在打开素材目录：%~1
%PY% -m djiviewer --dir "%~1"
goto bye

:usage
echo 用法：把 DCIM 目录拖到本文件上，或在命令行执行：
echo    打开素材目录.bat "G:\DCIM\DJI_001"
pause

:bye
