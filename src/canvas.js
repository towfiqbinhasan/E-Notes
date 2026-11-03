// Drawing: stroke geometry (perfect-freehand), per-sheet views, and pointer input
// (pen/mouse draw, finger scrolls and pinch-zooms, palm rejection, S Pen button = eraser,
// precise eraser, lasso selection, hold-to-shape, laser pointer).
import { getStroke } from 'perfect-freehand';
import { getPageImage } from './pdf.js';
import { uid } from './store.js';
import { commit, commitMany } from './history.js';
import { recognizeShape } from './shapes.js';

/** Every sheet is 1000 units wide; strokes are stored in these units. */
export const SHEET_W = 1000;
export const HIGHLIGHT_ALPHA = 0.6;   // highlights are multiplied with the page, so text under them stays dark

// ---------------- geometry ----------------

// Pen types. Strokes saved before pen types existed have no `k` and draw as "fountain".
const KINDS = {
  ball: { thinning: 0.15, smoothing: 0.55, streamline: 0.5 },
  fountain: { thinning: 0.55, smoothing: 0.5, streamline: 0.45 },
  brush: { thinning: 0.82, smoothing: 0.62, streamline: 0.4, taper: true },
  pencil: { thinning: 0.3, smoothing: 0.4, streamline: 0.35 },
  hl: { thinning: 0, smoothing: 0.65, streamline: 0.6, flat: true },   // chisel marker: even width, flat ends
};

const outlineCache = new WeakMap(); // item -> {path: string, p2d: Path2D, box}

function strokeOutline(item) {
  const p = item.p || [];
  const pts = [];
  for (let i = 0; i < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2]]);
  const o = item.t === 'hl' ? KINDS.hl : KINDS[item.k] || KINDS.fountain;
  const taper = o.taper ? item.s * 3 : 0;
  return getStroke(pts, {
    size: item.s,
    thinning: o.thinning,
    smoothing: o.smoothing,
    streamline: o.streamline,
    simulatePressure: !item.pr,
    start: { cap: !o.flat, taper },
    end: { cap: !o.flat, taper },
    last: true,
  });
}

/** Opacity of an ink item (stored as `o`, with sensible defaults). */
export function itemAlpha(it) {
  if (typeof it.o === 'number') return it.o;
  if (it.t === 'hl') return HIGHLIGHT_ALPHA;
  return it.k === 'pencil' ? 0.85 : 1;
}

/** SVG path for a filled outline polygon (quadratic curves through midpoints). */
export function polygonToPath(poly) {
  if (!poly.length) return '';
  const f = (n) => Math.round(n * 100) / 100;
  let d = `M${f(poly[0][0])} ${f(poly[0][1])}`;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    d += ` Q${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)}`;
  }
  return d + ' Z';
}

export function itemGeometry(item) {
  let g = outlineCache.get(item);
  if (!g) {
    const poly = strokeOutline(item);
    const path = polygonToPath(poly);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const p = item.p || [];
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    }
    const pad = item.s;
    g = { path, p2d: path ? new Path2D(path) : null, box: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad } };
    outlineCache.set(item, g);
  }
  return g;
}

const isInk = (it) => (it.t === 'pen' || it.t === 'hl') && !it.deleted_at;

/** Draw all ink of a sheet. ctx must already be scaled to sheet units. */
export function drawItems(ctx, items, hidden, extra) {
  const all = extra && extra.length ? [...items, ...extra] : items;
  // Highlighter first so it never covers pen ink.
  for (const pass of ['hl', 'pen']) {
    for (const it of all) {
      if (it.t !== pass || it.deleted_at || (hidden && hidden.has(it.id))) continue;
      drawItem(ctx, it);
    }
  }
}
export function drawItem(ctx, it) {
  const g = itemGeometry(it);
  if (!g.p2d) return;
  ctx.save();
  ctx.globalAlpha = itemAlpha(it);
  if (it.t === 'hl') ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = it.c;
  ctx.fill(g.p2d);
  ctx.restore();
}

let hlScratch = null; // reused offscreen canvas for highlight groups

/**
 * Draw highlights like a real marker: every colour group is painted at full strength first and then laid
 * down once at its opacity, so overlapping strokes of one colour stay even (no darker blotches).
 * The canvas itself is blended with "multiply" (CSS), so the text under a highlight stays crisp.
 */
function drawHighlights(ctx, items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.c}|${itemAlpha(it)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const t = ctx.getTransform();
  for (const group of groups.values()) {
    const alpha = itemAlpha(group[0]);
    if (group.length === 1) {
      const g = itemGeometry(group[0]);
      if (!g.p2d) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = group[0].c;
      ctx.fill(g.p2d);
      ctx.restore();
      continue;
    }
    if (!hlScratch) hlScratch = document.createElement('canvas');
    if (hlScratch.width !== ctx.canvas.width || hlScratch.height !== ctx.canvas.height) {
      hlScratch.width = ctx.canvas.width;
      hlScratch.height = ctx.canvas.height;
    }
    const o = hlScratch.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, hlScratch.width, hlScratch.height);
    o.setTransform(t);
    o.fillStyle = group[0].c;
    for (const it of group) { const g = itemGeometry(it); if (g.p2d) o.fill(g.p2d); }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(hlScratch, 0, 0);
    ctx.restore();
  }
}

/** Draw text boxes onto a canvas scaled to sheet units (export and AI pictures). */
export function drawTextItems(ctx, items) {
  const font = getComputedStyle(document.body).fontFamily;
  ctx.save();
  ctx.textBaseline = 'top';
  for (const it of items) {
    if (it.t !== 'text' || it.deleted_at || !it.text) continue;
    ctx.fillStyle = it.c;
    ctx.font = `${it.s}px ${font}`;
    const maxW = (it.w ?? SHEET_W - it.x) - 8;
    let y = it.y + it.s * 0.15;
    for (const para of it.text.split('\n')) {
      // simple word wrap
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const test = line + word;
        if (ctx.measureText(test).width > maxW && line.trim()) {
          ctx.fillText(line, it.x + 4, y);
          y += it.s * 1.3;
          line = word.trimStart();
        } else line = test;
      }
      ctx.fillText(line, it.x + 4, y);
      y += it.s * 1.3;
    }
  }
  ctx.restore();
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function hitsItem(it, x, y, r) {
  const { box } = itemGeometry(it);
  if (x < box.minX - r || x > box.maxX + r || y < box.minY - r || y > box.maxY + r) return false;
  const p = it.p;
  const reach = r + it.s / 2;
  if (p.length <= 3) return Math.hypot(p[0] - x, p[1] - y) <= reach;
  for (let i = 3; i < p.length; i += 3) {
    if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach) return true;
  }
  return false;
}

/** Precise eraser: cut the part of a stroke under the eraser, keep the rest as new strokes. */
function splitStroke(it, x, y, r) {
  const p = it.p;
  const reach = r + it.s * 0.3;
  const parts = [];
  let cur = [];
  for (let i = 0; i < p.length; i += 3) {
    const inside = Math.hypot(p[i] - x, p[i + 1] - y) <= reach;
    const crosses = i >= 3 && distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach;
    if (inside || crosses) {
      if (cur.length >= 6) parts.push(cur);
      cur = inside ? [] : [p[i], p[i + 1], p[i + 2]];
    } else {
      cur.push(p[i], p[i + 1], p[i + 2]);
    }
  }
  if (cur.length >= 6) parts.push(cur);
  return parts.map((seg) => ({ ...it, id: uid(), p: seg }));
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Where the PDF page sits inside a sheet, in sheet units. */
export function pdfRect(sheet) {
  if (!sheet.pdf_path) return null;
  const m = sheet.margin_width ?? 0.4;
  const w = SHEET_W * (1 - m);
  return { x: sheet.margin_side === 'left' ? SHEET_W * m : 0, y: 0, w, h: sheet.height };
}

/** The notes area of a sheet (where the paper pattern is drawn). */
export function notesRect(sheet) {
  const r = pdfRect(sheet);
  if (!r) return { x: 0, w: SHEET_W };
  return sheet.margin_side === 'left' ? { x: 0, w: r.x } : { x: r.w, w: SHEET_W - r.w };
}

export const PAPERS = [
  ['plain', 'Plain'],
  ['lined', 'Lined'],
  ['grid', 'Grid'],
  ['dotted', 'Dotted'],
];
export const PAPER_STEP = 32; // line / grid spacing in sheet units

// ---------------- one sheet on screen ----------------

const MAX_CANVAS_PIXELS = 16_000_000;

export class SheetView {
  constructor(sheet, { onMenu }) {
    this.sheet = sheet;
    this.zoom = 1;
    this.active = false;
    this.hidden = null;        // ids hidden while erasing / moving a selection
    this.extra = null;         // temporary items (pieces left by the precise eraser)
    this.ghosts = new Map();   // strokes another device is drawing right now (live ink)
    this.imgUrl = null;
    this.imgWidth = 0;

    this.el = document.createElement('div');
    this.el.className = 'sheet';
    this.el.dataset.id = sheet.id;

    this.paper = document.createElement('div');
    this.paper.className = 'sheet-paper';

    this.pdfBox = document.createElement('div');
    this.pdfBox.className = 'sheet-pdf';
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.draggable = false;
    this.pdfBox.append(this.img);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sheet-ink';

    this.textLayer = document.createElement('div');
    this.textLayer.className = 'sheet-texts';

    this.menuBtn = document.createElement('button');
    this.menuBtn.className = 'sheet-menu-btn';
    this.menuBtn.title = 'Sheet options';
    this.menuBtn.textContent = '⋯';
    this.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); onMenu(this, this.menuBtn); });

    this.el.append(this.paper, this.pdfBox, this.canvas, this.textLayer, this.menuBtn);
    this.applySheetLayout();
  }

  applySheetLayout() {
    const r = pdfRect(this.sheet);
    this.pdfBox.hidden = !r;
    if (r) {
      this.pdfBox.style.left = `${(r.x / SHEET_W) * 100}%`;
      this.pdfBox.style.width = `${(r.w / SHEET_W) * 100}%`;
      this.el.classList.toggle('margin-left', this.sheet.margin_side === 'left');
    }
    this.el.classList.toggle('has-pdf', !!r);
    const n = notesRect(this.sheet);
    this.paper.style.left = `${(n.x / SHEET_W) * 100}%`;
    this.paper.style.width = `${(n.w / SHEET_W) * 100}%`;
    this.paper.className = `sheet-paper paper-${this.sheet.paper || 'plain'}`;
  }

  layout(zoom) {
    this.zoom = zoom;
    this.el.style.width = `${SHEET_W * zoom}px`;
    this.el.style.height = `${this.sheet.height * zoom}px`;
    this.el.style.setProperty('--z', zoom);
  }

  /** Re-render canvases and the PDF image at the current zoom (after zoom settles). */
  refresh() {
    if (!this.active) return;
    this.renderInk();
    this.loadPdf();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.renderInk();
    this.renderTexts();
    this.loadPdf();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.canvas.width = this.canvas.height = 0;
    if (this.hlCanvas) this.hlCanvas.width = this.hlCanvas.height = 0;
    if (this.imgUrl) URL.revokeObjectURL(this.imgUrl);
    this.imgUrl = null;
    this.imgWidth = 0;
    this.img.removeAttribute('src');
  }

  pixelRatio() {
    const cssW = SHEET_W * this.zoom, cssH = this.sheet.height * this.zoom;
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)), 8192 / cssW, 8192 / cssH);
  }

  /** Size a canvas to cover the sheet and return a context scaled to sheet units. */
  prepareCanvas(canvas) {
    const ratio = this.pixelRatio();
    const w = Math.round(SHEET_W * this.zoom * ratio);
    const h = Math.round(this.sheet.height * this.zoom * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.zoom * ratio;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    return ctx;
  }

  renderInk() {
    if (!this.active) return;
    const extra = this.ghosts.size ? [...(this.extra || []), ...this.ghosts.values()] : this.extra;
    const all = extra && extra.length ? [...this.sheet.strokes, ...extra] : this.sheet.strokes;
    const visible = (it) => !it.deleted_at && !(this.hidden && this.hidden.has(it.id));
    const ctx = this.prepareCanvas(this.canvas);
    for (const it of all) if (it.t === 'pen' && visible(it)) drawItem(ctx, it);
    // Highlights live on their own canvas, blended with "multiply" (see .sheet-hl).
    const hl = all.filter((it) => it.t === 'hl' && visible(it));
    if (hl.length) {
      if (!this.hlCanvas) {
        this.hlCanvas = document.createElement('canvas');
        this.hlCanvas.className = 'sheet-hl';
        this.el.insertBefore(this.hlCanvas, this.canvas);
      }
      drawHighlights(this.prepareCanvas(this.hlCanvas), hl);
    } else if (this.hlCanvas && this.hlCanvas.width) {
      this.hlCanvas.width = this.hlCanvas.height = 0;
    }
  }

  async loadPdf() {
    const r = pdfRect(this.sheet);
    if (!r || !this.active) return;
    const want = r.w * this.zoom;
    if (this.imgUrl && this.imgWidth >= want * 0.95) return;
    const token = (this.loadToken = Symbol('load'));
    try {
      this.pdfBox.classList.add('loading');
      const blob = await getPageImage(this.sheet.pdf_path, this.sheet.pdf_page, want);
      if (token !== this.loadToken || !this.active) return;
      if (this.imgUrl) URL.revokeObjectURL(this.imgUrl);
      this.imgUrl = URL.createObjectURL(blob);
      this.imgWidth = want;
      this.img.src = this.imgUrl;
      this.pdfBox.classList.remove('loading', 'missing');
      this.retryDelay = 0;
    } catch (err) {
      console.warn('PDF page render failed', err);
      if (token !== this.loadToken) return;
      this.pdfBox.classList.remove('loading');
      this.pdfBox.classList.add('missing');
      if (!navigator.onLine) {
        this.pdfBox.dataset.msg = 'PDF page not downloaded yet — connect to the internet';
        window.addEventListener('online', () => this.loadPdf(), { once: true });
        return;
      }
      // The PDF may still be uploading from another device: keep trying while the page is shown.
      this.pdfBox.dataset.msg = `Could not load this PDF page — trying again…\n(${err?.message || err})`;
      this.retryDelay = Math.min((this.retryDelay || 2500) * 2, 120000);
      setTimeout(() => { if (token === this.loadToken && this.active) this.loadPdf(); }, this.retryDelay);
    }
  }

  renderTexts() {
    const focused = this.textLayer.querySelector('.textbox:focus');
    const keep = focused ? focused.dataset.id : null;
    for (const el of [...this.textLayer.children]) if (el.dataset.id !== keep) el.remove();
    for (const it of this.sheet.strokes) {
      if (it.t !== 'text' || it.deleted_at || it.id === keep) continue;
      this.textLayer.append(makeTextBox(this, it));
    }
  }

  textEl(id) {
    return this.textLayer.querySelector(`.textbox[data-id="${id}"]`);
  }

  update(sheet) {
    const old = this.sheet;
    this.sheet = sheet;
    // A live stroke from another device has now arrived for real.
    if (this.ghosts.size) for (const it of sheet.strokes) this.ghosts.delete(it.id);
    if (old.height !== sheet.height) this.layout(this.zoom);
    if (old.margin_side !== sheet.margin_side || old.margin_width !== sheet.margin_width ||
        old.pdf_path !== sheet.pdf_path || old.paper !== sheet.paper) {
      this.applySheetLayout();
      this.imgWidth = 0;
    }
    if (this.active) {
      this.renderInk();
      this.renderTexts();
      this.loadPdf();
    }
  }

  /** Marks for "find in PDF": [{x, y, w, h, current}] in sheet units. */
  setSearchMarks(marks) {
    if (!this.findLayer) {
      if (!marks.length) return;
      this.findLayer = document.createElement('div');
      this.findLayer.className = 'find-layer';
      this.el.insertBefore(this.findLayer, this.textLayer);
    }
    this.findLayer.textContent = '';
    for (const m of marks) {
      const el = document.createElement('span');
      el.className = 'find-mark' + (m.current ? ' current' : '');
      Object.assign(el.style, {
        left: `calc(${m.x - 1}px * var(--z))`, top: `calc(${m.y - 1}px * var(--z))`,
        width: `calc(${m.w + 2}px * var(--z))`, height: `calc(${m.h + 2}px * var(--z))`,
      });
      this.findLayer.append(el);
    }
  }

  /** Show (or finish) a stroke another device is drawing right now. */
  showGhost(item, done) {
    if (item && Array.isArray(item.p) && (item.t === 'pen' || item.t === 'hl')) {
      if (this.sheet.strokes.some((it) => it.id === item.id)) return;
      this.ghosts.set(item.id, item);
      clearTimeout(this.ghostTimer);
      // Safety net: drop ghosts if the real stroke never arrives.
      this.ghostTimer = setTimeout(() => { this.ghosts.clear(); this.renderInk(); }, done ? 15000 : 30000);
    }
    this.renderInk();
  }

  /** Client coordinates -> sheet units. */
  toUnits(clientX, clientY, rect = this.el.getBoundingClientRect()) {
    return { x: (clientX - rect.left) / this.zoom, y: (clientY - rect.top) / this.zoom };
  }
}

// ---------------- text boxes ----------------

let textDefaults = () => ({ color: '#111827', size: 22 });
export const setTextDefaults = (fn) => { textDefaults = fn; };

function makeTextBox(view, item, isNew = false) {
  const el = document.createElement('div');
  el.className = 'textbox';
  el.dataset.id = item.id;
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.spellcheck = true;
  el.style.left = `calc(${item.x}px * var(--z))`;
  el.style.top = `calc(${item.y}px * var(--z))`;
  el.style.maxWidth = `calc(${item.w ?? SHEET_W - item.x}px * var(--z))`;
  el.style.fontSize = `calc(${item.s}px * var(--z))`;
  el.style.color = item.c;
  el.textContent = item.text || '';

  el.addEventListener('blur', async () => {
    const text = el.innerText.replace(/\n+$/, '');
    if (text === (item.text || '')) {
      if (isNew) el.remove();
      return;
    }
    // Edits create a new item and tombstone the old one (keeps sync conflict-free).
    const added = text.trim() ? [{ ...item, id: uid(), text, created: isNew ? item.created : Date.now() }] : [];
    const removed = isNew ? [] : [item];
    el.remove();
    if (added.length || removed.length) await commit(view.sheet.id, added, removed);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    e.stopPropagation(); // keep tool shortcuts out of the text
  });
  return el;
}

function createTextBox(view, x, y) {
  const d = textDefaults();
  const item = { id: uid(), t: 'text', x: Math.round(x), y: Math.round(y - d.size * 0.7), s: d.size, c: d.color, text: '', created: Date.now() };
  const el = makeTextBox(view, item, true);
  view.textLayer.append(el);
  // Focus right away (inside the tap) so Android opens the keyboard and no key is lost.
  el.focus();
}

/** Bounding box of an item in sheet units. */
function itemBox(view, it) {
  if (it.t !== 'text') return itemGeometry(it).box;
  const el = view.textEl(it.id);
  if (el && el.offsetWidth) {
    const r = el.getBoundingClientRect(), s = view.el.getBoundingClientRect();
    return { minX: (r.left - s.left) / view.zoom, minY: (r.top - s.top) / view.zoom, maxX: (r.right - s.left) / view.zoom, maxY: (r.bottom - s.top) / view.zoom };
  }
  const w = it.w ?? Math.min(SHEET_W - it.x, (it.text || '').length * it.s * 0.55 + 10);
  return { minX: it.x, minY: it.y, maxX: it.x + w, maxY: it.y + it.s * 1.4 };
}

/** A copy of an item moved by (dx, dy) and/or scaled by f around (ox, oy). New id. */
function transformItem(it, { dx = 0, dy = 0, f = 1, ox = 0, oy = 0 }, keepCreated = true) {
  const mx = (x) => Math.round((ox + (x - ox) * f + dx) * 10) / 10;
  const my = (y) => Math.round((oy + (y - oy) * f + dy) * 10) / 10;
  const copy = { ...it, id: uid(), created: keepCreated ? it.created : Date.now() };
  delete copy.deleted_at;
  if (it.t === 'text') {
    copy.x = mx(it.x); copy.y = my(it.y);
    if (f !== 1) { copy.s = Math.max(6, Math.round(it.s * f)); if (it.w) copy.w = Math.round(it.w * f); }
  } else {
    const p = new Array(it.p.length);
    for (let i = 0; i < it.p.length; i += 3) { p[i] = mx(it.p[i]); p[i + 1] = my(it.p[i + 1]); p[i + 2] = it.p[i + 2]; }
    copy.p = p;
    if (f !== 1) copy.s = Math.max(0.3, Math.round(it.s * f * 10) / 10);
  }
  return copy;
}

// ---------------- input controller ----------------

let clipboard = null; // copied items (shared by all notebooks)

/**
 * Handles all pointer input on the scrolling viewport.
 * opts: { viewport, laserCanvas, findView(el), getTool(), getPen(tool), getZoom(), zoomAt(z, cx, cy),
 *         fingerDraw(), spaceHeld(), shapeHold(), centerView(), onToast(msg), setTool(tool) }
 */
export function createInput(opts) {
  const { viewport } = opts;
  const touches = new Map();     // pointerId -> {x, y}
  let gesture = null;            // {startDist, startZoom, cx, cy}
  let draw = null;               // current stroke / erase / lasso / transform / laser
  let pan = null;                // mouse pan {id, x, y}
  let sel = null;                // current lasso selection
  let lastPenTime = 0;
  let inertia = null;
  let velocity = { x: 0, y: 0, t: 0 };
  const live = document.createElement('canvas');
  live.className = 'sheet-live';
  // Low-latency canvas: ink appears under the pen tip sooner (Chrome / Android WebView).
  live.getContext('2d', { desynchronized: true });

  const isEraserButton = (e) => e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2) || e.button === 5);

  function stopInertia() { if (inertia) cancelAnimationFrame(inertia); inertia = null; }
  function attachLive(view) { view.el.append(live); return view.prepareCanvas(live); }
  function detachLive() { live.remove(); live.width = live.height = 0; }

  // ================= ink =================
  function startInk(e, view, tool) {
    const pen = opts.getPen(tool);
    draw = {
      kind: 'ink', id: e.pointerId, view, rect: view.el.getBoundingClientRect(), pointerType: e.pointerType,
      straight: tool === 'highlighter' && pen.straight,
      item: {
        id: uid(), t: tool === 'highlighter' ? 'hl' : 'pen', c: pen.color, s: pen.size, p: [],
        pr: e.pointerType === 'pen' ? 1 : 0, created: Date.now(),
      },
    };
    if (tool === 'pen' && pen.kind) draw.item.k = pen.kind;
    if (typeof pen.opacity === 'number') draw.item.o = pen.opacity;
    draw.done = [];                 // finished parts on earlier sheets (stroke drawn across sheets)
    draw.liveEl = newLiveCanvas(view);
    addPoints(e);
  }

  function newLiveCanvas(view) {
    const c = document.createElement('canvas');
    c.className = 'sheet-live';
    if (draw && draw.item && draw.item.t === 'hl') c.style.mixBlendMode = 'multiply'; // same look as when saved
    c.getContext('2d', { desynchronized: true }); // low-latency ink
    view.el.append(c);
    view.prepareCanvas(c);
    return c;
  }

  const r1 = (n) => Math.round(n * 10) / 10;

  /** The pen moved off this sheet onto another one: keep writing there as a new stroke. */
  function continueOnSheet(next, ev, pr) {
    const d = draw;
    // Let the old part run past the edge so both parts meet at the border.
    const q = d.view.toUnits(ev.clientX, ev.clientY, d.rect);
    d.item.p.push(r1(q.x), r1(q.y), pr);
    drawItem(d.view.prepareCanvas(d.liveEl), { ...d.item });
    if (opts.onLiveInk) opts.onLiveInk({ sheetId: d.view.sheet.id, item: { ...d.item, p: d.item.p.slice() }, done: false });
    d.done.push({ view: d.view, item: d.item, liveEl: d.liveEl });
    const item = { ...d.item, id: uid(), p: [], created: Date.now() };
    d.view = next;
    d.rect = next.el.getBoundingClientRect();
    d.item = item;
    d.liveEl = newLiveCanvas(next);
    if (d.lastClient) {
      const s = next.toUnits(d.lastClient.x, d.lastClient.y, d.rect);
      item.p.push(r1(s.x), r1(s.y), d.lastClient.pr);
    }
    clearTimeout(d.holdTimer);
    d.anchor = null;
    d.crossed = true;              // no shape snapping for strokes that span sheets
  }

  function addPoints(e) {
    if (draw.shaped) return;
    // Predicted points (where the pen is about to be) are drawn live but never saved.
    const pred = e.getPredictedEvents ? e.getPredictedEvents() : [];
    draw.predicted = [];
    for (const ev of pred.slice(0, 4)) {
      const q = draw.view.toUnits(ev.clientX, ev.clientY, draw.rect);
      draw.predicted.push(q.x, q.y, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5);
    }
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      let { x, y } = draw.view.toUnits(ev.clientX, ev.clientY, draw.rect);
      let pr = ev.pointerType === 'pen' ? ev.pressure : 0.5;
      if (!pr) pr = 0.5;
      pr = Math.round(pr * 100) / 100;
      // Crossed onto another sheet (above or below)? Continue the stroke there.
      if ((y < 0 || y > draw.view.sheet.height) && opts.viewAt) {
        const next = opts.viewAt(ev.clientX, ev.clientY);
        if (next && next !== draw.view) {
          continueOnSheet(next, ev, pr);
          ({ x, y } = draw.view.toUnits(ev.clientX, ev.clientY, draw.rect));
        }
      }
      draw.lastClient = { x: ev.clientX, y: ev.clientY, pr };
      const p = draw.item.p;
      const n = p.length;
      // Skip points closer than 0.3 units to the previous one.
      if (n && Math.abs(p[n - 3] - x) < 0.3 && Math.abs(p[n - 2] - y) < 0.3) continue;
      p.push(r1(x), r1(y), pr);
    }
    armShapeTimer();
    scheduleLive();
  }

  // Hold the pen still at the end of a stroke -> clean shape.
  function armShapeTimer() {
    if (!opts.shapeHold() || draw.straight || draw.crossed) return;
    const p = draw.item.p;
    const n = p.length;
    if (!n) return;
    const x = p[n - 3], y = p[n - 2];
    const still = 3 / draw.view.zoom;
    if (draw.anchor && Math.hypot(x - draw.anchor.x, y - draw.anchor.y) < still) return;
    draw.anchor = { x, y };
    clearTimeout(draw.holdTimer);
    const d = draw;
    d.holdTimer = setTimeout(() => {
      if (draw !== d || d.shaped) return;
      const pts = [];
      for (let i = 0; i < d.item.p.length; i += 3) pts.push([d.item.p[i], d.item.p[i + 1]]);
      const shape = recognizeShape(pts);
      if (!shape) return;
      d.item.p = shape.points.flatMap(([sx, sy]) => [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10, 0.5]);
      d.item.pr = 1;
      d.shaped = shape.name;
      if (navigator.vibrate) navigator.vibrate(12);
      scheduleLive();
    }, 550);
  }

  let liveFrame = 0;
  function scheduleLive() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0;
      if (!draw) return;
      if (draw.kind === 'ink') {
        const ctx = draw.view.prepareCanvas(draw.liveEl);
        // A fresh copy each frame (geometry is cached per object), plus the predicted tail.
        const tail = !draw.shaped && draw.predicted ? draw.predicted : [];
        drawItem(ctx, { ...draw.item, p: tail.length ? draw.item.p.concat(tail) : draw.item.p });
        emitLive(false);
      } else if (draw.kind === 'lasso') {
        const ctx = draw.view.prepareCanvas(live);
        const z = draw.view.zoom;
        ctx.beginPath();
        draw.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
        ctx.fill();
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = '#2563eb';
        ctx.stroke();
      } else if (draw.kind === 'transform') {
        renderTransform();
      }
    });
  }

  // Send the stroke in progress to the user's other devices (~8 times a second).
  function emitLive(done) {
    if (!opts.onLiveInk || !draw || draw.kind !== 'ink') return;
    const now = performance.now();
    if (!done && now - (draw.lastEmit || 0) < 120) return;
    draw.lastEmit = now;
    opts.onLiveInk({ sheetId: draw.view.sheet.id, item: { ...draw.item, p: draw.item.p.slice() }, done });
  }

  /** A highlighter stroke that was meant to be straight (small wobble only). */
  function nearlyStraight(item) {
    const p = item.p;
    if (p.length < 9) return false;
    const [x0, y0, x1, y1] = [p[0], p[1], p[p.length - 3], p[p.length - 2]];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < item.s * 1.5) return false;
    let dev = 0;
    for (let i = 0; i < p.length; i += 3) dev = Math.max(dev, distToSegment(p[i], p[i + 1], x0, y0, x1, y1));
    return dev <= Math.max(item.s * 0.6, len * 0.06);
  }

  function straighten(item) {
    const p = item.p;
    if (p.length < 6) return;
    const [x0, y0] = [p[0], p[1]];
    let [x1, y1] = [p[p.length - 3], p[p.length - 2]];
    const ang = Math.atan2(y1 - y0, x1 - x0);
    if (Math.abs(Math.sin(ang)) < 0.1) y1 = y0;
    if (Math.abs(Math.cos(ang)) < 0.1) x1 = x0;
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(Math.round((x0 + ((x1 - x0) * i) / n) * 10) / 10, Math.round((y0 + ((y1 - y0) * i) / n) * 10) / 10, 0.5);
    item.p = out;
    item.pr = 1;
  }

  // ================= eraser =================
  function startErase(e, view) {
    const er = opts.getPen('eraser');
    draw = {
      kind: 'erase', id: e.pointerId, view, rect: view.el.getBoundingClientRect(), pointerType: e.pointerType,
      mode: er.mode || 'stroke', hlOnly: !!er.hlOnly, r: er.size / 2 / view.zoom,
      removed: new Map(), pieces: new Map(), last: null, textBoxes: new Map(),
    };
    eraseAt(e);
  }

  function eraseHit(x, y) {
    const d = draw;
    const { view, r } = d;
    let changed = false;
    const pool = [];
    for (const it of view.sheet.strokes) if (isInk(it) && !d.removed.has(it.id)) pool.push(it);
    pool.push(...d.pieces.values());
    for (const it of pool) {
      if (d.hlOnly && it.t !== 'hl') continue;
      if (!hitsItem(it, x, y, r)) continue;
      changed = true;
      const isPiece = d.pieces.has(it.id);
      if (isPiece) d.pieces.delete(it.id); else d.removed.set(it.id, it);
      if (d.mode === 'partial') for (const part of splitStroke(it, x, y, r)) d.pieces.set(part.id, part);
    }
    if (!d.hlOnly) {
      for (const it of view.sheet.strokes) {
        if (it.t !== 'text' || it.deleted_at || d.removed.has(it.id)) continue;
        let b = d.textBoxes.get(it.id);
        if (!b) { b = itemBox(view, it); d.textBoxes.set(it.id, b); }
        if (x >= b.minX - r && x <= b.maxX + r && y >= b.minY - r && y <= b.maxY + r) {
          d.removed.set(it.id, it);
          const el = view.textEl(it.id);
          if (el) el.style.visibility = 'hidden';
        }
      }
    }
    return changed;
  }

  async function finishErase(d, cancelled) {
    const removed = [...d.removed.values()];
    const added = [...d.pieces.values()];
    d.view.hidden = null;
    d.view.extra = null;
    if (!cancelled && (removed.length || added.length)) await commit(d.view.sheet.id, added, removed);
    else for (const it of removed) { const el = d.view.textEl(it.id); if (el) el.style.visibility = ''; }
    d.view.renderInk();
  }

  function eraseAt(e) {
    const d = draw;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    let changed = false;
    for (const ev of evs.length ? evs : [e]) {
      let pt = d.view.toUnits(ev.clientX, ev.clientY, d.rect);
      // Rubbing onto another sheet: save what was erased here and keep erasing there.
      if ((pt.y < 0 || pt.y > d.view.sheet.height) && opts.viewAt) {
        const next = opts.viewAt(ev.clientX, ev.clientY);
        if (next && next !== d.view) {
          if (changed) { d.view.hidden = new Set(d.removed.keys()); d.view.extra = [...d.pieces.values()]; }
          finishErase({ ...d }, false);
          Object.assign(d, {
            view: next, rect: next.el.getBoundingClientRect(), r: (d.r * d.view.zoom) / next.zoom,
            removed: new Map(), pieces: new Map(), last: null, textBoxes: new Map(),
          });
          changed = false;
          pt = d.view.toUnits(ev.clientX, ev.clientY, d.rect);
        }
      }
      // Fill the gap since the last event so fast movements don't skip strokes.
      const from = d.last || pt;
      const steps = Math.max(1, Math.ceil(Math.hypot(pt.x - from.x, pt.y - from.y) / Math.max(1, d.r / 2)));
      for (let i = 1; i <= steps; i++) {
        if (eraseHit(from.x + ((pt.x - from.x) * i) / steps, from.y + ((pt.y - from.y) * i) / steps)) changed = true;
      }
      d.last = pt;
    }
    if (changed) {
      d.view.hidden = new Set(d.removed.keys());
      d.view.extra = [...d.pieces.values()];
      d.view.renderInk();
    }
  }

  // ================= lasso selection =================
  function startLasso(e, view) {
    clearSelection();
    draw = { kind: 'lasso', id: e.pointerId, view, rect: view.el.getBoundingClientRect(), pointerType: e.pointerType, poly: [] };
    attachLive(view);
    lassoPoint(e);
  }
  function lassoPoint(e) {
    const { x, y } = draw.view.toUnits(e.clientX, e.clientY, draw.rect);
    const last = draw.poly[draw.poly.length - 1];
    if (!last || Math.hypot(last[0] - x, last[1] - y) > 2) draw.poly.push([x, y]);
    scheduleLive();
  }
  function finishLasso(d) {
    detachLive();
    const poly = d.poly;
    if (poly.length < 3) return;
    const chosen = [];
    for (const it of d.view.sheet.strokes) {
      if (it.deleted_at) continue;
      if (it.t === 'text') {
        const b = itemBox(d.view, it);
        if (pointInPolygon((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, poly) || pointInPolygon(it.x + 6, it.y + it.s * 0.6, poly)) chosen.push(it);
      } else if (isInk(it)) {
        let inside = 0;
        const n = it.p.length / 3;
        for (let i = 0; i < it.p.length; i += 3) if (pointInPolygon(it.p[i], it.p[i + 1], poly)) inside++;
        if (inside / n >= 0.5) chosen.push(it);
      }
    }
    select(d.view, chosen);
  }

  const SEL_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed'];

  function select(view, items) {
    clearSelection();
    items = items.filter((it) => !it.deleted_at);
    if (!items.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      const b = itemBox(view, it);
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    const pad = 6;
    const box = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    const boxEl = document.createElement('div');
    boxEl.className = 'sel-box';
    boxEl.innerHTML = '<div class="sel-handle" title="Drag to resize"></div>';
    const barEl = document.createElement('div');
    barEl.className = 'sel-bar';
    const btn = (label, title, fn, cls = '') => {
      const b = document.createElement('button');
      b.innerHTML = label;
      b.title = title;
      if (cls) b.className = cls;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      barEl.append(b);
    };
    btn('Delete', 'Delete (Del)', () => deleteSelection(), 'danger');
    btn('Duplicate', 'Duplicate (Ctrl+D)', () => duplicateSelection());
    btn('Copy', 'Copy (Ctrl+C)', () => copySelection());
    btn('Cut', 'Cut (Ctrl+X)', () => cutSelection());
    for (const c of SEL_COLORS) btn(`<span class="sel-swatch" style="background:${c}"></span>`, `Colour ${c}`, () => recolorSelection(c), 'swatch-btn');
    view.el.append(boxEl, barEl);
    sel = { view, items, box, boxEl, barEl };
    placeSelection();
  }

  function placeSelection(b = sel.box) {
    const { boxEl, barEl, view } = sel;
    Object.assign(boxEl.style, {
      left: `calc(${b.x}px * var(--z))`, top: `calc(${b.y}px * var(--z))`,
      width: `calc(${b.w}px * var(--z))`, height: `calc(${b.h}px * var(--z))`,
    });
    // Keep the action bar inside the sheet (the sheet clips anything outside it).
    const z = view.zoom;
    const above = b.y * z > 52;
    const maxLeft = SHEET_W * z - barEl.offsetWidth - 4;
    barEl.style.left = `${Math.max(4, Math.min(b.x * z, maxLeft))}px`;
    barEl.style.top = above ? `${b.y * z - 46}px` : `${Math.min((b.y + b.h) * z + 8, view.sheet.height * z - 44)}px`;
  }

  function clearSelection() {
    if (!sel) return;
    sel.boxEl.remove();
    sel.barEl.remove();
    sel = null;
  }

  async function replaceSelection(copies) {
    const { view, items } = sel;
    clearSelection();
    await commit(view.sheet.id, copies, items);
    select(view, copies);
  }
  async function deleteSelection() {
    if (!sel) return;
    const { view, items } = sel;
    clearSelection();
    await commit(view.sheet.id, [], items);
  }
  async function duplicateSelection() {
    if (!sel) return;
    const { view, items } = sel;
    const copies = items.map((it) => transformItem(it, { dx: 20, dy: 20 }, false));
    clearSelection();
    await commit(view.sheet.id, copies, []);
    select(view, copies);
  }
  function copySelection() {
    if (!sel) return false;
    clipboard = sel.items.map((it) => JSON.parse(JSON.stringify(it)));
    opts.onToast(`Copied ${clipboard.length} item${clipboard.length === 1 ? '' : 's'}`);
    return true;
  }
  async function cutSelection() {
    if (copySelection()) await deleteSelection();
  }
  async function recolorSelection(c) {
    if (!sel) return;
    await replaceSelection(sel.items.map((it) => ({ ...transformItem(it, {}), c })));
  }
  async function paste(view = opts.centerView()) {
    if (!clipboard || !clipboard.length || !view) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity;
    for (const it of clipboard) {
      const b = it.t === 'text' ? { minX: it.x, minY: it.y, maxX: it.x + (it.w || 200) } : itemGeometry(it).box;
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX);
    }
    // Put it near the top of the visible part of the target sheet, slightly offset.
    const vr = viewport.getBoundingClientRect();
    const top = view.toUnits(0, Math.max(vr.top, view.el.getBoundingClientRect().top) + 40).y;
    let dx = 20, dy = Math.max(20, top - minY);
    if (maxX + dx > SHEET_W) dx = SHEET_W - maxX - 10;
    if (minY + dy > view.sheet.height - 40) dy = view.sheet.height - 40 - minY;
    const copies = clipboard.map((it, i) => ({ ...transformItem(it, { dx, dy }, false), created: Date.now() + i }));
    opts.setTool('lasso');
    await commit(view.sheet.id, copies, []);
    select(view, copies);
    return true;
  }

  // ----- move / resize the selection -----
  function startTransform(e, mode) {
    const { view, items, box } = sel;
    draw = {
      kind: 'transform', mode, id: e.pointerId, view, pointerType: e.pointerType,
      sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, f: 1, ox: box.x, oy: box.y,
      ink: items.filter((it) => it.t !== 'text'), texts: items.filter((it) => it.t === 'text'),
    };
    view.hidden = new Set(items.map((it) => it.id));
    view.renderInk();
    attachLive(view);
    renderTransform();
  }
  function moveTransform(e) {
    const d = draw;
    const ux = (e.clientX - d.sx) / d.view.zoom, uy = (e.clientY - d.sy) / d.view.zoom;
    if (d.mode === 'move') { d.dx = ux; d.dy = uy; }
    else {
      const { w, h } = sel.box;
      d.f = Math.max(0.1, Math.min(10, ((w + ux) / w + (h + uy) / h) / 2));
    }
    scheduleLive();
  }
  function renderTransform() {
    const d = draw;
    const ctx = d.view.prepareCanvas(live);
    ctx.save();
    if (d.mode === 'move') ctx.translate(d.dx, d.dy);
    else { ctx.translate(d.ox, d.oy); ctx.scale(d.f, d.f); ctx.translate(-d.ox, -d.oy); }
    drawItems(ctx, d.ink);
    ctx.restore();
    const z = d.view.zoom;
    for (const it of d.texts) {
      const el = d.view.textEl(it.id);
      if (!el) continue;
      el.style.transformOrigin = '0 0';
      if (d.mode === 'move') el.style.transform = `translate(${d.dx * z}px, ${d.dy * z}px)`;
      else {
        const tx = (d.ox + (it.x - d.ox) * d.f - it.x) * z, ty = (d.oy + (it.y - d.oy) * d.f - it.y) * z;
        el.style.transform = `translate(${tx}px, ${ty}px) scale(${d.f})`;
      }
    }
    const b = sel.box;
    placeSelection(d.mode === 'move'
      ? { ...b, x: b.x + d.dx, y: b.y + d.dy }
      : { x: b.x, y: b.y, w: b.w * d.f, h: b.h * d.f });
  }
  async function finishTransform(d, cancelled) {
    detachLive();
    d.view.hidden = null;
    const moved = d.mode === 'move' ? Math.hypot(d.dx, d.dy) > 0.5 : Math.abs(d.f - 1) > 0.01;
    if (cancelled || !moved) {
      for (const it of d.texts) { const el = d.view.textEl(it.id); if (el) el.style.transform = ''; }
      d.view.renderInk();
      if (sel) placeSelection();
      return;
    }
    const t = d.mode === 'move' ? { dx: d.dx, dy: d.dy } : { f: d.f, ox: d.ox, oy: d.oy };
    await replaceSelection(sel.items.map((it) => transformItem(it, t)));
  }

  // ================= laser pointer =================
  const laser = { trail: [], running: false, active: false };
  function laserPoint(e, first = false) {
    const r = opts.laserCanvas.getBoundingClientRect();
    laser.trail.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now(), brk: first });
    if (!laser.running) { laser.running = true; requestAnimationFrame(laserFrame); }
  }
  function laserFrame() {
    const c = opts.laserCanvas;
    const now = performance.now();
    const LIFE = 900;
    laser.trail = laser.trail.filter((p) => now - p.t < LIFE);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(239, 68, 68, 0.9)';
    ctx.shadowBlur = 12;
    for (let i = 1; i < laser.trail.length; i++) {
      const a = laser.trail[i - 1], b = laser.trail[i];
      if (b.brk) continue;
      const alpha = Math.max(0, 1 - (now - b.t) / LIFE);
      ctx.strokeStyle = `rgba(239, 68, 68, ${alpha})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const head = laser.trail[laser.trail.length - 1];
    if (laser.active && head) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (laser.trail.length || laser.active) requestAnimationFrame(laserFrame);
    else { laser.running = false; ctx.clearRect(0, 0, w, h); }
  }

  // ================= finishing =================
  async function endDraw(cancelled = false) {
    const d = draw;
    draw = null;
    if (!d) return;
    if (d.kind === 'ink') {
      clearTimeout(d.holdTimer);
      const parts = [...d.done, { view: d.view, item: d.item, liveEl: d.liveEl }];
      if (parts.length === 1 && d.item.t === 'hl' && (d.straight || nearlyStraight(d.item))) straighten(d.item);
      const valid = parts.filter((pt) => pt.item.p.length);
      if (valid.length && !cancelled) {
        if (opts.onLiveInk) for (const pt of valid) opts.onLiveInk({ sheetId: pt.view.sheet.id, item: pt.item, done: true });
        // One undo step for the whole stroke, even when it spans several sheets.
        await commitMany(valid.map((pt) => ({ sheetId: pt.view.sheet.id, added: [pt.item], removed: [] })));
      }
      for (const pt of parts) pt.liveEl.remove();
    } else if (d.kind === 'erase') {
      await finishErase(d, cancelled);
    } else if (d.kind === 'lasso') {
      if (cancelled) detachLive(); else finishLasso(d);
    } else if (d.kind === 'transform') {
      await finishTransform(d, cancelled);
    } else if (d.kind === 'laser') {
      laser.active = false;
    }
  }

  /** Start the right kind of gesture for the current tool. */
  function startTool(e, view) {
    const tool = isEraserButton(e) ? 'eraser' : opts.getTool();
    if (tool === 'laser') {
      draw = { kind: 'laser', id: e.pointerId, pointerType: e.pointerType };
      laser.active = true;
      laserPoint(e, true);
      return true;
    }
    if (tool === 'lasso') {
      if (sel && e.target.closest('.sel-handle')) { startTransform(e, 'resize'); return true; }
      if (sel && e.target.closest('.sel-box')) { startTransform(e, 'move'); return true; }
      if (!view) { clearSelection(); return false; }
      startLasso(e, view);
      return true;
    }
    if (!view) return false;
    if (tool === 'eraser') startErase(e, view);
    else if (tool === 'pen' || tool === 'highlighter') startInk(e, view, tool);
    else return false;
    return true;
  }

  // ================= finger gestures =================
  function gestureStart() {
    stopInertia();
    const pts = [...touches.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      gesture = { startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1, startZoom: opts.getZoom(), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    } else {
      gesture = null;
    }
  }

  function gestureMove(e) {
    const prev = touches.get(e.pointerId);
    const now = { x: e.clientX, y: e.clientY };
    touches.set(e.pointerId, now);
    if (touches.size === 1) {
      const dx = now.x - prev.x, dy = now.y - prev.y;
      viewport.scrollLeft -= dx;
      viewport.scrollTop -= dy;
      const t = performance.now();
      const dt = Math.max(1, t - velocity.t);
      velocity = { x: 0.8 * (dx / dt) + 0.2 * velocity.x, y: 0.8 * (dy / dt) + 0.2 * velocity.y, t };
    } else if (gesture) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      viewport.scrollLeft -= cx - gesture.cx;
      viewport.scrollTop -= cy - gesture.cy;
      gesture.cx = cx; gesture.cy = cy;
      opts.zoomAt(gesture.startZoom * (dist / gesture.startDist), cx, cy);
    }
  }

  function startInertia() {
    let { x: vx, y: vy } = velocity;
    if (performance.now() - velocity.t > 80 || Math.hypot(vx, vy) < 0.1) return;
    let last = performance.now();
    const step = (t) => {
      const dt = t - last; last = t;
      viewport.scrollLeft -= vx * dt;
      viewport.scrollTop -= vy * dt;
      const decay = Math.pow(0.995, dt);
      vx *= decay; vy *= decay;
      inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : null;
    };
    inertia = requestAnimationFrame(step);
  }

  // ================= event wiring =================
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sheet-menu-btn, .sheet-add, .sel-bar, button, input, select, a')) return;
    const tool = opts.getTool();
    const onText = e.target.closest('.textbox');
    if (e.pointerType === 'pen') lastPenTime = performance.now();

    // Finger: scroll / pinch (palm rejection: ignored right after pen activity or while drawing).
    if (e.pointerType === 'touch') {
      if (draw && draw.pointerType === 'pen') return;
      if (performance.now() - lastPenTime < 500) return;
      const canFingerDraw = opts.fingerDraw() && touches.size === 0 && tool !== 'hand' && tool !== 'text';
      if (canFingerDraw && !onText && !draw) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY, drawing: true });
        viewport.setPointerCapture(e.pointerId);
        if (startTool(e, opts.findView(e.target))) return;
        touches.delete(e.pointerId);
      }
      if (draw && draw.pointerType === 'touch') endDraw(true); // second finger: it was a gesture after all
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      viewport.setPointerCapture(e.pointerId);
      gestureStart();
      return;
    }

    // Pen or mouse.
    if (e.pointerType === 'pen') {
      // A pen touching down cancels any palm "scroll" that started just before.
      touches.clear();
      gesture = null;
      stopInertia();
    }
    if (tool === 'text' && !isEraserButton(e)) {
      if (onText) return; // let the browser place the caret
      const view = opts.findView(e.target);
      if (view) {
        e.preventDefault();
        const { x, y } = view.toUnits(e.clientX, e.clientY);
        createTextBox(view, x, y);
      }
      return;
    }
    const wantsPan = tool === 'hand' || e.button === 1 || opts.spaceHeld();
    if (wantsPan && e.pointerType === 'mouse') {
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (draw || tool === 'hand') return;
    if (document.activeElement && document.activeElement.classList.contains('textbox')) document.activeElement.blur();
    if (startTool(e, opts.findView(e.target))) {
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    if (draw && e.pointerId === draw.id) {
      if (draw.kind === 'ink') addPoints(e);
      else if (draw.kind === 'erase') eraseAt(e);
      else if (draw.kind === 'lasso') lassoPoint(e);
      else if (draw.kind === 'transform') moveTransform(e);
      else if (draw.kind === 'laser') laserPoint(e);
      return;
    }
    if (pan && e.pointerId === pan.id) {
      viewport.scrollLeft -= e.clientX - pan.x;
      viewport.scrollTop -= e.clientY - pan.y;
      pan.x = e.clientX; pan.y = e.clientY;
      return;
    }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) gestureMove(e);
  });

  const up = (e) => {
    if (draw && e.pointerId === draw.id) {
      if (e.type === 'pointerup' && draw.kind === 'ink') addPoints(e);
      endDraw(e.type === 'pointercancel' && draw.pointerType === 'touch');
      touches.delete(e.pointerId);
      return;
    }
    if (pan && e.pointerId === pan.id) {
      pan = null;
      viewport.classList.remove('panning');
      return;
    }
    if (touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (touches.size === 0) {
        if (!gesture) startInertia();
        gesture = null;
      } else {
        gestureStart();
      }
    }
  };
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', up);

  // Ctrl + wheel (and touchpad pinch) zooms around the cursor.
  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    opts.zoomAt(opts.getZoom() * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  }, { passive: false });

  // Stop the context menu from S Pen button / long-press inside the sheets.
  viewport.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.textbox')) e.preventDefault();
  });

  return {
    isDrawing: () => !!draw,
    cancel: () => endDraw(true),
    hasSelection: () => !!sel,
    clearSelection,
    deleteSelection,
    duplicateSelection,
    copySelection,
    cutSelection,
    paste,
    hasClipboard: () => !!(clipboard && clipboard.length),
    /** Zoom changed: move the selection's action bar. */
    relayout() { if (sel && !draw) placeSelection(); },
    /** Called when a sheet changed (local or remote) so the selection stays valid. */
    sheetUpdated(view) {
      if (!sel || sel.view !== view || draw) return;
      const alive = new Set(view.sheet.strokes.filter((it) => !it.deleted_at).map((it) => it.id));
      if (sel.items.some((it) => !alive.has(it.id))) clearSelection();
      else if (!sel.boxEl.isConnected) view.el.append(sel.boxEl, sel.barEl);
    },
  };
}
