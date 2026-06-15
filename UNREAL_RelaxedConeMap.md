# Relaxed Cone Map を Unreal で疑似立体表示する

このリポジトリの生成ツールが書き出した PNG を Unreal Engine 5 のマテリアルで読み込み、
**Relaxed Cone Stepping（リラックスド・コーン・ステッピング）によるレリーフマッピング**で
平面に疑似的な凹凸（視差・遮蔽つき）を表示する手順をまとめます。

そのまま貼り付けて動かせるように、**Custom（HLSL）ノードのコード全文**を載せています。
GLSL ビューワ（`js/shaders.js` の `viewFS`）と同じアルゴリズムを HLSL に移植したものです。

---

## 1. このツールが書き出すテクスチャの中身

「保存」ボタンで出力される `conemap_<サイズ>.png` の各チャンネルは次の通りです（`js/shaders.js` の `compFS` 参照）。

| チャンネル | 内容 | 意味 |
|-----------|------|------|
| **R** | 高さ (height) | `0` = 最も低い / `1` = 最も高い（表面の天面）。深さは `depth = 1 - R`。 |
| **G** | コーン比率 (cone ratio) | 各テクセルから立てた円錐が高さ場に当たらない最大の「半径 ÷ 深さ範囲」。レリーフマッピングのステップ距離計算に使う。 |
| **B** | 0（未使用） | — |
| **A** | 1（不透明） | — |

> **重要：値はリニア（ガンマ補正なし）でバイト格納されています。**
> PNG ですが「色」ではなく「数値」が入っているので、Unreal で **sRGB を必ず OFF** にしてインポートしてください。
> sRGB が ON のままだと R も G もガンマ復号されて高さ・コーン比率が壊れ、まともに立体になりません。

カラー（アルベド）は別途、元画像をそのまま使います（このコーンマップには色は含まれません）。

---

## 2. Unreal へのインポート設定（最重要）

コーンマップ PNG を Content Browser にドラッグして取り込み、ダブルクリックして次を設定します。

| 項目 | 設定値 | 理由 |
|------|--------|------|
| **sRGB** | **OFF（チェックを外す）** | リニアな数値データのため。最重要。 |
| **Compression Settings** | **VectorDisplacementmap (RGBA8)** | 非圧縮 RGBA8。R/G を独立・高精度に保てる。`Default`(DXT) だと G チャンネルが潰れて段差が出る。 |
| **Mip Gen Settings** | `FromTextureGroup`（既定）でOK。気になる場合 `NoMipmaps` | ミップで遠景のコーン比率が甘くなることがある。 |
| **Texture Group** | `World` など任意 | — |

カラー画像（アルベド）側は通常通り **sRGB ON** で取り込みます。

---

## 3. マテリアルの全体構成

```
[コーンマップTex (sRGB OFF)] ─┐
[CameraVector → Transform(World→Tangent)] ─┤
[TexCoord(UV)] ─┤
[Depth スカラーパラメータ] ─┤
                              ▼
                    ┌──────────────────────┐
                    │  Custom ノード        │  ← HLSL を貼り付け
                    │  ReliefConeMap        │
                    │  出力: float2 補正UV  │
                    └──────────────────────┘
                              │ 補正UV
              ┌───────────────┼─────────────────────┐
              ▼               ▼                     ▼
   [アルベドTex.Sample]  [法線 = 高さの中央差分]   （影/AO は任意）
              │               │
           BaseColor       Normal
```

ポイント：Custom ノードは **「補正後の UV」** を返すだけにします。
その UV でアルベス・法線をサンプリングすれば、視差のある凹凸として見えます。
（HLSL 内で 1 つの Custom ノードに全部詰め込むと法線出力が扱いにくいので、UV を返す設計が楽です。）

---

## 4. Custom ノードに貼る HLSL（コピペ）

### 4-1. Custom ノードの設定

マテリアルエディタで **Custom** ノードを追加し、詳細パネルで以下を設定します。

- **Output Type**: `CMOT Float2`
- **Inputs**（＋で追加、名前を正確に）:
  | 入力名 | 型 | つなぐもの |
  |--------|----|-----------|
  | `ConeMap` | Texture Object | コーンマップ Texture（Texture Object Parameter ノード） |
  | `UV` | Float2 | `TexCoord[0]`（必要ならタイリング乗算） |
  | `ViewTS` | Float3 | `CameraVector` を `Transform(World→Tangent)` した結果 |
  | `Depth` | Float | スカラーパラメータ（凹凸の深さ。0.02〜0.2 程度） |

> 補足：`ConeMap` は **Texture Object**（Texture Sample ノードではなく「Texture Object」ノード）を渡します。
> Custom ノード内ではサンプラーが自動で `ConeMapSampler` という名前になります。

### 4-2. コード

```hlsl
// ===== Relaxed Cone Stepping Relief Mapping =====
// テクスチャ: R = 高さ, G = コーン比率 (このツールの出力)
// 戻り値: 視差補正後の UV (float2)

// --- 探索回数（必要に応じて調整）---
const int CONE_STEPS = 32;   // コーンステッピングの最大反復
const int BIN_STEPS  = 8;    // 交点精密化の二分探索回数

// ViewTS: タンジェント空間でのカメラ方向（ピクセル→カメラ）。z>0 が表面の外側。
float3 v = ViewTS;
// 表面のほぼ真横を見ているときの破綻を防ぐ
float vz = (abs(v.z) < 1e-3) ? 1e-3 : v.z;

// 深さ 1 単位あたりの UV 移動量。dir.z = 1 になるよう正規化済み。
float2 dirXY = (v.xy / vz) * Depth;
float  rr    = length(dirXY);            // 水平方向の進み具合

// レイ位置 p = (u, v, depth)。depth は 0(天面) → 1(底) へ進む。
float3 p = float3(UV, 0.0);

// --- relaxed cone stepping ---
[loop]
for (int i = 0; i < CONE_STEPS; i++)
{
    float h_here = Texture2DSample(ConeMap, ConeMapSampler, p.xy).r; // 高さ
    float d = 1.0 - h_here;                                          // 深さ
    float gap = d - p.z;                                             // 表面までの残り
    if (gap <= 0.001) break;

    float c = max(Texture2DSample(ConeMap, ConeMapSampler, p.xy).g, 0.002); // コーン比率
    // 円錐が当たる手前まで一気に進む（GPU Gems 3 Ch.18）
    p += float3(dirXY, 1.0) * (c * gap / (rr + c));
    if (p.z >= 1.0) break;
}
if (p.z > 1.0) p += float3(dirXY, 1.0) * (1.0 - p.z);

// --- 二分探索で交点を精密化（relaxed cone は区間内の交差が高々1回）---
float lo = 0.0;
float hi = p.z;
[unroll]
for (int j = 0; j < BIN_STEPS; j++)
{
    float mid = 0.5 * (lo + hi);
    float2 q = UV + dirXY * mid;
    float dq = 1.0 - Texture2DSample(ConeMap, ConeMapSampler, q).r;
    if (mid < dq) lo = mid; else hi = mid;
}

return UV + dirXY * hi;   // 補正後の UV
```

このノードの出力（float2）を、アルベド・法線・各種マップの Texture Sample の **UV 入力**につなぎます。

---

## 5. 入力の作り方（ノードの繋ぎ方）

### `ViewTS`（タンジェント空間のカメラ方向）
1. **CameraVector** ノードを置く（ピクセル→カメラのワールド方向）。
2. **Transform** ノードを置き、詳細で `Source = World Space` / `Destination = Tangent Space`。
3. CameraVector → Transform → Custom の `ViewTS` へ。

> UE の `CameraVector` は「カメラへ向かう」向きなので、上の HLSL の符号と一致します。
> もし凹凸が**逆向き（裏返し）**に見えたら、`ViewTS` の前に `Multiply (-1)` を挟むか、
> HLSL の `v.xy / vz` を `-v.xy / vz` に変えてください（環境依存の符号差吸収用）。

### `UV`
- **TexCoord[0]** をそのまま。タイリングしたい場合は `Multiply` でスケールしてから入れる。

### `Depth`
- **ScalarParameter**（名前例 `ParallaxDepth`、既定 0.08）。値が大きいほど凹凸が深く・視差が強くなる。

---

## 6. 法線（陰影を出す）

補正 UV から、高さ R の**中央差分**で法線を作ります。専用の Custom ノードを 1 つ足すのが簡単です。

- Output Type: `CMOT Float3`
- Inputs: `ConeMap`(Texture Object), `UV`(Float2 ← 上の補正UV), `Depth`(Float), `TexelSize`(Float2 ← `1 / テクスチャ解像度`)

```hlsl
// 高さ R の中央差分からタンジェント空間法線を作る
float2 e = TexelSize;
float hL = Texture2DSample(ConeMap, ConeMapSampler, UV - float2(e.x, 0)).r;
float hR = Texture2DSample(ConeMap, ConeMapSampler, UV + float2(e.x, 0)).r;
float hD = Texture2DSample(ConeMap, ConeMapSampler, UV - float2(0, e.y)).r;
float hU = Texture2DSample(ConeMap, ConeMapSampler, UV + float2(0, e.y)).r;

// 高さの傾きを Depth でスケール（UV 1px あたりの高さ変化 → 勾配）
float dx = (hR - hL) / (2.0 * e.x) * Depth;
float dy = (hU - hD) / (2.0 * e.y) * Depth;

float3 N = normalize(float3(-dx, -dy, 1.0));
return N;   // タンジェント空間法線（そのまま Normal へ）
```

- `TexelSize` は `1 / TextureProperty(SizeX, SizeY)` か、`Constant2Vector` に手入力（例 1024 解像度なら `(0.000976,0.000976)`）。
- この Custom 出力を **Normal** につなぐ（マテリアルは Tangent Space Normal のままでOK）。
- 反転して見える場合は `dx`,`dy` の符号を反転。

これで Unreal 標準のライトによる陰影・スペキュラが凹凸に沿って出ます。
（GLSL ビューワが内部でやっている影レイマーチや AO までは標準ライティングに任せ、ここでは省略しています。必要なら影マーチも Custom 化できます。）

---

## 7. パラメータと調整の目安

| パラメータ | 役割 | 目安 |
|-----------|------|------|
| `Depth` | 凹凸の深さ・視差の強さ | 0.02（浅い）〜 0.2（深い）。強すぎると縁が伸びる。 |
| `CONE_STEPS` | コーンステッピング反復 | 24〜48。多いほど正確だが重い。 |
| `BIN_STEPS` | 交点精密化 | 6〜10 で十分。 |

---

## 8. うまくいかないときのチェックリスト

- **真っ平ら／模様だけで凹凸が出ない** → コーンマップの sRGB が ON のまま、または Compression が DXT。**sRGB OFF + VectorDisplacementmap** を確認。
- **凹凸が裏返し（へこむ↔出っぱる）** → `ViewTS` を `*-1`、または法線の `dx/dy` 符号を反転。
- **斜めから見るとUVが大きくズレて崩れる** → `Depth` を下げる。`v.z` のクランプが効いているか確認。
- **タイル境界で段差** → コーンマップを `NoMipmaps` で再インポート、またはテクスチャの Wrap/Clamp を元画像と揃える。
- **チラつき** → `[loop]` のままで可。`CONE_STEPS` を増やす。

---

## 9. 仕組みの要約（なぜコーン比率を使うのか）

通常のレリーフマッピングは視線レイを小刻みに進めて高さ場との交点を探しますが、固定ステップだと
「遠くは飛ばしすぎ／近くは無駄に細かい」状態になります。

Relaxed Cone Stepping では、各テクセルにあらかじめ「**そこから視線方向にどれだけ進んでも安全か**」を表す
円錐（コーン）の開き具合（= このツールの **G チャンネル**）を焼き込んでおき、
`p += dir * (c * gap / (rr + c))` で**一気に安全な距離だけジャンプ**します。
これにより少ない反復回数で正確な交点に到達でき、軽量かつ破綻の少ない疑似立体になります。
（出典：GPU Gems 3, Chapter 18 "Relaxed Cone Stepping for Relief Mapping"）
