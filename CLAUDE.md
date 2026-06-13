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

## Gitワークフロー

- デフォルトブランチ: `master`
- コミットメッセージ: 日本語で記載
- 作成者: hajime <h.tahara0926@gmail.com>
