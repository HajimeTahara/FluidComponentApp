# setup.ps1 - setup and server launcher
param(
    [switch]$StartOnly,
    [switch]$SetupOnly,
    [ValidateRange(1, 65535)]
    [int]$FrontendPort = 3011,
    [ValidateRange(1, 65535)]
    [int]$BackendPort = 8011
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) { return 'py' }
    if (Get-Command python -ErrorAction SilentlyContinue) { return 'python' }
    return $null
}

function Test-SystemBackendDeps($pythonCmd) {
    if (-not $pythonCmd) { return $false }
    & $pythonCmd -c "import fastapi, uvicorn, CoolProp, pandas, numpy, scipy" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Invoke-Setup {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  FluidComponentApp setup" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $pythonCmd = Get-PythonCommand
    if (-not $pythonCmd) {
        Write-Host "[ERROR] Python was not found. Please install Python 3.10 or later." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] $(& $pythonCmd --version 2>&1)" -ForegroundColor Green

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] Node.js was not found. Please install Node.js 18 or later." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Node.js $(node --version 2>&1)" -ForegroundColor Green

    Write-Host ""

    Write-Host "--- Backend ---" -ForegroundColor Yellow

    $systemHasDeps = Test-SystemBackendDeps $pythonCmd

    if ($systemHasDeps) {
        Write-Host "[OK] Backend packages are available in the system Python. Using system Python." -ForegroundColor Green
    } else {
        $venvPath = "$Root\backend\.venv"
        if (Test-Path $venvPath) {
            Write-Host "Virtual environment already exists: $venvPath" -ForegroundColor Gray
        } else {
            Write-Host "Creating Python virtual environment..."
            & $pythonCmd -m venv $venvPath
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[ERROR] Failed to create the virtual environment." -ForegroundColor Red
                exit 1
            }
            Write-Host "[OK] Virtual environment created" -ForegroundColor Green
        }

        Write-Host "Installing backend packages (pip install)..."
        & "$venvPath\Scripts\pip.exe" install --upgrade pip -q
        & "$venvPath\Scripts\pip.exe" install -r "$Root\backend\requirements.txt"
        Write-Host "[OK] Backend packages installed" -ForegroundColor Green
    }

    Write-Host ""

    Write-Host "--- Frontend ---" -ForegroundColor Yellow
    Write-Host "Installing frontend packages (npm install)..."
    Push-Location "$Root\frontend"
    npm install
    Pop-Location
    Write-Host "[OK] Frontend packages installed" -ForegroundColor Green

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Setup complete!" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Start-Servers {
    if ($FrontendPort -eq $BackendPort) {
        Write-Host "[ERROR] FrontendPort and BackendPort must be different." -ForegroundColor Red
        exit 1
    }

    $pythonCmd = Get-PythonCommand
    $systemHasDeps = Test-SystemBackendDeps $pythonCmd
    $venvPath = "$Root\backend\.venv"
    $venvReady = Test-Path "$venvPath\Scripts\uvicorn.exe"

    if (-not $systemHasDeps -and -not $venvReady) {
        Write-Host "[ERROR] Setup is not complete. Run .\setup.ps1 first." -ForegroundColor Red
        exit 1
    }

    $ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

    if ($systemHasDeps) {
        Write-Host "Starting backend with system Python." -ForegroundColor Gray
        $backendCmd = "Set-Location '$Root\backend'; Write-Host 'Backend: http://localhost:$BackendPort' -ForegroundColor Cyan; $pythonCmd -m uvicorn main:app --reload --port $BackendPort"
    } else {
        Write-Host "Starting backend with the virtual environment." -ForegroundColor Gray
        $backendCmd = "Set-Location '$Root\backend'; & '$venvPath\Scripts\Activate.ps1'; Write-Host 'Backend: http://localhost:$BackendPort' -ForegroundColor Cyan; uvicorn main:app --reload --port $BackendPort"
    }
    Start-Process $ps -ArgumentList @("-NoExit", "-Command", $backendCmd)

    Start-Sleep -Milliseconds 800

    $npmInstallCmd = ""
    if (-not (Test-Path "$Root\frontend\node_modules\.bin\next.cmd")) {
        Write-Host "Frontend packages were not found. Running npm install." -ForegroundColor Gray
        $npmInstallCmd = "npm install; "
    }
    $frontendCmd = "Set-Location '$Root\frontend'; $npmInstallCmd" +
        "`$env:NEXT_PUBLIC_API_URL = 'http://localhost:$BackendPort'; " +
        "`$env:NEXT_DIST_DIR = '.next-dev-$FrontendPort'; " +
        "Write-Host 'Frontend: http://localhost:$FrontendPort' -ForegroundColor Cyan; npm run dev -- --port $FrontendPort"
    Start-Process $ps -ArgumentList @("-NoExit", "-Command", $frontendCmd)

    Write-Host ""
    Write-Host "Servers started." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Frontend    : http://localhost:$FrontendPort" -ForegroundColor Cyan
    Write-Host "  Backend API : http://localhost:$BackendPort" -ForegroundColor Cyan
    Write-Host "  API docs    : http://localhost:$BackendPort/docs" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Press Ctrl+C in each server window to stop." -ForegroundColor Gray
}

if ($StartOnly -and $SetupOnly) {
    Write-Host "[ERROR] -StartOnly and -SetupOnly cannot be used together." -ForegroundColor Red
    exit 1
}

if ($StartOnly) {
    Start-Servers
} else {
    Invoke-Setup
    if (-not $SetupOnly) {
        Write-Host ""
        Write-Host "Starting servers..." -ForegroundColor White
        Write-Host ""
        Start-Servers
    }
}
