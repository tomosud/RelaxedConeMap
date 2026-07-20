"use strict";

// EGSR 2024 "Robust Cone Step Mapping" preprocessing shaders.
// Kept separate from the legacy GPU Gems 3 approximation on purpose.
const ROBUST_SHADERS = {
  generateFS: `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uHeight;
uniform sampler2D uPrev;
uniform ivec4 uCells[128]; // relative corner xy, outward direction xy
uniform int uCount;
uniform int uSize;
uniform bool uWrap;
out vec4 outColor;

int wrapIndex(int x){ int r = x % uSize; return r < 0 ? r + uSize : r; }

float loadHeight(ivec2 p){
  if(uWrap) p = ivec2(wrapIndex(p.x), wrapIndex(p.y));
  else p = clamp(p, ivec2(0), ivec2(uSize - 1));
  return texelFetch(uHeight, p, 0).r;
}

void main(){
  ivec2 baseIJ = ivec2(gl_FragCoord.xy);
  float baseH = loadHeight(baseIJ);
  float best = texelFetch(uPrev, baseIJ, 0).r;
  float invSize = 1.0 / float(uSize);

  for(int q = 0; q < 128; ++q){
    if(q >= uCount) break;
    ivec4 c = uCells[q];
    ivec2 dstIJ = baseIJ + c.xy;
    ivec2 dir = c.zw;

    if(!uWrap){
      ivec2 farIJ = dstIJ + dir;
      if(any(lessThan(dstIJ, ivec2(0))) || any(greaterThanEqual(dstIJ, ivec2(uSize))) ||
         any(lessThan(farIJ, ivec2(0))) || any(greaterThanEqual(farIJ, ivec2(uSize)))) continue;
    }

    float dist = length(vec2(c.xy)) * invSize;
    if(dist >= best * (1.0 - baseH)) continue;

    float h00 = loadHeight(dstIJ);
    float deltaH = h00 - baseH;
    if(deltaH <= 0.0 || dist >= best * deltaH) continue;

    float h10 = loadHeight(dstIJ + ivec2(dir.x, 0));
    float h01 = loadHeight(dstIJ + ivec2(0, dir.y));
    float h11 = loadHeight(dstIJ + dir);
    bool limiting = h00 > h10 || h00 > h01 || h10 > h11 || h01 > h11;
    if(limiting) best = min(best, dist / deltaH);
  }
  outColor = vec4(best, best, best, 1.0);
}
`,

  correctFS: `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uHeight;
uniform sampler2D uCone;
uniform int uSize;
uniform bool uWrap;
out vec4 outColor;
int wrapIndex(int x){ int r = x % uSize; return r < 0 ? r + uSize : r; }
float coneAt(ivec2 p){
  if(uWrap) p = ivec2(wrapIndex(p.x), wrapIndex(p.y));
  else p = clamp(p, ivec2(0), ivec2(uSize - 1));
  return texelFetch(uCone, p, 0).r;
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = 1.0;
  for(int y = -1; y <= 1; ++y)
    for(int x = -1; x <= 1; ++x) c = min(c, coneAt(p + ivec2(x, y)));
  outColor = vec4(c, c, c, 1.0);
}
`,

  exportFS: `#version 300 es
precision highp float;
uniform sampler2D uHeight;
uniform sampler2D uCone;
out vec4 outColor;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uHeight, p, 0).r;
  float c = texelFetch(uCone, p, 0).r;
  c = floor(clamp(c, 0.0, 1.0) * 255.0) / 255.0;
  outColor = vec4(h, c, 0.0, 1.0);
}
`,
};
