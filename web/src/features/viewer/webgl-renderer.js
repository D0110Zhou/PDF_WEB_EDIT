import { mergeBatches } from './geometry-batches.js';

export class WebGLBackend {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false })
           || canvas.getContext('webgl',  { antialias: true, premultipliedAlpha: false });
    if (!this.gl) throw new Error('WebGL 不可用');
    if (!(this.gl instanceof WebGL2RenderingContext) &&
        !this.gl.getExtension('OES_element_index_uint')) {
      throw new Error('缺少 OES_element_index_uint 擴展');
    }
    this._initShaders();
    this.fillVBO = null; this.fillIBO = null; this.fillIdxCount = 0;
    this.strokeVBO = null; this.strokeIBO = null; this.strokeIdxCount = 0;
  }

  _initShaders() {
    const gl = this.gl;
    const vs = `
      attribute vec2 a_pos;
      attribute vec4 a_color;
      uniform mat3 u_matrix;
      varying vec4 v_color;
      void main() {
        vec3 p = u_matrix * vec3(a_pos, 1.0);
        gl_Position = vec4(p.xy, 0.0, 1.0);
        v_color = a_color;
      }`;
    const fs = `
      precision mediump float;
      varying vec4 v_color;
      void main() { gl_FragColor = v_color; }`;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('Shader 錯誤: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('Program 連結失敗: ' + gl.getProgramInfoLog(prog));

    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'a_pos');
    this.aColor = gl.getAttribLocation(prog, 'a_color');
    this.uMatrix = gl.getUniformLocation(prog, 'u_matrix');
  }

  destroyGeometry() {
    const gl = this.gl;
    for (const k of ['fillVBO','fillIBO','strokeVBO','strokeIBO']) {
      if (this[k]) { gl.deleteBuffer(this[k]); this[k] = null; }
    }
    this.fillIdxCount = this.strokeIdxCount = 0;
  }

  destroy() {
    this.destroyGeometry();
    if (this.prog) this.gl.deleteProgram(this.prog);
  }

  uploadGeometry(batches) {
    this.destroyGeometry();
    const gl = this.gl;
    const F = mergeBatches(batches.filter(b => b.kind !== 'stroke'));
    const S = mergeBatches(batches.filter(b => b.kind === 'stroke'));

    if (F.indexCount > 0) {
      this.fillVBO = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
      gl.bufferData(gl.ARRAY_BUFFER, F.vertices, gl.STATIC_DRAW);
      this.fillIBO = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fillIBO);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, F.indices, gl.STATIC_DRAW);
      this.fillIdxCount = F.indexCount;
    }
    if (S.indexCount > 0) {
      this.strokeVBO = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeVBO);
      gl.bufferData(gl.ARRAY_BUFFER, S.vertices, gl.STATIC_DRAW);
      this.strokeIBO = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.strokeIBO);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, S.indices, gl.STATIC_DRAW);
      this.strokeIdxCount = S.indexCount;
    }
    return {
      fillTris: F.indexCount / 3,
      strokeTris: S.indexCount / 3,
      fillVerts: F.vertexCount,
      strokeVerts: S.vertexCount,
    };
  }

  render(matrix) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix3fv(this.uMatrix, false, matrix);

    let draws = 0;
    const STRIDE = 24;

    if (this.fillVBO && this.fillIdxCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(this.aColor);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, STRIDE, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fillIBO);
      gl.drawElements(gl.TRIANGLES, this.fillIdxCount, gl.UNSIGNED_INT, 0);
      draws++;
    }
    if (this.strokeVBO && this.strokeIdxCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeVBO);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(this.aColor);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, STRIDE, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.strokeIBO);
      gl.drawElements(gl.TRIANGLES, this.strokeIdxCount, gl.UNSIGNED_INT, 0);
      draws++;
    }
    return draws;
  }
}
