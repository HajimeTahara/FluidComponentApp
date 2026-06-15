# 2026-06-15 会話・更新ログ

## 会話の要点

- 作業再開のためコード全体を確認
- `setup.ps1` のPython検出バグ修正（`py` ランチャー優先検出）・完了後に `start.ps1` を自動実行
- 「圧損計算」タブを新規追加（Darcy-Weisbach、Colebrook/Blasius、流量-圧損グラフ）
- 圧損UIに断面ジオメトリSVG図、横軸切替（Q/v/Re）を追加
- P&IDと同様の React Flow キャンバスベースのパイプネットワーク圧損計算画面に全面刷新
- `PipeNetworkCalc.tsx` の TypeScript エラーを @xyflow/react v12 正しいパターンに修正して解決

---

## 現在の実装状態（前回セッション引き継ぎ）

### バックエンド (`backend/main.py`)

- FastAPI + CoolProp + scipy
- エンドポイント一覧:
  - `GET /fluids` — 対応流体リスト
  - `GET /fluids/{fluid}/critical` — 臨界点
  - `GET /fluids/{fluid}/saturation` — 飽和蒸気圧曲線
  - `GET /fluids/{fluid}/ph-diagram` — pH線図（等温線・等エントロピー線）
  - `GET /fluids/{fluid}/properties` — 指定T・Pでの物性値
  - `GET /fluids/{fluid}/state` — H・Pから状態量（pV線図用）
  - `GET /fluids/{fluid}/saturation/csv` — 飽和データCSVダウンロード
  - `POST /simulate` — P&IDグラフの液位・流量シミュレーション（RK45 ODE）

### フロントエンド

- `frontend/app/lib/api.ts` — バックエンドAPIクライアント（型定義含む）
- `frontend/app/components/PIDDiagram.tsx` — P&IDエディタ（約1130行）
  - 機器パレット（タンク・ポンプ・バルブ・熱交換器）のドラッグ＆ドロップ
  - ノードのインライン名称編集（ダブルクリック）
  - 配管接続（smoothstepエッジ）
  - 右パネル: ノード選択時→機器パラメータ、エッジ選択時→配管パラメータ
  - シミュレーション設定モーダル（流体・時間・出力間隔）
  - シミュレーション結果: 最終値リスト＋Plotlyグラフ

---

## 今後の作業候補（未完了）

- 配管パラメータ（内径・長さ・粗さ）をシミュレーションの圧力損失計算に反映（Darcy-Weisbach式）
- シミュレーション結果のCSVエクスポート
- 圧縮機・セパレータの物理モデル追加
- P&ID 図のPNG/SVG/JSONエクスポート
- 配管ラベル表示
- バックエンドの Modelica 連携（長期）
