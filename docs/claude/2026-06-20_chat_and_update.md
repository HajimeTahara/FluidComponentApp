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

---

# 2026-06-20 セッション3: ペイロード質量の統合・全備質量表示・フェアリング削除

## 会話の要点

- ユーザーから3点の指摘・要望
  1. `LaunchAnalysis.tsx`の「ペイロード質量」欄がロケット段スケッチ（`RocketBuilder`）と独立しているのは不自然では、ステージの固定質量で再現できないか
  2. 機体全体の質量を表示する場所が欲しい
  3. フェアリングはステージそのものを使って表現できるので、部品パレットから削除してよい
- 1点目について、固定質量は現在すべて段分離時に投棄される`dry_mass`に加算される実装であり、単純に置き換えるとペイロードが誤って投棄されてしまうことを説明。「固定質量に『投棄しない（ペイロード）』フラグを追加して統合」する方針をユーザーが選択（推奨案）
- 既存の保存済み機体プリセット（H3-30・Falcon 9）は段グラフを持たずVehicleSpec直下の`payload_mass`を使うため、その互換性は維持する方針で実装

## 変更したファイル

### `backend/main.py`
- `StageSpec`に`payload_mass: float = 0.0`を追加（段分離時にも投棄しない質量）
- `LaunchRequest.payload_mass`のデフォルトを`50.0`→`0.0`に変更し、意味を「追加ペイロード質量（スケッチ外、手動入力分）」に変更
- `/launch/simulate`の`initial_mass`計算に各段の`payload_mass`を加算
- `build_rocket_stage()`: 固定質量を`isPayload`フラグで分岐し、`true`のものは`dry_mass`に加算せず`payload_mass`として別集計し、`stage`レスポンスに`payload_mass`を追加

### `frontend/app/lib/api.ts`
- `StageSpec`型に`payload_mass: number`を追加
- `RocketFixedMassPayload`型に`isPayload?: boolean`を追加

### `frontend/app/components/RocketBuilder.tsx`
- `NodeCategory`から`fairing`を削除（`CATEGORIES`/`CATEGORY_LABEL`/`CATEGORY_COLOR`/`FIELD_DEFS`/`defaultParams`）
- `FixedMass`型に`isPayload: boolean`を追加、`StagePanel`の固定質量行に「ペイロード」チェックボックスを追加（投棄しない質量であることをtitle属性で説明）
- ステージ計算結果・ステージノードのサマリー表示に`payload_mass`がある場合のみ表示を追加
- `ZERO_STAGE`に`payload_mass: 0`を追加

### `frontend/app/components/LaunchAnalysis.tsx`
- `payloadMass`の初期値を`'50'`→`'0'`に変更し、ラベルを「追加ペイロード質量（スケッチ外）」に変更
- 全段の`propellant_mass + dry_mass + payload_mass`の合計＋追加ペイロード質量を`totalMass`として`useMemo`で計算し、「全備質量」として常時表示

### `frontend/app/components/VehicleDatabase.tsx`
- `StageSpec`の必須フィールド化に伴い、`DEFAULT_STAGE`に`payload_mass: 0`を追加
- `totalInitialMass()`の集計に各段の`payload_mass`を追加

## 動作確認

- `npx tsc --noEmit`・`npm run build`：エラーなし（型不整合は`VehicleDatabase.tsx`の`DEFAULT_STAGE`修正で解消）
- `py -c "import ast; ast.parse(...)"`でバックエンド構文確認
- バックエンドを一時的に起動し、`/rocket/stage/build`に`isPayload=true`の固定質量500kgと`isPayload=false`の100kgを送信→`payload_mass=500`が`dry_mass`に含まれず分離されることを確認
- `/launch/simulate`に段の`payload_mass=20`・手動`payload_mass=10`を送信→初期質量が`150+300+20+10=480kg`、第1段燃焼終了時の質量が`480-300=180kg`（ペイロードは投棄されず推進剤のみ減少）であることを確認
- テスト用に起動したバックエンドプロセスは停止済み（ユーザーの`--reload`付き開発サーバーはそのまま稼働中）

## 今後の作業候補（未完了）

- ブラウザでのUI動作確認：固定質量の「ペイロード」チェックボックス操作、全備質量表示の見え方（ユーザー側での確認待ち）
- `VehicleDatabase.tsx`の手動登録フォームには段ごとの`payload_mass`入力欄を追加していない（今回のスコープ外、必要なら別途対応）

---

# 2026-06-20 セッション4: ?ヒント・タンク簡素化・材料DB・推進剤のエッジ化

## 会話の要点

ユーザーがロケット段デザイナーを細かく確認し、4点の改善要望
1. ペイロードチェックボックスが分かりづらいので「?」アイコンでヒント表示
2. タンクの設計圧力・降伏強度・安全係数（設計情報）は削除してよい
3. 推進剤種類（酸化剤・燃料）はノードではなく、ノード間をつなぐエッジの情報として管理（定常流れタブのエッジ管理が参考）
4. 材料密度・降伏強度などの物性値は物性DBから取得し、パラメータ選択上はSUS・インコネルなど材料名を選ぶだけにしたい。材料DB登録用タブをサイドバーに新設し、TinyDBで実装、ロケット開発でよく使う金属材料を初期登録

## 変更したファイル

### `frontend/app/components/RocketBuilder.tsx`
- `HintIcon`コンポーネントを追加し、固定質量の「ペイロード」チェックボックス横に「?」アイコン＋説明文（投棄しない質量である旨）を表示
- タンクの`FIELD_DEFS`から`designPressurePa`/`yieldStrengthPa`/`safetyFactor`を削除し、`thicknessMm`（肉厚直接入力）に変更
- `FieldDef.type`に`'material'`を追加し、`MaterialField`共通コンポーネントを新設。tank/pipe/nozzle/外壁構造材（StagePanel）の`densityKgM3`、combustorの`densityKgM3`+`yieldStrengthPa`を、材料DBから選ぶ単一の「材質」セレクトに統合（選択時に密度・降伏強度を自動反映）
- `fetchMaterials()`で材料一覧を取得する`materials`状態を追加し、`ParamPanel`/`StagePanel`に配線
- combustorの`oxidizer`/`fuel`フィールドをノードパラメータから削除。代わりにエッジ選択（`onEdgeClick`）と`EdgePanel`（酸化剤→燃料のカスケード選択）を追加し、配管エッジの`data.oxidizer`/`data.fuel`として保持。`handleCalcStage`で配管エッジのoxidizer/fuelをバックエンドへ送信するように変更
- 不要になった`FieldDef`の`'select'`/`'text'`型・関連分岐を削除（dead code整理）

### `frontend/app/components/ComponentLibrary.tsx`
- 部品管理タブのタンク定義も整合性のため`designPressurePa`等を`thicknessMm`に変更

### `backend/main.py`
- `_calc_tank()`を簡素化し、フープ応力計算（`_pressure_vessel_thickness`）をやめて`thicknessMm`を直接シェル質量計算に使用
- 材料DB（TinyDB、`vehicle_db`に`materials`テーブルを追加）: `MaterialSpec`モデル、`GET/POST/DELETE /materials`エンドポイント、ロケット開発でよく使われる金属材料11件（Al 2219-T87, Al-Li 2195-T8, Al 6061-T6, Al 7075-T6, SUS304, SUS316L, Inconel 718, Inconel 625, Ti-6Al-4V, マルエージング鋼C-300, GRCop-84）を初期シード
- `RocketEdge`モデルに`oxidizer`/`fuel`（任意）を追加。`_propellant_for_node()`を新設し、燃焼器ノードに接続されたエッジから酸化剤・燃料種類を取得するように`build_rocket_stage()`を変更（ノードパラメータからの取得を廃止）
- `RocketStagePayload.structure`の型を`dict[str, float]`→`dict[str, float | str]`に変更（材質名の文字列を許容するため）

### `frontend/app/lib/api.ts`
- `MaterialSpec`/`Material`型と`fetchMaterials`/`createMaterial`/`deleteMaterial`を追加
- `RocketEdgePayload`に`oxidizer`/`fuel`、`RocketStagePayload.structure`の型に`string`を許容するよう変更

### `frontend/app/components/MaterialDatabase.tsx`（新規）
- 材料の一覧表示・新規登録・削除を行うコンポーネント（`ComponentLibrary.tsx`と同様のパターン）

### `frontend/app/components/Dashboard.tsx`
- サイドバータブに「材料DB」を追加

## 動作確認

- `npx tsc --noEmit`・`npm run build`：エラーなし
- バックエンド構文確認OK
- バックエンドを一時起動し、`/materials`で11件の初期材料を確認
- `/rocket/stage/build`にタンク（`material`文字列パラメータ含む）・燃焼器・ノズルを送信し、文字列パラメータが計算をクラッシュさせないことを確認
- エッジに`oxidizer`のみ設定→`fuel`はデフォルト"LCH4"にフォールバックすることを確認。酸化剤用エッジ・燃料用エッジを別々に設定→両方が正しく`stage.oxidizer`/`stage.fuel`に反映されることを確認
- テスト用バックエンドプロセスは停止済み（ユーザーの`--reload`付き開発サーバーはそのまま稼働中）

## 今後の作業候補（未完了）

- ブラウザでのUI動作確認：材質セレクトの見た目、エッジクリックでのEdgePanel表示、配管エッジの酸化剤・燃料選択（ユーザー側での確認待ち）
- 配管エッジの推進剤種類を、配管自体の見た目（色分けなど、定常流れタブのfluidColorForEdgeに近い表現）に反映することは未実装（今回はデータモデルの移行のみ）
- `ComponentLibrary.tsx`のcombustor定義にはまだ`oxidizer`/`fuel`/`yieldStrengthPa`/`densityKgM3`が残っており、RocketBuilderの新スキーマとは未整合（部品管理タブは独立カタログのため今回は対象外）

---

# 2026-06-20 セッション5: 「配管」ノード廃止→エッジ化、推進剤を単一選択に統合

## 会話の要点

ユーザーから「配管」部品とノード間のエッジの意味が重複しているとの指摘。
- 「配管」ノードを削除し、代わりにエッジ自体に配管径・板厚・材質・長さを設定できるようにしてほしい
- 配管1本は酸化剤・燃料のどちらか一種類しか流れないはずなので、酸化剤→燃料のカスケード選択（前セッションで実装）ではなく、両方を選択肢に含む単一の「推進剤」ドロップダウンに変更してほしい

## 変更したファイル

### `frontend/app/lib/propellants.ts`
- 酸化剤・燃料を1つのリストにまとめた`PROPELLANT_OPTIONS`（各要素に`role: 'oxidizer' | 'fuel'`）を追加（重複燃料は`Map`でユニーク化）

### `frontend/app/components/RocketBuilder.tsx`
- `NodeCategory`から`pipe`を削除（パレット・`FIELD_DEFS`・`defaultParams`から配管ノードを撤去）
- `EdgePanel`を全面書き換え：エッジ自体のパラメータ（外径・長さ・肉厚・材質・推進剤）を編集するパネルに変更。材質は既存の`MaterialField`を再利用、推進剤は`PROPELLANT_OPTIONS`を`<optgroup>`で酸化剤／燃料に分けた単一セレクトに変更
- エッジ新規接続時（`onConnect`）に配管としてのデフォルト値（外径200mm・長さ1000mm・肉厚2mm等）を付与
- `updateEdgeField`/`updateEdgeMaterial`を追加（旧`updateEdgePropellant`を置き換え）
- `handleCalcStage`: エッジの配管パラメータ・推進剤をバックエンドへ送信し、計算結果（配管質量）をエッジの`label`に表示するように変更

### `backend/main.py`
- `RocketEdge`モデルを拡張：`oxidizer`/`fuel`を`propellant`（単一）に統合し、`diameter_mm`/`length_mm`/`thickness_mm`/`material`/`density_kg_m3`を追加（エッジ＝配管そのもの）
- `PROPELLANT_OXIDIZERS = {"LOX", "NTO"}`を追加し、`_propellant_for_node()`を`edge.propellant`がどちらに属するかで分類する実装に変更
- `build_rocket_stage()`: 全エッジについて寸法・材質からシェル質量を計算して`dry_mass`に加算し、エッジごとの質量を`edge_results`としてレスポンスに追加（`{"nodes":..., "edges":..., "stage":...}`）。ノードループから`"fairing"`/`"pipe"`の分岐を削除（配管はエッジ側で計算するため不要に）

### `frontend/app/lib/api.ts`
- `RocketEdgePayload`の`oxidizer`/`fuel`を`diameter_mm`/`length_mm`/`thickness_mm`/`material`/`density_kg_m3`/`propellant`に置き換え
- `RocketEdgeResult`型を追加し、`RocketStageBuildResult`に`edges: Record<string, RocketEdgeResult>`を追加

## 動作確認

- `npx tsc --noEmit`：エラーは1件のみで、今回まったく変更していない別機能のファイル（`TransientNetworkCalc.tsx`、セッション開始時から未トラッキングの作業中ファイル）によるもの。今回変更したファイルにエラーなし
- `npm run build`は上記の既存エラーにより失敗する状態（今回の変更が原因ではない点をユーザーに報告済み、対応は未実施）
- バックエンド構文確認OK
- バックエンドを一時起動し、タンク2基（酸化剤用・燃料用）→燃焼器→ノズルを配管エッジ（寸法・材質・推進剤付き）で接続したペイロードを送信。`stage.oxidizer="LOX"`/`stage.fuel="LCH4"`が各配管エッジの`propellant`から正しく分類され、各配管の質量（`edges`レスポンス）も妥当な値で返ることを確認
- テスト用バックエンドプロセスは停止済み（ユーザーの`--reload`付き開発サーバーはそのまま稼働中）

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の型エラー（`boundaryType: string`が`'flow' | 'pressure'`に合わない）を修正しないと`npm run build`が通らない状態。これは今回のロケット段デザイナー作業とは無関係な別機能（非定常解析）のWIPファイルのため、対応するかどうかユーザーに確認が必要
- ブラウザでのUI動作確認：エッジパネルでの配管寸法・材質・推進剤の編集、計算後のエッジラベル（質量）表示（ユーザー側での確認待ち）

---

# 2026-06-20 セッション6: 全備質量の表示移動・燃焼器とノズルの統合

## 会話の要点

ユーザーから2点の指摘
1. 「追加ペイロード質量（スケッチ外）」欄は不要なので外してよい。「全備質量」はスケッチ（RocketBuilderキャンバス）の右上あたりに表示してほしい
2. 「燃焼器」と「ノズル」は1つの部品にまとめてほしい。新しい統合部品は、エッジが酸化剤・燃料の両方を引き込めるよう2つのポートを持たせてほしい

## 変更したファイル

### `frontend/app/components/LaunchAnalysis.tsx`
- 「追加ペイロード質量（スケッチ外）」の入力欄と、設定パネル内の「全備質量」`StatItem`表示・関連`totalMass`の`useMemo`を削除（`form.payloadMass`自体は機体プリセット読込み用に内部的に残す）

### `frontend/app/components/RocketBuilder.tsx`
- ステージ設計キャンバスのヘッダー（「段の設計」「+ ステージを追加」のバー）右端に「全備質量」表示を追加。全ステージの`stageResult`（推進剤+構造+ペイロード質量）合計を`useMemo`で計算し常時表示
- `NodeCategory`から`nozzle`を削除し、`combustor`（燃焼器）にノズル関連パラメータ（出口径・ノズル長さ・拡大比・外気圧・ノズル肉厚、材質は共有）を統合。フィールド名の衝突を避けるため`lengthMm`はノズル側を`nozzleLengthMm`に変更
- `resultSummary()`のnozzle分岐をcombustor分岐に統合（推力が出ていればF/Isp、出ていなければ殻質量/ṁを表示）
- 新規`CombustorFlowNode`コンポーネントを追加：左に酸化剤用target Handle（id="oxidizer"）、右に燃料用target Handle（id="fuel"）を持つ専用ノード描画（汎用`RocketFlowNode`の単一target/sourceとは別物。終端部品のためsource Handleは持たない）
- `nodeTypes`マッピングで`combustor`のみ`CombustorFlowNode`を使用するよう変更

### `backend/main.py`
- `_calc_combustor()`と`_calc_nozzle()`を1つの関数に統合。燃焼室シェル質量・ノズルシェル質量・質量流量・推力・Ispをすべて単一の`params`辞書から算出（ノードを跨いだペアリング不要に）
- `build_rocket_stage()`から`nozzle_combustor`ペアリング辞書の構築と`elif node.node_type == "nozzle":`分岐を削除（燃焼器1ノードで完結）
- `RocketNode.node_type`のコメントから`nozzle`を削除

## 動作確認

- `npx tsc --noEmit`：エラーは前回から変わらず1件のみ（無関係な`TransientNetworkCalc.tsx`）。今回変更したファイルにエラーなし
- バックエンド構文確認OK
- バックエンドを一時起動し、酸化剤タンク・燃料タンクをそれぞれ配管エッジ（`target_handle: "oxidizer"`/`"fuel"`、推進剤付き）で燃焼器1ノードに接続したペイロードを送信。推力134,381 N・Isp 233s（統合前と同じ値）が算出され、`stage.oxidizer`/`stage.fuel`も正しく分類されることを確認
- テスト用バックエンドプロセスは停止済み（ユーザーの`--reload`付き開発サーバーはそのまま稼働中）

## 今後の作業候補（未完了）

- ブラウザでのUI動作確認：燃焼器ノードの2ポート表示・配線のしやすさ、全備質量のヘッダー表示（ユーザー側での確認待ち）
- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）

---

# 2026-06-20 セッション7〜8: 部品ノード・ステージ枠のサイズをパラメータ連動に

## 会話の要点

- ユーザーから「スケッチの外径がパラメータ上の外径・長さに合わせて伸縮するようにできるか」という質問→実装
- 続けて「ステージも同様の仕様にできますか」→ステージ枠にも同じ考え方を適用

## 変更したファイル（`frontend/app/components/RocketBuilder.tsx`）

### 部品ノードのサイズ連動（セッション7）
- `nodeSize(category, params)`を追加：外径→幅、長さ→高さ（燃焼器は本体長さ＋ノズル長さを合算）に変換。1mm=0.03px、幅90〜220px・高さ56〜170pxでクランプ。ポンプは寸法パラメータがないため固定サイズ
- `RocketFlowNode`・`CombustorFlowNode`の固定`min-w-[150px]`等を廃止し、計算結果を`style={{width,height}}`で適用（パラメータ変更に応じて即時に再レンダリングされる）

### ステージ枠のサイズ連動（セッション8）
- `stageSize(structure)`を追加：外壁構造材の外径→幅、長さ→高さに変換。部品より緩やかな縮尺（1mm=0.2px／0.12px）・大きめの下限（幅400〜1400px、高さ220〜500px）を使用し、部品を複数並べられる広さを確保
- `StageFlowNode`から手動リサイズ用の`NodeResizer`を削除し、`stageSize(d.structure)`の計算結果を`style`で適用する方式に変更（部品ノードと同じ「パラメータ駆動・手動リサイズなし」の仕様に統一）
- `createStageNode`で固定の`width`/`height`を設定しなくなったことに伴い、`isInsideStage()`（ドロップ判定）と`addStage()`（次のステージのY座標計算）を、xyflowが自動計測する`node.measured.{width,height}`を優先し、未計測時のみ`stageSize()`の計算値にフォールバックする実装に変更（旧来の固定定数`STAGE_DEFAULT_WIDTH`/`STAGE_DEFAULT_HEIGHT`は不要になり削除）

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- Playwright（Python版、`playwright install chromium`で導入）を使い、開発サーバー（ユーザーが起動中のlocalhost:3000/8000をそのまま利用）に対してHTML5 drag-and-dropをJSで合成し実際にブラウザ操作で確認：
  - タンク（外径3700/長さ8000）と燃焼器（小型）をキャンバスに配置→タンクが明らかに大きく表示されることをスクリーンショットで確認
  - タンクの長さを8000mm→1000mmに変更→ノード高さが153px→51pxに即時縮小
  - ステージの外壁構造材を外径6000mm・長さ4000mmに変更→枠が722×234px→1171×468pxに拡大、外径1500mm・長さ1000mmに変更→390×215px（下限クランプ400/220に到達）まで縮小することを確認
- 検証用に作成した一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）
- ステージの手動リサイズ（`NodeResizer`）を廃止したため、外壁構造材の寸法を編集しないと枠の大きさを調整できない点をユーザーに説明済みか要確認（意図した仕様だが、UI上の代替手段がないことに注意）

---

# 2026-06-20 セッション9: 機体データベースを第1段・第2段・フェアリングで整理

## 会話の要点

ユーザーから「機体データベースを、一段目・二段目・フェアリングに分けて、重量・全長・直径を整理してほしい」という依頼。
従来は機体全体で単一の`length`/`diameter`しか持っておらず、フェアリングという概念自体も存在しなかったため、データモデルごと拡張する方針で対応。

## 変更したファイル

### `backend/main.py`
- `StageSpec`に`length_m`（段の全長）・`diameter_m`（段の直径）を追加
- `FairingSpec`モデルを新規追加（`mass_kg`/`length_m`/`diameter_m`）
- `VehicleSpec`の`length`/`diameter`（機体全体で1つだけの値）を削除し、`fairing: FairingSpec`を追加（段ごとの長さ・直径は各`StageSpec`が持つ）
- サンプル機体（H3-30・Falcon 9 Block 5）に、各段の全長・直径とフェアリングの質量・全長・直径を公開情報からの概算値で追加（H3-30: 1段38m/2段11m/フェアリング12m、いずれも直径5.2m、フェアリング質量2,600kg。Falcon9: 1段42.6m/2段12.6m、直径3.7m、フェアリング13.1m・直径5.2m・質量1,900kg）
- 旧スキーマ（`length`/`diameter`のみ）で既に保存されていたサンプルデータ（TinyDB `vehicles`テーブル、登録されていたのは元のサンプル2件のみ）を一度クリアし、新スキーマで再シードされることを確認

### `frontend/app/lib/api.ts`
- `StageSpec`に`length_m`/`diameter_m`を追加
- `FairingSpec`型を新規追加、`VehicleSpec`の`length`/`diameter`を`fairing: FairingSpec`に置き換え

### `frontend/app/components/VehicleDatabase.tsx`
- `totalInitialMass()`にフェアリング質量を加算
- 新規登録フォーム：機体全体の「全長」「直径」入力を削除し、各段の入力項目に「全長」「直径」を追加。段リストの下に「フェアリング」セクション（質量・全長・直径）を新設
- 一覧テーブルを2行ヘッダーに変更し、「第1段」「第2段」「フェアリング」それぞれに「質量・全長・直径」の3列を表示する構成に整理（既存の「段数」「全長」「直径」の単一列は廃止）

### `frontend/app/components/RocketBuilder.tsx`
- `StageSpec`型に`length_m`/`diameter_m`が追加されたことに伴い、`ZERO_STAGE`定数に`length_m: 0, diameter_m: 0`を追加（型エラー解消、ロケット段デザイナーの計算結果自体はこれらの値を使用しない）

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- バックエンドAPI（`/vehicles`）で新スキーマのデータが正しく返ることを確認
- Playwrightで実際にブラウザを操作し、一覧テーブルが「第1段／第2段／フェアリング」の3区分×3列で正しく表示されること、「+機体を追加」フォームに段ごとの全長・直径入力とフェアリングセクションが問題なく表示されることをスクリーンショットで確認（コンソールエラーなし）
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）
- フェアリング質量を`/launch/simulate`の弾道計算に反映するかは今回スコープ外（フェアリングは実機では上昇中に分離されるため、現在の「段末で投棄／投棄しない」の二択モデルに正確に組み込むには別途設計が必要）

---

# 2026-06-20 セッション10: 部品ノードの縦横比を入力パラメータの実寸比に正確に一致させる

## 会話の要点

ユーザーから「スケッチの外径・長さのサイズ入力に対して、スケッチのアスペクト比がマッチしていない」との指摘。意図は「おおよその入力パラメータから機体の縦横比をスケッチ上で把握できるようにしたい」ことなので、縦横比は入力値の比率に正確に一致させてほしいとのこと。

## 原因

- 部品ノード（`nodeSize`）・ステージ枠（`stageSize`）はいずれも「幅は外径基準で[MIN_W,MAX_W]にクランプ」「高さは長さ基準で[MIN_H,MAX_H]にクランプ」と幅・高さを別々にクランプしていたため、どちらか一方だけが範囲外になった場合に実寸比から外れてしまっていた（ステージはさらに幅・高さで縮尺自体も別々だった）
- 加えて、極端に小さい計算結果（例: 燃焼器の幅13.3px）では、CSSの`box-sizing: border-box`の仕様上「ボックスはパディング＋ボーダーの合計を下回れない」という制約により、指定した幅より実際の表示幅が大きくなり、見た目の比率がさらに崩れていた（`padding+border`の合計が20pxあったため、13.3px指定でも実際は20pxで描画されていた）

## 変更したファイル（`frontend/app/components/RocketBuilder.tsx`）

- `clamp()`を`clampPreserveAspect(rawWidth, rawHeight, minDim, maxDim)`に置き換え。大きい方の辺だけを`[minDim, maxDim]`の範囲に収め、幅・高さを必ず同じ係数で拡大縮小することで、縦横比＝外径:長さの実寸比を常に厳密に保つように変更
- `nodeSize()`（部品ノード）・`stageSize()`（ステージ枠）の両方を`clampPreserveAspect`を使う実装に統一（ステージは従来`STAGE_PX_PER_MM_W=0.2`/`STAGE_PX_PER_MM_H=0.12`と幅・高さで異なる縮尺を使っていたが、`STAGE_PX_PER_MM=0.15`の単一縮尺に統一）
- 上記のbox-sizing問題に対処するため、`RocketFlowNode`・`CombustorFlowNode`のパディング・ボーダーを縮小（`px-2 py-2 border-2`→`px-1 py-1 border`）し、`NODE_MIN_DIM`を60→70に微調整。あわせて`min-width: 0; min-height: 0`を明示指定し、暗黙の最小コンテンツサイズによる引き伸ばしも防止

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- Playwrightで実際に値を入れて検証（スクリーンショット・数値とも一時ファイルとして作成し、確認後すべて削除済み）：
  - タンク（外径3700/長さ8000）：表示比 0.46250 = 実寸比 0.46250（完全一致）
  - 燃焼器（外径400/長さ1800相当）：修正前は表示比0.333（実寸比0.222からズレ）→ 修正後0.2221 ≈ 0.2222（一致）
  - タンクを外径9000/長さ2000（横長）に変更：表示比4.501 ≈ 実寸比4.5（一致、横長の見た目になることも確認）
  - ステージ枠（外径3700/長さ2000）：表示比1.85 = 実寸比1.85（完全一致）
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）
- 極端に偏った縦横比（例: 直径100mmで長さ8000mmのような細長い部品）の場合、パディング・ボーダーの最小フロアにより縦横比がわずかに崩れる可能性が残る（現実的な部品の寸法範囲では問題ない想定）

---

# 2026-06-20 セッション11: 配管エッジを推進剤（酸化剤/燃料）で色分け

## 会話の要点

ユーザーから「エッジの色がグレーなのを酸化剤を青、燃料をオレンジ系にしてもらえますか」という依頼。配管エッジには既に`propellant`（推進剤、酸化剤または燃料の一種）が設定可能だが、見た目に反映されていなかったため対応。

## 変更したファイル（`frontend/app/components/RocketBuilder.tsx`）

- `PROPELLANT_ROLE_BY_VALUE`（推進剤の値→役割のマップ）と`propellantEdgeColor(propellant)`（酸化剤=`#0ea5e9`系の青、燃料=`#f97316`系のオレンジ、未設定はデフォルトのグレーのまま）を追加
- `coloredEdges`を`useMemo`で追加し、各エッジの`data.propellant`に応じて`style.stroke`を適用したエッジ配列を生成。`<ReactFlow edges={edges}>`を`edges={coloredEdges}`に変更

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- Playwrightでタンク2基→燃焼器を配管エッジで接続し、それぞれのエッジに酸化剤(LOX)・燃料(LCH4)を設定→エッジが青・オレンジに色分けされることをスクリーンショットで確認
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

---

# 2026-06-20 セッション12: 推進剤DB（流体）を新設し、タンクの推進剤密度をエッジから自動取得

## 会話の要点

ユーザーから2点の依頼
1. タンクの「推進剤密度」パラメータを、配管エッジに設定した推進剤の情報から読み込むようにしてほしい
2. 推進剤の物性（密度）はまだDB化されていないので、材料DBに統合してほしい。ただし材料DBは固体専用なので、推進剤を登録する流体系のDBは別に分けてほしい（「一旦実装してみてもらえますか」とのことでまず試作）

## 変更したファイル

### `backend/main.py`
- 材料DB（`materials`テーブル）とは別に`propellants`テーブルを新設。`PropellantSpec`モデル（`name`/`role`/`density_kg_m3`/`note`）を追加し、`GET/POST/DELETE /propellants`を実装
- 初期データ6件を投入：LOX(酸化剤,1141kg/m3)・NTO(酸化剤,1443kg/m3)・LCH4(燃料,423kg/m3)・LH2(燃料,71kg/m3)・RP-1(燃料,810kg/m3)・MMH(燃料,880kg/m3)。`name`は配管エッジの`propellant`値（`PROPELLANT_OPTIONS`の`value`）と一致させてあるため、文字列一致でそのまま引き当てられる

### `frontend/app/lib/api.ts`
- `PropellantSpec`/`Propellant`型と`fetchPropellants`/`createPropellant`/`deletePropellant`を追加

### `frontend/app/components/PropellantDatabase.tsx`（新規）
- 推進剤の一覧表示・新規登録（名称・区分=酸化剤/燃料・密度・メモ）・削除を行うコンポーネント（`MaterialDatabase.tsx`と同様のパターンだが別コンポーネント・別テーブル）

### `frontend/app/components/Dashboard.tsx`
- 「材料DB」タブの中に`MaterialDatabase`（固体）と`PropellantDatabase`（流体）を並べて表示するように変更（タブ自体は増やさず、同タブ内でセクションを分離）

### `frontend/app/components/RocketBuilder.tsx`
- `propellants`（推進剤DB一覧）を`fetchPropellants()`で取得する状態を追加
- タンクの`FIELD_DEFS`の`propellantDensityKgM3`を新しい`type: 'propellantDensity'`に変更。手入力の数値欄を廃止し、接続された配管エッジの`propellant`を`propellantForNode(nodeId, edges)`で検出→推進剤DBから密度を引いて読み取り専用表示（未接続時は「配管エッジで推進剤を設定してください」と案内）
- `ParamPanel`に`propellants`・`edges`propsを追加
- `handleCalcStage`で、タンクノードの送信パラメータを生成する際に、接続エッジの`propellant`から推進剤DBの密度を引いて`propellantDensityKgM3`を上書きしてバックエンドに送信（表示値と計算に使われる値の単一ソース化）

## 既知の制約（今回のスコープ）

- 「エッジから自動取得」はタンクに**直接**つながるエッジのみを見ている。タンク→ポンプ→燃焼器のように間にポンプを挟み、推進剤がポンプ→燃焼器側のエッジにしか設定されていない場合は検出できない（「一旦実装してみてもらえますか」というご依頼だったため、まずは直接接続のケースのみ対応）
- 推進剤DBに未登録の名称がエッジに設定された場合は「（推進剤DBに未登録）」と表示し、密度の上書きは行われない（既存のデフォルト値が使われる）

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- バックエンド構文確認OK、`/propellants`で初期データ6件が正しく返ることを確認
- Playwrightでタンク→燃焼器を配管エッジで接続し、エッジに酸化剤LOXを設定→タンクのパラメータパネルに「推進剤密度: 1,141（液体酸素 LOX）」と自動表示されることを確認。「この段を計算」を実行し、推進剤質量がLOX密度（1141kg/m3、デフォルトの423kg/m3ではない）で計算されていることを確認（推進剤95,200.8kg、密度比から妥当な値）
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）
- タンク→ポンプ→燃焼器のように間接的に接続されたケースへの対応（グラフを辿って間接的な推進剤を検出する）
- 燃焼器のO/F比・推進剤選択と、実際に接続された酸化剤・燃料の組み合わせとの整合チェック（現状は警告なし）

---

# 2026-06-20 セッション13: サイドバー名称変更と「推進剤DB」→「流体ライブラリ」への拡張

## 会話の要点

1. サイドバーの「流体ライブラリ」（CoolPropベースの液種選択・線図タブ）が、材料DBと並ぶと名前がややこしいとの指摘→「状態方程式」に変更
2. その上で、材料DB内の「推進剤DB」を「流体ライブラリ」という名前に変更（空いた名前を転用）。あわせて以下を要望：
   - 区分（気体・液体）の追加
   - 酸化剤・燃料をBoolean（チェックボックス）管理に変更（従来は単一の`role`文字列セレクト）
   - 水などの汎用流体も登録できるように
   - 物性値として密度に加え、粘度・熱伝導率・定圧比熱を追加
   - 物性値の参照温度・参照圧力も追加

## 変更したファイル

### `frontend/app/components/Dashboard.tsx`
- サイドバータブ`fluid-library`のラベルを「流体ライブラリ」→「状態方程式」に変更
- 「材料DB」タブ内の`PropellantDatabase`を`FluidLibrary`に差し替え

### `backend/main.py`
- 旧`propellants`テーブル・`PropellantSpec`モデル・`/propellants`系エンドポイントを廃止し、`fluid_library`テーブル・`FluidLibrarySpec`モデル・`/fluid-library`系エンドポイント（GET/POST/DELETE）に置き換え
- `FluidLibrarySpec`: `name`/`phase`(gas|liquid)/`is_oxidizer`(bool)/`is_fuel`(bool)/`density_kg_m3`/`viscosity_pa_s`/`thermal_conductivity_w_m_k`/`specific_heat_j_kg_k`/`reference_temperature_k`/`reference_pressure_pa`/`note`
- 初期データを8件に拡充：LOX・NTO・LCH4・LH2・RP-1・MMH（推進剤6種、`is_oxidizer`/`is_fuel`をbooleanで設定）に加え、Water（水、汎用、酸化剤/燃料いずれもFalse）とGHe（加圧用ヘリウムガス、`phase="gas"`の例）を追加。各流体に粘度・熱伝導率・定圧比熱・参照温度・参照圧力の概算値を設定
- 旧`propellants`テーブルの残存データ（旧スキーマ）はTinyDBから削除し、新テーブルでクリーンに再シード

### `frontend/app/lib/api.ts`
- `PropellantSpec`/`Propellant`/`fetchPropellants`/`createPropellant`/`deletePropellant`を、`FluidLibrarySpec`/`FluidLibraryEntry`/`fetchFluidLibrary`/`createFluidLibraryEntry`/`deleteFluidLibraryEntry`にリネーム。型に新フィールド（`phase`/`is_oxidizer`/`is_fuel`/`viscosity_pa_s`/`thermal_conductivity_w_m_k`/`specific_heat_j_kg_k`/`reference_temperature_k`/`reference_pressure_pa`）を追加

### `frontend/app/components/PropellantDatabase.tsx`→`FluidLibrary.tsx`（リネーム＋再構成）
- 一覧テーブルに状態（気体/液体）・酸化剤チェック・燃料チェック・粘度・熱伝導率・定圧比熱・参照T・参照P列を追加
- 新規登録フォームに状態セレクト、酸化剤・燃料の独立したチェックボックス（同時にON可能）、追加物性値の入力欄を追加

### `frontend/app/components/RocketBuilder.tsx`
- `fetchPropellants`/`Propellant`型の参照を`fetchFluidLibrary`/`FluidLibraryEntry`に追従（タンクの推進剤密度自動取得ロジック自体はフィールド名`density_kg_m3`が変わっていないため変更不要）

## 動作確認

- `npx tsc --noEmit`：エラーは引き続き1件のみ（無関係な`TransientNetworkCalc.tsx`）
- バックエンド構文確認OK、`/fluid-library`で新スキーマの8件（LOX/NTO/LCH4/LH2/RP-1/MMH/Water/GHe）が正しく返ることを確認
- Playwrightでブラウザを操作し、サイドバーが「状態方程式」、材料DBタブ内に「流体ライブラリ」セクション（状態・酸化剤・燃料チェック・各物性値列を含むテーブル）が表示されることをスクリーンショットで確認
- リネーム後もロケット段デザイナーのタンク推進剤密度自動取得（配管エッジのLOX設定→「推進剤密度: 1,141（液体酸素 LOX）」表示）が引き続き正しく動作することを確認
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`の既存型エラー対応は未着手（別件、対応するか要確認）
- 流体ライブラリの粘度・熱伝導率・定圧比熱は現時点でRocketBuilder側では未使用（密度のみ利用）。将来的に熱計算等に使う場合は活用先の実装が必要

---

# 2026-06-20 セッション14: 材料DBの見出し変更・物性値拡充・Cu系材料追加、固体/流体ライブラリの編集機能

## 会話の要点

ユーザーから4点の依頼
1. 材料DB上部の見出し「材料DB」を「固体ライブラリ」に変更（「流体ライブラリ」と対をなす名称に）
2. 材料の物性値として熱伝導率・比熱・参照温度を追加登録
3. Cu系合金・純銅・鋳鉄を材料DBに追加
4. 固体・流体の両ライブラリについて、登録済みエントリを変更する「編集」機能を追加（「削除」ボタンの隣に配置）

## 変更したファイル

### `backend/main.py`
- `MaterialSpec`に`thermal_conductivity_w_m_k`/`specific_heat_j_kg_k`/`reference_temperature_k`を追加。既存11件すべてに概算値を設定
- 新規材料4件を追加：純銅 C1100、NARloy-Z（Cu-Ag-Zr合金、SSME/RS-25チャンバライナー）、Cu-Cr-Zr合金（高強度・高熱伝導銅合金）、鋳鉄 FC250。これで材料DBは計15件
- `/materials/{id}`に`PUT`（更新）エンドポイントを追加（`update_material`）
- `/fluid-library/{id}`にも同様に`PUT`（更新）エンドポイントを追加（`update_fluid_library_entry`）
- 旧スキーマの`materials`テーブルの残存データはクリアし、新スキーマで再シード

### `frontend/app/lib/api.ts`
- `MaterialSpec`型に新フィールド3つを追加。`updateMaterial(id, payload)`・`updateFluidLibraryEntry(id, payload)`を追加

### `frontend/app/components/MaterialDatabase.tsx`
- 見出しを「材料DB」→「固体ライブラリ」に変更
- 新規登録フォーム・一覧テーブルに熱伝導率・比熱・参照温度の列/入力を追加
- 編集機能を追加：行の「削除」の隣に「編集」ボタンを配置。クリックでその材料のデータをフォームに読み込み、ボタン表示が「材料を更新」に切り替わり（「キャンセル」ボタンも表示）、`updateMaterial`で更新するように変更

### `frontend/app/components/FluidLibrary.tsx`
- 同様に編集機能を追加（「編集」ボタン、フォームの「流体を更新」「キャンセル」、`updateFluidLibraryEntry`呼び出し）

## 動作確認

- `npx tsc --noEmit`：今回変更したファイルにエラーなし（`PipeNetworkCalc.tsx`の`valve_zeta_full_open`関連エラーは、ユーザーが並行して作業中の別機能によるもので無関係。`TransientNetworkCalc.tsx`の既存エラーも別件）
- バックエンド構文確認OK。`/materials`で新スキーマの15件、`/fluid-library`で8件が返ることを確認
- Playwrightで固体ライブラリの「純銅 C1100」を編集→メモを書き換えて更新→テーブルに反映されることを確認。流体ライブラリの「Water」も同様に編集→更新が反映されることを確認
- 検証で書き換えたテストデータ（メモ欄）は、テーブルをドロップして再シードする形で元のサンプル値に復元済み
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`・`PipeNetworkCalc.tsx`の既存型エラー対応は未着手（いずれも別件、対応するか要確認）
- 材料の熱伝導率・比熱は現時点でRocketBuilder側では未使用（密度・降伏強度のみ利用）。将来熱計算等に使う場合は活用先の実装が必要

---

# 2026-06-20 セッション15: デフォルトスケッチをH3構成に近い値で自動生成

## 会話の要点

ユーザーから「デフォルトでH3の構成に近い値になるようにスケッチを作ってもらえますか」という依頼。これまでロケット段デザイナーは常に空のステージ1個から始まる仕様だったため、初期状態として公開情報ベースのH3-30相当の2段構成（タンク・燃焼器・配管）を自動生成するように変更。

## 変更したファイル（`frontend/app/components/RocketBuilder.tsx`）

- `createH3DefaultGraph()`を新規追加。H3-30の概算スペック（1段目: LE-9×3・LOX/LH2・推進剤225t・乾燥48t・推力4,416kN(vacuum)・燃焼214s／2段目: LE-5B-3・推進剤23t・乾燥3.5t・推力137kN(vacuum)・燃焼700s、各段全長・直径は公開値の概算）から逆算した寸法・パラメータで、2ステージ×（LOXタンク・LH2タンクラベル・燃焼器ノード×各1）＋配管エッジ（酸化剤=LOX・燃料=LH2、それぞれ色分け表示）を構築
- 各段の乾燥質量を実機値に近づけるため、シェル質量だけでは届かない分（エンジン本体・配管・アビオニクス等に相当）を固定質量として追加（1段目36,800kg・2段目1,264kg）
- 2段目の燃焼器は拡大比110の真空仕様（LE-5B-3は上空点火のみ）のため、外気圧パラメータを海面（101325Pa）ではなく真空（0Pa）に設定（海面大気圧のままだと過膨張で推力が負になる計算上の問題があったための実機に即した修正）
- `useNodesState`/`useEdgesState`の初期値を、従来の「空のステージ1個」から`createH3DefaultGraph()`の戻り値に変更。`stageCounter`の初期値も2に調整（追加ステージが3から始まるように）

## 動作確認

- `npx tsc --noEmit`：今回変更したファイルにエラーなし
- バックエンドAPI（`/rocket/stage/build`）に同じノード・エッジ構成を送信し、計算結果が目標値に近いことを確認：
  - 1段目: 推進剤224,915kg（目標225,000kg）・乾燥48,008.8kg（目標48,000kg）・推力3,852,740N（vacuum目標4,416,000N、海面大気圧条件のため過膨張分低めで現実的）・燃焼215.3s（目標214s）
  - 2段目: 推進剤23,011.6kg（目標23,000kg）・乾燥3,499.3kg（目標3,500kg）・推力148,347N（vacuum目標137,000kg）・燃焼698.7s（目標700s）
  - 2段構成での`/launch/simulate`も正常終了（T/W=1.295、Δv=11,037m/s、エラーなし）
- Playwrightでページを開いた直後（ユーザー操作なし）に上記の2ステージ構成が自動表示されることを確認。各ステージの「この段を計算」を実行し、上記の数値どおりに表示されることをスクリーンショットで確認
- 検証用の一時スクリプト・スクリーンショットはすべて削除済み

## 今後の作業候補（未完了）

- `TransientNetworkCalc.tsx`・`PipeNetworkCalc.tsx`の既存型エラー対応は未着手（いずれも別件、対応するか要確認）
- デフォルトスケッチの寸法・固定質量はあくまで概算（特に乾燥質量の大半を占める固定質量は「エンジン・配管・アビオニクス等」とまとめた逆算値）であり、詳細な内訳を持たせたい場合は別途調整が必要
