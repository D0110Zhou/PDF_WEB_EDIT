import * as pdfjsLib from 'pdfjs-dist';

const OPS = pdfjsLib.OPS;
const PATH = Object.freeze({ MOVE: 0, LINE: 1, CUBIC: 2, QUADRATIC: 3, CLOSE: 4 });

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Collect straight vector segments in the same top-left page coordinates as PDF.js viewports. */
export function extractVectorLines(opList, pageTransform) {
  const lines = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const point = (x, y) => {
    const u = [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const [a, b, c, d, e, f] = pageTransform;
    return [a * u[0] + c * u[1] + e, b * u[0] + d * u[1] + f];
  };
  const add = (p1, p2) => {
    if (!p1 || !p2) return;
    const [x1, y1] = p1, [x2, y2] = p2;
    if (Math.hypot(x2 - x1, y2 - y1) > 1e-3) lines.push({ x1, y1, x2, y2 });
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const op = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (op === OPS.save) stack.push(ctm.slice());
    else if (op === OPS.restore) ctm = stack.pop() || ctm;
    else if (op === OPS.transform && args?.length >= 6) ctm = multiply(ctm, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      const formMatrix = args?.[0];
      if (formMatrix?.length === 6) ctm = multiply(ctm, formMatrix);
    } else if (op === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (op === OPS.constructPath) {
      if (typeof args?.[0] === 'number' && Array.isArray(args[1])) {
        for (const encoded of args[1]) {
          let current = null;
          let start = null;
          for (let p = 0; p < encoded.length;) {
            const code = encoded[p++];
            if (code === PATH.MOVE) {
              current = point(encoded[p++], encoded[p++]);
              start = current;
            } else if (code === PATH.LINE) {
              const next = point(encoded[p++], encoded[p++]);
              add(current, next);
              current = next;
            } else if (code === PATH.CUBIC) {
              p += 4;
              current = point(encoded[p++], encoded[p++]);
            } else if (code === PATH.QUADRATIC) {
              p += 2;
              current = point(encoded[p++], encoded[p++]);
            } else if (code === PATH.CLOSE) {
              add(current, start);
              current = start;
            } else break;
          }
        }
      } else {
        // Older PDF.js builds expose path drawing opcodes separately.
        const [pathOps, data] = Array.isArray(args?.[0]) && Array.isArray(args?.[1])
          ? (args[0].length <= args[1].length ? [args[0], args[1]] : [args[1], args[0]])
          : [null, null];
        if (!pathOps || !data) continue;
        let offset = 0, current = null, start = null;
        for (const pathOp of pathOps) {
          if (pathOp === OPS.moveTo || pathOp === OPS.lineTo) {
            const next = point(data[offset++], data[offset++]);
            if (pathOp === OPS.lineTo) add(current, next);
            else start = next;
            current = next;
          } else if (pathOp === OPS.rectangle) {
            const x = data[offset++], y = data[offset++], w = data[offset++], h = data[offset++];
            const corners = [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
            for (let k = 0; k < 4; k++) add(corners[k], corners[(k + 1) % 4]);
            current = start = null;
          } else if (pathOp === OPS.closePath) {
            add(current, start);
            current = start;
          } else if (pathOp === OPS.curveTo) {
            offset += 4;
            current = point(data[offset++], data[offset++]);
          } else if (pathOp === OPS.curveTo2) {
            offset += 2;
            current = point(data[offset++], data[offset++]);
          } else if (pathOp === OPS.curveTo3) {
            offset += 2;
            current = point(data[offset++], data[offset++]);
          }
        }
      }
    }
  }
  return lines;
}

function cluster(values, tolerance = 1.5) {
  values.sort((a, b) => a.value - b.value);
  const groups = [];
  for (const item of values) {
    const last = groups.at(-1);
    if (!last || item.value - last.values.at(-1) > tolerance) groups.push({ values: [item.value], intervals: [] });
    else last.values.push(item.value);
    groups.at(-1).intervals.push(item.interval);
  }
  return groups.map(group => ({
    value: group.values.reduce((sum, value) => sum + value, 0) / group.values.length,
    intervals: group.intervals,
  }));
}

function coveredFraction(intervals, start, end) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(start, Math.min(a, b)), Math.min(end, Math.max(a, b))])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, edge = -Infinity;
  for (const [a, b] of clipped) {
    const left = Math.max(a, edge);
    if (b > left) total += b - left;
    edge = Math.max(edge, b);
  }
  return total / Math.max(1e-6, end - start);
}

/** Construct cell rectangles where all four neighboring grid edges are present. */
export function detectVectorCells(lines, roi) {
  const horizontal = [], vertical = [];
  for (const line of lines) {
    const { x1, y1, x2, y2 } = line;
    if (Math.abs(y2 - y1) <= 0.75) {
      const y = (y1 + y2) / 2, left = Math.max(roi.x0, Math.min(x1, x2)), right = Math.min(roi.x1, Math.max(x1, x2));
      if (right - left >= 6 && y >= roi.y0 - 2 && y <= roi.y1 + 2) horizontal.push({ value: y, interval: [left, right] });
    } else if (Math.abs(x2 - x1) <= 0.75) {
      const x = (x1 + x2) / 2, top = Math.max(roi.y0, Math.min(y1, y2)), bottom = Math.min(roi.y1, Math.max(y1, y2));
      if (bottom - top >= 6 && x >= roi.x0 - 2 && x <= roi.x1 + 2) vertical.push({ value: x, interval: [top, bottom] });
    }
  }

  const rows = cluster(horizontal), columns = cluster(vertical);
  const cells = [];
  for (let row = 0; row < rows.length - 1; row++) {
    const y0 = rows[row].value, y1 = rows[row + 1].value;
    if (y1 - y0 < 5) continue;
    for (let col = 0; col < columns.length - 1; col++) {
      const x0 = columns[col].value, x1 = columns[col + 1].value;
      if (x1 - x0 < 5) continue;
      const width = x1 - x0, height = y1 - y0;
      const top = coveredFraction(rows[row].intervals, x0, x1);
      const bottom = coveredFraction(rows[row + 1].intervals, x0, x1);
      const left = coveredFraction(columns[col].intervals, y0, y1);
      const right = coveredFraction(columns[col + 1].intervals, y0, y1);
      if (top >= 0.78 && bottom >= 0.78 && left >= 0.78 && right >= 0.78) {
        cells.push({ x0, y0, x1, y1 });
      }
    }
  }
  return { cells, horizontalLines: rows.length, verticalLines: columns.length };
}
