# 2026-06-20 会話・更新ログ

## 会話の要点

- `setup.ps1` / `start.ps1` の仮想環境依存を見直し、実環境（システムPython）にバックエンド依存ライブラリが揃っている場合はそちらを優先して起動するように変更
- `start.ps1` 実行時に `frontend/node_modules` が無く `next` コマンドが見つからないエラーが発生 → `npm install` 未実行が原因と判明、`start.ps1` に自動インストール処理を追加
- DB導入の検討: スキーマ未定のため当初MongoDB（フレキシブルなドキュメントDB）を検討
  - MongoDBのデータファイル（WiredTiger）はバイナリでgit管理に不向きと判断
  - 代替として **TinyDB**（Python製、JSON1ファイルがそのままDBになる）を提案・採用方針に
  - 「後でMongoDB等に本格移行する際の手戻り」を懸念する質問あり
    - 結論: DBアクセスを薄いリポジトリ層（`get_xxx()` / `save_xxx()`）に閉じ込めておけば、TinyDB→Mongo移行はそのアクセス層の置き換えで済む
    - 本当に手戻りが大きくなるのはDBの種類ではなく「データモデル自体の作り直し」であり、これはスキーマ未定の現状ではどのDBを選んでも避けられない
  - 現時点ではDB実装自体は未着手（方針合意のみ）

---

## 変更したファイル

### `setup.ps1`

- バックエンドセットアップ時、システムPythonで `import fastapi, uvicorn, CoolProp, pandas, numpy, scipy` が成功するか事前チェック
  - 成功 → 仮想環境を作成せず実環境を使用する旨を表示してスキップ
  - 失敗 → 従来通り `backend/.venv` を作成し `pip install -r requirements.txt`

### `start.ps1`

- バックエンド起動: システムPythonの依存チェック結果に応じて分岐
  - 実環境に依存ライブラリが揃っている → `py -m uvicorn main:app --reload`（仮想環境を経由しない）
  - 揃っていない → 従来通り `.venv\Scripts\Activate.ps1` 後に `uvicorn main:app --reload`
  - どちらも未準備の場合はエラーで `setup.ps1` の実行を促す
- フロントエンド起動: `frontend/node_modules/.bin/next.cmd` が無ければ起動コマンドの先頭で自動的に `npm install` を実行してから `npm run dev`

### 動作確認

- システムPython（`py`）に依存ライブラリが揃っていることを確認し、`py -m uvicorn main:app --reload` でバックエンドが起動・HTTP 200応答することを確認済み
- `frontend` で `npm install` を実行し `next` コマンドが利用可能になることを確認済み

---

## 今後の作業候補（未完了）

- DB（TinyDB想定）の実装: リポジトリ層の設計、データモデルの暫定スキーマ検討
- 配管パラメータ（内径・長さ・粗さ）をシミュレーションの圧力損失計算に反映（Darcy-Weisbach式）
- シミュレーション結果のCSVエクスポート
- 圧縮機・セパレータの物理モデル追加
- P&ID 図のPNG/SVG/JSONエクスポート
- 配管ラベル表示
- バックエンドの Modelica 連携（長期）

---

# 2026-06-20 セッション2: ロケット段デザイナーの不具合修正とUI刷新

## 会話の要点

- 前セッションで実装済みのロケット段デザイナー（部品パレット→キャンバス→「この段を計算」→打上げ解析）について、ユーザーが実際にブラウザで開いたところ "Maximum update depth exceeded" のクラッシュが発生
  - 原因: `LaunchAnalysis.tsx` が `<RocketBuilder onStagesChange={stages => set('stages', stages)} />` のようにインライン関数を毎レンダー新規生成して渡しており、`RocketBuilder.tsx` 側の `useEffect` の依存配列に `onStagesChange` を含めていたため、親の再レンダー→新しい関数→子のeffect再発火→`setForm`→親再レンダー…の無限ループになっていた
  - 修正: `LaunchAnalysis.tsx` で `useCallback`（空依存配列、`setForm` の関数更新形を使用）により `onStagesChange` の参照を安定化
- 動作確認後、ユーザーから設計画面のUIに関する相談：タブ切り替え方式ではなく、画面に「ステージ」の枠を縦に並べて、各枠の中に部品ノードを配置する形（添付イメージ：ステージ-3／ステージ-2／ステージ-1を縦に積んだスクリーンショット）にしたいという要望
  - あわせて、個別部品として配置していた「外壁構造材」「固定質量」はステージそのものの属性として持たせたい、という方針も提示
  - 固定質量は複数項目（アビオニクス・回収系など）を扱えるリスト形式にすることを確認（ユーザー選択）
- Plan モードで実装プランを作成・承認（`eventual-dazzling-anchor.md` を新方針で上書き）後、実装を完了

## 変更したファイル

### `frontend/app/components/LaunchAnalysis.tsx`

- `useCallback` をインポートし、`handleStagesChange`（`setForm` の関数更新形で `stages` のみ更新、依存配列は空）を追加
- `<RocketBuilder onStagesChange={handleStagesChange} />` に変更（インライン関数の都度生成をやめ、安定した参照を渡すように修正）

### `backend/main.py`

- `RocketStagePayload` に `structure: dict[str, float] = {}` と `fixed_masses: list[dict] = []` を追加（外壁構造材・固定質量を部品ノードではなく段単位のパラメータとして受け取る）
- `build_rocket_stage()` のノード種別ディスパッチから `structure`/`fixed_mass` 分岐を削除し、`payload.structure`（あれば `_calc_shell_component` で外壁シェル質量を加算）と `payload.fixed_masses`（各 `massKg` の合計を加算）を `dry_mass` に反映するロジックを追加

### `frontend/app/lib/api.ts`

- `RocketStagePayload` 型に `structure?: Record<string, number>` と `fixed_masses?: RocketFixedMassPayload[]`（`{id, label, massKg}`）を追加

### `frontend/app/components/RocketBuilder.tsx`（大幅書き換え）

- タブ切り替え方式（`StageCanvas[]` ＋ `commitCurrentStage`/`switchStage`/`addStage`/`removeStage` によるタブごとの独立キャンバス）を廃止し、**単一の `nodes`/`edges` キャンバス**に統一
- ステージを React Flow の **グループノード**（`type: 'stage'`、`parentId`/`extent: 'parent'` で部品ノードを内包）として実装。`NodeResizer` で枠のリサイズに対応
- パレットから「外壁構造材」「固定質量」を削除（`NodeCategory` は `tank/pipe/pump/combustor/nozzle/fairing` の6種に縮小）。ステージ選択時のパラメータパネル（`StagePanel`）に外壁構造材（外径・長さ・肉厚・材料密度）と固定質量リスト（名称＋質量、行の追加／削除）を実装
- 部品ドロップ時、ドロップ位置がどのステージ枠の矩形に収まるかを判定して `parentId` を設定（枠外へのドロップはエラー表示）
- `onConnect` で `parentId` が異なるノード間の接続（ステージを跨ぐ接続）を拒否
- ステージごとに「この段を計算」ボタン（`StagePanel` 内）→ そのステージの子ノード・子エッジのみを抽出して `buildRocketStage()` を呼び出し、`structure`/`fixed_masses` も合わせて送信
- ステージノードを Y座標降順（画面下＝初段）でソートし、`LaunchRequest.stages` の順序として `onStagesChange` 経由で親に伝える（変化がない場合は再通知しないようガード）

## 動作確認

- `npx tsc --noEmit` / `npm run build`：エラーなし
- バックエンド: `python -c "import ast; ast.parse(...)"` で構文確認
- `TestClient` で `/rocket/stage/build` に `structure`/`fixed_masses` を含むペイロード（タンク＋燃焼器＋ノズル）を送信→各部品質量・推力(約134kN)・Isp(約233s)が妥当な値で返ることを確認。続けてそのステージ結果を `/launch/simulate` に渡し、軌道計算が正常終了（apogee約693km、T/W約6.3）することを確認
- 開発サーバー上でのドラッグ＆ドロップ・リサイズ等のブラウザ手動確認は未実施（ユーザー側での確認待ち）

## 今後の作業候補（未完了）

- 開発サーバーでの手動確認：ステージ枠内への部品ドラッグ＆ドロップ、枠のリサイズ、複数ステージの個別計算、最終的な打上げ計算までの一連の操作感
- 設計（ノードグラフ）のVehicleDBへの保存・再読込（将来フェーズ）
- 上記に挙げた前回セッションからの未完了項目（DB実装、配管パラメータの圧損反映など）
