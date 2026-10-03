import * as pdfjsLib from 'pdfjs-dist';
import { parseOperators } from './operator-parser.js';
import { createRenderer } from './renderer-factory.js';
import { PdfDocumentService } from '../pdf/pdf-document-service.js';

export class App {
  constructor(pdfjs = pdfjsLib) {
    this.pdfjs = pdfjs;
    this.documentService = new PdfDocumentService(pdfjs);
    this.canvas    = document.getElementById('canvas');
    this.viewer    = document.getElementById('viewer');
    this.textLayer = document.getElementById('textLayer');
    this.zoomLabel = document.getElementById('zoomLabel');
    this.statusEl  = document.getElementById('status');
    this.statsEl   = document.getElementById('stats');
    this.badgeEl   = document.getElementById('backendBadge');
    this.fpsLabel  = document.getElementById('fpsLabel');

    this.pdfDoc = null;
    this.pdfPage = null;
    this.pageWidth = 0;
    this.pageHeight = 0;
    this.textContent = null;
    this.batches = [];

    this.backend = null;
    this.backendName = '';
    this.geoStats = null;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dpr = 1;

    this.dragging = false;
    this.lastMouse = null;
    this._rebuildScheduled = false;
    this._renderScheduled = false;
    this._frameTimes = [];
    this._boundResize = () => {
      this._resizeCanvas();
      this._render();
    };

    this._bindUI();
    this._bindCanvas();
    this._resizeCanvas();
    window.addEventListener('resize', this._boundResize);
  }

  _log(msg) {
    const el = this.statusEl;
    const lines = el.textContent.split('\n');
    if (lines.length === 1 && lines[0] === '等待載入 PDF...') lines.length = 0;
    lines.push(msg);
    while (lines.length > 40) lines.shift();
    el.textContent = lines.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  _bindUI() {
    document.getElementById('fileInput').addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) this.loadPDF(f);
    });

    document.getElementById('zoomSlider').addEventListener('input', e => {
      this.zoom = parseFloat(e.target.value);
      this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
      this._scheduleRebuildTextLayer();
      this._render();
    });

    document.getElementById('backendSelect').addEventListener('change', async e => {
      if (this.pdfDoc) {
        await this._initBackend(e.target.value);
        if (this.backend && this.batches.length) {
          this.geoStats = this.backend.uploadGeometry(this.batches);
        }
      }
      this._render();
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
      this.zoom = 1; this.panX = 0; this.panY = 0;
      document.getElementById('zoomSlider').value = 1;
      this.zoomLabel.textContent = '100%';
      this._scheduleRebuildTextLayer();
      this._render();
    });
  }

  _bindCanvas() {
    this.viewer.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.canvas.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.panX += dx; this.panY += dy;
      this._render();
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
      this.canvas.classList.remove('dragging');
    });

    this.viewer.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const z = this.zoom;
      const z2 = Math.max(0.1, Math.min(64, z * factor));
      if (z2 === z) return;

      const rect = this.viewer.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      const pw = this.pageWidth, ph = this.pageHeight;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const px = (mx - W/2 - this.panX + pw * z / 2) / z;
      const py = ph - (my - H/2 - this.panY + ph * z / 2) / z;

      this.panX = mx - W/2 + pw * z2 / 2 - px * z2;
      this.panY = my - H/2 + ph * z2 / 2 - (ph - py) * z2;
      this.zoom = z2;

      document.getElementById('zoomSlider').value = Math.min(64, z2);
      this.zoomLabel.textContent = Math.round(z2 * 100) + '%';
      this._scheduleRebuildTextLayer();
      this._render();
    }, { passive: false });
  }

  _resizeCanvas() {
    const rect = this.viewer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.dpr = dpr;
  }

  _getFreshCanvas() {
    const fresh = this.canvas.cloneNode(false);
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this._resizeCanvas();
    return fresh;
  }

  async _initBackend(pref) {
    this.backend?.destroy?.();
    this.backend?.destroyGeometry?.();
    this.backend = null;
    this.backendName = '';
    this.geoStats = null;
    this.badgeEl.className = 'badge init';
    this.badgeEl.textContent = '初始化中...';

    try {
      const selected = await createRenderer(pref, () => this._getFreshCanvas(), msg => this._log(msg));
      this.backend = selected.backend;
      this.backendName = selected.name;
      this.badgeEl.className = `badge ${selected.badgeClass}`;
      this.badgeEl.textContent = selected.badgeClass === 'gpu' ? 'WebGPU' : 'WebGL';
    } catch (error) {
      this.badgeEl.className = 'badge err';
      this.badgeEl.textContent = pref === 'webgpu' ? 'WebGPU 不可用' : '無可用後端';
      throw error;
    }
  }

  async loadPDF(file) {
    this._log('載入: ' + file.name);
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    document.getElementById('zoomSlider').value = 1;
    this.zoomLabel.textContent = '100%';
    if (this.backend) this.backend.destroyGeometry();
    this.pdfDoc?.destroy?.();

    this.pdfDoc = await this.documentService.open(file);
    this._log('頁數: ' + this.pdfDoc.numPages);

    const page = await this.documentService.getPage(this.pdfDoc, 1);
    this.pdfPage = page;

    const vp0 = page.getViewport({ scale: 1 });
    this.pageWidth = vp0.width;
    this.pageHeight = vp0.height;
    this._log(`頁面尺寸: ${this.pageWidth.toFixed(1)} × ${this.pageHeight.toFixed(1)} pt`);

    this._log('解析 operator list...');
    const opList = await this.documentService.getOperatorList(page);
    this._log(`運算子數量: ${opList.fnArray.length}`);

    const opCounts = {};
    for (let i = 0; i < opList.fnArray.length; i++) {
      const op = opList.fnArray[i];
      opCounts[op] = (opCounts[op] || 0) + 1;
    }
    const opNames = {};
    for (const [name, code] of Object.entries(this.pdfjs.OPS)) opNames[code] = name;
    const topOps = Object.entries(opCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([code, n]) => `${opNames[code] || code}:${n}`).join(' ');
    this._log('Top OPS: ' + topOps);

    const t0 = performance.now();
    try {
      this.batches = parseOperators(opList);
    } catch (err) {
      this._log('✗ 解析失敗: ' + err.message);
      console.error(err);
      return;
    }
    const t1 = performance.now();
    this._log(`解析耗時: ${(t1 - t0).toFixed(1)} ms`);

    let fillB = 0, strokeB = 0;
    for (const b of this.batches) (b.kind === 'stroke' ? strokeB++ : fillB++);
    this._log(`原始批次: fill=${fillB}, stroke=${strokeB}, 合計=${this.batches.length}`);

    if (!this.backend) await this._initBackend(document.getElementById('backendSelect').value);

    this._log('上傳幾何至 GPU...');
    const t2 = performance.now();
    this.geoStats = this.backend.uploadGeometry(this.batches || []);
    const t3 = performance.now();
    this._log(`上傳耗時: ${(t3 - t2).toFixed(1)} ms`);
    this._log(`Fill 三角形: ${this.geoStats.fillTris.toLocaleString()}`);
    this._log(`Stroke 三角形: ${this.geoStats.strokeTris.toLocaleString()}`);

    this._log('取得文字內容...');
    const t4 = performance.now();
    this.textContent = await this.documentService.getTextContent(page);
    const t5 = performance.now();
    this._log(`文字項目數: ${this.textContent.items.length}`);
    this._log(`取文字耗時: ${(t5 - t4).toFixed(1)} ms`);

    this._rebuildTextLayer();
    this._render();
  }

  _computeMatrix() {
    const Wcss = this.canvas.width / this.dpr;
    const Hcss = this.canvas.height / this.dpr;
    const z = this.zoom;
    const pw = this.pageWidth, ph = this.pageHeight;
    const a = 2 * z / Wcss;
    const d = 2 * z / Hcss;
    const e = (2 * this.panX - pw * z) / Wcss;
    const f = (-2 * this.panY - ph * z) / Hcss;
    return new Float32Array([a, 0, 0, 0, d, 0, e, f, 1]);
  }

  _scheduleRebuildTextLayer() {
    if (this._rebuildScheduled) return;
    this._rebuildScheduled = true;
    requestAnimationFrame(() => {
      this._rebuildScheduled = false;
      this._rebuildTextLayer();
    });
  }

  _rebuildTextLayer() {
    if (!this.textLayer || !this.textContent || !this.pdfPage) return;
    const viewport = this.pdfPage.getViewport({ scale: this.zoom });
    this.textLayer.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const item of this.textContent.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;
      const tx = this.pdfjs.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (fontHeight < 0.5) continue;

      const span = document.createElement('span');
      span.textContent = str;
      span.style.left = tx[4] + 'px';
      span.style.top  = (tx[5] - fontHeight * 0.8) + 'px';
      span.style.fontSize = fontHeight + 'px';
      const angle = Math.atan2(tx[1], tx[0]);
      if (Math.abs(angle) > 0.001) span.style.transform = `rotate(${angle}rad)`;
      frag.appendChild(span);
    }
    this.textLayer.appendChild(frag);
    this._updateTextLayerPosition();
  }

  _updateTextLayerPosition() {
    if (!this.textLayer || !this.textContent) return;
    const rect = this.viewer.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const z = this.zoom;
    const pw = this.pageWidth, ph = this.pageHeight;
    const ox = W / 2 + this.panX - pw * z / 2;
    const oy = H / 2 + this.panY - ph * z / 2;
    this.textLayer.style.transform = `translate(${ox}px, ${oy}px)`;
  }

  _render() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this._doRender();
    });
  }

  _doRender() {
    if (!this.backend) {
      this._updateTextLayerPosition();
      return;
    }
    const matrix = this._computeMatrix();
    const t0 = performance.now();
    const rect = this.viewer.getBoundingClientRect();
    const draws = this.backend.render(matrix);
    const t1 = performance.now();
    this._updateTextLayerPosition();

    const now = performance.now();
    this._frameTimes.push(now);
    while (this._frameTimes.length > 60) this._frameTimes.shift();
    let fps = '—';
    if (this._frameTimes.length >= 2) {
      const span = (now - this._frameTimes[0]) / 1000;
      fps = (this._frameTimes.length / span).toFixed(0);
    }
    this.fpsLabel.textContent = fps + ' fps';

    const g = this.geoStats || { fillTris: 0, strokeTris: 0 };
    this.statsEl.textContent =
      `後端:          ${this.backendName}\n` +
      `縮放:          ${(this.zoom * 100).toFixed(0)}%\n` +
      `Draw call:     ${draws}\n` +
      `Fill 三角形:   ${g.fillTris.toLocaleString()}\n` +
      `Stroke 三角形: ${g.strokeTris.toLocaleString()}\n` +
      `文字項目:      ${this.textContent ? this.textContent.items.length : 0}\n` +
      `渲染耗時:      ${(t1 - t0).toFixed(2)} ms\n` +
      `Canvas:        ${this.canvas.width}×${this.canvas.height}\n` +
      `DPR:           ${this.dpr}`;
  }

  destroy() {
    window.removeEventListener('resize', this._boundResize);
    this.backend?.destroy?.();
    this.backend?.destroyGeometry?.();
    this.pdfDoc?.destroy?.();
  }
}
