// App UI: sidebar, toolbar, sheet list, zoom, import/export, settings, shortcuts.
import * as store from './store.js';
import { undo, redo, canUndo, canRedo, onHistoryChange, clearHistory, commit } from './history.js';
import { SheetView, SHEET_W, createInput, pdfRect, setTextDefaults, PAPERS } from './canvas.js';
import { migratePrefs, toolStyle, initPresets } from './tools.js';
import { importPdf } from './pdf.js';
import { exportSheets, safeFileName } from './export.js';
import { desktop, isElectron, isNative, saveFile, applyNativeTheme, onBackButton } from './platform.js';
import { initAiPanel } from './ai.js';
import { isConfigured } from './supabase.js';

const $ = (id) => document.getElementById(id);

// ---------------- icons (24x24 stroke icons) ----------------
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  pen: svg('<path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>'),
  highlighter: svg('<path d="M9 14l-4 4v2h4l4-4"/><path d="M9 14l8-8 3 3-8 8z"/><path d="M14 20h6"/>'),
  eraser: svg('<path d="M7 20h13"/><path d="M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 18H7.5z"/><path d="M9 11l5 5"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  hand: svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-7a1.5 1.5 0 0 1 3 0V12"/><path d="M14 6.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.4 15a1.6 1.6 0 0 1 2.4-2.1L8 14"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>'),
  sheet: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 9v6M9 12h6"/>'),
  export: svg('<path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  cursor: svg('<path d="M5 3l14 7.5-6.2 1.8L10 19z"/><path d="M13 13l5 5"/>'),
  lasso: svg('<path d="M7 17.5C4.6 16.2 3 14.2 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8c-1 0-2-.1-2.9-.4" stroke-dasharray="2.5 2.5"/><path d="M7 17.5c0 1.4-1.1 2.5-2.5 2.5"/><circle cx="8" cy="16" r="2"/>'),
  laser: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
};

// ---------------- drawing cursor ----------------
const CURSOR_STYLES = [
  ['dot', 'Dot (pen colour and size)'],
  ['circle', 'Circle outline (shows size)'],
  ['pen', 'Pen icon'],
  ['crosshair', 'Crosshair'],
  ['arrow', 'Arrow'],
  ['none', 'Hidden (best for S Pen / tablets)'],
];

const svgCursor = (body, w, h, hx, hy) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}") ${hx} ${hy}, crosshair`;

/** CSS cursor value for a tool. `px` = on-screen stroke width. */
function cursorFor(style, tool, color, px) {
  if (style === 'arrow') return 'default';
  if (style === 'none') return 'none';
  if (style === 'crosshair') return 'crosshair';
  const d = Math.max(4, Math.min(120, px));            // browsers ignore cursors over 128 px
  const s = Math.ceil(d + 4), c = s / 2, r = d / 2;
  if (tool === 'eraser' || style === 'circle') {
    const ring = tool === 'eraser' ? '#6b7280' : color;
    const fill = tool === 'eraser' ? 'rgba(255,255,255,0.6)' : 'none';
    return svgCursor(
      `<circle cx="${c}" cy="${c}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="3"/>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ring}" stroke-width="1.5"/>`,
      s, s, Math.round(c), Math.round(c));
  }
  if (style === 'pen') {
    return svgCursor(
      '<path d="M3 29l2-7L22 5l5 5L10 27z" fill="#fff" stroke="#1f2937" stroke-width="1.5" stroke-linejoin="round"/>' +
      `<path d="M3 29l2-7 5 5z" fill="${color}" stroke="#1f2937" stroke-width="1.2" stroke-linejoin="round"/>` +
      '<path d="M19 8l5 5" stroke="#1f2937" stroke-width="1.5"/>',
      32, 32, 3, 29);
  }
  // dot: filled with the ink colour, thin outline so light colours stay visible
  const alpha = tool === 'highlighter' ? 0.55 : 1;
  return svgCursor(
    `<circle cx="${c}" cy="${c}" r="${r + 0.5}" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="1"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity="${alpha}"/>`,
    s, s, Math.round(c), Math.round(c));
}

// ---------------- preferences (UI only; notebook data never goes here) ----------------
const PREFS_KEY = 'enotes-prefs';
const DEFAULT_PREFS = {
  theme: 'system',
  tool: 'pen',
  shapeHold: true,
  paperBlank: 'plain',
  paperPdf: 'plain',
  marginSide: 'right',
  marginWidth: 0.4,
  fingerDraw: false,
  cursor: 'dot',
  sheetGap: 28,
  lastNotebook: {},
};
const prefs = migratePrefs((() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
})());
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ---------------- theme ----------------
const media = matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => (prefs.theme === 'system' ? (media.matches ? 'dark' : 'light') : prefs.theme);
export function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = t === 'dark' ? '#171a23' : '#ffffff';
  const btn = $('btn-theme');
  if (btn) btn.innerHTML = t === 'dark' ? ICONS.sun : ICONS.moon;
  applyNativeTheme(t);
}
media.addEventListener('change', () => prefs.theme === 'system' && applyTheme());

// ---------------- toasts ----------------
export function toast(msg, { error = false, ms = 3000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// =====================================================================
export function initUI(opts) {
  const { user, localMode, onSignOut } = opts;
  const getSync = () => opts.sync; // sync starts after the UI, so always read it lazily
  const viewport = $('viewport');
  const sheetsEl = $('sheets');
  // Space between sheets (Settings), in sheet units so it scales with zoom.
  const applySheetGap = () => sheetsEl.style.setProperty('--sheet-gap', prefs.sheetGap);
  applySheetGap();
  const app = $('app');
  const views = new Map();       // sheet id -> SheetView
  let userZoom = 1;              // 1 = sheet fits the window width
  let refreshTimer = null;
  let spaceHeld = false;

  // ----- static icons -----
  $('btn-menu').innerHTML = ICONS.menu;
  $('btn-add-pdf').innerHTML = ICONS.pdf;
  $('btn-add-sheet').innerHTML = ICONS.sheet;
  $('btn-export').innerHTML = ICONS.export;
  $('btn-undo').innerHTML = ICONS.undo;
  $('btn-redo').innerHTML = ICONS.redo;
  $('btn-cursor').innerHTML = ICONS.cursor;
  $('btn-ai').innerHTML = ICONS.sparkle;
  for (const b of document.querySelectorAll('.tool')) b.innerHTML = ICONS[b.dataset.tool];
  $('account-email').textContent = localMode ? 'This device only (no account)' : user.email || '';
  $('btn-signout').textContent = localMode ? 'Sign in' : 'Sign out';
  // A build without sync has no account to sign in to.
  $('btn-signout').hidden = localMode && !isConfigured;
  applyTheme();

  // ================= sidebar & notebooks =================
  const isNarrow = () => matchMedia('(max-width: 820px)').matches;
  function toggleSidebar(force) {
    if (isNarrow()) app.classList.toggle('sidebar-open', force);
    else app.classList.toggle('sidebar-hidden', force === undefined ? undefined : !force);
  }
  const closeSidebarIfNarrow = () => isNarrow() && app.classList.remove('sidebar-open');
  $('btn-menu').onclick = () => toggleSidebar();
  $('btn-close-sidebar').onclick = () => toggleSidebar(false);
  $('scrim').onclick = () => toggleSidebar(false);

  function renderNotebookList() {
    const list = $('notebook-list');
    list.textContent = '';
    const current = store.currentNotebook();
    for (const nb of store.listNotebooks()) {
      const item = document.createElement('div');
      item.className = 'nb-item' + (nb.id === current ? ' active' : '');
      item.innerHTML = `<span class="name"></span><span class="nb-actions">
        <button class="icon-btn" data-act="rename" title="Rename">✎</button>
        <button class="icon-btn" data-act="delete" title="Delete">🗑</button></span>`;
      item.querySelector('.name').textContent = nb.title || 'Untitled';
      item.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'rename') return startRename(item, nb);
        if (act === 'delete') return removeNotebook(nb);
        openNotebook(nb.id);
        closeSidebarIfNarrow();
      };
      item.ondblclick = () => startRename(item, nb);
      list.append(item);
    }
  }

  function startRename(item, nb) {
    const name = item.querySelector('.name');
    const input = document.createElement('input');
    input.value = nb.title;
    input.className = 'nb-title';
    input.style.fontSize = '14px';
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) await store.renameNotebook(nb.id, input.value.trim());
      renderNotebookList();
      if (nb.id === store.currentNotebook()) $('nb-title').value = store.getNotebook(nb.id).title;
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
  }

  async function removeNotebook(nb) {
    if (!confirm(`Delete notebook "${nb.title}" on all your devices?`)) return;
    await store.deleteNotebook(nb.id);
    if (store.currentNotebook() === nb.id) {
      const next = store.listNotebooks()[0];
      await openNotebook(next ? next.id : null);
    }
  }

  async function newNotebook() {
    const nb = await store.createNotebook('Untitled');
    await openNotebook(nb.id);
    closeSidebarIfNarrow();
    $('nb-title').focus();
    $('nb-title').select();
  }
  $('btn-new-notebook').onclick = newNotebook;

  $('nb-title').addEventListener('change', async (e) => {
    const id = store.currentNotebook();
    if (!id) return;
    const title = e.target.value.trim() || 'Untitled';
    e.target.value = title;
    await store.renameNotebook(id, title);
  });
  $('nb-title').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
  });

  // ----- search -----
  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 150);
  });
  $('search').addEventListener('keydown', (e) => e.stopPropagation());
  async function runSearch(q) {
    const box = $('search-results');
    const listEl = $('notebook-list');
    if (!q.trim()) { box.hidden = true; listEl.hidden = false; return; }
    const hits = await store.search(q);
    box.textContent = '';
    if (!hits.length) box.innerHTML = '<p class="muted" style="padding:8px 10px">No matches</p>';
    for (const h of hits) {
      const el = document.createElement('div');
      el.className = 'search-hit';
      el.innerHTML = '<b></b><span></span>';
      el.querySelector('b').textContent = h.notebook.title;
      el.querySelector('span').textContent = h.sheet ? `“${h.snippet}”` : 'Notebook';
      el.onclick = async () => {
        await openNotebook(h.notebook.id);
        if (h.sheet) scrollToSheet(h.sheet.id);
        closeSidebarIfNarrow();
      };
      box.append(el);
    }
    box.hidden = false;
    listEl.hidden = true;
  }

  // ================= sheets =================
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = views.get(e.target.dataset.id);
      if (!v) continue;
      if (e.isIntersecting) v.activate();
      else v.deactivate();
    }
  }, { root: viewport, rootMargin: '120% 60% 120% 60%' });

  const fitZoom = () => Math.max(0.15, Math.min(1.4, (viewport.clientWidth - (isNarrow() ? 16 : 48)) / SHEET_W));
  const zoom = () => fitZoom() * userZoom;

  let openToken = 0;
  async function openNotebook(id) {
    if (id && !store.getNotebook(id)) id = null;
    const token = ++openToken;
    clearHistory();
    for (const v of views.values()) { io.unobserve(v.el); v.deactivate(); v.el.remove(); }
    views.clear();
    await store.openNotebook(id);
    if (token !== openToken) return; // a newer openNotebook() call won
    prefs.lastNotebook[user.id] = id;
    savePrefs();
    $('nb-title').value = id ? store.getNotebook(id).title : '';
    $('nb-title').disabled = !id;
    viewport.scrollTop = 0;
    renderNotebookList();
    renderSheets();
  }

  function onSheetMenu(view, anchor) { openSheetMenu(view, anchor); }

  function renderSheets() {
    const list = store.listSheets();
    const keep = new Set(list.map((s) => s.id));
    for (const [id, v] of views) {
      if (!keep.has(id)) { io.unobserve(v.el); v.deactivate(); v.el.remove(); views.delete(id); }
    }
    const z = zoom();
    sheetsEl.style.setProperty('--z', z);
    let prev = null;
    for (const s of list) {
      let v = views.get(s.id);
      if (!v) {
        v = new SheetView(s, { onMenu: onSheetMenu });
        v.layout(z);
        views.set(s.id, v);
        io.observe(v.el);
      } else if (v.sheet !== s) {
        v.update(s);
      }
      const expected = prev ? prev.el.nextSibling : sheetsEl.firstChild;
      if (expected !== v.el) sheetsEl.insertBefore(v.el, expected);
      prev = v;
    }
    const hasNotebook = !!store.currentNotebook();
    updatePill();
    $('empty').hidden = list.length > 0;
    $('empty-title').textContent = hasNotebook ? 'Drop PDFs here' : 'No notebook yet';
    $('empty-text').textContent = hasNotebook
      ? 'Each PDF page becomes a sheet with room for notes beside it.'
      : 'Add a PDF or a blank sheet and a notebook is created for you.';
  }

  const findView = (target) => {
    const el = target.closest && target.closest('.sheet');
    return el ? views.get(el.dataset.id) : null;
  };

  function viewAtY(clientY) {
    let best = null, bestDist = Infinity;
    for (const v of views.values()) {
      const r = v.el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return v;
      const d = Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
      if (d < bestDist) { bestDist = d; best = v; }
    }
    return best;
  }
  function centerView() {
    const r = viewport.getBoundingClientRect();
    return viewAtY(r.top + r.height / 2);
  }
  function scrollToSheet(id) {
    const v = views.get(id);
    if (v) viewport.scrollTop += v.el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
  }

  // ----- page number ("3 / 12") and go to sheet -----
  const pill = $('page-pill');
  let pillFrame = 0;
  function updatePill() {
    const list = store.listSheets();
    pill.hidden = list.length < 2;
    if (pill.hidden) return;
    const v = centerView();
    const i = v ? list.findIndex((x) => x.id === v.sheet.id) : 0;
    pill.textContent = `${Math.max(0, i) + 1} / ${list.length}`;
  }
  viewport.addEventListener('scroll', () => {
    if (!pillFrame) pillFrame = requestAnimationFrame(() => { pillFrame = 0; updatePill(); });
  }, { passive: true });
  pill.onclick = () => {
    const list = store.listSheets();
    menu.textContent = '';
    menu.classList.remove('cursor-menu');
    const form = document.createElement('form');
    form.className = 'goto';
    form.innerHTML = `<span class="muted small">Go to sheet</span><input type="number" min="1" max="${list.length}" required><button class="btn small primary">Go</button>`;
    const num = form.querySelector('input');
    num.value = String(parseInt(pill.textContent, 10) || 1);
    num.addEventListener('keydown', (e) => e.stopPropagation());
    form.onsubmit = (e) => {
      e.preventDefault();
      const n = Math.max(1, Math.min(list.length, parseInt(num.value, 10) || 1));
      closeMenu();
      scrollToSheet(list[n - 1].id);
    };
    menu.append(form);
    for (const [label, idx] of [['First sheet', 0], ['Last sheet', list.length - 1]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { closeMenu(); scrollToSheet(list[idx].id); };
      menu.append(b);
    }
    showPopup(pill);
    num.focus();
    num.select();
  };

  // ----- zoom -----
  function zoomAt(z, cx, cy) {
    const vr = viewport.getBoundingClientRect();
    if (cx == null) { cx = vr.left + vr.width / 2; cy = vr.top + vr.height / 2; }
    userZoom = Math.max(0.3, Math.min(6, z / fitZoom()));
    const anchorView = viewAtY(cy);
    let anchor = null;
    if (anchorView) {
      const r = anchorView.el.getBoundingClientRect();
      anchor = { ux: (cx - r.left) / anchorView.zoom, uy: (cy - r.top) / anchorView.zoom };
    }
    const nz = zoom();
    sheetsEl.style.setProperty('--z', nz);
    for (const v of views.values()) v.layout(nz);
    if (anchor) {
      const r = anchorView.el.getBoundingClientRect();
      viewport.scrollLeft += r.left + anchor.ux * nz - cx;
      viewport.scrollTop += r.top + anchor.uy * nz - cy;
    }
    $('zoom-label').textContent = `${Math.round(userZoom * 100)}%`;
    updateCursor();
    input.relayout();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { for (const v of views.values()) v.refresh(); }, 200);
  }
  const zoomBy = (f) => zoomAt(zoom() * f);
  const zoomReset = () => zoomAt(fitZoom());
  $('btn-zoom-in').onclick = () => zoomBy(1.2);
  $('btn-zoom-out').onclick = () => zoomBy(1 / 1.2);
  $('zoom-label').onclick = zoomReset;
  // Window resized: keep the same relative zoom (next frame, to avoid a resize loop).
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const z = zoom();
      sheetsEl.style.setProperty('--z', z);
      for (const v of views.values()) v.layout(z);
      updateCursor();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { for (const v of views.values()) v.refresh(); }, 200);
    });
  }).observe(viewport);

  // ================= tools =================
  const TOOLS = ['pen', 'highlighter', 'eraser', 'lasso', 'text', 'laser', 'hand'];
  function setTool(tool) {
    if (!TOOLS.includes(tool)) tool = 'pen';
    if (document.activeElement && document.activeElement.classList.contains('textbox') && tool !== 'text') document.activeElement.blur();
    if (tool !== 'lasso' && input) input.clearSelection();
    prefs.tool = tool;
    savePrefs();
    for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    viewport.className = `viewport tool-${tool}`;
    presets.close();
    presets.render();
    updateCursor();
  }

  const presets = initPresets({
    prefs,
    savePrefs,
    onChange: () => updateCursor(),
    onClearSheet: () => {
      const v = centerView();
      if (!v) return;
      const items = v.sheet.strokes.filter((it) => !it.deleted_at);
      if (items.length && confirm('Remove all ink and text from this sheet? (You can undo.)')) commit(v.sheet.id, [], items);
    },
  });

  // ----- cursor style -----
  function updateCursor() {
    const tool = prefs.tool;
    const st = toolStyle(prefs, tool);
    if (!st.size || tool === 'text') { viewport.style.removeProperty('--draw-cursor'); return; }
    // Pen/highlighter sizes are in sheet units; the eraser size is in screen pixels.
    const px = tool === 'eraser' ? st.size : st.size * zoom();
    viewport.style.setProperty('--draw-cursor', cursorFor(prefs.cursor, tool, st.color || '#111827', px));
  }
  function setCursorStyle(style) {
    prefs.cursor = style;
    savePrefs();
    $('set-cursor').value = style;
    updateCursor();
  }
  for (const [value, label] of CURSOR_STYLES) $('set-cursor').append(new Option(label, value));
  $('set-cursor').onchange = (e) => setCursorStyle(e.target.value);
  $('btn-cursor').onclick = () => {
    menu.textContent = '';
    menu.classList.add('cursor-menu');
    for (const [value, label] of CURSOR_STYLES) {
      const b = document.createElement('button');
      b.textContent = label;
      if (value === prefs.cursor) b.className = 'checked';
      b.onclick = () => { closeMenu(); setCursorStyle(value); };
      menu.append(b);
    }
    showPopup($('btn-cursor'));
  };
  for (const b of document.querySelectorAll('.tool')) b.onclick = () => setTool(b.dataset.tool);
  setTextDefaults(() => { const t = toolStyle(prefs, 'text'); return { color: t.color, size: t.size }; });

  const input = createInput({
    viewport,
    laserCanvas: $('laser-canvas'),
    findView,
    getTool: () => prefs.tool,
    getPen: (tool) => toolStyle(prefs, tool),
    getZoom: zoom,
    zoomAt,
    fingerDraw: () => prefs.fingerDraw,
    spaceHeld: () => spaceHeld,
    shapeHold: () => prefs.shapeHold,
    centerView,
    onToast: (msg) => toast(msg),
    setTool: (t) => setTool(t),
    onLiveInk: (payload) => { const sync = getSync(); if (sync) sync.sendLiveInk(payload); },
  });

  // ----- undo / redo -----
  const updateUndo = () => { $('btn-undo').disabled = !canUndo(); $('btn-redo').disabled = !canRedo(); };
  onHistoryChange(updateUndo);
  updateUndo();
  $('btn-undo').onclick = () => undo();
  $('btn-redo').onclick = () => redo();

  // ================= adding PDFs & sheets =================
  async function ensureNotebook(titleHint) {
    let id = store.currentNotebook();
    if (!id) {
      const nb = await store.createNotebook(titleHint || 'Untitled');
      await openNotebook(nb.id);
      id = nb.id;
    }
    return id;
  }

  async function importFiles(files) {
    const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { toast('Only PDF files can be added', { error: true }); return; }
    const baseName = pdfs[0].name.replace(/\.pdf$/i, '');
    const nbId = await ensureNotebook(baseName);
    // Name an empty "Untitled" notebook after the first PDF.
    const nb = store.getNotebook(nbId);
    if (nb.title === 'Untitled' && !store.listSheets().length) {
      await store.renameNotebook(nbId, baseName);
      $('nb-title').value = baseName;
    }
    let firstNew = null;
    for (const f of pdfs) {
      const t = toast(`Adding ${f.name}…`, { ms: 60000 });
      try {
        const info = await importPdf(f);
        const path = `${user.id}/${info.hash}.pdf`;
        if (!localMode) await store.queueUpload('pdf', info.hash);
        const m = prefs.marginWidth;
        const pdfW = SHEET_W * (1 - m);
        const parts = info.pages.map((pg, i) => ({
          pdf_path: path, pdf_page: i + 1, pdf_name: f.name,
          margin_side: prefs.marginSide, margin_width: m, paper: prefs.paperPdf,
          height: Math.round((pdfW * pg.h) / pg.w),
        }));
        const created = await store.addSheets(nbId, parts);
        firstNew = firstNew || created[0];
        t.remove();
        toast(`Added ${info.pages.length} page${info.pages.length === 1 ? '' : 's'} from ${f.name}`);
      } catch (err) {
        console.error(err);
        t.remove();
        toast(`Could not open ${f.name}: ${err.message || err}`, { error: true, ms: 6000 });
      }
    }
    if (firstNew) requestAnimationFrame(() => scrollToSheet(firstNew.id));
  }

  async function addBlankSheet(afterId) {
    const nbId = await ensureNotebook('Untitled');
    const after = afterId || (centerView() && centerView().sheet.id) || null;
    const [s] = await store.addSheets(nbId, [{ height: 1300, paper: prefs.paperBlank }], after);
    requestAnimationFrame(() => scrollToSheet(s.id));
  }

  const fileInput = $('file-input');
  const pickPdf = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files.length) importFiles(fileInput.files); fileInput.value = ''; };
  $('btn-add-pdf').onclick = pickPdf;
  $('empty-add-pdf').onclick = pickPdf;
  $('btn-add-sheet').onclick = () => addBlankSheet();
  $('empty-add-sheet').onclick = () => addBlankSheet();

  // Drag and drop (browser, Electron window, Android split-screen drag).
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop-overlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    importFiles(e.dataTransfer.files);
  });

  // PDFs opened with the installed PWA ("Open with E-Notes").
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = await Promise.all((params.files || []).map((h) => h.getFile()));
      if (files.length) importFiles(files);
    });
  }
  // PDFs opened with the desktop app.
  if (desktop) {
    desktop.onOpenPdfs((list) => importFiles(list.map((f) => new File([f.data], f.name, { type: 'application/pdf' }))));
  }

  // ================= sheet menu =================
  const menu = $('sheet-menu');
  function closeMenu() { menu.hidden = true; }
  function showPopup(anchor) {
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, r.bottom + 4))}px`;
  }
  function openSheetMenu(view, anchor) {
    const s = view.sheet;
    const idx = store.listSheets().findIndex((x) => x.id === s.id);
    menu.textContent = '';
    menu.classList.remove('cursor-menu');
    const add = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = async () => { closeMenu(); await fn(); };
      menu.append(b);
    };
    const info = document.createElement('div');
    info.className = 'muted small';
    info.style.padding = '6px 12px';
    info.textContent = `Sheet ${idx + 1}` + (s.pdf_name ? ` · ${s.pdf_name} p.${s.pdf_page}` : '');
    menu.append(info);
    add('Insert blank sheet below', () => addBlankSheet(s.id));
    add('Duplicate sheet', async () => { const c = await store.duplicateSheet(s.id); if (c) requestAnimationFrame(() => scrollToSheet(c.id)); });
    const count = store.listSheets().length;
    if (idx > 0) add('Move sheet up', () => store.moveSheet(s.id, -1).then(() => requestAnimationFrame(() => scrollToSheet(s.id))));
    if (idx < count - 1) add('Move sheet down', () => store.moveSheet(s.id, 1).then(() => requestAnimationFrame(() => scrollToSheet(s.id))));
    menu.append(document.createElement('hr'));
    const paperRow = document.createElement('div');
    paperRow.className = 'menu-paper';
    paperRow.innerHTML = '<span class="muted small">Paper</span>';
    for (const [value, label] of PAPERS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = (s.paper || 'plain') === value ? 'active' : '';
      b.onclick = () => { closeMenu(); store.updateSheetMeta(s.id, { paper: value }); };
      paperRow.append(b);
    }
    menu.append(paperRow);
    if (pdfRect(s)) {
      add(`Move notes margin to the ${s.margin_side === 'left' ? 'right' : 'left'}`,
        () => store.updateSheetMeta(s.id, { margin_side: s.margin_side === 'left' ? 'right' : 'left' }));
      for (const w of [0.3, 0.4, 0.5]) {
        if (Math.abs(w - s.margin_width) < 0.01) continue;
        add(`Margin width ${Math.round(w * 100)}%`, () => {
          const aspect = s.height / (SHEET_W * (1 - s.margin_width));
          return store.updateSheetMeta(s.id, { margin_width: w, height: Math.round(SHEET_W * (1 - w) * aspect) });
        });
      }
    }
    const ink = s.strokes.filter((it) => !it.deleted_at);
    if (ink.length) add('Clear all notes on this sheet', () => commit(s.id, [], ink));
    menu.append(document.createElement('hr'));
    add('Delete sheet', async () => {
      if (confirm('Delete this sheet on all your devices?')) await store.deleteSheet(s.id);
    }, 'danger');
    showPopup(anchor);
  }
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);

  // ================= export =================
  async function openExport() {
    const id = store.currentNotebook();
    const sheets = store.listSheets();
    if (!id || !sheets.length) { toast('Nothing to export yet'); return; }
    const dlg = $('export-dialog');
    const box = $('export-options');
    box.textContent = '';
    $('export-progress').hidden = true;
    const title = store.getNotebook(id).title;
    const option = (label, list, name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.onclick = () => runExport(list, name);
      box.append(b);
    };
    option(`Whole notebook — ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`, sheets, title);
    const byPdf = new Map();
    for (const s of sheets) {
      if (!s.pdf_path) continue;
      if (!byPdf.has(s.pdf_path)) byPdf.set(s.pdf_path, { name: s.pdf_name || 'PDF', list: [] });
      byPdf.get(s.pdf_path).list.push(s);
    }
    if (byPdf.size > 1 || (byPdf.size === 1 && [...byPdf.values()][0].list.length !== sheets.length)) {
      for (const { name, list } of byPdf.values()) {
        option(`Only ${name} — ${list.length} page${list.length === 1 ? '' : 's'}`, list, `${title} - ${name.replace(/\.pdf$/i, '')}`);
      }
    }
    dlg.showModal();
  }
  async function runExport(list, name) {
    const prog = $('export-progress');
    const buttons = $('export-options').querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    prog.hidden = false;
    try {
      const bytes = await exportSheets(list, (d, t) => { prog.textContent = `Preparing page ${d} of ${t}…`; });
      prog.textContent = 'Saving…';
      const msg = await saveFile(`${safeFileName(name)} (notes).pdf`, bytes);
      $('export-dialog').close();
      if (msg) toast(msg);
    } catch (err) {
      console.error(err);
      prog.textContent = `Export failed: ${err.message || err}`;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }
  $('btn-export').onclick = openExport;

  // ================= settings =================
  function openSettings() {
    $('set-margin-side').value = prefs.marginSide;
    $('set-margin-width').value = prefs.marginWidth;
    $('set-margin-width-label').textContent = `${Math.round(prefs.marginWidth * 100)}%`;
    $('set-finger').checked = prefs.fingerDraw;
    $('set-shapes').checked = prefs.shapeHold;
    $('set-paper-blank').value = prefs.paperBlank;
    $('set-paper-pdf').value = prefs.paperPdf;
    $('set-cursor').value = prefs.cursor;
    $('set-theme').value = prefs.theme;
    $('set-gap').value = prefs.sheetGap;
    $('set-gap-label').textContent = prefs.sheetGap;
    const where = isElectron ? 'Desktop' : isNative ? 'Android' : 'Web';
    $('settings-about').textContent = `Version ${__APP_VERSION__} · ${where}`;
    $('settings-dialog').showModal();
  }
  $('set-margin-side').onchange = (e) => { prefs.marginSide = e.target.value; savePrefs(); };
  $('set-margin-width').oninput = (e) => {
    prefs.marginWidth = Number(e.target.value);
    $('set-margin-width-label').textContent = `${Math.round(prefs.marginWidth * 100)}%`;
    savePrefs();
  };
  $('set-finger').onchange = (e) => { prefs.fingerDraw = e.target.checked; savePrefs(); };
  $('set-shapes').onchange = (e) => { prefs.shapeHold = e.target.checked; savePrefs(); };
  for (const id of ['set-paper-blank', 'set-paper-pdf']) {
    for (const [value, label] of PAPERS) $(id).append(new Option(label, value));
  }
  $('set-paper-blank').onchange = (e) => { prefs.paperBlank = e.target.value; savePrefs(); };
  $('set-paper-pdf').onchange = (e) => { prefs.paperPdf = e.target.value; savePrefs(); };
  $('set-theme').onchange = (e) => { prefs.theme = e.target.value; savePrefs(); applyTheme(); };
  $('set-gap').oninput = (e) => {
    prefs.sheetGap = Number(e.target.value);
    $('set-gap-label').textContent = prefs.sheetGap;
    applySheetGap();
    savePrefs();
  };
  $('btn-settings').onclick = openSettings;
  $('btn-theme').onclick = () => {
    prefs.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  };

  // ================= AI helper (free) =================
  const aiPanel = initAiPanel({
    getCurrent: () => {
      const v = centerView();
      if (!v) return null;
      const sheet = store.getSheet(v.sheet.id) || v.sheet;
      return { sheet, index: store.listSheets().findIndex((s) => s.id === sheet.id) };
    },
    scrollToSheet: (id) => requestAnimationFrame(() => scrollToSheet(id)),
    toast,
    /** The sheet under a screen point (for "Snip"): {sheet, rect, zoom} or null. */
    sheetAt: (x, y) => {
      for (const el of document.elementsFromPoint(x, y)) {
        const sheetEl = el.closest && el.closest('.sheet');
        const v = sheetEl && views.get(sheetEl.dataset.id);
        if (v) return { sheet: store.getSheet(v.sheet.id) || v.sheet, rect: v.el.getBoundingClientRect(), zoom: v.zoom };
      }
      return null;
    },
  });
  $('btn-ai').onclick = () => aiPanel.toggle();

  // ================= sync status & account =================
  const STATUS_TEXT = { synced: 'Synced', syncing: 'Syncing…', offline: 'Offline', error: 'Sync error', local: 'This device only', signin: 'Sign in to sync' };
  function setSyncStatus(s) {
    const el = $('sync-status');
    el.className = `sync-status ${s}`;
    el.querySelector('span').textContent = STATUS_TEXT[s] || s;
    el.title = s === 'error' ? 'Changes are saved on this device and will retry automatically' : STATUS_TEXT[s] || '';
  }
  setSyncStatus(localMode ? 'local' : 'syncing');

  $('btn-signout').onclick = async () => {
    const sync = getSync();
    if (!localMode && sync && (await sync.pendingCount())) {
      if (!confirm('Some changes have not been uploaded yet. They stay on this device and upload when you sign in again. Sign out anyway?')) return;
    }
    onSignOut();
  };

  // ================= store events =================
  store.events.addEventListener('notebooks', () => {
    renderNotebookList();
    const id = store.currentNotebook();
    if (id && !store.getNotebook(id)?.deleted_at) {
      if (document.activeElement !== $('nb-title')) $('nb-title').value = store.getNotebook(id).title;
    } else if (id) {
      const next = store.listNotebooks()[0];
      openNotebook(next ? next.id : null);
    } else if (store.listNotebooks().length) {
      // First sync on a new device: open the notebook that just arrived.
      const last = prefs.lastNotebook[user.id];
      const pick = (last && store.getNotebook(last) && !store.getNotebook(last).deleted_at) ? last : store.listNotebooks()[0].id;
      openNotebook(pick);
    }
  });
  store.events.addEventListener('sheets', (e) => {
    if (e.detail.notebookId === store.currentNotebook()) renderSheets();
  });
  store.events.addEventListener('sheet', (e) => {
    const v = views.get(e.detail.sheet.id);
    if (v) { v.update(e.detail.sheet); input.sheetUpdated(v); }
  });

  // ================= keyboard & commands =================
  const commands = {
    'new-notebook': newNotebook,
    'import-pdf': pickPdf,
    'add-sheet': () => addBlankSheet(),
    export: openExport,
    settings: openSettings,
    undo: () => undo(),
    redo: () => redo(),
    'zoom-in': () => zoomBy(1.2),
    'zoom-out': () => zoomBy(1 / 1.2),
    'zoom-reset': zoomReset,
    'toggle-sidebar': () => toggleSidebar(),
    'toggle-theme': () => $('btn-theme').click(),
    'tool:pen': () => setTool('pen'),
    'tool:highlighter': () => setTool('highlighter'),
    'tool:eraser': () => setTool('eraser'),
    'tool:text': () => setTool('text'),
    'tool:hand': () => setTool('hand'),
    'tool:lasso': () => setTool('lasso'),
    'tool:laser': () => setTool('laser'),
    copy: () => input.copySelection(),
    cut: () => input.cutSelection(),
    paste: () => input.paste(),
    duplicate: () => input.duplicateSelection(),
    delete: () => input.deleteSelection(),
  };
  if (desktop) desktop.onMenu((cmd) => commands[cmd] && commands[cmd]());

  const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let cmd = null;
    if (mod) {
      if (k === 'z') cmd = e.shiftKey ? 'redo' : 'undo';
      else if (k === 'y') cmd = 'redo';
      else if (k === 'c' && input.hasSelection()) cmd = 'copy';
      else if (k === 'x' && input.hasSelection()) cmd = 'cut';
      else if (k === 'd' && input.hasSelection()) cmd = 'duplicate';
      else if (k === 'v' && input.hasClipboard()) cmd = 'paste';
      // In Electron these come from the native menu instead.
      else if (!isElectron) {
        if (k === '=' || k === '+') cmd = 'zoom-in';
        else if (k === '-') cmd = 'zoom-out';
        else if (k === '0') cmd = 'zoom-reset';
        else if (k === 'o') cmd = 'import-pdf';
        else if (k === 'e') cmd = 'export';
        else if (k === 'b') cmd = 'toggle-sidebar';
      }
    } else if (!e.altKey) {
      cmd = { p: 'tool:pen', h: 'tool:highlighter', e: 'tool:eraser', t: 'tool:text', v: 'tool:hand', l: 'tool:lasso', k: 'tool:laser' }[k] || null;
      if ((k === 'delete' || k === 'backspace') && input.hasSelection()) cmd = 'delete';
      if (e.code === 'Space') {
        e.preventDefault();
        if (!spaceHeld) { spaceHeld = true; viewport.classList.add('tool-hand'); }
        return;
      }
      if (k === 'escape') { closeMenu(); input.clearSelection(); return; }
    }
    if (cmd) { e.preventDefault(); commands[cmd](); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceHeld) {
      spaceHeld = false;
      if (prefs.tool !== 'hand') viewport.classList.remove('tool-hand');
    }
  });

  // Android back button: close popups / sidebar first.
  onBackButton(() => {
    const open = document.querySelector('dialog[open]');
    if (open) { open.close(); return true; }
    if (!menu.hidden) { closeMenu(); return true; }
    if (presets.isOpen()) { presets.close(); return true; }
    if (input.hasSelection()) { input.clearSelection(); return true; }
    if (aiPanel.isOpen()) { aiPanel.toggle(false); return true; }
    if (app.classList.contains('sidebar-open')) { toggleSidebar(false); return true; }
    return false;
  });

  // ================= start =================
  setTool(prefs.tool);
  const last = prefs.lastNotebook[user.id];
  const first = store.listNotebooks()[0];
  openNotebook(last && store.getNotebook(last) && !store.getNotebook(last).deleted_at ? last : first ? first.id : null);
  if (isNarrow() && !store.listNotebooks().length) toggleSidebar(false);

  /** A stroke another device is drawing right now. */
  function showLiveInk(payload) {
    if (!payload || !payload.sheetId) return;
    const v = views.get(payload.sheetId);
    if (v) v.showGhost(payload.item, payload.done);
  }

  return { setSyncStatus, showLiveInk };
}
