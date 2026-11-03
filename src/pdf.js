// PDF handling: import + hash, local storage of the original file, rendering
// pages with pdf.js (bundled, works offline) and caching rendered pages in IndexedDB.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getDb } from './db.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const ASSETS = new URL('pdfjs/', document.baseURI).href;

let downloader = null;      // async (path) => Blob, set by sync.js when signed in
export const setPdfDownloader = (fn) => { downloader = fn; };

export const hashFromPath = (path) => path.split('/').pop().replace(/\.pdf$/i, '');

/** SHA-256 hex of the file, so the same PDF is stored and uploaded only once. */
export async function hashBytes(buf) {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure contexts (plain http on a LAN) have no crypto.subtle: use a 2x FNV-1a fallback.
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 2246822519) >>> 0;
  }
  return 'f' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + bytes.length.toString(16);
}

const docs = new Map(); // hash -> Promise<PDFDocumentProxy>

function loadDoc(hash, data) {
  if (!docs.has(hash)) {
    const task = pdfjs.getDocument({
      data,
      cMapUrl: ASSETS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: ASSETS + 'standard_fonts/',
      wasmUrl: ASSETS + 'wasm/',
      iccUrl: ASSETS + 'iccs/',
      isEvalSupported: false, // our Content-Security-Policy forbids eval
    });
    const p = task.promise;
    p.catch(() => docs.delete(hash));
    docs.set(hash, p);
  }
  return docs.get(hash);
}

/**
 * Store a dropped/picked PDF locally and read its page sizes.
 * Returns {hash, name, pages: [{w, h}]} (sizes in PDF points, rotation applied).
 */
export async function importPdf(file) {
  const buf = await file.arrayBuffer();
  const hash = await hashBytes(buf);
  const db = getDb();
  const isNew = !(await db.getKey('pdfs', hash));
  if (isNew) await db.put('pdfs', { hash, name: file.name, blob: new Blob([buf], { type: 'application/pdf' }) }, hash);
  const doc = await loadDoc(hash, new Uint8Array(buf.slice(0)));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ w: vp.width, h: vp.height });
  }
  return { hash, name: file.name, pages, isNew };
}

/** Original PDF bytes for a storage path: from IndexedDB, else downloaded once and kept. */
export async function getPdfBytes(path) {
  const hash = hashFromPath(path);
  const db = getDb();
  const rec = await db.get('pdfs', hash);
  if (rec) return new Uint8Array(await rec.blob.arrayBuffer());
  if (!downloader || !navigator.onLine) throw new Error('PDF not downloaded yet (offline)');
  const blob = await downloader(path);
  await db.put('pdfs', { hash, name: path, blob }, hash);
  return new Uint8Array(await blob.arrayBuffer());
}

export async function getDoc(path) {
  const hash = hashFromPath(path);
  if (docs.has(hash)) return docs.get(hash);
  return loadDoc(hash, await getPdfBytes(path));
}

/** The printed text of one PDF page (empty for scanned pages without a text layer). */
export async function getPageText(path, pageNum) {
  const doc = await getDoc(path);
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  let out = '';
  for (const it of content.items) {
    if (!('str' in it)) continue;
    out += it.str;
    out += it.hasEOL ? '\n' : (it.str && !it.str.endsWith(' ') ? ' ' : '');
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const textCache = new Map(); // "path|page" -> {text, spans}

/**
 * Page text with where every piece sits on the page (for "find in PDF").
 * spans: [{start, end, x, y, w, h}] with x/y/w/h as fractions (0..1) of the page width/height.
 */
export async function getPageTextLayout(path, pageNum) {
  const key = `${path}|${pageNum}`;
  if (textCache.has(key)) return textCache.get(key);
  const doc = await getDoc(path);
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  let text = '';
  const spans = [];
  for (const it of content.items) {
    if (!('str' in it) || !it.str) { if (it.hasEOL) text += ' '; continue; }
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    const fontH = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 10;
    const w = Math.abs(it.width * vp.scale) || fontH * it.str.length * 0.5;
    spans.push({
      start: text.length, end: text.length + it.str.length,
      x: tx[4] / vp.width, y: (tx[5] - fontH) / vp.height, w: w / vp.width, h: (fontH * 1.2) / vp.height,
    });
    text += it.str;
    text += it.hasEOL || !it.str.endsWith(' ') ? ' ' : '';
  }
  const out = { text, spans };
  textCache.set(key, out);
  if (textCache.size > 2000) textCache.delete(textCache.keys().next().value);
  return out;
}

// ---------- rendering with a small queue (max 2 pages at once) ----------

let running = 0;
const queue = [];
function schedule(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < 2 && queue.length) {
    const { job, resolve, reject } = queue.shift();
    running++;
    job().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

/** Render one page to a canvas `pixelWidth` wide. Used by the viewer and the export fallback. */
export async function renderPageToCanvas(path, pageNum, pixelWidth) {
  const doc = await getDoc(path);
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: pixelWidth / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

const toBlob = (canvas) => new Promise((res) => canvas.toBlob((b) => res(b), 'image/webp', 0.92));

/**
 * Get a rendered page image (Blob) at roughly `cssWidth` CSS pixels.
 * Widths are bucketed so zooming a little does not re-render, and each page
 * keeps only its latest size in the cache.
 */
export async function getPageImage(path, pageNum, cssWidth) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.min(4000, Math.max(400, Math.ceil((cssWidth * dpr) / 400) * 400));
  const hash = hashFromPath(path);
  const prefix = `${hash}:${pageNum}:`;
  const key = prefix + width;
  const db = getDb();
  const cached = await db.get('pages', key);
  if (cached) return cached;
  return schedule(async () => {
    const again = await db.get('pages', key);
    if (again) return again;
    const canvas = await renderPageToCanvas(path, pageNum, width);
    let blob = await toBlob(canvas);
    if (!blob) blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    canvas.width = canvas.height = 0;
    const tx = db.transaction('pages', 'readwrite');
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    for (const old of await tx.store.getAllKeys(range)) await tx.store.delete(old);
    await tx.store.put(blob, key);
    await tx.done;
    return blob;
  });
}
