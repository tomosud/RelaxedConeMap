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
  if(srcImage && srcImage.kind === "floatHeight"){
    const src = srcImage.data;
    const sw = srcImage.width;
    const sh = srcImage.height;
    const inv = $("chkInvert").checked;
    const heightData = new Float32Array(n * n);
    const im = ctx.createImageData(n, n);
    const d = im.data;
    let maxH = 0;

    for(let y = 0; y < n; y++){
      const sy = n > 1 ? y * (sh - 1) / (n - 1) : 0;
      const y0 = Math.floor(sy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const ty = sy - y0;
      for(let x = 0; x < n; x++){
        const sx = n > 1 ? x * (sw - 1) / (n - 1) : 0;
        const x0 = Math.floor(sx);
        const x1 = Math.min(sw - 1, x0 + 1);
        const tx = sx - x0;
        const a = src[y0 * sw + x0];
        const b = src[y0 * sw + x1];
        const cc = src[y1 * sw + x0];
        const dd = src[y1 * sw + x1];
        let v = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty;
        if(inv) v = 1 - v;
        v = Math.max(0, Math.min(1, v));
        if(v > maxH) maxH = v;
        heightData[y * n + x] = v;
        const byte = Math.round(v * 255);
        const i = (y * n + x) * 4;
        d[i] = d[i+1] = d[i+2] = byte;
        d[i+3] = 255;
      }
    }

    ctx.putImageData(im, 0, 0);
    processed = { canvas: c, heightData, maxH, n };
    const tcv = $("thumb");
    const tc = tcv.getContext("2d");
    tc.imageSmoothingEnabled = true;
    tc.clearRect(0, 0, tcv.width, tcv.height);
    tc.drawImage(c, 0, 0, tcv.width, tcv.height);
    return;
  }
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
  generator.setHeight(processed, processed.maxH, $("chkWrap").checked);
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
    ? `Canceled (${generator.elapsed.toFixed(1)} sec)`
    : `Done (${generator.elapsed.toFixed(1)} sec)`;
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
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<title>Unreal Material Text</title>" +
    "<style>body{margin:0;background:#15171c;color:#e2e6ee;font-family:system-ui,sans-serif}" +
    "header{position:sticky;top:0;background:#1d2027;padding:12px 16px;border-bottom:1px solid #2a2e36;display:flex;gap:12px;align-items:center;flex-wrap:wrap}" +
    "h1{font-size:14px;margin:0;font-weight:600}" +
    "p{margin:0;font-size:12px;color:#9aa3b2}" +
    "button{font-size:13px;padding:7px 12px;border-radius:6px;border:1px solid #465066;background:#2d5ba9;color:#fff;cursor:pointer}" +
    "button:hover{background:#356ac4}" +
    "textarea{display:block;width:100%;height:calc(100vh - 70px);box-sizing:border-box;border:0;padding:14px 16px;" +
    "background:#15171c;color:#cdd3dd;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;resize:none;white-space:pre;overflow:auto}" +
    "</style></head><body>" +
    "<header><h1>Unreal Material Text</h1>" +
    "<button id=\"sel\">Select All and Copy</button>" +
    "<p>Paste the text below into Unreal's Material Editor with Ctrl+V.</p></header>" +
    "<textarea id=\"ta\" readonly spellcheck=\"false\"></textarea>" +
    "<script>var ta=document.getElementById('ta');" +
    "ta.value=" + json + ";" +
    "document.getElementById('sel').onclick=function(){ta.focus();ta.select();" +
    "try{document.execCommand('copy');this.textContent='Copied';}catch(e){this.textContent='Copy Manually';}};" +
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
      throw new Error("material.txt is empty. Please check the file contents.");
    }
    const opened = openMaterialPage(text);
    if(!opened) throw new Error("The popup was blocked. Please allow popups and try again.");
    $("status").textContent = "Opened the Unreal material text on a separate page. Select all and copy it.";
  } catch(err) {
    btn.textContent = "Failed to Open";
    $("status").textContent = "Failed to open the Unreal material text: " + (err.message || String(err));
    setTimeout(() => { btn.textContent = "Open Unreal Material Text"; }, 2500);
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
    dropZone: "Load a height map image. Brighter pixels are treated as higher terrain and darker pixels as lower terrain.",
    btnCamera: "Take a photo with your phone camera, then generate depth and a cone map from it.",
    btnPhoto: "Choose a photo from this device, then generate depth and a cone map from it.",
    btnSample: "Create a sample height map and immediately start cone map generation.",
    btnHeight: "Choose and load a height map image. Brighter pixels are treated as higher terrain and darker pixels as lower terrain.",
    selSize: "The output cone map PNG resolution. Larger values add detail, generation time, and memory use.",
    selChannel: "Choose which input image channel is used as height. Luminance is usually best; use R/G/B/A for dedicated source maps.",
    chkInvert: "Invert the height values. Enable this when black is high and white is low.",
    chkWrap: "Connect opposite image edges for repeatable tiling. Enable for tile materials, or disable for one-off images.",
    rngRadius: "How many pixels around each source pixel to inspect when generating the cone map. Larger values account for farther occluders but take longer.",
    rngSteps: "How many samples to use along each test ray during cone map generation. Higher values improve cone ratio accuracy but take longer.",
    btnGen: "Regenerate the Relaxed Cone Step Mapping cone map on the GPU using the current input and settings.",
    btnSave: "Save the generated PNG. R stores height and G stores cone ratio.",
    selMode: "Switch the preview between relief display, source height, cone ratio, and raymarch iteration count.",
    rngDepth: "Controls how deep the height appears in the preview. Higher values make the relief stronger but can show artifacts sooner.",
    rngTile: "How many times to repeat the height map across the preview surface. Use this to inspect tile seams and repeated patterns.",
    rngConeSteps: "Maximum Relaxed Cone Stepping iterations for the preview. Too few can stop intersection search early; more is heavier. Iteration colors saturate at 32.",
    chkShadow: "Adds simple self-shadowing to the preview. It makes the shape easier to read with a small rendering cost.",
    chkSpecular: "Shows light-driven specular highlights. Disable when you want to prioritize checking the source color.",
    chkAutoLight: "Automatically rotates the light azimuth to inspect relief and shadow changes continuously.",
    btnTilt: "Move the preview viewpoint using the phone tilt sensor. iOS Safari requires permission after tapping.",
    chkNoShading: "Shows surface color without lighting. Enable when you want to inspect the original image color.",
    rngLightAz: "Horizontal light angle. Adjusts whether shadows and highlights come from the left or right.",
    rngLightEl: "Light elevation. Lower values produce longer shadows; higher values look more front-lit."
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
    const text = "Legend for the raymarch iteration heat map. Colors show absolute counts from 0 to 32; 32 or more uses the maximum color.";
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
  img.onerror = () => { URL.revokeObjectURL(url); $("status").textContent = "Could not load the image."; };
  img.src = url;
}

async function loadDepthFile(file){
  if(!file || !file.type.startsWith("image/")) return;
  if(!depthEngine){
    $("status").textContent = "Could not initialize the depth estimation engine.";
    return;
  }
  hideSampleButton();
  if(generator.busy) generator.abort();
  const reader = new FileReader();
  reader.onerror = () => $("status").textContent = "Could not load the image.";
  reader.onload = async e => {
    try {
      $("btnCamera").disabled = true;
      $("btnPhoto").disabled = true;
      $("btnGen").disabled = true;
      $("btnSave").disabled = true;
      $("status").textContent = "Loading depth estimation model...";
      await depthEngine.initModel();
      $("status").textContent = "Estimating depth from image...";
      const result = await depthEngine.estimate(e.target.result);
      srcImage = {
        kind: "floatHeight",
        data: result.depth.heightData,
        width: result.depth.width,
        height: result.depth.height
      };
      colorImage = imageDataToCanvas(result.original.imageData, result.original.width, result.original.height);
      startGenerate();
    } catch(err) {
      $("status").textContent = "Depth estimation failed: " + (err.message || String(err));
      const ms = $("mStartStatus");
      if(ms) ms.textContent = "Failed: " + (err.message || String(err));
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
  $("mStartStatus").textContent = "Estimating depth...";
  $("cameraInput").click();
});
if(mStartPhoto) mStartPhoto.addEventListener("click", () => {
  enableTiltDefault();
  $("mStartStatus").textContent = "Estimating depth...";
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
      $("status").textContent = "Current orientation set as the center.";
      return;
    }
    await viewer.enableTilt();
    $("btnTilt").textContent = "Recenter Tilt Control";
    $("status").textContent = "Tilt control enabled.";
  } catch(err) {
    $("status").textContent = err.message || String(err);
  }
});
for(const id of ["selSize", "selChannel", "chkInvert"]){
  $(id).addEventListener("change", () => {
    if(srcImage && !generator.busy){
      processSource();
      $("status").textContent = "Settings changed. Click Generate to recalculate.";
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
      `Generating... ${(generator.progress * 100).toFixed(0)}% (${el.toFixed(1)} sec)`;
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
