@echo off
setlocal

set "ROOT=%~dp0"
set "FRONTEND_PORT=3011"
set "BACKEND_PORT=8011"
set "PS_ARGS="

:parse_args
if "%~1"=="" goto find_powershell

if /I "%~1"=="-FrontendPort" (
    if "%~2"=="" (
        echo [ERROR] -FrontendPort requires a port number.
        exit /b 1
    )
    set "FRONTEND_PORT=%~2"
    shift
    shift
    goto parse_args
)

if /I "%~1"=="-BackendPort" (
    if "%~2"=="" (
        echo [ERROR] -BackendPort requires a port number.
        exit /b 1
    )
    set "BACKEND_PORT=%~2"
    shift
    shift
    goto parse_args
)

set "PS_ARGS=%PS_ARGS% %1"
shift
goto parse_args

:find_powershell
where pwsh >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PS=pwsh"
) else (
    where powershell >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        set "PS=powershell"
    ) else (
        echo [ERROR] PowerShell was not found.
        exit /b 1
    )
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup.ps1" -FrontendPort %FRONTEND_PORT% -BackendPort %BACKEND_PORT% %PS_ARGS%
exit /b %ERRORLEVEL%
