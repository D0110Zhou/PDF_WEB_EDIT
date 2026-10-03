import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fontKeyForCharacter, layoutCell } from '../layout/text-layout.js';

function encodeLatinText(text, font) {
  return Array.from(text, character => {
    try {
      font.encodeText(character);
      return character;
    } catch {
      throw new Error(`字元「${character}」無法由目前的 Calibri 資源編碼。請到 C:\\Windows\\Fonts\\ 複製 calibri.ttf 到「下載」資料夾，再按「嵌入 Calibri」載入。`);
    }
  }).join('');
}

function createSystemCalibriFont(pdf) {
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

function registerAcroFormFont(pdf, resourceName, fontRef) {
  const acroForm = pdf.catalog.getOrCreateAcroForm();
  const context = pdf.context;
  const drKey = PDFName.of('DR');
  const fontKey = PDFName.of('Font');
  let defaultResources = acroForm.dict.lookupMaybe(drKey, PDFDict);
  if (!defaultResources) {
    defaultResources = context.obj({});
    acroForm.dict.set(drKey, defaultResources);
  }
  let fonts = defaultResources.lookupMaybe(fontKey, PDFDict);
  if (!fonts) {
    fonts = context.obj({});
    defaultResources.set(fontKey, fonts);
  }
  fonts.set(PDFName.of(resourceName), fontRef);
}

function xmlEscape(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function addFreeTextLine(pdf, page, runs, fonts, cell, baseline, fontSize) {
  const pageHeight = page.getHeight();
  const top = baseline - fontSize * 0.75;
  const bottom = top + fontSize * 1.3;
  const width = cell.x1 - cell.x0, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const y = height - (baseline - top);
  const usedFonts = {};
  const content = ['q', 'BT', '0 g'];
  for (const run of runs) {
    const font = fonts[run.fontKey];
    if (!font) throw new Error(`缺少 ${run.fontKey} 字型；請先載入對應字型檔。`);
    const encodedText = run.fontKey === 'Calibri'
      ? encodeLatinText(run.text, font.encoder)
      : run.text;
    const encoded = font.encoder.encodeText(encodedText).toString();
    const x = Math.max(0, run.x - cell.x0);
    content.push(`/${run.fontKey} ${fontSize.toFixed(2)} Tf`);
    content.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${encoded} Tj`);
    usedFonts[run.fontKey] = font.fontRef;
  }
  content.push('ET', 'Q');
  const context = pdf.context;
  const appearance = context.flateStream(content.join('\n'), {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height],
    Resources: { Font: usedFonts },
  });
  const appearanceRef = context.register(appearance);
  const text = runs.map(run => run.text).join('');
  const defaultFontKey = runs[0]?.fontKey ?? 'Calibri';
  const defaultFontFamily = fonts[defaultFontKey]?.family ?? 'Calibri';
  const richText = `<body xmlns="http://www.w3.org/1999/xhtml"><p style="font-size:${fontSize.toFixed(2)}pt;text-align:center;color:#000000">${runs.map(run => {
    const family = fonts[run.fontKey]?.family ?? 'Calibri';
    return `<span style="font-family:${family}">${xmlEscape(run.text)}</span>`;
  }).join('')}</p></body>`;
  const annotation = context.obj({
    Type: 'Annot', Subtype: 'FreeText',
    Rect: [cell.x0, pageHeight - bottom, cell.x1, pageHeight - top],
    Contents: PDFHexString.fromText(text),
    F: 4, Q: 1,
    DA: PDFString.of(`/${defaultFontKey} ${fontSize.toFixed(2)} Tf 0 g`),
    DS: PDFString.of(`font: ${defaultFontFamily} ${fontSize.toFixed(1)}pt; text-align: center; color: #000000;`),
    RC: PDFHexString.fromText(richText),
    DR: { Font: usedFonts },
    BS: { W: 0 },
    AP: { N: appearanceRef },
  });
  page.node.addAnnot(context.register(annotation));
}

export async function exportEditedPdf(file, projectData, style, calibriFontBytes, cjkFontBytes) {
  const needsKaiTi = Object.values(projectData).some(page => (page.texts || []).some(text =>
    Array.from(String(text ?? '')).some(character => fontKeyForCharacter(character) === 'KaiTi')));
  if (needsKaiTi && !cjkFontBytes) {
    throw new Error('偵測到需要標楷體的中文字或中文標點。請到 C:\\Windows\\Fonts\\ 複製 kaiu.ttf 到「下載」資料夾，再選取該檔案載入標楷體。');
  }

  const pdf = await PDFDocument.load(await file.arrayBuffer());
  pdf.registerFontkit(fontkit);
  const embeddedCalibri = calibriFontBytes
    ? await pdf.embedFont(calibriFontBytes, { subset: true })
    : null;
  // Use a Calibri font resource by name for editable FreeText annotations.
  const latinEncoder = embeddedCalibri || await pdf.embedFont(StandardFonts.Helvetica);
  const calibriFontRef = embeddedCalibri?.ref ?? createSystemCalibriFont(pdf);
  const cjkFont = cjkFontBytes ? await pdf.embedFont(cjkFontBytes, { subset: true }) : null;
  const fonts = {
    Calibri: { fontRef: calibriFontRef, encoder: latinEncoder, family: 'Calibri' },
    ...(cjkFont ? { KaiTi: { fontRef: cjkFont.ref, encoder: cjkFont, family: 'DFKai-SB' } } : {}),
  };
  registerAcroFormFont(pdf, 'Calibri', calibriFontRef);
  if (cjkFont) registerAcroFormFont(pdf, 'KaiTi', cjkFont.ref);
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
        if (!line.runs.map(run => run.text).join('').trim()) continue;
        addFreeTextLine(pdf, page, line.runs, fonts, { x0, x1, y0, y1 }, line.baseline, layout.fontSize);
      }
      wrote = true;
    }
    if (wrote) writtenPages++;
  }

  return { bytes: await pdf.save(), writtenPages };
}
