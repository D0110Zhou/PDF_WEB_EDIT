export const DEFAULT_TEXT_STYLE = Object.freeze({ font_size: 12, line_spacing: 1, auto_fit: true });

export function normalizeTextStyle(style = {}) {
  const font = Number(style.font_size ?? DEFAULT_TEXT_STYLE.font_size);
  const spacing = Number(style.line_spacing ?? DEFAULT_TEXT_STYLE.line_spacing);
  return {
    font_size: Number.isFinite(font) ? Math.min(72, Math.max(4, font)) : DEFAULT_TEXT_STYLE.font_size,
    line_spacing: Number.isFinite(spacing) ? Math.min(3, Math.max(0.5, spacing)) : DEFAULT_TEXT_STYLE.line_spacing,
    auto_fit: style.auto_fit === undefined ? true : Boolean(style.auto_fit),
  };
}

/** Parse a user-facing 1-based page range into unique, ascending page numbers. */
export function parsePageRange(value, pageCount) {
  const pages = new Set();
  for (const part of value.split(',').map(item => item.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start > end) continue;
    for (let page = start; page <= end && page <= pageCount; page++) {
      if (page >= 1) pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Parse Python's one-based cell index syntax such as "1-4,8,9" into zero-based indices. */
export function parseCellIndices(value, cellCount) {
  const indices = new Set();
  for (const part of value.replaceAll(' ', '').split(',').filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start > end) continue;
    for (let index = start; index <= end && index <= cellCount; index++) {
      if (index >= 1) indices.add(index - 1);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

function validRect(rect) {
  return Array.isArray(rect) && rect.length === 4 && rect.every(value => Number.isFinite(Number(value)));
}

/** Keep the Python PDFWriter project schema: pdf_path, style, project_data. */
export function normalizeProject(data) {
  if (!data || typeof data !== 'object' || !data.project_data || typeof data.project_data !== 'object' || Array.isArray(data.project_data)) {
    throw new Error('JSON 專案需包含 project_data 物件');
  }
  const projectData = {};
  for (const [key, page] of Object.entries(data.project_data)) {
    if (!/^\d+$/.test(key) || !page || typeof page !== 'object') continue;
    const cells = Array.isArray(page.cells) ? page.cells.filter(validRect).map(rect => rect.map(Number)) : [];
    const original = Array.isArray(page.original_cells) ? page.original_cells.filter(validRect).map(rect => rect.map(Number)) : [];
    const texts = Array.isArray(page.texts) ? page.texts.map(text => String(text ?? '')) : [];
    const roi = validRect(page.user_roi) ? page.user_roi.map(Number) : null;
    projectData[key] = { user_roi: roi, cells, original_cells: original, texts };
  }
  return {
    pdf_path: String(data.pdf_path ?? ''),
    style: normalizeTextStyle(data.style),
    project_data: projectData,
  };
}

export function projectBlob(data) {
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
}

export async function chooseSaveTarget({ suggestedName, mimeType, extension, description }) {
  if (typeof window.showSaveFilePicker === 'function') {
    return window.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [mimeType]: [extension] } }],
    });
  }
  return null;
}

export async function writeBlobToTarget(handle, blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
  return { method: 'picker', fileName: handle.name };
}

export function downloadBlob(blob, suggestedName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'download', fileName: suggestedName };
}

export async function saveBlobWithPicker(blob, options) {
  const handle = await chooseSaveTarget(options);
  if (handle) return writeBlobToTarget(handle, blob);
  return downloadBlob(blob, options.suggestedName);
}
