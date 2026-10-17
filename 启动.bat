@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto havepython
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if defined PY goto havepython

echo.
echo [错误] 没有找到 Python。
echo        请安装 Python 3.9 以上版本，安装时勾选 "Add python.exe to PATH"，
echo        装好后重新双击本文件。
echo.
pause
exit /b 1

:havepython
echo ============================================================
echo   DJI Footage Viewer
echo   素材目录 : %~dp0
echo   服务地址 : http://127.0.0.1:8777/
echo   端口被占用时会自动改用 8778、8779 ...
echo   保持本窗口开着；关掉这个窗口就等于停止服务
echo ============================================================
echo.

%PY% -m djiviewer %*
if "%ERRORLEVEL%"=="0" goto bye
echo.
echo [错误] 服务没有正常启动，返回码 %ERRORLEVEL%
echo        可以先跑这条命令看诊断：
echo            %PY% -m djiviewer --check
echo.
pause

:bye
