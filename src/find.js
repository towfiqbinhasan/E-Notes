// Find in PDF (Ctrl+F): searches the printed text of every PDF page in the open notebook and the
// typed text boxes, marks every match on the sheets and steps through them with Enter / Shift+Enter.
import { getPageTextLayout } from './pdf.js';
import { pdfRect, SHEET_W } from './canvas.js';

const $ = (id) => document.getElementById(id);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Measures how far into a piece of text a character is, using real letter widths
// (an "i" is much narrower than a "W"), so the marks line up with the words.
let measureCtx = null;
function fractionAt(str, k) {
  if (k <= 0) return 0;
  if (k >= str.length) return 1;
  if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); measureCtx.font = '100px Helvetica, Arial, sans-serif'; }
  const full = measureCtx.measureText(str).width;
  return full ? measureCtx.measureText(str.slice(0, k)).width / full : k / str.length;
}

/** Rectangles (sheet units) covering text[a..b) of a page laid out in `layout`. */
function rectsFor(layout, a, b, sheet) {
  const r = pdfRect(sheet);
  const out = [];
  for (const sp of layout.spans) {
    if (sp.end <= a || sp.start >= b) continue;
    const str = layout.text.slice(sp.start, sp.end);
    const f0 = fractionAt(str, Math.max(a, sp.start) - sp.start);
    const f1 = fractionAt(str, Math.min(b, sp.end) - sp.start);
    out.push({
      x: r.x + (sp.x + sp.w * f0) * r.w,
      y: sp.y * r.h,
      w: Math.max(2, sp.w * (f1 - f0) * r.w),
      h: sp.h * r.h,
    });
  }
  return out;
}

/**
 * opts: { getSheets() -> sheets in order, getView(sheetId) -> SheetView, scrollToY(sheetId, y), onOpenChange(open) }
 */
export function initFind({ getSheets, getView, scrollToY, onOpenChange = () => {} }) {
  const bar = $('find-bar');
  const input = $('find-input');
  const count = $('find-count');
  let results = [];          // [{sheetId, rects:[{x,y,w,h}]}]
  let current = -1;
  let token = 0;
  let timer = null;
  const painted = new Set(); // sheet ids that show marks

  function paint(sheetId) {
    const view = getView(sheetId);
    if (!view) return;
    const marks = [];
    results.forEach((res, i) => {
      if (res.sheetId !== sheetId) return;
      for (const rc of res.rects) marks.push({ ...rc, current: i === current });
    });
    view.setSearchMarks(marks);
    if (marks.length) painted.add(sheetId); else painted.delete(sheetId);
  }
  function clearMarks() {
    for (const id of painted) { const v = getView(id); if (v) v.setSearchMarks([]); }
    painted.clear();
  }

  function showCount(searching = false) {
    if (!input.value.trim()) { count.textContent = ''; return; }
    if (!results.length) { count.textContent = searching ? 'Searching…' : 'No matches'; bar.classList.toggle('none', !searching); return; }
    bar.classList.remove('none');
    count.textContent = `${current + 1} / ${results.length}${searching ? '+' : ''}`;
  }

  function go(i) {
    if (!results.length) return;
    const prev = results[current];
    current = (i + results.length) % results.length;
    const res = results[current];
    if (prev && prev.sheetId !== res.sheetId) paint(prev.sheetId);
    paint(res.sheetId);
    scrollToY(res.sheetId, res.rects[0] ? res.rects[0].y : 0);
    showCount(searching);
  }

  let searching = false;
  async function run() {
    const my = ++token;
    clearMarks();
    results = [];
    current = -1;
    const q = input.value.trim();
    if (q.length < 2) { searching = false; showCount(); return; }
    const re = new RegExp(q.split(/\s+/).map(escapeRe).join('\\s+'), 'giu');
    const sheets = getSheets();
    searching = true;
    showCount(true);
    for (let i = 0; i < sheets.length; i++) {
      if (my !== token) return; // a newer search started
      const s = sheets[i];
      const found = [];
      if (s.pdf_path) {
        try {
          const layout = await getPageTextLayout(s.pdf_path, s.pdf_page);
          for (const m of layout.text.matchAll(re)) found.push({ sheetId: s.id, rects: rectsFor(layout, m.index, m.index + m[0].length, s) });
        } catch { /* PDF not downloaded yet */ }
      }
      for (const it of s.strokes) {
        if (it.t !== 'text' || it.deleted_at || !it.text) continue;
        re.lastIndex = 0;
        if (re.test(it.text)) found.push({ sheetId: s.id, rects: [{ x: it.x, y: it.y, w: Math.min(it.w ?? SHEET_W - it.x, 500), h: it.s * 1.4 }] });
      }
      if (my !== token) return;
      if (found.length) {
        results.push(...found);
        if (current < 0) go(0); else paint(s.id);
      }
      showCount(true);
      if (i % 8 === 7) await new Promise((r) => setTimeout(r)); // keep the page responsive on long PDFs
    }
    searching = false;
    showCount();
  }

  function open() {
    bar.hidden = false;
    onOpenChange(true);
    input.focus();
    input.select();
    if (input.value.trim() && !results.length) run();
  }
  function close() {
    token++;
    bar.hidden = true;
    clearMarks();
    results = [];
    current = -1;
    searching = false;
    onOpenChange(false);
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep tool shortcuts out of the box
    if (e.key === 'Enter') { e.preventDefault(); go(current + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  $('find-next').onclick = () => go(current + 1);
  $('find-prev').onclick = () => go(current - 1);
  $('find-close').onclick = close;

  return {
    open,
    close,
    toggle: () => (bar.hidden ? open() : close()),
    isOpen: () => !bar.hidden,
    /** The notebook or its sheets changed: search again (keeps the query). */
    refresh: () => { if (!bar.hidden && input.value.trim()) run(); else clearMarks(); },
  };
}
