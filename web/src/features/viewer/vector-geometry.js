import * as pdfjsLib from 'pdfjs-dist';
const OPS = pdfjsLib.OPS;

export function flattenBezier(p0, p1, p2, p3, out, minSteps = 8, maxSteps = 256) {
  const chord =
    Math.hypot(p1[0]-p0[0], p1[1]-p0[1]) +
    Math.hypot(p2[0]-p1[0], p2[1]-p1[1]) +
    Math.hypot(p3[0]-p2[0], p3[1]-p2[1]);
  const steps = Math.min(maxSteps, Math.max(minSteps, Math.ceil(chord * 2)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t;
    const x = mt*mt*mt*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t*t*t*p3[0];
    const y = mt*mt*mt*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t*t*t*p3[1];
    out.push([x, y]);
  }
}

// ═════════════════════════════════════════════════════════════
// 2. 掃描線奇偶填充（消除白色縫隙）
// ═════════════════════════════════════════════════════════════

/**
 * 用掃描線演算法將一組多邊形（可能帶洞、嵌套）轉為水平長條幾何。
 * 每個長條是一個四邊形（含 0.5px 的重疊避免縫隙）。
 *
 * @param {Array<Array<[number,number]>>} polys 所有輪廓
 * @param {number} scanStep 掃描線間距（pt），預設 0.4
 * @returns { vertices: Float32Array, indices: Uint32Array }
 */
export function scanlineFill(polys, scanStep = 0.4) {
  // 1. 收集所有邊 + y 範圍
  const edges = [];
  let minY = Infinity, maxY = -Infinity;

  for (const poly of polys) {
    if (poly.length < 3) continue;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % n];
      if (y0 === y1) continue;
      edges.push({
        y0: Math.min(y0, y1), y1: Math.max(y0, y1),
        x0: y0 < y1 ? x0 : x1,
        x1: y0 < y1 ? x1 : x0,
      });
      if (y0 < minY) minY = y0;
      if (y0 > maxY) maxY = y0;
      if (y1 < minY) minY = y1;
      if (y1 > maxY) maxY = y1;
    }
  }

  if (!isFinite(minY)) return { vertices: new Float32Array(0), indices: new Uint32Array(0) };

  const spanCount = Math.ceil((maxY - minY) / scanStep);
  if (spanCount <= 0 || spanCount > 200000) {
    // 幾何過於極端，回傳空
    return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
  }

  const verts = [];
  const inds = [];

  // 每條掃描線的 y 中心
  const yStart = minY + scanStep / 2;
  const yEnd   = maxY;
  const overlap = scanStep * 0.15;   // 讓相鄰長條稍微重疊

  for (let y = yStart; y < yEnd; y += scanStep) {
    const xs = [];
    for (const e of edges) {
      if (y >= e.y0 && y < e.y1) {
        const t = (y - e.y0) / (e.y1 - e.y0);
        xs.push(e.x0 + t * (e.x1 - e.x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    // 奇偶：每兩個交點之間填一個長條
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = xs[i], xb = xs[i + 1];
      if (xb - xa < 1e-6) continue;
      const y0 = y - scanStep / 2 - overlap;
      const y1 = y + scanStep / 2 + overlap;
      const base = verts.length / 2;
      verts.push(xa, y0, xb, y0, xb, y1, xa, y1);
      inds.push(base, base+1, base+2, base, base+2, base+3);
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(inds),
  };
}

// ═════════════════════════════════════════════════════════════
// 3. PDF Operator List → 幾何批次
// ═════════════════════════════════════════════════════════════

