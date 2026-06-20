# setup.ps1 - 初回セットアップスクリプト（一度だけ実行）
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FluidComponentApp セットアップ開始" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Python バージョン確認（py ランチャー優先、なければ python）
$pythonCmd = if (Get-Command py -ErrorAction SilentlyContinue) { 'py' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { $null }
if (-not $pythonCmd) {
    Write-Host "[ERROR] Python が見つかりません。Python 3.10 以上をインストールしてください。" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] $(& $pythonCmd --version 2>&1)" -ForegroundColor Green

# Node.js バージョン確認
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js が見つかりません。Node.js 18 以上をインストールしてください。" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Node.js $(node --version 2>&1)" -ForegroundColor Green

Write-Host ""

# ── バックエンド ──────────────────────────────────────────────────
Write-Host "--- バックエンド ---" -ForegroundColor Yellow

# 実環境（システム Python）に必要なライブラリが既に揃っているか確認
& $pythonCmd -c "import fastapi, uvicorn, CoolProp, pandas, numpy, scipy" 2>$null
$systemHasDeps = ($LASTEXITCODE -eq 0)

if ($systemHasDeps) {
    Write-Host "[OK] 実環境に必要なライブラリが揃っています。仮想環境を作成せず実環境を使用します。" -ForegroundColor Green
} else {
    $venvPath = "$Root\backend\.venv"
    if (Test-Path $venvPath) {
        Write-Host "仮想環境は既に存在します: $venvPath" -ForegroundColor Gray
    } else {
        Write-Host "Python 仮想環境を作成中..."
        & $pythonCmd -m venv $venvPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] 仮想環境の作成に失敗しました。" -ForegroundColor Red
            exit 1
        }
        Write-Host "[OK] 仮想環境を作成しました" -ForegroundColor Green
    }

    Write-Host "依存パッケージをインストール中 (pip install)..."
    & "$venvPath\Scripts\pip.exe" install --upgrade pip -q
    & "$venvPath\Scripts\pip.exe" install -r "$Root\backend\requirements.txt"
    Write-Host "[OK] バックエンドパッケージのインストール完了" -ForegroundColor Green
}

Write-Host ""

# ── フロントエンド ────────────────────────────────────────────────
Write-Host "--- フロントエンド ---" -ForegroundColor Yellow
Write-Host "依存パッケージをインストール中 (npm install)..."
Push-Location "$Root\frontend"
npm install
Pop-Location
Write-Host "[OK] フロントエンドパッケージのインストール完了" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  セットアップ完了！" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "サーバーを起動します..." -ForegroundColor White
Write-Host ""
& "$Root\start.ps1"
