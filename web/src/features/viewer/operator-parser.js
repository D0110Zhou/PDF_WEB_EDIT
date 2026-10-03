import * as pdfjsLib from 'pdfjs-dist';
import { flattenBezier, scanlineFill } from './vector-geometry.js';
const OPS = pdfjsLib.OPS;

// PDF.js packs path commands into Float32Array buffers. These compact drawing
// opcodes are distinct from the public PDF.js OPS constants above.
const DRAW_PATH_OP = Object.freeze({ MOVE_TO: 0, LINE_TO: 1, CURVE_TO: 2, QUADRATIC_TO: 3, CLOSE: 4 });

function parseOperators(opList) {
  const fns  = opList.fnArray;
  const args = opList.argsArray;
  const batches = [];
  const stats = { constructPath: 0, pathMatched: 0, fill: 0, stroke: 0,
                  endPath: 0, formBegin: 0, formEnd: 0, joins: 0 };

  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  let fillColor = [0, 0, 0, 1];
  let strokeColor = [0, 0, 0, 1];
  let lineWidth = 1;
  let lineCap = 0;
  let lineJoin = 0;
  let pendingPolys = [];

  const applyCTM = (x, y) => {
    const [a, b, c, d, e, f] = ctm;
    return [a*x + c*y + e, b*x + d*y + f];
  };
  const scaleLineWidth = w => {
    const [a, b, c, d] = ctm;
    return w * (Math.hypot(a, b) + Math.hypot(c, d)) / 2;
  };
  const mulCTM = (m1, m2) => {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1*a2 + c1*b2, b1*a2 + d1*b2,
      a1*c2 + c1*d2, b1*c2 + d1*d2,
      a1*e2 + c1*f2 + e1, b1*e2 + d1*f2 + f1,
    ];
  };
  const grayToRGB = v => [v, v, v];
  const cmykToRGB = (c, m, y, k) => [(1-c)*(1-k), (1-m)*(1-k), (1-y)*(1-k)];

  // ★ 填色用 scanline（無縫隙）；只有非常小的路徑（< 32 點）才用 earcut 快速路徑
  const emitFill = polys => {
    const [r, g, b] = fillColor;

    // 邊界框快速判斷，避免極小或極大的路徑浪費時間
    let totalPts = 0;
    for (const p of polys) totalPts += p.length;
    if (totalPts === 0) return;

    const { vertices, indices } = scanlineFill(polys, 0.4);
    if (!indices.length) return;

    batches.push({
      kind: 'fill',
      vertices,
      indices,
      color: [r, g, b, 1],
    });
  };

  const emitStroke = polys => {
    const verts = [], indices = [];
    const [r, g, b] = strokeColor;
    const halfW = Math.max(scaleLineWidth(lineWidth) / 2, 0.05);

    const pushTri = (ax, ay, bx, by, cx, cy) => {
      const base = verts.length / 2;
      verts.push(ax, ay, bx, by, cx, cy);
      indices.push(base, base + 1, base + 2);
    };

    const quad = (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      const nx = -dy / len * halfW, ny = dx / len * halfW;
      pushTri(ax+nx, ay+ny, bx+nx, by+ny, bx-nx, by-ny);
      pushTri(ax+nx, ay+ny, bx-nx, by-ny, ax-nx, ay-ny);
    };

    // 頂點圓盤（12 段近似）
    const disc = (cx, cy) => {
      const seg = 12;
      const PI2 = Math.PI * 2;
      let px = cx + halfW, py = cy;
      for (let i = 1; i <= seg; i++) {
        const a = (i / seg) * PI2;
        const qx = cx + Math.cos(a) * halfW;
        const qy = cy + Math.sin(a) * halfW;
        pushTri(cx, cy, px, py, qx, qy);
        px = qx; py = qy;
      }
    };

    for (const poly of polys) {
      if (poly.length < 2) continue;
      for (let i = 0; i < poly.length - 1; i++) {
        quad(poly[i][0], poly[i][1], poly[i+1][0], poly[i+1][1]);
      }

      const isClosed =
        poly.length >= 3 &&
        Math.abs(poly[0][0] - poly[poly.length-1][0]) < 1e-6 &&
        Math.abs(poly[0][1] - poly[poly.length-1][1]) < 1e-6;

      const innerEnd = isClosed ? poly.length - 1 : poly.length;
      for (let i = 1; i < innerEnd; i++) {
        disc(poly[i][0], poly[i][1]);
        stats.joins++;
      }
      if (isClosed && poly.length >= 3) {
        disc(poly[0][0], poly[0][1]);
        stats.joins++;
      }
      if (!isClosed && lineCap === 1 && poly.length >= 2) {
        disc(poly[0][0], poly[0][1]);
        disc(poly[poly.length-1][0], poly[poly.length-1][1]);
        stats.joins += 2;
      }
    }

    if (indices.length) {
      batches.push({
        kind: 'stroke',
        vertices: new Float32Array(verts),
        indices:  new Uint32Array(indices),
        color: [r, g, b, 1],
      });
    }
  };

  for (let i = 0; i < fns.length; i++) {
    const op = fns[i], a = args[i];
    switch (op) {
      case OPS.save:    ctmStack.push(ctm.slice()); break;
      case OPS.restore: if (ctmStack.length) ctm = ctmStack.pop(); break;
      case OPS.transform: ctm = mulCTM(ctm, a); break;

      case OPS.paintFormXObjectBegin: {
        stats.formBegin++;
        ctmStack.push(ctm.slice());
        const formMatrix = a && a[0];
        if (formMatrix && formMatrix.length === 6) ctm = mulCTM(ctm, formMatrix);
        break;
      }
      case OPS.paintFormXObjectEnd: {
        stats.formEnd++;
        if (ctmStack.length) ctm = ctmStack.pop();
        break;
      }

      case OPS.setLineWidth:        lineWidth = a[0]; break;
      case OPS.setLineCap:          lineCap = a[0]; break;
      case OPS.setLineJoin:         lineJoin = a[0]; break;
      case OPS.setFillRGBColor:     fillColor = a; break;
      case OPS.setStrokeRGBColor:   strokeColor = a; break;
      case OPS.setFillGray:         fillColor = grayToRGB(a[0]); break;
      case OPS.setStrokeGray:       strokeColor = grayToRGB(a[0]); break;
      case OPS.setFillCMYKColor:    fillColor = cmykToRGB(a[0], a[1], a[2], a[3]); break;
      case OPS.setStrokeCMYKColor:  strokeColor = cmykToRGB(a[0], a[1], a[2], a[3]); break;

      case OPS.constructPath: {
        stats.constructPath++;
        if (!Array.isArray(a) || a.length < 2) break;

        // Current PDF.js builds use [operationCount, Float32Array[], bounds].
        // Keep this path alongside the older split ops/coordinates format.
        if (typeof a[0] === 'number' && Array.isArray(a[1]) &&
            a[1].every(segment => ArrayBuffer.isView(segment))) {
          for (const encoded of a[1]) {
            let index = 0;
            let poly = [];
            const finishOpenPath = () => {
              if (poly.length > 1) pendingPolys.push(poly);
              poly = [];
            };
            while (index < encoded.length) {
              const pathOp = encoded[index++];
              switch (pathOp) {
                case DRAW_PATH_OP.MOVE_TO:
                  finishOpenPath();
                  poly.push(applyCTM(encoded[index++], encoded[index++]));
                  break;
                case DRAW_PATH_OP.LINE_TO:
                  poly.push(applyCTM(encoded[index++], encoded[index++]));
                  break;
                case DRAW_PATH_OP.CURVE_TO: {
                  const p0 = poly.length ? poly[poly.length - 1] : [0, 0];
                  const c1 = applyCTM(encoded[index++], encoded[index++]);
                  const c2 = applyCTM(encoded[index++], encoded[index++]);
                  const end = applyCTM(encoded[index++], encoded[index++]);
                  flattenBezier(p0, c1, c2, end, poly);
                  break;
                }
                case DRAW_PATH_OP.QUADRATIC_TO: {
                  const p0 = poly.length ? poly[poly.length - 1] : [0, 0];
                  const control = applyCTM(encoded[index++], encoded[index++]);
                  const end = applyCTM(encoded[index++], encoded[index++]);
                  const c1 = [p0[0] + (control[0] - p0[0]) * (2 / 3), p0[1] + (control[1] - p0[1]) * (2 / 3)];
                  const c2 = [end[0] + (control[0] - end[0]) * (2 / 3), end[1] + (control[1] - end[1]) * (2 / 3)];
                  flattenBezier(p0, c1, c2, end, poly);
                  break;
                }
                case DRAW_PATH_OP.CLOSE:
                  if (poly.length > 1) {
                    poly.push([poly[0][0], poly[0][1]]);
                    pendingPolys.push(poly);
                  }
                  poly = [];
                  break;
                default:
                  // Unknown opcodes cannot be safely decoded; stop this path.
                  index = encoded.length;
                  finishOpenPath();
                  break;
              }
            }
            finishOpenPath();
          }
          stats.pathMatched++;
          const paintOp = a[0];
          const doFill = paintOp === OPS.fill || paintOp === OPS.eoFill ||
            paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke ||
            paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
          const doStroke = paintOp === OPS.stroke || paintOp === OPS.closeStroke ||
            paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke ||
            paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
          if (doFill && pendingPolys.length) { emitFill(pendingPolys); stats.fill++; }
          if (doStroke && pendingPolys.length) { emitStroke(pendingPolys); stats.stroke++; }
          if (!doFill && !doStroke && paintOp === OPS.endPath) stats.endPath++;
          pendingPolys = [];
          break;
        }

        let pathData, pathOps;
        const p0 = a[0], p1 = a[1];
        if (Array.isArray(p0) && Array.isArray(p1)) {
          if (p0.length <= p1.length) { pathOps = p0; pathData = p1; }
          else                        { pathData = p0; pathOps = p1; }
        } else break;

        let ai = 0;
        let poly = [];
        for (const po of pathOps) {
          switch (po) {
            case OPS.moveTo:
              if (poly.length > 1) pendingPolys.push(poly);
              poly = [];
              poly.push(applyCTM(pathData[ai++], pathData[ai++]));
              break;
            case OPS.lineTo:
              poly.push(applyCTM(pathData[ai++], pathData[ai++]));
              break;
            case OPS.curveTo: {
              const x1 = pathData[ai++], y1 = pathData[ai++];
              const x2 = pathData[ai++], y2 = pathData[ai++];
              const x3 = pathData[ai++], y3 = pathData[ai++];
              const last = poly.length ? poly[poly.length - 1] : [0, 0];
              flattenBezier(last, applyCTM(x1, y1), applyCTM(x2, y2), applyCTM(x3, y3), poly);
              break;
            }
            case OPS.curveTo2: {
              const x2 = pathData[ai++], y2 = pathData[ai++];
              const x3 = pathData[ai++], y3 = pathData[ai++];
              const last = poly.length ? poly[poly.length - 1] : [0, 0];
              flattenBezier(last, last, applyCTM(x2, y2), applyCTM(x3, y3), poly);
              break;
            }
            case OPS.curveTo3: {
              const x1 = pathData[ai++], y1 = pathData[ai++];
              const x3 = pathData[ai++], y3 = pathData[ai++];
              const last = poly.length ? poly[poly.length - 1] : [0, 0];
              const c1 = applyCTM(x1, y1), c3 = applyCTM(x3, y3);
              flattenBezier(last, c1, c3, c3, poly);
              break;
            }
            case OPS.closePath: {
              if (poly.length > 1) {
                poly.push([poly[0][0], poly[0][1]]);
                pendingPolys.push(poly);
              }
              poly = [];
              break;
            }
            case OPS.rectangle: {
              const x = pathData[ai++], y = pathData[ai++];
              const w = pathData[ai++], h = pathData[ai++];
              if (poly.length > 1) pendingPolys.push(poly);
              poly = [];
              const p1 = applyCTM(x, y);
              const p2 = applyCTM(x + w, y);
              const p3 = applyCTM(x + w, y + h);
              const p4 = applyCTM(x, y + h);
              pendingPolys.push([p1, p2, p3, p4, [p1[0], p1[1]]]);
              break;
            }
          }
        }
        if (poly.length > 1) pendingPolys.push(poly);
        stats.pathMatched++;
        break;
      }

      case OPS.fill:
      case OPS.eoFill:
      case OPS.stroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke: {
        if (!pendingPolys.length) break;
        const doFill   = op === OPS.fill   || op === OPS.eoFill ||
                         op === OPS.fillStroke || op === OPS.eoFillStroke;
        const doStroke = op === OPS.stroke ||
                         op === OPS.fillStroke || op === OPS.eoFillStroke;
        if (doFill)   { emitFill(pendingPolys.map(p => p.slice()));   stats.fill++; }
        if (doStroke) { emitStroke(pendingPolys.map(p => p.slice())); stats.stroke++; }
        pendingPolys = [];
        break;
      }

      case OPS.endPath:
        stats.endPath++;
        pendingPolys = [];
        break;
    }
  }

  console.log('[parseOperators] 統計:', stats);
  return batches;
}

// ═════════════════════════════════════════════════════════════
// 4. 合併工具
// ═════════════════════════════════════════════════════════════


export { parseOperators };
