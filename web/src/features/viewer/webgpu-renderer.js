import { mergeBatches } from './geometry-batches.js';

export class WebGPUBackend {
  constructor(canvas) { this.canvas = canvas; }

  async init() {
    if (!navigator.gpu) throw new Error('此瀏覽器不支援 WebGPU');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('找不到 WebGPU adapter');
    this.device = await adapter.requestDevice();

    this.ctx = this.canvas.getContext('webgpu');
    if (!this.ctx) throw new Error('無法取得 webgpu context');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    this.sampleCount = 4;

    const shaderCode = `
      struct U { mvp: mat3x3<f32> };
      @group(0) @binding(0) var<uniform> u: U;

      struct VOut {
        @builtin(position) pos: vec4<f32>,
        @location(0) color: vec4<f32>,
      };

      @vertex
      fn vs(@location(0) p: vec2<f32>, @location(1) c: vec4<f32>) -> VOut {
        var o: VOut;
        let m = u.mvp * vec3<f32>(p, 1.0);
        o.pos = vec4<f32>(m.xy, 0.0, 1.0);
        o.color = c;
        return o;
      }

      @fragment
      fn fs(in: VOut) -> @location(0) vec4<f32> {
        return in.color;
      }`;

    const shaderModule = this.device.createShaderModule({ code: shaderCode });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule, entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: shaderModule, entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: this.sampleCount },
    });

    this.mvpBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mvpBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.mvpBuffer } }],
    });

    this.msaaTexture = null;
    this.msaaSize = { w: 0, h: 0 };
    this.fillVBO = null; this.fillIBO = null; this.fillIdxCount = 0;
    this.strokeVBO = null; this.strokeIBO = null; this.strokeIdxCount = 0;
  }

  _ensureMsaaTexture() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.msaaTexture && this.msaaSize.w === w && this.msaaSize.h === h) return;
    if (this.msaaTexture) this.msaaTexture.destroy();
    this.msaaTexture = this.device.createTexture({
      size: [w, h],
      sampleCount: this.sampleCount,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaSize = { w, h };
  }

  destroyGeometry() {
    for (const k of ['fillVBO','fillIBO','strokeVBO','strokeIBO']) {
      if (this[k]) { this[k].destroy(); this[k] = null; }
    }
    this.fillIdxCount = this.strokeIdxCount = 0;
  }

  destroy() {
    this.destroyGeometry();
    this.msaaTexture?.destroy();
    this.mvpBuffer?.destroy();
    this.device?.destroy();
  }

  uploadGeometry(batches) {
    this.destroyGeometry();
    const F = mergeBatches(batches.filter(b => b.kind !== 'stroke'));
    const S = mergeBatches(batches.filter(b => b.kind === 'stroke'));

    const upload = (m, kind) => {
      if (m.indexCount === 0) return;
      const vb = this.device.createBuffer({
        size: m.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vb, 0, m.vertices);
      const ib = this.device.createBuffer({
        size: m.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(ib, 0, m.indices);
      if (kind === 'fill') {
        this.fillVBO = vb; this.fillIBO = ib; this.fillIdxCount = m.indexCount;
      } else {
        this.strokeVBO = vb; this.strokeIBO = ib; this.strokeIdxCount = m.indexCount;
      }
    };
    upload(F, 'fill');
    upload(S, 'stroke');

    return {
      fillTris: F.indexCount / 3,
      strokeTris: S.indexCount / 3,
      fillVerts: F.vertexCount,
      strokeVerts: S.vertexCount,
    };
  }

  render(matrix) {
    const mvp = new Float32Array(12);
    mvp[0]=matrix[0]; mvp[1]=matrix[1]; mvp[2]=matrix[2]; mvp[3]=0;
    mvp[4]=matrix[3]; mvp[5]=matrix[4]; mvp[6]=matrix[5]; mvp[7]=0;
    mvp[8]=matrix[6]; mvp[9]=matrix[7]; mvp[10]=matrix[8]; mvp[11]=0;
    this.device.queue.writeBuffer(this.mvpBuffer, 0, mvp);

    this._ensureMsaaTexture();

    const enc = this.device.createCommandEncoder();
    const swapView = this.ctx.getCurrentTexture().createView();
    const msaaView = this.msaaTexture.createView();

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: msaaView,
        resolveTarget: swapView,
        loadOp: 'clear',
        storeOp: 'discard',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.mvpBindGroup);

    let draws = 0;
    if (this.fillVBO && this.fillIdxCount > 0) {
      pass.setVertexBuffer(0, this.fillVBO);
      pass.setIndexBuffer(this.fillIBO, 'uint32');
      pass.drawIndexed(this.fillIdxCount);
      draws++;
    }
    if (this.strokeVBO && this.strokeIdxCount > 0) {
      pass.setVertexBuffer(0, this.strokeVBO);
      pass.setIndexBuffer(this.strokeIBO, 'uint32');
      pass.drawIndexed(this.strokeIdxCount);
      draws++;
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
    return draws;
  }
}
