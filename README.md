# Relaxed Cone Map Generator

高さマップ、深度マップ、または通常の写真から、レリーフマッピング用の Cone Map をブラウザ上で生成するツールです。

https://tomosud.github.io/RelaxedConeMap/

生成方式は次の 2 種類から選べます。

- **Robust RCS (EGSR 2024)** — 現在の既定。双線形補間される高さ場に対して保守的な Cone Map を生成します。
- **Legacy approximate RCS** — GPU Gems 3 の Relaxed Cone Step Mapping を基にした従来方式です。

入力画像や AI 深度推定、Cone Map 生成、3D プレビューはローカルのブラウザ内で処理され、画像をサーバーへ送信しません。生成とプレビューには WebGL2/GPU、深度推定には ONNX Runtime Web と同梱モデルを使用します。

## 主な機能

- 高さ・深度マップから Cone Map PNG を生成
- 写真から AI で深度を推定し、その結果から Cone Map を自動生成
- Robust / Legacy 生成方式の切り替え
- Relief、Height Map、Cone Map、Raymarch Iterations のリアルタイム表示
- タイリング、反転、入力チャンネル、解像度の指定
- 生成方式に対応した Unreal Engine マテリアルノードの出力
- PC のマウス操作と、モバイル端末の傾き操作に対応

## まず使う

### 高さマップ・深度マップから作る

1. Web ページを開くか、`run_local.bat` でローカル版を起動します。
2. **Choose Height / Depth Map** から画像を選びます。白を高く、黒を低く扱います。
3. **Implementation** で生成方式を選びます。通常は既定の **Robust RCS** を推奨します。
4. Resolution、Channel、Invert Height、Tiling を設定します。
5. **Generate (GPU)** を押します。
6. 右側の 3D プレビューを確認し、**Save Cone Map PNG** で保存します。

画像をまだ選んでいない場合はサンプル地形を使えます。PC 版では起動時にもサンプルが自動生成されます。

### 写真から作る（AI 深度推定）

1. **From Photo (Depth Estimation)** の領域へ写真をドロップ、クリックして選択、またはクリップボードから貼り付けます。
2. 初回は深度推定モデルを読み込み、写真から高さとして使う深度を推定します。
3. 推定完了後、選択中の方式で Cone Map が自動生成されます。
4. 必要に応じて設定を変更し、**Generate (GPU)** で再生成します。

深度推定はローカルの **Depth Anything V3 Small** を優先し、読み込めない場合は同梱の量子化 Depth Anything モデルへフォールバックします。推定値は画像内の最小・最大値で 0–1 に正規化され、近い部分が高くなる向きに変換されます。

写真は通常タイル状につながらないため、深度推定後は **Tiling (Wrap) が OFF** になります。また、写真そのものがプレビューのカラーとして使われます。単眼深度推定は実寸や絶対距離を復元するものではないため、輪郭、反射面、透明物、細い物体では誤差が出ることがあります。

## Robust と Legacy の違い

| 項目 | Robust RCS (EGSR 2024) | Legacy approximate RCS |
|---|---|---|
| 用途 | 品質と安全性を優先する通常利用 | 従来結果との互換、短い探索での試行 |
| Cone の生成 | 双線形高さ場の falling-edge 制約を評価 | 周辺オフセットとレイ上のサンプルから近似 |
| 探索範囲 | 高さ場全体。Cone bound により早期除外 | Search Radius 内のみ |
| 補正 | 安全な双線形 Cone 補間のための 3×3 minimum correction | なし |
| プレビュー追跡 | cell-max step と二分探索 | Relaxed Cone Step と二分探索 |
| 調整項目 | 解像度、Wrap など。探索品質は固定 | Search Radius、Ray Search Steps を調整可能 |
| 必要機能 | WebGL2 + `EXT_color_buffer_float` | WebGL2。拡張がない場合は低精度バッファへフォールバック |
| Unreal 素材 | `robust_material.txt` | `material.txt` |

Robust は全高さ場を対象にするため、特に高解像度では Legacy より生成に時間がかかります。一方、Search Radius の外側を見落とす近似ではなく、PNG に保存される 8-bit 高さに対して保守的になるよう Cone 比率を作成・量子化します。

Legacy の **Search Radius** は調べる周囲の半径、**Ray Search Steps** は各方向に沿ったサンプル数です。値を上げると見落としを減らせますが、生成時間も増えます。この 2 項目は Robust 選択時には使用されません。

> 生成方式を切り替えた後は **Generate (GPU)** を押して作り直してください。保存される PNG と Unreal マテリアルテキストは、現在選択されている方式に対応します。

## 設定

### 入力・生成

| 設定 | 内容 |
|---|---|
| Resolution | 出力サイズ（128 / 256 / 512 / 1024）。入力画像は選択サイズの正方形へリサイズされます。 |
| Channel | 高さとして読む成分。Luminance、R、G、B、A から選択します。 |
| Invert Height | 高さを反転します。黒が高い素材に使用します。 |
| Tiling (Wrap) | 画像の上下・左右をつないで計算します。繰り返し素材では ON、写真など一枚物では OFF にします。 |
| Implementation | Robust または Legacy を選択します。 |
| Search Radius | Legacy の探索半径です。Robust では無効です。 |
| Ray Search Steps | Legacy の方向ごとの探索サンプル数です。Robust では無効です。 |

### プレビュー

| 設定 | 内容 |
|---|---|
| Display | Relief、Height Map、Cone Map、Raymarch Iterations を切り替えます。 |
| Depth Scale | 視差の強さです。大きすぎると斜め方向で破綻しやすくなります。 |
| Tile Count | プレビュー上の繰り返し数です。 |
| Cone Steps | プレビューの最大追跡回数です。増やすと精度と負荷が上がります。 |
| Self Shadow | 自己影を表示します。 |
| Specular | スペキュラを表示します。 |
| Auto Rotate Light | ライトを自動回転します。 |
| No Shading | カラーをシェーディングなしで確認します。 |
| Light Azimuth / Elevation | ライトの方位角と仰角です。 |

PC 版の操作は、左ドラッグで回転、右ドラッグで移動、ホイールでズームです。**Raymarch Iterations** は追跡回数をヒートマップ表示し、負荷や収束の確認に使えます。

## 出力 PNG

`conemap_<解像度>.png` という名前の正方形 PNG を保存します。

| チャンネル | 内容 |
|---|---|
| R | 高さ。0 が最低、1 が最高 |
| G | Cone ratio。1 は制約なし |
| B | 未使用 |
| A | 1（不透明） |

これはカラー画像ではなくリニアな数値テクスチャです。アルベドは含まれないため、必要なら元画像を別テクスチャとして使用してください。

## Unreal Engine で使う

### 1. Cone Map をインポートする

保存した PNG を Unreal Engine 5 の Content Browser に読み込み、Texture Editor で次を設定します。

| 項目 | 設定 |
|---|---|
| sRGB | **OFF** |
| Compression Settings | **VectorDisplacementmap (RGBA8)** |
| Mip Gen Settings | 通常は既定値。遠距離で問題が出る場合は `NoMipmaps` も検討 |

sRGB が ON だと R/G の数値がガンマ変換され、交点探索が正しく動きません。通常のカラー画像は別途 sRGB ON で読み込みます。

### 2. 対応するマテリアルノードを貼り付ける

1. Web ツールで、PNG を生成したときと同じ **Implementation** を選びます。
2. **Open Unreal Material Text** を押します。
3. 開いたページで **Select All and Copy** を押します。
4. Unreal の Material Editor の空白部分へ `Ctrl+V` で貼り付けます。
5. 作成された `ConeMap` Texture Object Parameter にインポートした PNG を指定します。
6. 出力用の named reroute をマテリアルへ接続します。
   - `to baseColor_1` → Base Color
   - `to Normal_1` → Normal
7. Material Instance で `Depth` を調整します。

ボタンは選択中の方式に応じて自動的に次のファイルを開きます。

- Robust: [`unreal_material/robust_material.txt`](unreal_material/robust_material.txt)
- Legacy: [`unreal_material/material.txt`](unreal_material/material.txt)

Robust 用グラフは cell-max tracing（32 steps）と 5 回の二分探索、補正 UV からの 2-tap 法線生成を含みます。Legacy 用グラフは従来の Relaxed Cone Stepping（32 steps）と 8 回の二分探索を使います。方式の異なる PNG とマテリアルを組み合わせないでください。

貼り付け後に参照先がサンプル用テクスチャのままの場合は、`ConeMap` パラメータを必ず自分のテクスチャへ差し替えてください。UV のタイリングを変更する場合、カラーと Cone Map の両方へ同じ UV を使います。

詳しい手動構築方法と HLSL の説明は [`UNREAL_RelaxedConeMap.md`](UNREAL_RelaxedConeMap.md) も参照してください。

## モバイル版

モバイルでは写真から 3D 表示までを短い操作で行う画面になります。

1. **Take Photo** または **Choose Photo** を選びます。
2. AI 深度推定と Cone Map 生成が自動実行されます。
3. **Enable Tilt Control** を有効にすると、端末の傾きで視点を動かせます。iOS Safari ではセンサー権限の許可が必要です。
4. 画面下の **Depth** で立体感を調整します。

モバイルでは負荷を抑えるため Relief 表示に固定し、自己影、スペキュラ、シェーディングの一部を無効にします。PNG 保存、詳細調整、Unreal マテリアル出力は PC 版を使用してください。

## ローカルで実行する

Windows では `run_local.bat` をダブルクリックします。Python 3 の簡易 HTTP サーバーが起動し、`http://localhost:8765/` が開きます。

```text
run_local.bat
```

ファイルを `file://` で直接開くと、深度モデルや Unreal マテリアルテキストをブラウザが読み込めません。必ず HTTP サーバー経由で開いてください。

対応環境は WebGL2 を利用できる最新版の Chrome、Edge、Firefox、Safari です。Robust には `EXT_color_buffer_float` も必要です。初回の深度モデル読み込みには時間とメモリを使用します。

## ファイル構成

```text
index.html                          UI
style.css                           レイアウト
js/main.js                          入出力、方式切替、UI 制御
js/generator.js                     Legacy Cone Map 生成
js/robust-generator.js              Robust Cone Map 生成
js/shaders.js                       Legacy 生成・共通プレビュー shader
js/robust-shaders.js                Robust 生成 shader
js/viewer.js                        WebGL2 3D プレビュー
js/depth.js                         ONNX 深度推定
model/                              Depth Anything モデル
unreal_material/material.txt        Legacy 用 Unreal ノード
unreal_material/robust_material.txt Robust 用 Unreal ノード
run_local.bat                       ローカル HTTP サーバー
```

## 参考文献

- R. Bán, G. Valasek, Cs. Bálint, V. A. Vad, [“Robust Cone Step Mapping”](https://doi.org/10.2312/sr.20241146), EGSR 2024. [Reference implementation](https://github.com/Bundas102/robust-cone-map)
- F. Policarpo, M. M. Oliveira, [“Relaxed Cone Stepping for Relief Mapping”](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-18-relaxed-cone-stepping-relief-mapping), GPU Gems 3, Chapter 18
- J. Dummer, “Cone Step Mapping: An Iterative Ray-Heightfield Intersection Algorithm”

**License**
MIT
