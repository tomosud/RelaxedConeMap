"use strict";
// Relaxed Cone Map の GPU 生成パイプライン。
// 全オフセット (探索半径内の全テクセル) を距離昇順にソートし、
// 128 個ずつのバッチに分けてフラグメントシェーダーで min 蓄積する。
// 1 フレームあたりの GPU 時間を計測してバッチ数を自動調整するので、
// 重い設定でも UI が固まらない。

class ConeMapGenerator {
  constructor(gl){
    this.gl = gl;
    this.BATCH = 128;
    this.floatColorExt = gl.getExtension("EXT_color_buffer_float");
    if(!this.floatColorExt)
      throw new Error("EXT_color_buffer_float is required for R16F cone buffers.");
    this.prog = glProgram(gl, SHADERS.fsqVS, SHADERS.genFS);
    this.compProg = glProgram(gl, SHADERS.fsqVS, SHADERS.compFS);
    const u = n => gl.getUniformLocation(this.prog, n);
    this.u = {
      height: u("uHeight"), prev: u("uPrev"), invSize: u("uInvSize"),
      offsets: u("uOffsets"), count: u("uCount"), steps: u("uSteps"),
      minDepth: u("uMinDepth"),
    };
    this.uc = {
      height: gl.getUniformLocation(this.compProg, "uHeight"),
      cone: gl.getUniformLocation(this.compProg, "uCone"),
    };
    this.smpRepeat = makeSampler(gl, gl.REPEAT, gl.LINEAR);
    this.smpClamp = makeSampler(gl, gl.CLAMP_TO_EDGE, gl.LINEAR);
    this.size = 0;
    this.coneTexOpts = { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT };
    this.heightTex = null;
    this.ping = [null, null];
    this.fbo = [null, null];
    this.exportTex = null;
    this.exportFbo = null;
    this.cur = 0;
    this.busy = false;
    this.done = false;
    this.k = 2;            // 1チャンクあたりのパス数 (自動調整)
    this.passIdx = 0;
    this.totalPasses = 0;
    this.elapsed = 0;
  }

  setHeight(canvas, maxHeight, wrap){
    const gl = this.gl, n = canvas.width;
    this.maxHeight = maxHeight;
    this.wrap = wrap;
    if(n !== this.size){
      [this.heightTex, this.ping[0], this.ping[1], this.exportTex]
        .forEach(t => t && gl.deleteTexture(t));
      [this.fbo[0], this.fbo[1], this.exportFbo]
        .forEach(f => f && gl.deleteFramebuffer(f));
      this.heightTex = makeTex(gl, n, n);
      this.ping = [makeTex(gl, n, n, this.coneTexOpts), makeTex(gl, n, n, this.coneTexOpts)];
      this.fbo = [makeFBO(gl, this.ping[0]), makeFBO(gl, this.ping[1])];
      this.exportTex = makeTex(gl, n, n);
      this.exportFbo = makeFBO(gl, this.exportTex);
      this.size = n;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.resetCone();
  }

  resetCone(){
    const gl = this.gl;
    for(const f of this.fbo){
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.viewport(0, 0, this.size, this.size);
      gl.clearColor(1, 1, 1, 1);          // コーン比率の初期値 = 1.0 (制約なし)
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 0;
    this.busy = false;
    this.done = false;
    this.passIdx = 0;
    this.totalPasses = 0;
  }

  start(radius, steps){
    const n = this.size;
    radius = Math.max(2, Math.min(radius, n >> 1));
    const offs = [];
    for(let dy = -radius; dy <= radius; dy++){
      for(let dx = -radius; dx <= radius; dx++){
        if(dx === 0 && dy === 0) continue;
        const d2 = dx * dx + dy * dy;
        if(d2 <= radius * radius) offs.push([dx, dy, d2]);
      }
    }
    offs.sort((a, b) => a[2] - b[2]);
    this.offsets = new Int32Array(offs.length * 2);
    offs.forEach((o, i) => { this.offsets[i*2] = o[0]; this.offsets[i*2+1] = o[1]; });
    this.nOffsets = offs.length;

    this.resetCone();
    this.steps = steps;
    this.totalPasses = Math.ceil(this.nOffsets / this.BATCH);
    this.busy = true;
    this.done = false;
    this.k = 2;
    this.t0 = performance.now();
    this.elapsed = 0;
  }

  pass(){
    const gl = this.gl;
    const start = this.passIdx * this.BATCH;
    const count = Math.min(this.BATCH, this.nOffsets - start);
    const dst = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.bindSampler(0, this.wrap ? this.smpRepeat : this.smpClamp);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ping[this.cur]);
    gl.bindSampler(1, null);
    gl.uniform1i(this.u.height, 0);
    gl.uniform1i(this.u.prev, 1);
    gl.uniform2f(this.u.invSize, 1 / this.size, 1 / this.size);
    gl.uniform1i(this.u.count, count);
    gl.uniform1i(this.u.steps, this.steps);
    gl.uniform1f(this.u.minDepth, Math.max(0, 1 - this.maxHeight));
    gl.uniform2iv(this.u.offsets, this.offsets.subarray(start * 2, (start + count) * 2));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = dst;
    this.passIdx++;
    if(this.passIdx >= this.totalPasses){
      this.busy = false;
      this.done = true;
      this.elapsed = (performance.now() - this.t0) / 1000;
    }
  }

  // GPU の完了を確実に待つ (gl.finish は Chrome ではブロックしないため)
  _syncGPU(){
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.FLOAT, this._syncBuf || (this._syncBuf = new Float32Array(1)));
  }

  // budgetMs を目安にパスを進める (フレーム毎に呼ぶ)
  runChunk(budgetMs){
    const gl = this.gl;
    const tStart = performance.now();
    while(this.busy && performance.now() - tStart < budgetMs){
      const t0 = performance.now();
      for(let i = 0; i < this.k && this.busy; i++) this.pass();
      this._syncGPU();
      const dt = performance.now() - t0;
      if(dt < budgetMs * 0.4) this.k = Math.min(this.k * 2, 64);
      else if(dt > budgetMs) this.k = Math.max(1, this.k >> 1);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get progress(){ return this.totalPasses ? this.passIdx / this.totalPasses : 0; }
  get coneTex(){ return this.ping[this.cur]; }

  abort(){
    if(this.busy){
      this.busy = false;
      this.done = true;
      this.elapsed = (performance.now() - this.t0) / 1000;
    }
  }

  // R=高さ, G=コーン比率 に合成して読み出す
  exportPixels(){
    const gl = this.gl, n = this.size;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.exportFbo);
    gl.viewport(0, 0, n, n);
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.coneTex);
    gl.bindSampler(1, null);
    gl.uniform1i(this.uc.height, 0);
    gl.uniform1i(this.uc.cone, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const data = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, n };
  }
}
