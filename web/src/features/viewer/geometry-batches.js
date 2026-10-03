function mergeBatches(batches) {
  let vCount = 0, iCount = 0;
  for (const b of batches) {
    vCount += b.vertices.length / 2;
    iCount += b.indices.length;
  }
  if (iCount === 0) {
    return { vertices: new Float32Array(0), indices: new Uint32Array(0),
             vertexCount: 0, indexCount: 0 };
  }
  const vertices = new Float32Array(vCount * 6);
  const indices  = new Uint32Array(iCount);
  let vOff = 0, iOff = 0, vBase = 0;
  for (const b of batches) {
    const [r, g, bl, a] = b.color;
    const nVerts = b.vertices.length / 2;
    for (let i = 0; i < nVerts; i++) {
      vertices[vOff++] = b.vertices[i * 2];
      vertices[vOff++] = b.vertices[i * 2 + 1];
      vertices[vOff++] = r;
      vertices[vOff++] = g;
      vertices[vOff++] = bl;
      vertices[vOff++] = a;
    }
    const nIdx = b.indices.length;
    for (let i = 0; i < nIdx; i++) {
      indices[iOff++] = vBase + b.indices[i];
    }
    vBase += nVerts;
  }
  return { vertices, indices, vertexCount: vCount, indexCount: iCount };
}

// ═════════════════════════════════════════════════════════════
// 5. WebGL 後端
// ═════════════════════════════════════════════════════════════

export { mergeBatches };
