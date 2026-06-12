"use strict";
// 全シェーダーソース (WebGL2 / GLSL ES 3.00)
const SHADERS = {

// フルスクリーントライアングル
fsqVS: `#version 300 es
const vec2 q[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main(){ gl_Position = vec4(q[gl_VertexID], 0.0, 1.0); }
`,

// Relaxed Cone Map 生成パス (GPU Gems 3 Ch.18 の前処理をバッチ化したもの)
// 1ドローで uOffsets の一部 (最大128個) のオフセット先テクセルを処理し、
// 前パスまでの最小コーン比率 (uPrev) と min を取って書き出す。
genFS: `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uHeight;   // R = 高さ
uniform sampler2D uPrev;     // R = これまでの最小コーン比率
uniform vec2  uInvSize;
uniform ivec2 uOffsets[128]; // 距離昇順ソート済み
uniform int   uCount;
uniform int   uSteps;
uniform float uMinDepth;     // マップ全体の最小デプス (= 1 - 最大高さ)
out vec4 outColor;

float depthAt(vec2 uv){ return 1.0 - texture(uHeight, uv).r; }

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(px) + 0.5) * uInvSize;
  float srcDepth = depthAt(uv);
  float best = texelFetch(uPrev, px, 0).r;
  float denom = max(srcDepth - uMinDepth, 1e-4);

  for(int i = 0; i < 128; i++){
    if(i >= uCount) break;
    vec2 off = vec2(uOffsets[i]) * uInvSize;
    float distUV = length(off);
    // この距離から得られる比率の下限が best 以上なら、
    // 以降のオフセットは全てより遠い (ソート済み) ので打ち切り
    if(distUV >= best * denom) break;

    vec2 dstUV = uv + off;
    float dstDepth = depthAt(dstUV);

    // ソース表面 (uv, 0) から (dstUV, dstDepth) を貫くレイを、
    // ハイトフィールドの外に出るまで前進探索する
    vec3 v = vec3(off, max(dstDepth, 1e-4));
    v /= v.z;
    v *= 1.0 - dstDepth;
    vec3 stepF = v / float(uSteps);
    vec3 ray = vec3(dstUV, dstDepth) + stepF;
    for(int s = 1; s < 64; s++){
      if(s >= uSteps) break;
      float d = depthAt(ray.xy);
      if(d <= ray.z) ray += stepF;   // まだ表面の内側なら前進
    }
    float ratio = (ray.z >= srcDepth) ? 1.0
                : length(ray.xy - uv) / (srcDepth - ray.z);
    best = min(best, ratio);
  }
  outColor = vec4(best, best, best, 1.0);
}
`,

// 出力合成: R = 高さ, G = コーン比率
compFS: `#version 300 es
precision highp float;
uniform sampler2D uHeight;
uniform sampler2D uCone;
out vec4 outColor;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uHeight, p, 0).r;
  float c = texelFetch(uCone, p, 0).r;
  outColor = vec4(h, c, 0.0, 1.0);
}
`,

// プレビュー: XZ 平面のクワッド
viewVS: `#version 300 es
const vec2 q[4] = vec2[4](vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0), vec2(1.0,1.0));
uniform mat4 uVP;
out vec3 vWorld;
out vec2 vUV;
void main(){
  vec2 p = q[gl_VertexID];
  vWorld = vec3(p.x, 0.0, p.y);
  vUV = vec2(p.x, -p.y) * 0.5 + 0.5;
  gl_Position = uVP * vec4(vWorld, 1.0);
}
`,

// プレビュー: Relaxed Cone Stepping によるレリーフマッピング
viewFS: `#version 300 es
precision highp float;
uniform sampler2D uHeight;  // R = 高さ
uniform sampler2D uCone;    // R = コーン比率
uniform vec3  uCam;
uniform vec3  uLight;       // 表面→ライト方向 (ワールド, 正規化済み)
uniform float uDepth;       // 深さスケール (ワールド単位)
uniform float uTile;
uniform int   uConeSteps;
uniform bool  uShadow;
uniform int   uMode;        // 0:レリーフ 1:高さ 2:コーン
in vec3 vWorld;
in vec2 vUV;
out vec4 outColor;

float hAt(vec2 uv){ return texture(uHeight, uv).r; }
float dAt(vec2 uv){ return 1.0 - texture(uHeight, uv).r; }
float cAt(vec2 uv){ return max(texture(uCone, uv).r, 0.002); }

void main(){
  vec2 uv0 = vUV * uTile;
  if(uMode == 1){ outColor = vec4(vec3(hAt(uv0)), 1.0); return; }
  if(uMode == 2){ outColor = vec4(vec3(texture(uCone, uv0).r), 1.0); return; }

  vec3 wdir = normalize(vWorld - uCam);
  float ds = max(uDepth, 1e-4);
  // テクスチャ空間 (u, v, depth) でのレイ方向
  vec3 dir = vec3(wdir.x * 0.5 * uTile, wdir.z * 0.5 * uTile, -wdir.y / ds);
  if(dir.z < 1e-5){ outColor = vec4(0.0); return; }
  dir /= dir.z;                       // dir.z = 1 (深さ単位で前進)
  float rr = length(dir.xy);

  // --- relaxed cone stepping ---
  vec3 p = vec3(uv0, 0.0);
  for(int i = 0; i < 48; i++){
    if(i >= uConeSteps) break;
    float d = dAt(p.xy);
    float c = cAt(p.xy);
    float h = max(d - p.z, 0.0);
    p += dir * (c * h / (rr + c));
  }
  if(p.z > 1.0) p += dir * (1.0 - p.z);

  // --- 二分探索による交点精密化 (relaxed cone は区間内の交差が高々1回) ---
  float lo = 0.0, hi = p.z;
  for(int i = 0; i < 8; i++){
    float mid = 0.5 * (lo + hi);
    vec3 q = vec3(uv0, 0.0) + dir * mid;
    if(q.z < dAt(q.xy)) lo = mid; else hi = mid;
  }
  p = vec3(uv0, 0.0) + dir * hi;

  // --- 法線 (中央差分) ---
  vec2 e = 1.0 / vec2(textureSize(uHeight, 0));
  float hx = hAt(p.xy + vec2(e.x, 0.0)) - hAt(p.xy - vec2(e.x, 0.0));
  float hz = hAt(p.xy + vec2(0.0, e.y)) - hAt(p.xy - vec2(0.0, e.y));
  float kx = (hx * ds) / (2.0 * e.x * (2.0 / uTile));
  float kz = (hz * ds) / (2.0 * e.y * (2.0 / uTile));
  vec3 N = normalize(vec3(-kx, 1.0, -kz));

  // --- ライティング ---
  vec3 L = normalize(uLight);
  float diff = max(dot(N, L), 0.0);
  float lit = 1.0;
  if(uShadow && diff > 0.0 && L.y > 0.05){
    vec3 ld = vec3(L.x * 0.5 * uTile, L.z * 0.5 * uTile, -L.y / ds);
    ld /= -ld.z;                      // ld.z = -1 (上方向へ)
    float t0 = p.z;
    for(int i = 1; i <= 24; i++){
      float ft = t0 * (float(i) / 25.0);
      vec3 q = p + ld * ft;
      if(dAt(q.xy) < q.z - 0.01){ lit = 0.25; break; }
    }
  }
  float h = hAt(p.xy);
  vec3 albedo = mix(vec3(0.30, 0.27, 0.25), vec3(0.85, 0.82, 0.78), h);
  float ao = mix(0.45, 1.0, h);
  vec3 V = -wdir;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.35;
  vec3 col = albedo * (0.20 * ao + 0.95 * diff * lit) + vec3(spec) * lit * step(0.001, diff);
  col = pow(col, vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`,
};
