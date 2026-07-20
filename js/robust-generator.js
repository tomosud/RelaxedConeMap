"use strict";

// Independent implementation of Algorithm 2 and Equation 2 from
// Bán et al., "Robust Cone Step Mapping", EGSR 2024.
class RobustConeMapGenerator {
  constructor(gl){
    this.gl = gl;
    this.BATCH = 128;
    this.floatColorExt = gl.getExtension("EXT_color_buffer_float");
    if(!this.floatColorExt) throw new Error("Robust RCS requires EXT_color_buffer_float.");
    this.genProg = glProgram(gl, SHADERS.fsqVS, ROBUST_SHADERS.generateFS);
    this.correctProg = glProgram(gl, SHADERS.fsqVS, ROBUST_SHADERS.correctFS);
    this.exportProg = glProgram(gl, SHADERS.fsqVS, ROBUST_SHADERS.exportFS);
    const ug = n => gl.getUniformLocation(this.genProg, n);
    this.ug = { height: ug("uHeight"), prev: ug("uPrev"), cells: ug("uCells"), count: ug("uCount"), size: ug("uSize"), wrap: ug("uWrap") };
    const uc = n => gl.getUniformLocation(this.correctProg, n);
    this.uc = { height: uc("uHeight"), cone: uc("uCone"), size: uc("uSize"), wrap: uc("uWrap") };
    this.ue = { height: gl.getUniformLocation(this.exportProg, "uHeight"), cone: gl.getUniformLocation(this.exportProg, "uCone") };
    this.smpRepeat = makeSampler(gl, gl.REPEAT, gl.LINEAR);
    this.smpClamp = makeSampler(gl, gl.CLAMP_TO_EDGE, gl.LINEAR);
    this.size = 0;
    this.heightTex = null;
    this.heightTexKind = null;
    this.ping = [null, null];
    this.fbo = [null, null];
    this.correctedTex = null;
    this.correctedFbo = null;
    this.exportTex = null;
    this.exportFbo = null;
    this.cur = 0;
    this.busy = false;
    this.done = false;
    this.phase = "idle";
    this.passIdx = 0;
    this.totalPasses = 0;
    this.elapsed = 0;
    this.debugStats = null;
  }

  setHeight(source, maxHeight, wrap){
    const gl = this.gl;
    const canvas = source.canvas || source;
    const heightData = source.heightData || null;
    const n = canvas.width;
    const kind = heightData ? "r16f" : "rgba8";
    this.wrap = !!wrap;
    if(n !== this.size || kind !== this.heightTexKind){
      [this.heightTex, ...this.ping, this.correctedTex, this.exportTex].forEach(t => t && gl.deleteTexture(t));
      [...this.fbo, this.correctedFbo, this.exportFbo].forEach(f => f && gl.deleteFramebuffer(f));
      this.heightTex = heightData
        ? makeTex(gl, n, n, { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT })
        : makeTex(gl, n, n);
      this.ping = [0, 1].map(() => makeTex(gl, n, n, { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT }));
      this.fbo = this.ping.map(makeFBO.bind(null, gl));
      this.correctedTex = makeTex(gl, n, n);
      this.correctedFbo = makeFBO(gl, this.correctedTex);
      this.exportTex = makeTex(gl, n, n);
      this.exportFbo = makeFBO(gl, this.exportTex);
      this.size = n;
      this.heightTexKind = kind;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    if(heightData){
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, n, n, 0, gl.RED, gl.HALF_FLOAT, makeHalfFloatHeight(heightData, n));
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    this._clearCones();
  }

  _clearCones(){
    const gl = this.gl;
    for(const f of this.fbo){
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.viewport(0, 0, this.size, this.size);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 0;
  }

  // Enumerates the same outward-facing bilinear cells as Algorithm 2. Cells
  // are ordered by Chebyshev distance, enabling the cone-bound early reject.
  _makeCells(){
    const cells = [];
    const dirs = [[1,1],[-1,1],[1,-1],[-1,-1]];
    for(let r = 1; r <= this.size; ++r){
      for(const [sx, sy] of dirs){
        for(let k = 0; k <= r; ++k) cells.push(sx * r, sy * k, sx, sy);
        for(let k = 0; k < r; ++k) cells.push(sx * k, sy * r, sx, sy);
      }
    }
    return new Int32Array(cells);
  }

  start(){
    this._clearCones();
    this.cells = this._makeCells();
    this.cellCount = this.cells.length / 4;
    this.generatePasses = Math.ceil(this.cellCount / this.BATCH);
    this.totalPasses = this.generatePasses + 1;
    this.passIdx = 0;
    this.phase = "generate";
    this.busy = true;
    this.done = false;
    this.t0 = performance.now();
    this.elapsed = 0;
    this.debugStats = null;
  }

  _generatePass(){
    const gl = this.gl;
    const first = this.passIdx * this.BATCH;
    const count = Math.min(this.BATCH, this.cellCount - first);
    const dst = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(this.genProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.ping[this.cur]);
    gl.uniform1i(this.ug.height, 0); gl.uniform1i(this.ug.prev, 1);
    gl.uniform1i(this.ug.count, count); gl.uniform1i(this.ug.size, this.size); gl.uniform1i(this.ug.wrap, this.wrap ? 1 : 0);
    gl.uniform4iv(this.ug.cells, this.cells.subarray(first * 4, (first + count) * 4));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = dst;
    this.passIdx++;
    if(this.passIdx >= this.generatePasses) this.phase = "correct";
  }

  _correctPass(){
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.correctedFbo);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(this.correctProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.ping[this.cur]);
    gl.uniform1i(this.uc.height, 0); gl.uniform1i(this.uc.cone, 1);
    gl.uniform1i(this.uc.size, this.size); gl.uniform1i(this.uc.wrap, this.wrap ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passIdx++;
    this.phase = "done";
    this.busy = false;
    this.done = true;
    this.elapsed = (performance.now() - this.t0) / 1000;
    this.debugStats = this._collectDebugStats();
  }

  runChunk(budgetMs){
    const start = performance.now();
    while(this.busy && performance.now() - start < budgetMs){
      if(this.phase === "generate") this._generatePass();
      else if(this.phase === "correct") this._correctPass();
      this.gl.flush();
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  abort(){
    if(!this.busy) return;
    this.busy = false;
    this.done = true;
    this.elapsed = (performance.now() - this.t0) / 1000;
    this.debugStats = this._collectDebugStats();
  }


  _statsForFbo(fbo, packed = false){
    const gl = this.gl;
    let values;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    if(packed){
      const bytes = new Uint8Array(this.size * this.size * 4);
      gl.readPixels(0, 0, this.size, this.size, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      values = new Float32Array(this.size * this.size);
      for(let i = 0; i < values.length; ++i)
        values[i] = (bytes[i*4] + bytes[i*4+1]*256 + bytes[i*4+2]*65536) / 16777215;
    } else {
      values = new Float32Array(this.size * this.size);
      gl.readPixels(0, 0, this.size, this.size, gl.RED, gl.FLOAT, values);
    }
    let min = Infinity, max = -Infinity, sum = 0, zeros = 0, invalid = 0;
    for(const v of values){
      if(!Number.isFinite(v)){ invalid++; continue; }
      min = Math.min(min, v); max = Math.max(max, v); sum += v;
      if(v === 0) zeros++;
    }
    const valid = values.length - invalid;
    return {
      min: valid ? min : NaN,
      max: valid ? max : NaN,
      mean: valid ? sum / valid : NaN,
      zeroPercent: 100 * zeros / values.length,
      invalid,
    };
  }

  _collectDebugStats(){
    const raw = this._statsForFbo(this.fbo[this.cur]);
    const corrected = this._statsForFbo(this.correctedFbo, true);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return { raw, corrected, size: this.size };
  }

  getDebugText(){
    if(!this.debugStats) return "Robust debug: no completed generation";
    const f = s => `min=${s.min.toExponential(4)} max=${s.max.toExponential(4)} mean=${s.mean.toExponential(4)} zero=${s.zeroPercent.toFixed(2)}% invalid=${s.invalid}`;
    return `Robust ${this.debugStats.size}x${this.debugStats.size}\nRaw:       ${f(this.debugStats.raw)}\nCorrected: ${f(this.debugStats.corrected)}`;
  }
  exportPixels(){
    const gl = this.gl, n = this.size;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.exportFbo);
    gl.viewport(0, 0, n, n);
    gl.useProgram(this.exportProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.coneTex);
    gl.uniform1i(this.ue.height, 0); gl.uniform1i(this.ue.cone, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const data = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, n };
  }

  get progress(){ return this.totalPasses ? this.passIdx / this.totalPasses : 0; }
  get coneTex(){ return this.phase === "done" ? this.correctedTex : this.ping[this.cur]; }
}
