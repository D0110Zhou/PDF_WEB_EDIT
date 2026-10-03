import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { layoutCell } from '../layout/text-layout.js';

const hasCJK = text => /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(text);

function encodeLatinText(text, font) {
  return Array.from(text, character => {
    try {
      font.encodeText(character);
      return character;
    } catch {
      return '?';
    }
  }).join('');
}

async function createSystemCalibriFont(pdf) {
  const loadedFonts = await document.fonts.load('1000px Calibri');
  if (!loadedFonts.length) throw new Error('找不到系統 Calibri 字型；請安裝 Calibri 後再匯出。');
  const context = document.createElement('canvas').getContext('2d');
  context.font = '1000px Calibri';
  if ('fontKerning' in context) context.fontKerning = 'none';
  const decoder = new TextDecoder('windows-1252');
  const widths = [];
  for (let code = 32; code <= 255; code++) {
    const character = decoder.decode(Uint8Array.of(code));
    widths.push(code === 127 || character === '\ufffd'
      ? 0
      : Math.round(context.measureText(character).width));
  }
  const descriptor = pdf.context.register(pdf.context.obj({
    Type: 'FontDescriptor', FontName: PDFName.of('Calibri'), Flags: 32,
    FontBBox: [-500, -250, 1250, 1000], ItalicAngle: 0,
    Ascent: 950, Descent: -250, CapHeight: 700, StemV: 80,
  }));
  return pdf.context.register(pdf.context.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: PDFName.of('Calibri'),
    Encoding: PDFName.of('WinAnsiEncoding'), FirstChar: 32, LastChar: 255,
    Widths: widths, FontDescriptor: descriptor,
  }));
}

function addFreeTextLine(pdf, page, fontRef, encoder, fontKey, text, cell, baseline, fontSize, firstRunX) {
  const pageHeight = page.getHeight();
  const top = baseline - fontSize * 0.75;
  const bottom = top + fontSize * 1.3;
  const width = cell.x1 - cell.x0, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const encoded = encoder.encodeText(text).toString();
  const x = Math.max(0, firstRunX - cell.x0);
  const y = height - (baseline - top);
  const stream = `q BT /${fontKey} ${fontSize.toFixed(2)} Tf 0 g ${x.toFixed(2)} ${y.toFixed(2)} Td ${encoded} Tj ET Q`;
  const context = pdf.context;
  const appearance = context.flateStream(stream, {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height],
    Resources: { Font: { [fontKey]: fontRef } },
  });
  const appearanceRef = context.register(appearance);
  const annotation = context.obj({
    Type: 'Annot', Subtype: 'FreeText',
    Rect: [cell.x0, pageHeight - bottom, cell.x1, pageHeight - top],
    Contents: PDFHexString.fromText(text),
    F: 4, Q: 1,
    DA: PDFString.of(`/${fontKey} ${fontSize.toFixed(2)} Tf 0 g`),
    DS: PDFString.of(`font: ${fontKey} ${fontSize.toFixed(1)}pt; text-align: center; color: #000000;`),
    DR: { Font: { [fontKey]: fontRef } },
    BS: { W: 0 },
    AP: { N: appearanceRef },
  });
  page.node.addAnnot(context.register(annotation));
}

export async function exportEditedPdf(file, projectData, style, calibriFontBytes, cjkFontBytes) {
  const hasCjkText = Object.values(projectData).some(page => (page.texts || []).some(text => hasCJK(String(text ?? ''))));
  if (hasCjkText && !cjkFontBytes) throw new Error('偵測到中文字；請先載入可嵌入的 TTF/OTF 中文字型。');

  const pdf = await PDFDocument.load(await file.arrayBuffer());
  pdf.registerFontkit(fontkit);
  const embeddedCalibri = calibriFontBytes
    ? await pdf.embedFont(calibriFontBytes, { subset: true })
    : null;
  // If the local Vite font endpoint is unavailable, keep using the Windows
  // Calibri resource by name as the PySide6 version does.
  const latinEncoder = embeddedCalibri || await pdf.embedFont(StandardFonts.Helvetica);
  const calibriFontRef = embeddedCalibri?.ref ?? await createSystemCalibriFont(pdf);
  const cjkFont = cjkFontBytes ? await pdf.embedFont(cjkFontBytes, { subset: true }) : null;
  const pages = pdf.getPages();
  let writtenPages = 0;

  for (const [key, pageData] of Object.entries(projectData).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const pageIndex = Number(key);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    let wrote = false;
    for (let index = 0; index < (pageData.cells || []).length; index++) {
      const value = String(pageData.texts?.[index] ?? '');
      if (!value.trim()) continue;
      const coordinates = pageData.cells[index];
      if (!Array.isArray(coordinates) || coordinates.length !== 4) continue;
      const [x0, y0, x1, y1] = coordinates.map(Number);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      const layout = layoutCell(value, { x0, y0, x1, y1 }, style);
      if (!layout) continue;
      for (const line of layout.lines) {
        const text = line.runs.map(run => run.text).join('');
        const usesCjk = hasCJK(text);
        const font = usesCjk ? cjkFont : latinEncoder;
        const fontRef = usesCjk ? cjkFont.ref : calibriFontRef;
        const fontKey = usesCjk ? 'CJK' : 'Calibri';
        const safeText = usesCjk ? text : encodeLatinText(text, latinEncoder);
        const firstRunX = line.runs[0]?.x ?? x0;
        addFreeTextLine(pdf, page, fontRef, font, fontKey, safeText, { x0, x1, y0, y1 }, line.baseline, layout.fontSize, firstRunX);
      }
      wrote = true;
    }
    if (wrote) writtenPages++;
  }

  return { bytes: await pdf.save(), writtenPages };
}
