"use strict";
// プレビュー描画 (オービットカメラ + relaxed cone stepping シェーダー)

function m4Persp(fovy, aspect, near, far){
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0]);
}

function m4LookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz){
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  const zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  const xl = Math.hypot(xx, xy, xz); xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * ex + xy * ey + xz * ez),
    -(yx * ex + yy * ey + yz * ez),
    -(zx * ex + zy * ey + zz * ez), 1]);
}

function m4Mul(a, b){
  const o = new Float32Array(16);
  for(let c = 0; c < 4; c++)
    for(let r = 0; r < 4; r++)
      o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
  return o;
}

class Viewer {
  constructor(gl, canvas){
    this.gl = gl;
    this.canvas = canvas;
    this.prog = glProgram(gl, SHADERS.viewVS, SHADERS.viewFS);
    const u = n => gl.getUniformLocation(this.prog, n);
    this.u = {
      vp: u("uVP"), height: u("uHeight"), cone: u("uCone"), color: u("uColor"), cam: u("uCam"),
      light: u("uLight"), depth: u("uDepth"), tile: u("uTile"), planeScale: u("uPlaneScale"),
      coneSteps: u("uConeSteps"), shadow: u("uShadow"), useColor: u("uUseColor"),
      specular: u("uSpecular"), shading: u("uShading"), mode: u("uMode"),
    };
    this.smp = makeSampler(gl, gl.REPEAT, gl.LINEAR);
    this.coneSmp = makeSampler(gl, gl.REPEAT, gl.NEAREST);
    this.colorTex = null;
    this.hasColor = false;
    this.planeScale = [1, 1];
    this.yaw = 0.6;
    this.pitch = 0.95;
    this.dist = 2.6;
    this._bindInput();
  }

  setColorSource(canvas, aspect = 1){
    const gl = this.gl;
    this.hasColor = !!canvas;
    if(!canvas){
      this.planeScale = [1, 1];
      return;
    }
    aspect = Math.max(1e-4, aspect || 1);
    this.planeScale = aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
    if(!this.colorTex) this.colorTex = makeTex(gl, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _bindInput(){
    const cv = this.canvas;
    let drag = false, lx = 0, ly = 0;
    cv.addEventListener("pointerdown", e => {
      drag = true; lx = e.clientX; ly = e.clientY;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", e => {
      if(!drag) return;
      this.yaw -= (e.clientX - lx) * 0.008;
      this.pitch += (e.clientY - ly) * 0.008;
      this.pitch = Math.min(1.45, Math.max(0.15, this.pitch));
      lx = e.clientX; ly = e.clientY;
    });
    cv.addEventListener("pointerup", () => drag = false);
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      this.dist *= Math.exp(e.deltaY * 0.001);
      this.dist = Math.min(8, Math.max(0.6, this.dist));
    }, { passive: false });
  }

  render(heightTex, coneTex, P){
    const gl = this.gl, cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(cv.clientWidth * dpr));
    const h = Math.max(1, Math.floor(cv.clientHeight * dpr));
    if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.07, 0.075, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if(!heightTex || !coneTex) return;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const ex = this.dist * cp * Math.sin(this.yaw);
    const ey = this.dist * sp;
    const ez = this.dist * cp * Math.cos(this.yaw);
    const vp = m4Mul(
      m4Persp(45 * Math.PI / 180, w / h, 0.05, 50),
      m4LookAt(ex, ey, ez, 0, 0, 0, 0, 1, 0));
    const az = P.lightAz * Math.PI / 180, el = P.lightEl * Math.PI / 180;

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.vp, false, vp);
    gl.uniform3f(this.u.cam, ex, ey, ez);
    gl.uniform3f(this.u.light,
      Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    gl.uniform1f(this.u.depth, P.depth);
    gl.uniform1f(this.u.tile, P.tile);
    gl.uniform2f(this.u.planeScale, this.planeScale[0], this.planeScale[1]);
    gl.uniform1i(this.u.coneSteps, P.coneSteps);
    gl.uniform1i(this.u.shadow, P.shadow ? 1 : 0);
    gl.uniform1i(this.u.useColor, this.hasColor ? 1 : 0);
    gl.uniform1i(this.u.specular, P.specular ? 1 : 0);
    gl.uniform1i(this.u.shading, P.shading ? 1 : 0);
    gl.uniform1i(this.u.mode, P.mode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.bindSampler(0, this.smp);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, coneTex);
    gl.bindSampler(1, this.coneSmp);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex || heightTex);
    gl.bindSampler(2, this.smp);
    gl.uniform1i(this.u.height, 0);
    gl.uniform1i(this.u.cone, 1);
    gl.uniform1i(this.u.color, 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
