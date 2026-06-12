"use strict";
// WebGL2 小物ヘルパー

function glCompile(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error("shader compile error:\n" + gl.getShaderInfoLog(s));
  return s;
}

function glProgram(gl, vsSrc, fsSrc){
  const p = gl.createProgram();
  gl.attachShader(p, glCompile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, glCompile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error("program link error:\n" + gl.getProgramInfoLog(p));
  return p;
}

function makeTex(gl, w, h){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}

function makeFBO(gl, tex){
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}

function makeSampler(gl, wrap, filter){
  const s = gl.createSampler();
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter);
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap);
  return s;
}
