# start.ps1 - バックエンド・フロントエンドを別ウィンドウで起動
$Root = $PSScriptRoot

# Python コマンドを選択（py ランチャー優先、なければ python）
$pythonCmd = if (Get-Command py -ErrorAction SilentlyContinue) { 'py' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { $null }

# 実環境（システム Python）に必要なライブラリが揃っているか確認
$systemHasDeps = $false
if ($pythonCmd) {
    & $pythonCmd -c "import fastapi, uvicorn, CoolProp, pandas, numpy, scipy" 2>$null
    $systemHasDeps = ($LASTEXITCODE -eq 0)
}

$venvPath = "$Root\backend\.venv"
$venvReady = Test-Path "$venvPath\Scripts\uvicorn.exe"

if (-not $systemHasDeps -and -not $venvReady) {
    Write-Host "[ERROR] セットアップが完了していません。先に .\setup.ps1 を実行してください。" -ForegroundColor Red
    exit 1
}

# PowerShell 実行ファイルを選択（pwsh 優先、なければ powershell）
$ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

# バックエンド起動（実環境にライブラリが揃っていれば実環境、なければ仮想環境を使用）
if ($systemHasDeps) {
    Write-Host "実環境の Python でバックエンドを起動します。" -ForegroundColor Gray
    $backendCmd = "Set-Location '$Root\backend'; Write-Host 'Backend: http://localhost:8000' -ForegroundColor Cyan; $pythonCmd -m uvicorn main:app --reload"
} else {
    Write-Host "仮想環境の Python でバックエンドを起動します。" -ForegroundColor Gray
    $backendCmd = "Set-Location '$Root\backend'; & '$venvPath\Scripts\Activate.ps1'; Write-Host 'Backend: http://localhost:8000' -ForegroundColor Cyan; uvicorn main:app --reload"
}
Start-Process $ps -ArgumentList @("-NoExit", "-Command", $backendCmd)

Start-Sleep -Milliseconds 800

# フロントエンド起動（依存パッケージが無ければ自動で npm install）
$npmInstallCmd = ""
if (-not (Test-Path "$Root\frontend\node_modules\.bin\next.cmd")) {
    Write-Host "フロントエンドの依存パッケージが見つかりません。npm install を実行します。" -ForegroundColor Gray
    $npmInstallCmd = "npm install; "
}
$frontendCmd = "Set-Location '$Root\frontend'; $npmInstallCmd" + "Write-Host 'Frontend: http://localhost:3000' -ForegroundColor Cyan; npm run dev"
Start-Process $ps -ArgumentList @("-NoExit", "-Command", $frontendCmd)

Write-Host ""
Write-Host "サーバーを起動しました。" -ForegroundColor Green
Write-Host ""
Write-Host "  フロントエンド : http://localhost:3000" -ForegroundColor Cyan
Write-Host "  バックエンドAPI: http://localhost:8000" -ForegroundColor Cyan
Write-Host "  API ドキュメント: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "終了するには各ウィンドウで Ctrl+C を押してください。" -ForegroundColor Gray
