# FluidComponentApp

液化メタンをはじめとする各種流体の熱物性データを閲覧・抽出できるWebアプリ。
P&IDエディタおよび液位シミュレーション機能を搭載。

## 前提条件

| ツール | 推奨バージョン |
|--------|--------------|
| Python | 3.10 以上 |
| Node.js | 18 以上 |
| npm | 9 以上 |
| PowerShell | 5.1 以上（PowerShell 7 推奨） |

## クイックスタート

### 1. リポジトリをクローン

```powershell
git clone <リポジトリURL>
cd FluidComponentApp
```

### 2. 初回セットアップ（一度だけ実行）

```powershell
.\setup.ps1
```

コマンドプロンプトの場合:

```bat
.\setup.bat
```

以下を自動で行います：
- `backend/.venv` にPython仮想環境を作成
- バックエンド依存パッケージをインストール（CoolProp, FastAPI, scipy など）
- フロントエンド依存パッケージをインストール（Next.js, @xyflow/react など）
- セットアップ完了後、サーバーを起動

> **スクリプト実行が拒否される場合：**
> PowerShellの実行ポリシーを変更してください（一度だけ）。
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

### 3. 2回目以降のサーバー起動

```powershell
.\setup.ps1 -StartOnly
```

コマンドプロンプトの場合:

```bat
.\setup.bat -StartOnly
```

ポートを変更する場合は、フロントとバックのポートを引数で指定できます。

```powershell
.\setup.ps1 -StartOnly -FrontendPort 3001 -BackendPort 8001
```

コマンドプロンプトでも同じ引数を使用できます。

```bat
.\setup.bat -StartOnly -FrontendPort 3001 -BackendPort 8001
```

既定値はフロントエンドが`3000`、バックエンドが`8000`です。
`setup.bat`では、ファイル先頭の`FRONTEND_PORT`と`BACKEND_PORT`を書き換えて既定値を変更することもできます。
フロントエンドの開発用出力先はポートごとに分離されるため、異なるポートを指定すれば同じプロジェクトを複数起動できます。

バックエンドとフロントエンドがそれぞれ別ウィンドウで起動します。

| サーバー | URL |
|----------|-----|
| フロントエンド | http://localhost:3000 |
| バックエンドAPI | http://localhost:8000 |
| API ドキュメント | http://localhost:8000/docs |

## 手動での起動（スクリプトを使わない場合）

### バックエンド

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn main:app --reload
```

### フロントエンド

```powershell
cd frontend
npm run dev
```

## プロジェクト構成

```
FluidComponentApp/
├── backend/
│   ├── main.py              # FastAPI アプリ（物性API + シミュレーション）
│   └── requirements.txt
├── frontend/
│   └── app/
│       ├── components/
│       │   ├── PIDDiagram.tsx       # P&IDエディタ + シミュレーション
│       │   ├── Dashboard.tsx        # メインダッシュボード
│       │   ├── PHDiagramChart.tsx   # pH線図
│       │   ├── SaturationChart.tsx  # 飽和蒸気圧曲線
│       │   └── PropertiesLookup.tsx # 物性値検索
│       └── lib/
│           └── api.ts               # APIクライアント
├── setup.ps1                # セットアップ兼サーバー起動スクリプト
└── setup.bat                # コマンドプロンプト用ラッパー
```

## 主な機能

- **物性値タブ**: 流体を選択して温度・圧力を指定し物性値を取得
- **pH線図タブ**: 圧力-エンタルピー線図の描画・エクスポート
- **飽和曲線タブ**: 飽和蒸気圧曲線の描画・CSVエクスポート
- **P&IDタブ**: ブロックダイアグラムエディタ + 液位シミュレーション

## 対応流体

Water / Methane / Nitrogen / Oxygen / Hydrogen / CarbonDioxide / Propane / Ammonia / R134a / Ethane
