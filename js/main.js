"use strict";
(function(){
const $ = id => document.getElementById(id);
const canvas = $("glcanvas");
const gl = canvas.getContext("webgl2", { antialias: true });
if(!gl){ $("glError").hidden = false; return; }

const generator = new ConeMapGenerator(gl);
const viewer = new Viewer(gl, canvas);

let srcImage = null;   // Image または canvas
let processed = null;  // { canvas, maxH, n }
let autoLightT = 0, lastT = performance.now();

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

function startGenerate(){
  if(!srcImage) srcImage = makeSampleHeight(512);
  processSource();
  generator.setHeight(processed.canvas, processed.maxH, $("chkWrap").checked);
  generator.start(+$("rngRadius").value, +$("rngSteps").value);
  genActive = true;
  $("btnGen").disabled = true;
  $("btnAbort").hidden = false;
  $("btnSave").disabled = true;
  $("prog").value = 0;
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

// ---------- UI ----------
function bindLabel(rngId, lblId){
  const r = $(rngId), l = $(lblId);
  const f = () => l.textContent = r.value;
  r.addEventListener("input", f); f();
}
bindLabel("rngRadius", "lblRadius");
bindLabel("rngSteps", "lblSteps");
bindLabel("rngDepth", "lblDepth");
bindLabel("rngTile", "lblTile");
bindLabel("rngConeSteps", "lblConeSteps");
bindLabel("rngLightAz", "lblLightAz");
bindLabel("rngLightEl", "lblLightEl");

function loadFile(file){
  if(!file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { srcImage = img; URL.revokeObjectURL(url); startGenerate(); };
  img.onerror = () => { URL.revokeObjectURL(url); $("status").textContent = "画像を読み込めませんでした"; };
  img.src = url;
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
$("btnSample").addEventListener("click", () => { srcImage = makeSampleHeight(512); startGenerate(); });
$("btnGen").addEventListener("click", startGenerate);
$("btnAbort").addEventListener("click", () => generator.abort());
$("btnSave").addEventListener("click", savePNG);
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
  viewer.render(generator.heightTex, generator.coneTex, {
    depth: +$("rngDepth").value,
    tile: +$("rngTile").value,
    coneSteps: +$("rngConeSteps").value,
    shadow: $("chkShadow").checked,
    mode: +$("selMode").value,
    lightAz: (+$("rngLightAz").value + autoLightT) % 360,
    lightEl: +$("rngLightEl").value,
  });
  requestAnimationFrame(frame);
}

// 初期表示: サンプル地形で自動生成
srcImage = makeSampleHeight(512);
startGenerate();
requestAnimationFrame(frame);
})();
