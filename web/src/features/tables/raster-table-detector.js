import { detectVectorCells } from './vector-table-detector.js';

function collectRuns(bits, minLength, maxGap = 4) {
  const positions = [];
  let start = -1;
  for (let index = 0; index <= bits.length; index++) {
    if (bits[index] && start < 0) start = index;
    if ((!bits[index] || index === bits.length) && start >= 0) {
      if (index - start >= minLength) positions.push((start + index - 1) / 2);
      start = -1;
    }
  }
  const groups = [];
  for (const position of positions) {
    const previous = groups.at(-1);
    if (!previous || position - previous.at(-1) > maxGap) groups.push([position]);
    else previous.push(position);
  }
  return groups.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
}

/** Raster fallback corresponding to the PySide6 detector's long horizontal/vertical kernels. */
export async function detectRasterCells(page, roi) {
  const scale = 150 / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, background: '#fff' }).promise;

  const bounds = {
    x0: Math.max(0, Math.floor(roi.x0 * scale)), y0: Math.max(0, Math.floor(roi.y0 * scale)),
    x1: Math.min(canvas.width, Math.ceil(roi.x1 * scale)), y1: Math.min(canvas.height, Math.ceil(roi.y1 * scale)),
  };
  const width = bounds.x1 - bounds.x0, height = bounds.y1 - bounds.y0;
  if (width < 10 || height < 10) return { cells: [], horizontalLines: 0, verticalLines: 0 };
  const pixels = context.getImageData(bounds.x0, bounds.y0, width, height).data;
  const isDark = (x, y) => {
    const offset = (y * width + x) * 4;
    return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114 < 180;
  };
  const minHorizontalRun = Math.max(5, Math.round(width * 0.15));
  const minVerticalRun = Math.max(5, Math.round(height * 0.15));
  const rowBits = new Array(height), columnBits = new Array(width).fill(false);
  const verticalRuns = new Array(width).fill(0);

  for (let y = 0; y < height; y++) {
    let longest = 0, current = 0;
    for (let x = 0; x < width; x++) {
      if (isDark(x, y)) {
        current++;
        verticalRuns[x]++;
        if (verticalRuns[x] >= minVerticalRun) columnBits[x] = true;
      } else { current = 0; verticalRuns[x] = 0; }
      longest = Math.max(longest, current);
    }
    rowBits[y] = longest >= minHorizontalRun;
  }

  const yCuts = collectRuns(rowBits, 1);
  const xCuts = collectRuns(columnBits, 1);
  if (yCuts.length < 2) return { cells: [], horizontalLines: yCuts.length, verticalLines: xCuts.length };
  const x0 = xCuts.length >= 2 ? xCuts[0] : 0;
  const x1 = xCuts.length >= 2 ? xCuts.at(-1) : width;
  if (x1 - x0 < 5) return { cells: [], horizontalLines: yCuts.length, verticalLines: xCuts.length };

  const lines = [];
  for (const y of yCuts) lines.push({ x1: (bounds.x0 + x0) / scale, y1: (bounds.y0 + y) / scale, x2: (bounds.x0 + x1) / scale, y2: (bounds.y0 + y) / scale });
  for (const x of xCuts) lines.push({ x1: (bounds.x0 + x) / scale, y1: (bounds.y0 + yCuts[0]) / scale, x2: (bounds.x0 + x) / scale, y2: (bounds.y0 + yCuts.at(-1)) / scale });
  const scaledROI = { x0: (bounds.x0 + x0) / scale, y0: (bounds.y0 + yCuts[0]) / scale, x1: (bounds.x0 + x1) / scale, y1: (bounds.y0 + yCuts.at(-1)) / scale };
  const result = detectVectorCells(lines, scaledROI);
  return { ...result, horizontalLines: yCuts.length, verticalLines: xCuts.length };
}
