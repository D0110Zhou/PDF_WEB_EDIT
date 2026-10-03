import * as pdfjsLib from 'pdfjs-dist';
import { parseOperators } from './operator-parser.js';
import { createRenderer } from './renderer-factory.js';
import { PdfDocumentService } from '../pdf/pdf-document-service.js';
import { detectVectorCells, extractVectorLines } from '../tables/vector-table-detector.js';
import { detectRasterCells } from '../tables/raster-table-detector.js';
import { chooseSaveTarget, downloadBlob, normalizeProject, normalizeTextStyle, parseCellIndices, parsePageRange, projectBlob, saveBlobWithPicker, writeBlobToTarget } from '../project/project-service.js';
import { fontKeyForCharacter, layoutCell } from '../layout/text-layout.js';

export class App {
  constructor(pdfjs = pdfjsLib) {
    this.pdfjs = pdfjs;
    this.documentService = new PdfDocumentService(pdfjs);
    this.canvas    = document.getElementById('canvas');
    this.viewer    = document.getElementById('viewer');
    this.textLayer = document.getElementById('textLayer');
    this.annotationOverlay = document.getElementById('annotationOverlay');
    this.zoomLabel = document.getElementById('zoomLabel');
    this.statusEl  = document.getElementById('status');
    this.statsEl   = document.getElementById('stats');
    this.badgeEl   = document.getElementById('backendBadge');
    this.fpsLabel  = document.getElementById('fpsLabel');

    this.pdfDoc = null;
    this.pdfPage = null;
    this.pdfFileName = '';
    this.pdfPath = '';
    this.pdfFile = null;
    this.calibriFontBytes = null;
    this.cjkFontBytes = null;
    this.cjkFontName = '';
    this.pageNumber = 0;
    this.pageNumbers = [];
    this.pageWidth = 0;
    this.pageHeight = 0;
    this.textContent = null;
    this.batches = [];
    this.vectorLines = [];
    this.userROI = null;
    this.cells = [];
    this.originalCells = [];
    this.cellTexts = [];
    this.projectData = {};
    this.projectPending = false;
    this.textStyle = normalizeTextStyle();

    this.backend = null;
    this.backendName = '';
    this.backendPreference = '';
    this.operatorList = null;
    this.hasImageOps = false;
    this.geoStats = null;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dpr = 1;

    this.dragging = false;
    this.lastMouse = null;
    this.roiMode = false;
    this.roiStart = null;
    this.currentROIScreen = null;
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
      if (f) this.loadPDF(f).catch(error => this._log(`載入失敗: ${error.message}`));
      e.target.value = '';
    });

    document.getElementById('loadPagesBtn').addEventListener('click', () => this.loadPageRange());
    document.getElementById('pageSelect').addEventListener('change', e => {
      const nextPage = Number(e.target.value);
      if (nextPage && nextPage !== this.pageNumber) this.loadPage(nextPage).catch(error => this._log(`頁面切換失敗: ${error.message}`));
    });
    document.getElementById('roiModeBtn').addEventListener('click', e => {
      this.roiMode = !this.roiMode;
      e.currentTarget.setAttribute('aria-pressed', String(this.roiMode));
      this.viewer.classList.toggle('selecting-roi', this.roiMode);
      this._log(this.roiMode ? '請在頁面上拖曳框選表格區域' : '已取消框選模式');
    });
    document.getElementById('saveProjectBtn').addEventListener('click', () => this.saveProject().catch(error => this._log(`JSON 儲存失敗: ${error.message}`)));
    document.getElementById('exportPdfBtn').addEventListener('click', () => this.exportPdf());
    document.getElementById('projectInput').addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.loadProject(file).catch(error => this._log(`JSON 載入失敗: ${error.message}`));
      e.target.value = '';
    });
    document.getElementById('cjkFontInput').addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.loadCjkFont(file).catch(error => this._log(`中文字型載入失敗: ${error.message}`));
      e.target.value = '';
    });
    document.getElementById('latinFontInput').addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.loadLatinFont(file).catch(error => this._log(`Calibri 載入失敗: ${error.message}`));
      e.target.value = '';
    });
    for (const id of ['fontSize', 'lineSpacing', 'autoFit']) {
      document.getElementById(id).addEventListener('input', () => this.updateTextStyle());
    }
    document.querySelectorAll('[data-adjust]').forEach(button => {
      button.addEventListener('click', () => this.adjustSelectedCells(button.dataset.adjust));
    });
    document.getElementById('resetCellsBtn').addEventListener('click', () => this.resetSelectedCells());

    document.getElementById('cellEditors').addEventListener('input', e => {
      const index = Number(e.target.dataset.cellIndex);
      if (!Number.isInteger(index) || index < 0 || index >= this.cellTexts.length) return;
      this.cellTexts[index] = e.target.value;
      this._renderOverlay();
      this.saveCurrentPageState();
    });

    document.getElementById('zoomSlider').addEventListener('input', e => {
      this.zoom = parseFloat(e.target.value);
      this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
      this._scheduleRebuildTextLayer();
      this._renderOverlay();
      this._render();
    });

    document.getElementById('backendSelect').addEventListener('change', async e => {
      try {
        const preference = e.target.value === 'auto' && this.hasImageOps ? 'pdfjs' : e.target.value;
        if (this.pdfDoc) {
          if (preference !== 'pdfjs' && !this.batches.length && this.operatorList) {
            this.batches = parseOperators(this.operatorList);
          }
          await this._initBackend(preference);
          if (this.backend && this.batches.length) {
            this.geoStats = this.backend.uploadGeometry(this.batches);
          }
        }
        this._render();
      } catch (error) {
        this._log(`渲染後端切換失敗: ${error.message}`);
      }
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
      this.zoom = 1; this.panX = 0; this.panY = 0;
      document.getElementById('zoomSlider').value = 1;
      this.zoomLabel.textContent = '100%';
      this._scheduleRebuildTextLayer();
      this._renderOverlay();
      this._render();
    });
  }

  _bindCanvas() {
    this.viewer.addEventListener('mousedown', e => {
      if (e.button !== 0 || !this.pdfPage) return;
      if (this.roiMode) {
        const rect = this.viewer.getBoundingClientRect();
        this.roiStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.currentROIScreen = { x: this.roiStart.x, y: this.roiStart.y, width: 0, height: 0 };
        this._renderOverlay();
        e.preventDefault();
        return;
      }
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.canvas.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (this.roiStart) {
        const rect = this.viewer.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        this.currentROIScreen = {
          x: Math.min(this.roiStart.x, x), y: Math.min(this.roiStart.y, y),
          width: Math.abs(x - this.roiStart.x), height: Math.abs(y - this.roiStart.y),
        };
        this._renderOverlay();
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.panX += dx; this.panY += dy;
      this._renderOverlay();
      this._render();
    });
    window.addEventListener('mouseup', () => {
      if (this.roiStart) {
        const selected = this.currentROIScreen;
        this.roiStart = null;
        this.currentROIScreen = null;
        if (selected && selected.width > 5 && selected.height > 5) this.finishROI(selected).catch(error => this._log(`影像格線偵測失敗: ${error.message}`));
        else this._renderOverlay();
        return;
      }
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
      this._renderOverlay();
      this._render();
    }, { passive: false });
  }

  _resizeCanvas() {
    const rect = this.viewer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.dpr = dpr;
    this._renderOverlay();
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
      const selected = await createRenderer(pref, () => this._getFreshCanvas(), msg => this._log(msg), {
        page: this.pdfPage,
        onRasterReady: () => this._render(),
      });
      this.backend = selected.backend;
      this.backendName = selected.name;
      this.backendPreference = pref;
      this.viewer.classList.toggle('pdfjs-rendering', pref === 'pdfjs');
      this.badgeEl.className = `badge ${selected.badgeClass}`;
      this.badgeEl.textContent = selected.badgeClass === 'gpu' ? 'WebGPU' : selected.badgeClass === 'gl' ? 'WebGL' : 'PDF.js';
    } catch (error) {
      this.badgeEl.className = 'badge err';
      this.badgeEl.textContent = pref === 'webgpu' ? 'WebGPU 不可用' : '無可用後端';
      throw error;
    }
  }

  async loadPDF(file) {
    this._log('載入: ' + file.name);
    if (this.backend) this.backend.destroyGeometry();
    this.pdfDoc?.destroy?.();
    if (!this.projectPending) this.projectData = {};
    this.pdfPage = null;
    this.pdfFileName = file.name;
    this.pdfFile = file;
    if (!this.projectPending || !this.pdfPath) this.pdfPath = file.name;
    this.pdfDoc = await this.documentService.open(file);
    this._log('頁數: ' + this.pdfDoc.numPages);
    const savedPages = this.projectPending
      ? Object.keys(this.projectData).map(key => Number(key) + 1).filter(page => page <= this.pdfDoc.numPages)
      : [];
    if (savedPages.length) document.getElementById('pageRange').value = savedPages.join(',');
    this.pageNumbers = parsePageRange(document.getElementById('pageRange').value, this.pdfDoc.numPages);
    if (!this.pageNumbers.length) this.pageNumbers = [1];
    this.populatePageSelect();
    await this.loadPage(this.pageNumbers[0], false);
    this.projectPending = false;
  }

  populatePageSelect() {
    const select = document.getElementById('pageSelect');
    select.replaceChildren();
    for (const pageNumber of this.pageNumbers) {
      const option = document.createElement('option');
      option.value = String(pageNumber);
      option.textContent = `第 ${pageNumber} 頁 / ${this.pdfDoc.numPages}`;
      select.append(option);
    }
    select.disabled = !this.pageNumbers.length;
  }

  async loadPageRange() {
    if (!this.pdfDoc) return this._log('請先載入 PDF');
    const pages = parsePageRange(document.getElementById('pageRange').value, this.pdfDoc.numPages);
    if (!pages.length) return this._log('頁碼範圍無效，請使用例如 1, 5-7');
    this.saveCurrentPageState();
    this.pageNumbers = pages;
    this.populatePageSelect();
    await this.loadPage(pages[0], false);
  }

  async loadPage(pageNumber, saveCurrent = true) {
    if (!this.pdfDoc || pageNumber < 1 || pageNumber > this.pdfDoc.numPages) return;
    if (saveCurrent) this.saveCurrentPageState();
    if (this.backend) this.backend.destroyGeometry();
    this.textLayer.replaceChildren();
    this.cells = [];
    this.originalCells = [];
    this.cellTexts = [];
    this.userROI = null;
    this.pageNumber = pageNumber;
    document.getElementById('pageSelect').value = String(pageNumber);
    const page = await this.documentService.getPage(this.pdfDoc, pageNumber);
    this.pdfPage = page;
    const vp0 = page.getViewport({ scale: 1 });
    this.pageWidth = vp0.width;
    this.pageHeight = vp0.height;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    document.getElementById('zoomSlider').value = 1;
    this.zoomLabel.textContent = '100%';
    this._log(`載入第 ${pageNumber} 頁；頁面尺寸: ${this.pageWidth.toFixed(1)} × ${this.pageHeight.toFixed(1)} pt`);

    this._log('解析 operator list...');
    const opList = await this.documentService.getOperatorList(page);
    this.vectorLines = extractVectorLines(opList, vp0.transform);
    this._log(`運算子數量: ${opList.fnArray.length}`);

    const opCounts = {};
    for (let i = 0; i < opList.fnArray.length; i++) {
      const op = opList.fnArray[i];
      opCounts[op] = (opCounts[op] || 0) + 1;
    }
    const opNames = {};
    for (const [name, code] of Object.entries(this.pdfjs.OPS)) opNames[code] = name;
    this.operatorList = opList;
    this.hasImageOps = opList.fnArray.some(code => /Image/i.test(opNames[code] || ''));
    const topOps = Object.entries(opCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([code, n]) => `${opNames[code] || code}:${n}`).join(' ');
    this._log('Top OPS: ' + topOps);

    const selectedPreference = document.getElementById('backendSelect').value;
    const preference = selectedPreference === 'auto' && this.hasImageOps ? 'pdfjs' : selectedPreference;
    const t0 = performance.now();
    if (preference === 'pdfjs') {
      this.batches = [];
      this._log('偵測到影像運算子，使用 PDF.js 完整頁面渲染');
    } else {
      try {
        this.batches = parseOperators(opList);
      } catch (err) {
        this._log('✗ 解析失敗: ' + err.message);
        console.error(err);
        return;
      }
    }
    const t1 = performance.now();
    this._log(`解析耗時: ${(t1 - t0).toFixed(1)} ms`);

    let fillB = 0, strokeB = 0;
    for (const b of this.batches) (b.kind === 'stroke' ? strokeB++ : fillB++);
    this._log(`原始批次: fill=${fillB}, stroke=${strokeB}, 合計=${this.batches.length}`);

    if (!this.backend || this.backendPreference !== preference) await this._initBackend(preference);
    else if (preference === 'pdfjs') this.backend.setPage?.(page);

    this._log(preference === 'pdfjs' ? '準備 PDF.js 完整頁面渲染...' : '上傳幾何至 GPU...');
    const t2 = performance.now();
    this.geoStats = this.backend.uploadGeometry(this.batches || []);
    const t3 = performance.now();
    this._log(`${preference === 'pdfjs' ? '幾何處理' : '上傳'}耗時: ${(t3 - t2).toFixed(1)} ms`);
    this._log(`Fill 三角形: ${this.geoStats.fillTris.toLocaleString()}`);
    this._log(`Stroke 三角形: ${this.geoStats.strokeTris.toLocaleString()}`);

    this._log('取得文字內容...');
    const t4 = performance.now();
    this.textContent = await this.documentService.getTextContent(page);
    const t5 = performance.now();
    this._log(`文字項目數: ${this.textContent.items.length}`);
    this._log(`取文字耗時: ${(t5 - t4).toFixed(1)} ms`);
    this.loadCurrentPageState();
    this._rebuildTextLayer();
    this.renderCellEditors();
    this._renderOverlay();
    this._render();
  }

  screenToPage(point) {
    const rect = this.viewer.getBoundingClientRect();
    return {
      x: (point.x - rect.width / 2 - this.panX + this.pageWidth * this.zoom / 2) / this.zoom,
      y: (point.y - rect.height / 2 - this.panY + this.pageHeight * this.zoom / 2) / this.zoom,
    };
  }

  pageToScreen(point) {
    const rect = this.viewer.getBoundingClientRect();
    return {
      x: rect.width / 2 + this.panX - this.pageWidth * this.zoom / 2 + point.x * this.zoom,
      y: rect.height / 2 + this.panY - this.pageHeight * this.zoom / 2 + point.y * this.zoom,
    };
  }

  async finishROI(screenRect) {
    const a = this.screenToPage({ x: screenRect.x, y: screenRect.y });
    const b = this.screenToPage({ x: screenRect.x + screenRect.width, y: screenRect.y + screenRect.height });
    this.userROI = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const detectionROI = {
      x0: Math.max(0, this.userROI.x0 - 5), y0: Math.max(0, this.userROI.y0 - 5),
      x1: Math.min(this.pageWidth, this.userROI.x1 + 5), y1: Math.min(this.pageHeight, this.userROI.y1 + 5),
    };
    let result = detectVectorCells(this.vectorLines, detectionROI);
    let method = '向量';
    if (!result.cells.length) {
      this._log('向量線未形成完整格子，改用 PDF.js 影像格線投影');
      result = await detectRasterCells(this.pdfPage, detectionROI);
      method = '影像';
    }
    this.cells = result.cells;
    this.originalCells = this.cells.map(cell => ({ ...cell }));
    this.cellTexts = this.cells.map(() => '');
    this.renderCellEditors();
    this._renderOverlay();
    this.saveCurrentPageState();
    this._log(`${method}偵測格線 ${result.horizontalLines} × ${result.verticalLines}，找到 ${this.cells.length} 格`);
    if (!this.cells.length) this._log('此區域未辨識出完整格子；請調整框選範圍或手動微調。');
  }

  saveCurrentPageState() {
    if (!this.pdfDoc || !this.pageNumber || (!this.cells.length && !this.userROI)) return;
    this.projectData[String(this.pageNumber - 1)] = {
      user_roi: this.userROI ? [this.userROI.x0, this.userROI.y0, this.userROI.x1, this.userROI.y1] : null,
      cells: this.cells.map(cell => [cell.x0, cell.y0, cell.x1, cell.y1]),
      original_cells: this.originalCells.map(cell => [cell.x0, cell.y0, cell.x1, cell.y1]),
      texts: this.cellTexts.map(text => String(text ?? '')),
    };
  }

  loadCurrentPageState() {
    const data = this.projectData[String(this.pageNumber - 1)];
    if (!data) {
      this.userROI = null;
      this.cells = [];
      this.originalCells = [];
      this.cellTexts = [];
      return;
    }
    this.userROI = data.user_roi ? { x0: data.user_roi[0], y0: data.user_roi[1], x1: data.user_roi[2], y1: data.user_roi[3] } : null;
    this.cells = data.cells.map(rect => ({ x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] }));
    this.originalCells = data.original_cells.map(rect => ({ x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] }));
    this.cellTexts = this.cells.map((_, index) => String(data.texts[index] ?? ''));
  }

  renderCellEditors() {
    const container = document.getElementById('cellEditors');
    container.replaceChildren();
    if (!this.cells.length) {
      container.textContent = '框選表格區域以偵測格子。';
      return;
    }
    const fragment = document.createDocumentFragment();
    this.cells.forEach((_, index) => {
      const row = document.createElement('label');
      row.className = 'cell-editor';
      const title = document.createElement('span');
      title.textContent = `格 #${index + 1}`;
      const input = document.createElement('textarea');
      input.rows = 2;
      input.dataset.cellIndex = String(index);
      input.value = this.cellTexts[index] ?? '';
      input.setAttribute('aria-label', `格子 ${index + 1} 的文字`);
      row.append(title, input);
      fragment.append(row);
    });
    container.append(fragment);
  }

  adjustSelectedCells(direction) {
    if (!this.cells.length) return;
    const indexes = parseCellIndices(document.getElementById('cellRange').value, this.cells.length);
    const step = Math.min(20, Math.max(0.1, Number(document.getElementById('adjustStep').value) || 1));
    const changes = {
      up: [0, -step, 0, 0], down: [0, step, 0, 0], left: [-step, 0, 0, 0], right: [step, 0, 0, 0],
      'width-dec': [0, 0, -step, 0], 'width-inc': [0, 0, step, 0],
      'height-dec': [0, 0, 0, -step], 'height-inc': [0, 0, 0, step],
    }[direction];
    if (!changes || !indexes.length) return;
    const [dx, dy, dw, dh] = changes;
    for (const index of indexes) {
      const old = this.cells[index];
      const next = {
        x0: old.x0 + dx - dw / 2, y0: old.y0 + dy - dh / 2,
        x1: old.x1 + dx + dw / 2, y1: old.y1 + dy + dh / 2,
      };
      if (next.x1 - next.x0 >= 5 && next.y1 - next.y0 >= 5) this.cells[index] = next;
    }
    this._renderOverlay();
    this.saveCurrentPageState();
  }

  resetSelectedCells() {
    const indexes = parseCellIndices(document.getElementById('cellRange').value, this.cells.length);
    for (const index of indexes) if (this.originalCells[index]) this.cells[index] = { ...this.originalCells[index] };
    this._renderOverlay();
    this.saveCurrentPageState();
  }

  updateTextStyle() {
    this.textStyle = normalizeTextStyle({
      font_size: document.getElementById('fontSize').value,
      line_spacing: document.getElementById('lineSpacing').value,
      auto_fit: document.getElementById('autoFit').checked,
    });
    this._renderOverlay();
  }

  async saveProject() {
    this.saveCurrentPageState();
    if (!Object.keys(this.projectData).length) return this._log('目前沒有表格編輯資料可儲存');
    const orderedData = Object.fromEntries(Object.entries(this.projectData).sort((a, b) => Number(a[0]) - Number(b[0])));
    const data = { pdf_path: this.pdfPath || this.pdfFileName, style: this.textStyle, project_data: orderedData };
    try {
      const saved = await saveBlobWithPicker(projectBlob(data), {
        suggestedName: 'pdf_editor_project.json', mimeType: 'application/json', extension: '.json', description: 'JSON 專案',
      });
      this._log(saved.method === 'picker'
        ? `JSON 專案已儲存：${saved.fileName}（${Object.keys(this.projectData).length} 頁）`
        : `JSON 專案已送至瀏覽器下載：${saved.fileName}（${Object.keys(this.projectData).length} 頁）`);
    } catch (error) {
      if (error.name === 'AbortError') return this._log('已取消 JSON 儲存');
      throw error;
    }
  }

  async loadCjkFont(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fontFace = new FontFace('PDFEditorKaiTi', bytes);
    await fontFace.load();
    document.fonts.add(fontFace);
    this.cjkFontBytes = bytes;
    this.cjkFontName = file.name;
    this._updateFontStatus();
    this._renderOverlay();
  }

  async loadLatinFont(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const face = new FontFace('PDFEditorCalibri', bytes);
    await face.load();
    document.fonts.add(face);
    this.calibriFontBytes = bytes;
    this._updateFontStatus();
    this._renderOverlay();
  }

  _updateFontStatus() {
    const latin = this.calibriFontBytes
      ? '英數：Calibri 已載入並將嵌入 PDF'
      : '英數預覽：系統 Calibri；PDF 使用 Calibri 字型名稱（未嵌入）';
    const cjk = this.cjkFontBytes
      ? `中文：${this.cjkFontName} 已載入並將嵌入 PDF`
      : '中文預覽：系統標楷體；若缺少字型，請從 C:\\Windows\\Fonts\\ 複製 kaiu.ttf 到「下載」，再載入字型';
    document.getElementById('fontStatus').textContent = `${latin}。${cjk}。`;
  }

  async exportPdf() {
    if (!this.pdfFile) return this._log('請先載入原始 PDF');
    this.saveCurrentPageState();
    if (!Object.keys(this.projectData).length) return this._log('沒有表格編輯內容可匯出');
    const needsKaiTi = Object.values(this.projectData).some(page => (page.texts || []).some(text =>
      Array.from(String(text ?? '')).some(character => fontKeyForCharacter(character) === 'KaiTi')));
    if (needsKaiTi && !this.cjkFontBytes) {
      const message = '偵測到中文或中文標點，但尚未載入標楷體。請到 C:\\Windows\\Fonts\\ 複製 kaiu.ttf 到「下載」資料夾，再按「嵌入標楷體」選取該檔案。';
      this._log(message);
      window.alert(message);
      return;
    }
    const saveOptions = {
      suggestedName: `${this.pdfFileName.replace(/\.pdf$/i, '')}_edited.pdf`,
      mimeType: 'application/pdf', extension: '.pdf', description: 'PDF 文件',
    };
    try {
      // Open the save dialog directly from the click handler, before async PDF
      // generation can consume the browser's transient user activation.
      const saveTarget = await chooseSaveTarget(saveOptions);
      const { exportEditedPdf } = await import('../pdf/pdf-export-service.js');
      const result = await exportEditedPdf(this.pdfFile, this.projectData, this.textStyle, this.calibriFontBytes, this.cjkFontBytes);
      if (!result.writtenPages) return this._log('專案中沒有非空白儲存格文字');
      const blob = new Blob([result.bytes], { type: 'application/pdf' });
      const saved = saveTarget
        ? await writeBlobToTarget(saveTarget, blob)
        : downloadBlob(blob, saveOptions.suggestedName);
      this._log(saved.method === 'picker'
        ? `PDF 已儲存：${saved.fileName}；原始 PDF 未更動。`
        : `PDF 已送至瀏覽器下載：${saved.fileName}；原始 PDF 未更動。`);
    } catch (error) {
      if (error.name === 'AbortError') return this._log('已取消 PDF 儲存');
      this._log(`PDF 匯出失敗: ${error.message}`);
      if (/標楷體|Calibri/.test(error.message)) window.alert(error.message);
    }
  }

  async loadProject(file) {
    const project = normalizeProject(JSON.parse(await file.text()));
    this.projectData = project.project_data;
    this.textStyle = project.style;
    this.pdfPath = project.pdf_path;
    this.projectPending = !this.pdfDoc;
    document.getElementById('fontSize').value = this.textStyle.font_size;
    document.getElementById('lineSpacing').value = this.textStyle.line_spacing;
    document.getElementById('autoFit').checked = this.textStyle.auto_fit;
    if (this.pdfDoc) {
      const pages = Object.keys(this.projectData).map(key => Number(key) + 1).filter(page => page <= this.pdfDoc.numPages);
      this.pageNumbers = pages.length ? pages : [1];
      document.getElementById('pageRange').value = this.pageNumbers.join(',');
      this.populatePageSelect();
      await this.loadPage(this.pageNumbers[0], false);
    }
    this._log(this.pdfDoc
      ? `已載入 JSON 專案：${Object.keys(this.projectData).length} 頁`
      : `已讀取 JSON 專案；請載入對應 PDF（專案記錄 ${Object.keys(this.projectData).length} 頁）`);
  }

  _renderOverlay() {
    if (!this.annotationOverlay) return;
    const rect = this.viewer.getBoundingClientRect();
    this.annotationOverlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    const ns = 'http://www.w3.org/2000/svg';
    const make = (name, attributes) => {
      const element = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
      return element;
    };
    this.annotationOverlay.replaceChildren();
    const drawPageRect = (pageRect, className) => {
      const topLeft = this.pageToScreen({ x: pageRect.x0, y: pageRect.y0 });
      const bottomRight = this.pageToScreen({ x: pageRect.x1, y: pageRect.y1 });
      const box = make('rect', {
        x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y,
        class: className,
      });
      this.annotationOverlay.append(box);
    };
    if (this.userROI) drawPageRect(this.userROI, 'user-roi');
    this.cells.forEach((cell, index) => {
      const topLeft = this.pageToScreen({ x: cell.x0, y: cell.y0 });
      const bottomRight = this.pageToScreen({ x: cell.x1, y: cell.y1 });
      this.annotationOverlay.append(make('rect', {
        x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y,
        class: 'detected-cell',
      }));
      const markerRadius = 9;
      this.annotationOverlay.append(make('circle', { cx: topLeft.x, cy: topLeft.y, r: markerRadius, class: 'cell-marker' }));
      const marker = make('text', { x: topLeft.x, y: topLeft.y + 3, class: 'cell-marker-text' });
      marker.textContent = String(index + 1);
      this.annotationOverlay.append(marker);
      const layout = layoutCell(this.cellTexts[index], cell, this.textStyle);
      if (!layout) return;
      for (const line of layout.lines) for (const run of line.runs) {
        const baseline = this.pageToScreen({ x: run.x, y: line.baseline });
        const preview = make('text', {
          x: baseline.x, y: baseline.y, class: 'cell-preview',
          'font-size': layout.fontSize * this.zoom, 'font-family': run.family,
        });
        preview.textContent = run.text;
        this.annotationOverlay.append(preview);
      }
    });
    if (this.currentROIScreen) this.annotationOverlay.append(make('rect', {
      x: this.currentROIScreen.x, y: this.currentROIScreen.y,
      width: this.currentROIScreen.width, height: this.currentROIScreen.height, class: 'roi-preview',
    }));
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
    const draws = this.backend.render(matrix, {
      zoom: this.zoom, dpr: this.dpr, pageWidth: this.pageWidth, pageHeight: this.pageHeight,
      width: rect.width, height: rect.height, panX: this.panX, panY: this.panY,
    });
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
