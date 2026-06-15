"use strict";
(function(){
const $ = id => document.getElementById(id);
const canvas = $("glcanvas");
const gl = canvas.getContext("webgl2", { antialias: true });
if(!gl){ $("glError").hidden = false; return; }

let generator, viewer;
try {
  generator = new ConeMapGenerator(gl);
  viewer = new Viewer(gl, canvas);
} catch(err) {
  const e = $("glError");
  e.textContent = err.message || String(err);
  e.hidden = false;
  throw err;
}

let srcImage = null;   // Image または canvas
let colorImage = null; // 深度推定プレビュー用の元画像カラー
let processed = null;  // { canvas, maxH, n }
const depthEngine = window.DepthEngine ? new DepthEngine() : null;
let autoLightT = 0, lastT = performance.now();

// スマホ (タッチ) モード判定
const isMobile = window.matchMedia("(max-width:700px)").matches;
if(isMobile) document.body.classList.add("mobile");

// 傾き検出をデフォルト有効化 (ユーザージェスチャ内で試みる)
async function enableTiltDefault(){
  if(viewer.tiltEnabled) return;
  try { await viewer.enableTilt(); } catch(_) { /* 不可ならドラッグ操作にフォールバック */ }
}

function enterMobileViewer(){
  if(!isMobile) return;
  document.body.classList.add("viewing");
  viewer.setFaceOn(true);
  enableTiltDefault();
}

// サンプルボタンは初回(ユーザー入力前)だけ表示する
function hideSampleButton(){
  const b = $("btnSample");
  if(b) b.hidden = true;
}

// ---------- サンプル地形 (タイラブル) ----------
function makeSampleHeight(n){
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  const im = ctx.createImageData(n, n);
  const hsh = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  function vnoise(x, y, p, seed){
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const a = hsh(x0 + seed, y0 + seed), b = hsh(x1 + seed, y0 + seed);
    const cc = hsh(x0 + seed, y1 + seed), d = hsh(x1 + seed, y1 + seed);
    return (a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v;
  }
  const wrapD = d => d - Math.round(d);
  const blobs = [
    [0.30, 0.30, 0.16, 0.95],
    [0.72, 0.45, 0.11, 0.80],
    [0.55, 0.78, 0.13, 1.00],
    [0.15, 0.70, 0.08, 0.70],
  ];
  for(let y = 0; y < n; y++){
    for(let x = 0; x < n; x++){
      const fx = x / n, fy = y / n;
      let sum = 0, amp = 0.5, p = 8;
      for(let o = 0; o < 4; o++){
        sum += amp * vnoise(fx * p, fy * p, p, o * 37);
        amp *= 0.5; p *= 2;
      }
      let v = sum * 0.55;
      for(const [bx, by, br, bh] of blobs){
        const dx = wrapD(fx - bx), dy = wrapD(fy - by);
        const r = Math.hypot(dx, dy);
        if(r < br){
          const t = r / br;
          v = Math.max(v, Math.sqrt(Math.max(0, 1 - t * t)) * bh);
        }
      }
      if(Math.abs(wrapD(fx - 0.05)) < 0.015) v = Math.max(v, 0.85); // 壁
      const b = Math.max(0, Math.min(255, Math.round(v * 255)));
      const i = (y * n + x) * 4;
      im.data[i] = im.data[i+1] = im.data[i+2] = b;
      im.data[i+3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

// ---------- 入力処理 ----------
function processSource(){
  const n = +$("selSize").value;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(srcImage, 0, 0, n, n);
  const im = ctx.getImageData(0, 0, n, n);
  const d = im.data;
  const ch = $("selChannel").value;
  const inv = $("chkInvert").checked;
  let maxH = 0;
  for(let i = 0; i < d.length; i += 4){
    let v;
    switch(ch){
      case "r": v = d[i]; break;
      case "g": v = d[i+1]; break;
      case "b": v = d[i+2]; break;
      case "a": v = d[i+3]; break;
      default:  v = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
    }
    v /= 255;
    if(inv) v = 1 - v;
    if(v > maxH) maxH = v;
    const b = Math.round(v * 255);
    d[i] = d[i+1] = d[i+2] = b;
    d[i+3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  processed = { canvas: c, maxH, n };
  const tcv = $("thumb");
  const tc = tcv.getContext("2d");
  tc.imageSmoothingEnabled = true;
  tc.clearRect(0, 0, tcv.width, tcv.height);
  tc.drawImage(c, 0, 0, tcv.width, tcv.height);
}

function imageDataToCanvas(imageData, width, height){
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").putImageData(imageData, 0, 0);
  return c;
}

function makeSquareCanvas(source, n){
  const c = document.createElement("canvas");
  c.width = c.height = n;
  c.getContext("2d").drawImage(source, 0, 0, n, n);
  return c;
}

function startGenerate(){
  if(!srcImage) srcImage = makeSampleHeight(512);
  processSource();
  generator.setHeight(processed.canvas, processed.maxH, $("chkWrap").checked);
  viewer.setColorSource(
    colorImage ? makeSquareCanvas(colorImage, processed.n) : null,
    colorImage ? colorImage.width / colorImage.height : 1);
  generator.start(+$("rngRadius").value, +$("rngSteps").value);
  genActive = true;
  $("btnGen").disabled = true;
  $("btnAbort").hidden = false;
  $("btnSave").disabled = true;
  $("prog").value = 0;
  enterMobileViewer();
}

function finishUI(aborted){
  $("btnGen").disabled = false;
  $("btnAbort").hidden = true;
  $("btnSave").disabled = false;
  $("prog").value = aborted ? generator.progress : 1;
  $("status").textContent = aborted
    ? `中止しました (${generator.elapsed.toFixed(1)} 秒)`
    : `完了 (${generator.elapsed.toFixed(1)} 秒)`;
}

// ---------- PNG 保存 ----------
function savePNG(){
  const { data, n } = generator.exportPixels();
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  const im = ctx.createImageData(n, n);
  const row = n * 4;
  for(let y = 0; y < n; y++)  // GLの読み出しは上下逆なので反転
    im.data.set(data.subarray((n - 1 - y) * row, (n - y) * row), y * row);
  ctx.putImageData(im, 0, 0);
  c.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `conemap_${n}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
}

// ---------- Unreal マテリアルを別ページで表示 ----------
let unrealMaterialText = null;
// 起動時に先読みしておく
fetch("unreal_material/material.txt")
  .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
  .then(t => { unrealMaterialText = t; })
  .catch(() => { /* クリック時に再取得を試みる */ });

function openMaterialPage(text){
  const json = JSON.stringify(text)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const html =
    "<!DOCTYPE html><html lang=\"ja\"><head><meta charset=\"utf-8\">" +
    "<title>Unreal マテリアル テキスト</title>" +
    "<style>body{margin:0;background:#15171c;color:#e2e6ee;font-family:system-ui,sans-serif}" +
    "header{position:sticky;top:0;background:#1d2027;padding:12px 16px;border-bottom:1px solid #2a2e36;display:flex;gap:12px;align-items:center;flex-wrap:wrap}" +
    "h1{font-size:14px;margin:0;font-weight:600}" +
    "p{margin:0;font-size:12px;color:#9aa3b2}" +
    "button{font-size:13px;padding:7px 12px;border-radius:6px;border:1px solid #465066;background:#2d5ba9;color:#fff;cursor:pointer}" +
    "button:hover{background:#356ac4}" +
    "textarea{display:block;width:100%;height:calc(100vh - 70px);box-sizing:border-box;border:0;padding:14px 16px;" +
    "background:#15171c;color:#cdd3dd;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;resize:none;white-space:pre;overflow:auto}" +
    "</style></head><body>" +
    "<header><h1>Unreal マテリアル テキスト</h1>" +
    "<button id=\"sel\">全選択してコピー</button>" +
    "<p>下のテキストを Unreal のマテリアルエディタに Ctrl+V で貼り付けてください。</p></header>" +
    "<textarea id=\"ta\" readonly spellcheck=\"false\"></textarea>" +
    "<script>var ta=document.getElementById('ta');" +
    "ta.value=" + json + ";" +
    "document.getElementById('sel').onclick=function(){ta.focus();ta.select();" +
    "try{document.execCommand('copy');this.textContent='コピーしました';}catch(e){this.textContent='手動でコピーしてください';}};" +
    "ta.focus();ta.select();<\/script>" +
    "</body></html>";
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if(!w){ URL.revokeObjectURL(url); return false; }
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

async function copyUnrealMaterial(){
  const btn = $("btnCopyMaterial");
  try {
    let text = unrealMaterialText;
    if(text == null){
      const res = await fetch("unreal_material/material.txt");
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      unrealMaterialText = text;
    }
    if(!text || !text.trim()){
      throw new Error("material.txt が空です。ファイルの内容を確認してください。");
    }
    const opened = openMaterialPage(text);
    if(!opened) throw new Error("ポップアップがブロックされました。ポップアップを許可してください。");
    $("status").textContent = "別ページに Unreal マテリアルのテキストを表示しました。全選択してコピーしてください。";
  } catch(err) {
    btn.textContent = "表示に失敗しました";
    $("status").textContent = "Unreal マテリアルの表示に失敗しました: " + (err.message || String(err));
    setTimeout(() => { btn.textContent = "Unreal マテリアルのテキストを開く"; }, 2500);
  }
}

// ---------- UI ----------
function bindLabel(rngId, lblId){
  const r = $(rngId), l = $(lblId);
  const f = () => l.textContent = r.value;
  r.addEventListener("input", f); f();
}

function updateHeatTicks(){
  $("heatTicks").innerHTML = [0, 8, 16, 24, 32]
    .map(v => `<span>${v}</span>`)
    .join("");
}

function bindTooltips(){
  const tips = {
    dropZone: "入力するハイトマップ画像を読み込みます。白に近いほど高く、黒に近いほど低い地形として扱います。",
    btnCamera: "iPhone やスマホのカメラで撮影し、その写真から深度とコーンマップを続けて生成します。",
    btnPhoto: "端末内の写真を選び、その写真から深度とコーンマップを続けて生成します。",
    btnSample: "動作確認用のサンプルハイトマップを生成し、そのままコーンマップ生成を開始します。",
    btnHeight: "ハイトマップ画像を選んで読み込みます。白に近いほど高く、黒に近いほど低い地形として扱います。",
    selSize: "生成するコーンマップ PNG の一辺の解像度です。大きいほど細かくなりますが、生成時間とメモリ使用量が増えます。",
    selChannel: "入力画像のどのチャンネルを高さとして使うかを選びます。通常は輝度で、専用画像なら R/G/B/A を指定します。",
    chkInvert: "高さを反転します。黒が高く白が低い画像を使う場合に ON にします。",
    chkWrap: "画像端をまたいで繰り返し接続します。タイル素材として使う場合は ON、単発画像なら OFF が向いています。",
    rngRadius: "コーンマップ生成時に、各ピクセルから周囲を何ピクセル先まで調べるかです。大きいほど遠くの遮蔽まで考慮しますが、生成が重くなります。",
    rngSteps: "コーンマップ生成時の検査レイを何分割してサンプルするかです。多いほどコーン比率の精度が上がりますが、生成時間が増えます。",
    btnGen: "現在の入力画像と設定で、Relaxed Cone Step Mapping 用のコーンマップを GPU で再生成します。",
    btnSave: "生成済みの PNG を保存します。R に高さ、G にコーン比率が入ります。",
    selMode: "プレビューの表示内容を切り替えます。レリーフ表示、元の高さ、コーン比率、レイマーチ回数の確認に使います。",
    rngDepth: "プレビュー上で高さをどれくらい深く見せるかです。大きいほど凹凸が強くなりますが、破綻も目立ちやすくなります。",
    rngTile: "プレビュー面に同じハイトマップを何回繰り返して貼るかです。タイル継ぎ目や繰り返しパターンの確認に使います。",
    rngConeSteps: "プレビュー描画時の Relaxed Cone Stepping の最大反復回数です。足りないと交点探索が途中で止まりやすく、多いほど重くなります。レイマーチ回数表示の色は 32 回で最大色に飽和します。",
    chkShadow: "プレビューに簡易セルフシャドウを追加します。形状の見え方は確認しやすくなりますが、描画負荷は少し増えます。",
    chkSpecular: "ライトによる光沢ハイライトを表示します。元画像カラーの確認を優先したい場合は OFF にします。",
    chkAutoLight: "ライトの方位角を自動で回転させます。凹凸や影の出方を連続的に確認したい時に使います。",
    btnTilt: "スマホの傾きセンサーでプレビューの視点を動かします。iOS Safari ではタップ後に許可が必要です。",
    chkNoShading: "ライトによる陰影を使わず、表面色をそのまま表示します。元画像のカラーを確認したいときに ON にします。",
    rngLightAz: "ライトの水平角度です。影やハイライトが左右どちらから入るかを調整します。",
    rngLightEl: "ライトの仰角です。低いほど影が長く、高いほど正面から照らした見た目になります。"
  };
  for(const [id, text] of Object.entries(tips)){
    const el = $(id);
    if(!el) continue;
    const target = el.closest("label") || el;
    target.classList.add("hasTip");
    target.dataset.tip = text;
  }
  const heatLegend = document.querySelector(".heatLegend");
  if(heatLegend){
    const text = "レイマーチ回数ヒートマップの凡例です。色は絶対回数で、0 回から 32 回までを表示し、32 回以上は最大色として扱います。";
    heatLegend.classList.add("hasTip");
    heatLegend.dataset.tip = text;
  }
}

bindLabel("rngRadius", "lblRadius");
bindLabel("rngSteps", "lblSteps");
bindLabel("rngDepth", "lblDepth");
bindLabel("rngTile", "lblTile");
bindLabel("rngConeSteps", "lblConeSteps");
bindLabel("rngLightAz", "lblLightAz");
bindLabel("rngLightEl", "lblLightEl");
updateHeatTicks();
bindTooltips();

function loadFile(file){
  if(!file || !file.type.startsWith("image/")) return;
  hideSampleButton();
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { srcImage = img; colorImage = null; URL.revokeObjectURL(url); startGenerate(); };
  img.onerror = () => { URL.revokeObjectURL(url); $("status").textContent = "画像を読み込めませんでした"; };
  img.src = url;
}

async function loadDepthFile(file){
  if(!file || !file.type.startsWith("image/")) return;
  if(!depthEngine){
    $("status").textContent = "深度推定エンジンを初期化できませんでした";
    return;
  }
  hideSampleButton();
  if(generator.busy) generator.abort();
  const reader = new FileReader();
  reader.onerror = () => $("status").textContent = "画像を読み込めませんでした";
  reader.onload = async e => {
    try {
      $("btnCamera").disabled = true;
      $("btnPhoto").disabled = true;
      $("btnGen").disabled = true;
      $("btnSave").disabled = true;
      $("status").textContent = "深度推定モデルを読み込み中...";
      await depthEngine.initModel();
      $("status").textContent = "画像から深度を推定中...";
      const result = await depthEngine.estimate(e.target.result);
      srcImage = imageDataToCanvas(result.depth.imageData, result.depth.width, result.depth.height);
      colorImage = imageDataToCanvas(result.original.imageData, result.original.width, result.original.height);
      startGenerate();
    } catch(err) {
      $("status").textContent = "深度推定に失敗しました: " + (err.message || String(err));
      const ms = $("mStartStatus");
      if(ms) ms.textContent = "失敗しました: " + (err.message || String(err));
      $("btnGen").disabled = false;
    } finally {
      $("btnCamera").disabled = false;
      $("btnPhoto").disabled = false;
    }
  };
  reader.readAsDataURL(file);
}

const dz = $("dropZone");
dz.addEventListener("click", () => $("fileInput").click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", e => {
  e.preventDefault();
  dz.classList.remove("over");
  loadFile(e.dataTransfer.files[0]);
});
$("fileInput").addEventListener("change", e => loadFile(e.target.files[0]));
$("cameraInput").addEventListener("change", e => loadDepthFile(e.target.files[0]));
$("depthFileInput").addEventListener("change", e => loadDepthFile(e.target.files[0]));
$("btnHeight").addEventListener("click", () => $("fileInput").click());
$("btnCamera").addEventListener("click", () => $("cameraInput").click());
$("btnPhoto").addEventListener("click", () => $("depthFileInput").click());

// スマホスタート画面のボタン
const mStartCamera = $("mStartCamera"), mStartPhoto = $("mStartPhoto");
if(mStartCamera) mStartCamera.addEventListener("click", () => {
  enableTiltDefault();
  $("mStartStatus").textContent = "深度を推定中…";
  $("cameraInput").click();
});
if(mStartPhoto) mStartPhoto.addEventListener("click", () => {
  enableTiltDefault();
  $("mStartStatus").textContent = "深度を推定中…";
  $("depthFileInput").click();
});

// スマホ下部の奥行きスライダー (パネルの rngDepth と同期)
const mRngDepth = $("mRngDepth");
if(mRngDepth) mRngDepth.addEventListener("input", () => {
  $("mLblDepth").textContent = mRngDepth.value;
  $("rngDepth").value = mRngDepth.value;
  $("lblDepth").textContent = mRngDepth.value;
});
$("btnSample").addEventListener("click", () => { srcImage = makeSampleHeight(512); colorImage = null; startGenerate(); });
$("btnGen").addEventListener("click", startGenerate);
$("btnAbort").addEventListener("click", () => generator.abort());
$("btnSave").addEventListener("click", savePNG);
$("btnCopyMaterial").addEventListener("click", copyUnrealMaterial);
$("btnTilt").addEventListener("click", async () => {
  try {
    if(viewer.tiltEnabled){
      viewer.resetTiltCenter();
      $("status").textContent = "現在の向きを基準にしました";
      return;
    }
    await viewer.enableTilt();
    $("btnTilt").textContent = "傾き操作を再センター";
    $("status").textContent = "傾き操作を有効化しました";
  } catch(err) {
    $("status").textContent = err.message || String(err);
  }
});
for(const id of ["selSize", "selChannel", "chkInvert"]){
  $(id).addEventListener("change", () => {
    if(srcImage && !generator.busy){
      processSource();
      $("status").textContent = "設定変更 → 「生成」で再計算してください";
    }
  });
}

// ---------- メインループ ----------
let genActive = false;
function frame(){
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  lastT = now;
  if(generator.busy){
    generator.runChunk(30);
    $("prog").value = generator.progress;
    const el = (now - generator.t0) / 1000;
    $("status").textContent =
      `生成中… ${(generator.progress * 100).toFixed(0)}% (${el.toFixed(1)} 秒)`;
  }
  if(genActive && !generator.busy){
    finishUI(generator.progress < 1);
    genActive = false;
  }

  if($("chkAutoLight").checked) autoLightT += dt * 20;
  const viewMode = +$("selMode").value;
  viewer.render(generator.heightTex, generator.coneTex, {
    depth: +$("rngDepth").value,
    tile: +$("rngTile").value,
    coneSteps: +$("rngConeSteps").value,
    shadow: isMobile ? false : $("chkShadow").checked,
    shading: isMobile ? false : !$("chkNoShading").checked,
    specular: isMobile ? false : $("chkSpecular").checked,
    mode: isMobile ? 0 : viewMode,
    lightAz: (+$("rngLightAz").value + autoLightT) % 360,
    lightEl: +$("rngLightEl").value,
  });
  requestAnimationFrame(frame);
}

// 初期表示: サンプル地形で自動生成 (スマホはスタート画面を表示)
if(!isMobile){
  srcImage = makeSampleHeight(512);
  startGenerate();
}
requestAnimationFrame(frame);
})();
