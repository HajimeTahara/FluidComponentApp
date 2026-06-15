# start.ps1 - バックエンド・フロントエンドを別ウィンドウで起動
$Root = $PSScriptRoot

$venvPath = "$Root\backend\.venv"
if (-not (Test-Path "$venvPath\Scripts\uvicorn.exe")) {
    Write-Host "[ERROR] セットアップが完了していません。先に .\setup.ps1 を実行してください。" -ForegroundColor Red
    exit 1
}

# PowerShell 実行ファイルを選択（pwsh 優先、なければ powershell）
$ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

# バックエンド起動
$backendCmd = "Set-Location '$Root\backend'; & '$venvPath\Scripts\Activate.ps1'; Write-Host 'Backend: http://localhost:8000' -ForegroundColor Cyan; uvicorn main:app --reload"
Start-Process $ps -ArgumentList @("-NoExit", "-Command", $backendCmd)

Start-Sleep -Milliseconds 800

# フロントエンド起動
$frontendCmd = "Set-Location '$Root\frontend'; Write-Host 'Frontend: http://localhost:3000' -ForegroundColor Cyan; npm run dev"
Start-Process $ps -ArgumentList @("-NoExit", "-Command", $frontendCmd)

Write-Host ""
Write-Host "サーバーを起動しました。" -ForegroundColor Green
Write-Host ""
Write-Host "  フロントエンド : http://localhost:3000" -ForegroundColor Cyan
Write-Host "  バックエンドAPI: http://localhost:8000" -ForegroundColor Cyan
Write-Host "  API ドキュメント: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "終了するには各ウィンドウで Ctrl+C を押してください。" -ForegroundColor Gray
