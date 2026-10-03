/** Full-fidelity PDF.js raster renderer used for pages with embedded images. */
export class PdfJsRenderer {
  constructor(canvas, page, onRasterReady = () => {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.page = page;
    this.onRasterReady = onRasterReady;
    this.pageCanvas = null;
    this.rasterScale = 0;
    this.renderTask = null;
    this.generation = 0;
  }

  setPage(page) {
    this._cancelRender();
    this.page = page;
    this.pageCanvas = null;
    this.rasterScale = 0;
  }

  uploadGeometry() { return { fillTris: 0, strokeTris: 0, fillVerts: 0, strokeVerts: 0 }; }
  destroyGeometry() {}

  _cancelRender() {
    this.generation++;
    if (!this.renderTask) return;
    try { this.renderTask.cancel(); } catch {}
    this.renderTask = null;
  }

  _requestRaster(scale) {
    if (!this.page || this.renderTask || this.rasterScale >= scale * 0.97) return;
    this._cancelRender();
    const generation = this.generation;
    const viewport = this.page.getViewport({ scale });
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = Math.max(1, Math.ceil(viewport.width));
    pageCanvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = pageCanvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    const task = this.page.render({ canvasContext: context, viewport, background: '#fff' });
    this.renderTask = task;
    task.promise.then(() => {
      if (generation !== this.generation) return;
      this.pageCanvas = pageCanvas;
      this.rasterScale = scale;
      this.renderTask = null;
      this.onRasterReady();
    }).catch(error => {
      if (error?.name !== 'RenderingCancelledException') console.error('PDF.js 完整頁面渲染失敗', error);
      if (generation === this.generation) this.renderTask = null;
    });
  }

  render(_matrix, view) {
    const { zoom, dpr, pageWidth, pageHeight, width, height, panX, panY } = view;
    const maxScale = Math.min(8, 8192 / pageWidth, 8192 / pageHeight, Math.sqrt(12_000_000 / (pageWidth * pageHeight)));
    this._requestRaster(Math.max(0.25, Math.min(zoom * dpr, maxScale)));
    const ctx = this.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.pageCanvas) return 0;
    const x = width / 2 + panX - pageWidth * zoom / 2;
    const y = height / 2 + panY - pageHeight * zoom / 2;
    ctx.drawImage(this.pageCanvas, x * dpr, y * dpr, pageWidth * zoom * dpr, pageHeight * zoom * dpr);
    return 1;
  }

  destroy() {
    this._cancelRender();
    this.page = null;
    this.pageCanvas = null;
  }
}
