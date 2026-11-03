// Export sheets to a PDF with the handwriting flattened in (pdf-lib).
// Original PDF pages are embedded as vectors (sharp text); ink is drawn as vector paths.
import { PDFDocument, rgb, BlendMode } from 'pdf-lib';
import { SHEET_W, itemAlpha, itemGeometry, pdfRect, notesRect, drawTextItems, PAPER_STEP } from './canvas.js';
import { getPdfBytes, renderPageToCanvas } from './pdf.js';

const BLANK_SCALE = 0.6; // blank sheets: 1000 units -> 600 pt (about A4 width)

function hexToRgb(hex) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Rasterize the text boxes of one sheet to a transparent PNG (supports every script/font). */
async function textOverlayPng(sheet, k) {
  const texts = sheet.strokes.filter((it) => it.t === 'text' && !it.deleted_at && it.text);
  if (!texts.length) return null;
  const px = 2 * k; // 2 pixels per PDF point
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(SHEET_W * px);
  canvas.height = Math.ceil(sheet.height * px);
  const ctx = canvas.getContext('2d');
  ctx.scale(px, px);
  drawTextItems(ctx, texts);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Lined / grid / dotted paper in the notes area, as thin vector lines. */
function drawPaper(page, sheet, k, H) {
  const type = sheet.paper || 'plain';
  if (type === 'plain') return;
  const { x, w } = notesRect(sheet);
  const color = rgb(0.75, 0.82, 0.92);
  const step = PAPER_STEP;
  const x0 = x * k, x1 = (x + w) * k;
  if (type === 'lined' || type === 'grid') {
    for (let y = step; y < sheet.height; y += step) {
      page.drawLine({ start: { x: x0, y: H - y * k }, end: { x: x1, y: H - y * k }, thickness: 0.5, color });
    }
  }
  if (type === 'grid') {
    for (let gx = x + step; gx < x + w; gx += step) {
      page.drawLine({ start: { x: gx * k, y: 0 }, end: { x: gx * k, y: H }, thickness: 0.5, color });
    }
  }
  if (type === 'dotted') {
    for (let y = step; y < sheet.height; y += step) {
      for (let gx = x + step; gx < x + w; gx += step) {
        page.drawCircle({ x: gx * k, y: H - y * k, size: 0.9, color: rgb(0.6, 0.65, 0.72) });
      }
    }
  }
}

/**
 * @param sheets  array of sheet objects (in order)
 * @param onProgress (done, total)
 * @returns Uint8Array PDF bytes
 */
export async function exportSheets(sheets, onProgress = () => {}) {
  const out = await PDFDocument.create();
  out.setProducer('E-Notes');
  out.setCreator('E-Notes');
  const sources = new Map(); // pdf_path -> PDFDocument | null (null = cannot embed, rasterize)
  const pictures = new Map(); // data URL -> embedded image (the same screenshot is embedded once)

  async function picture(src) {
    if (!pictures.has(src)) {
      const bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      pictures.set(src, await (src.startsWith('data:image/png') ? out.embedPng(bytes) : out.embedJpg(bytes)));
    }
    return pictures.get(src);
  }

  async function sourceDoc(path) {
    if (!sources.has(path)) {
      try {
        sources.set(path, await PDFDocument.load(await getPdfBytes(path), { ignoreEncryption: true }));
      } catch (e) {
        console.warn('Embedding failed, will rasterize', e);
        sources.set(path, null);
      }
    }
    return sources.get(path);
  }

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const r = pdfRect(sheet);
    let k = BLANK_SCALE;
    let draw = null;

    if (r) {
      const src = await sourceDoc(sheet.pdf_path);
      const srcPage = src ? src.getPage(sheet.pdf_page - 1) : null;
      const rotated = srcPage && srcPage.getRotation().angle % 360 !== 0;
      if (srcPage && !rotated) {
        const embedded = await out.embedPage(srcPage);
        k = embedded.width / r.w;
        draw = (page, H) => page.drawPage(embedded, { x: r.x * k, y: H - r.h * k, width: r.w * k, height: r.h * k });
      } else {
        // Rotated or unreadable by pdf-lib: use a high resolution image of the page instead.
        k = BLANK_SCALE * (SHEET_W / r.w);
        const canvas = await renderPageToCanvas(sheet.pdf_path, sheet.pdf_page, Math.round(r.w * k * 2.5));
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        draw = (page, H) => page.drawImage(img, { x: r.x * k, y: H - r.h * k, width: r.w * k, height: r.h * k });
      }
    }

    const W = SHEET_W * k, H = sheet.height * k;
    const page = out.addPage([W, H]);
    drawPaper(page, sheet, k, H);
    if (draw) draw(page, H);

    // Pasted pictures: on the page, under the ink.
    for (const it of sheet.strokes) {
      if (it.t !== 'img' || it.deleted_at || !it.src) continue;
      try {
        page.drawImage(await picture(it.src), { x: it.x * k, y: H - (it.y + it.h) * k, width: it.w * k, height: it.h * k });
      } catch (e) {
        console.warn('Picture could not be exported', e);
      }
    }

    // Ink: highlighter first, then pen (same order as on screen).
    for (const pass of ['hl', 'pen']) {
      for (const it of sheet.strokes) {
        if (it.t !== pass || it.deleted_at) continue;
        const { path } = itemGeometry(it);
        if (!path) continue;
        page.drawSvgPath(path, {
          x: 0, y: H, scale: k,
          color: hexToRgb(it.c),
          opacity: itemAlpha(it),
          borderWidth: 0,
          blendMode: pass === 'hl' ? BlendMode.Multiply : BlendMode.Normal, // text under highlights stays dark
        });
      }
    }

    const png = await textOverlayPng(sheet, k);
    if (png) page.drawImage(await out.embedPng(png), { x: 0, y: 0, width: W, height: H });

    onProgress(i + 1, sheets.length);
  }
  return out.save();
}

export const safeFileName = (s) => (s || 'E-Notes').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'E-Notes';
