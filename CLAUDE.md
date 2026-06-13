# CLAUDE.md

このファイルは、リポジトリ内でClaude Code (claude.ai/code) が作業する際のガイダンスを提供します。

## プロジェクト概要

液化メタンをはじめとする各種流体の熱物性データを閲覧・抽出できるWebアプリ。

- **データソース**: Python の CoolProp ライブラリ
- **主要機能**:
  - 液種選択と物性値の一覧表示
  - pH線図（圧力-エンタルピー線図）の描画
  - 飽和蒸気圧曲線の描画
  - グラフの画像エクスポート（PNG/SVG）
  - 物性データのCSVエクスポート

## アーキテクチャ

```text
frontend/   ← Next.js 14 (App Router) + TypeScript + Tailwind CSS + Plotly.js
backend/    ← FastAPI (Python) + CoolProp + pandas
```

- フロントエンド: `http://localhost:3000`
- バックエンド API: `http://localhost:8000`

## 開発サーバー起動方法

```bash
# バックエンド
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# フロントエンド
cd frontend
npm install
npm run dev
```

## P&ID タブ

プラント設備の配管計装線図（P&ID）を作成・編集するブロックダイアグラムエディタ。

- **ライブラリ**: `@xyflow/react` (React Flow v12) — TypeScript ネイティブ、カスタムノード・エッジ対応
- **配置**: `frontend/app/components/PIDDiagram.tsx`
- **機能方針**:
  - 左サイドバー（ダーク系）：機器パレットからドラッグ＆ドロップでキャンバスに追加
  - ノードのハンドルをドラッグして配管（スムースステップエッジ）で接続
  - ノード名をダブルクリックしてインライン編集
  - Delete / Backspace キーで選択ノード・配管を削除
  - ミニマップ・パン・ズーム対応
- **対応機器シンボル（SVG）**:
  - T（タンク）、P（ポンプ）、V（バルブ）、E（熱交換器）、C（圧縮機）、D（セパレータ）
- **スタイル方針**: ダーク系パレット＋ライトグレーキャンバス、各機器に固有アクセントカラー
- **今後の拡張候補**: エクスポート（PNG/SVG/JSON）、配管ラベル、追加機器シンボル、ルーティング改善

## P&ID シミュレーション

P&ID 図をもとに液位・流量の時間発展をシミュレーションする機能。

### アーキテクチャ方針

- **フロントエンド**: P&ID 図の作成、パラメータ入力、シミュレーション時間・条件設定、結果グラフ表示のみ担当
- **バックエンド (FastAPI + Python)**: グラフ解析・ODE 構築・数値積分・結果返却を担当
- **通信方式**: REST（バッチ） — POST `/simulate` にグラフ JSON を送り、全時系列データを一括返却
- **将来の Modelica 連携**: JSON グラフ形式を維持することで、バックエンドを Modelica に差し替え可能にする設計

### 物理モデル（scipy.integrate.solve_ivp を使用）

| 機器 | モデル |
|------|--------|
| タンク | `dh/dt = (ΣQ_in - ΣQ_out) / A` (液位 ODE) |
| バルブ | `Q = Cv × (opening/100) × √(ΔP_bar / SG)` (Cv 式、重力駆動) |
| ポンプ | `Q = flowRate / 3600` (定流量、m³/s) |
| 熱交換器 | 定格流量上限付き重力駆動パススルー（第1版は熱収支省略） |

### `/simulate` エンドポイント

- **入力**: `{ nodes, edges, duration[s], dt[s], fluid }`
- **出力**: `{ time[], results: { [nodeId]: { label, level[], volume[] } | { flowRate[] } } }`
- 物性値（密度）は CoolProp で取得

## 会話・更新ログ

作業再開時の引き継ぎのため、`docs/claude/` に会話記録とコード更新履歴を残す。

- **ファイル命名**: `docs/claude/<date>_chat_and_update.md`（例: `2026-06-14_chat_and_update.md`）
- **作成タイミング**: 新しい会話セッションが開始したとき
- **記録内容**: その日の会話の要点・実装した機能・変更したファイルと変更内容・未完了の作業

## Gitワークフロー

- デフォルトブランチ: `master`
- コミットメッセージ: 日本語で記載
- 作成者: hajime <h.tahara0926@gmail.com>
