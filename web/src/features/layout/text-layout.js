import { normalizeTextStyle } from '../project/project-service.js';

const context = document.createElement('canvas').getContext('2d');
const CALIBRI_SYMBOLS = new Set(['▼', '㊣', '℃', '℉']);
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const CJK_PUNCTUATION = /[\u3000-\u303f\ufe10-\ufe1f\ufe30-\ufe4f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;

export function fontKeyForCharacter(character) {
  if (CALIBRI_SYMBOLS.has(character)) return 'Calibri';
  return CJK_SCRIPT.test(character) || CJK_PUNCTUATION.test(character) ? 'KaiTi' : 'Calibri';
}

const familyFor = character => fontKeyForCharacter(character) === 'KaiTi'
  ? 'PDFEditorKaiTi, "DFKai-SB", "BiauKai", KaiTi, "標楷體", serif'
  : 'PDFEditorCalibri, Calibri, Arial, sans-serif';

function charWidth(character, size) {
  context.font = `${size}px ${familyFor(character)}`;
  if ('fontKerning' in context) context.fontKerning = 'none';
  return context.measureText(character).width;
}

function textWidth(text, size) {
  let total = 0;
  for (const character of text) total += charWidth(character, size);
  return total;
}

export function wrapText(text, fontSize, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let current = '', currentWidth = 0, lastSpace = -1;
    for (const character of paragraph) {
      if (!current && character === ' ') continue;
      const width = charWidth(character, fontSize);
      if (current && currentWidth + width > maxWidth) {
        if (character === ' ') {
          lines.push(current.trimEnd());
          current = ''; currentWidth = 0; lastSpace = -1;
          continue;
        }
        if (lastSpace >= 0) {
          const head = current.slice(0, lastSpace).trimEnd();
          const tail = current.slice(lastSpace + 1);
          lines.push(head);
          current = tail; currentWidth = textWidth(tail, fontSize); lastSpace = -1;
        } else {
          lines.push(current);
          current = ''; currentWidth = 0; lastSpace = -1;
        }
      }
      current += character;
      currentWidth += width;
      if (character === ' ') lastSpace = current.length - 1;
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function layoutCell(text, rect, styleInput) {
  if (!text || !String(text).trim()) return null;
  const style = normalizeTextStyle(styleInput);
  const width = rect.x1 - rect.x0, height = rect.y1 - rect.y0;
  const availableWidth = Math.max(width - 4, 8);
  const availableHeight = Math.max(height - 2, 5);
  let fontSize = style.font_size;
  let lines;
  while (true) {
    lines = wrapText(text, fontSize, availableWidth);
    if (!style.auto_fit || lines.length * fontSize * style.line_spacing <= availableHeight || fontSize - 0.5 < 5) break;
    fontSize -= 0.5;
  }
  const lineHeight = fontSize * style.line_spacing;
  const contentHeight = fontSize;
  const top = rect.y0 + (height - lines.length * lineHeight) / 2;
  const laidOut = [];
  lines.forEach((line, index) => {
    if (!line) return;
    const runs = [];
    for (const character of line) {
      const fontKey = fontKeyForCharacter(character);
      const family = familyFor(character);
      const last = runs.at(-1);
      if (last?.fontKey === fontKey) last.text += character;
      else runs.push({ fontKey, family, text: character });
    }
    const totalWidth = runs.reduce((sum, run) => sum + textWidth(run.text, fontSize), 0);
    let x = rect.x0 + (width - totalWidth) / 2;
    for (const run of runs) {
      run.x = x;
      x += textWidth(run.text, fontSize);
    }
    laidOut.push({ baseline: top + index * lineHeight + (lineHeight - contentHeight) / 2 + fontSize * 0.8, runs });
  });
  return { fontSize, lines: laidOut };
}
