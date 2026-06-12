# Relaxed Cone Map Generator

ハイトマップ画像から **Relaxed Cone Step Mapping** 用のコーンマップを生成し、その場で 3D プレビューできる Web ツールです。
生成・プレビューとも **WebGL2 (GPU)** で動作し、サーバー処理は一切不要。GitHub Pages にそのまま置けます。

> Relaxed Cone Step Mapping は GPU Gems 3 / Chapter 18
> "Relaxed Cone Stepping for Relief Mapping" (F. Policarpo, M. M. Oliveira) の手法です。
> 視差マッピング(レリーフマッピング)のレイマーチを、事前計算した「コーン比率」で大股に安全にスキップし、少ないステップ数で正確な交点を求められます。

## 使い方

### オンライン (GitHub Pages)

1. このリポジトリを GitHub に push
2. リポジトリの **Settings → Pages → Source** で `main` ブランチ / `/ (root)` を選択
3. 表示された URL を開くだけ

### ローカル

`run_local.bat` をダブルクリックしてください (Python 3 が必要です)。
`http://localhost:8765/` が自動で開きます。

ブラウザ要件: WebGL2 対応の Chrome / Edge / Firefox / Safari。

### 操作手順

1. **ハイトマップ画像をドロップ**(または「サンプル地形を生成」で試す)
2. 解像度・チャンネル・反転などを設定し **「生成 (GPU)」**
3. 生成中もプレビューがリアルタイムに更新されます
4. **「コーンマップ PNG を保存」**でダウンロード

プレビュー操作: 左ドラッグで回転、ホイールでズーム。

## パラメータ

| 項目 | 説明 |
|---|---|
| 解像度 | 出力コーンマップのサイズ (正方形にリサンプルされます) |
| チャンネル | 高さとして使う入力画像のチャンネル (輝度 / R / G / B / A) |
| 高さを反転 | 白=低 の画像 (デプスマップ) を使う場合に ON |
| タイリング(ラップ) | タイル化前提のテクスチャなら ON (端を跨いで計算)。非タイルなら OFF |
| 探索半径 | コーン制約を探すテクセル範囲。大きいほど正確だが計算時間が増える (目安: 高さスケールが大きいほど広く) |
| レイ探索ステップ | 1 オフセットあたりのレイ前進サンプル数。多いほど高精度 |
| 深さスケール | プレビューでの凹凸の深さ (ワールド単位) |
| コーンステップ数 | プレビューシェーダーのコーンステップ反復回数 |

計算量は おおよそ `解像度² × 探索半径² × ステップ数` に比例します。
512 以上 + 広い半径は数十秒かかることがあります (進捗バー表示・中止可能。UI は固まりません)。

## 出力フォーマット

PNG (入力と同サイズの正方形):

| チャンネル | 内容 |
|---|---|
| R | 高さ (0–1) |
| G | コーン比率 (0–1) … `半径 / 深さ` 。1.0 = 制約なし |
| B / A | 未使用 (0 / 255) |

コーン比率は「そのテクセルの表面位置を頂点とする、上方向に開いた安全コーンの開き具合 (UV 距離 / デプス差)」です。デプスは `1 - 高さ`、UV は 0–1 の正方形空間です。

## ランタイムでの使い方 (シェーダー例)

タンジェント空間の視線レイ `dir` (深さ方向 z を +、`dir.z==1` に正規化済み) で:

```glsl
// coneMap: R = height, G = cone ratio
float rr = length(dir.xy);
vec3 p = vec3(uv, 0.0);            // 表面 (depth=0) から開始
for (int i = 0; i < CONE_STEPS; i++) {
    vec2  t = texture(coneMap, p.xy).rg;
    float d = 1.0 - t.r;           // depth
    float c = max(t.g, 0.002);     // cone ratio
    p += dir * (c * max(d - p.z, 0.0) / (rr + c));
}
// 二分探索で精密化 (relaxed cone なので区間内の交差は高々 1 回)
float lo = 0.0, hi = p.z;
for (int i = 0; i < 8; i++) {
    float mid = 0.5 * (lo + hi);
    vec3  q = vec3(uv, 0.0) + dir * mid;
    if (q.z < 1.0 - texture(coneMap, q.xy).r) lo = mid; else hi = mid;
}
vec2 hitUV = uv + dir.xy * hi;     // ここで法線マップ等をサンプル
```

このリポジトリのプレビューシェーダー ([js/shaders.js](js/shaders.js) の `viewFS`) が実装例そのものなので参考にしてください。

## 仕組み (生成側)

各テクセルについて「ソース表面から周辺テクセルを貫いて表面外に出るまで」のレイを GPU 上で追跡し、得られるコーン比率の最小値を蓄積します (GPU Gems 3 の前処理アルゴリズム)。

- 周辺オフセットを距離昇順にソートし、128 個ずつのバッチでフラグメントシェーダーに渡して min 合成 (ピンポンバッファ)
- 「これ以上遠いオフセットは現在の最小値を更新できない」場合は早期打ち切り
- フレームあたりの GPU 時間を計測してバッチ数を自動調整 → ブラウザが固まらない

### 既知の制限

- 入力は正方形にリサンプルされます (コーン比率は等方な UV 空間を前提とするため)
- 高さ 1.0 (純白) の 1px だけの尖塔のような極端な形状は、理論上コーン制約を取りこぼすことがあります (元論文の実装と同じ挙動)

## ファイル構成

```
index.html        UI
style.css
js/shaders.js     生成・プレビュー両方の GLSL
js/generator.js   コーンマップ生成パイプライン
js/viewer.js      3D プレビュー
js/main.js        UI 結線・サンプル地形・PNG 入出力
run_local.bat     ローカル確認用 (Python の http.server)
```

## 参考文献

- F. Policarpo, M. M. Oliveira, "Relaxed Cone Stepping for Relief Mapping", GPU Gems 3, Chapter 18
- J. Dummer, "Cone Step Mapping: An Iterative Ray-Heightfield Intersection Algorithm"

## ライセンス

MIT
