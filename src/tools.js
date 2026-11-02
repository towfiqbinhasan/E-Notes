// Pen presets in the toolbar (coloured dot + ▾) and the popover that edits them:
// pen type, colour palette, recent colours, thickness, opacity, eraser options.
import { drawItem, HIGHLIGHT_ALPHA } from './canvas.js';

const $ = (id) => document.getElementById(id);

export const PEN_KINDS = [
  ['ball', 'Ballpoint'],
  ['fountain', 'Fountain'],
  ['brush', 'Brush'],
  ['pencil', 'Pencil'],
];

export const PALETTE = [
  '#000000', '#374151', '#6b7280', '#9ca3af', '#ffffff', '#7f1d1d', '#dc2626', '#f97316', '#f59e0b', '#facc15',
  '#14532d', '#16a34a', '#22c55e', '#84cc16', '#0d9488', '#1e3a8a', '#2563eb', '#3b82f6', '#06b6d4', '#0ea5e9',
  '#4c1d95', '#7c3aed', '#a855f7', '#db2777', '#f472b6', '#78350f', '#a16207', '#fb923c', '#fda4af', '#fde68a',
];

const DEFAULT_PRESETS = {
  pen: [
    { c: '#111827', s: 3, k: 'ball', o: 1 },
    { c: '#2563eb', s: 3, k: 'ball', o: 1 },
    { c: '#dc2626', s: 3, k: 'ball', o: 1 },
    { c: '#111827', s: 5, k: 'fountain', o: 1 },
  ],
  highlighter: [
    { c: '#facc15', s: 22, o: HIGHLIGHT_ALPHA, straight: false },
    { c: '#4ade80', s: 22, o: HIGHLIGHT_ALPHA, straight: false },
    { c: '#f472b6', s: 22, o: HIGHLIGHT_ALPHA, straight: false },
  ],
  text: [
    { c: '#111827', s: 22 },
    { c: '#2563eb', s: 22 },
  ],
};
const SIZE_RANGE = { pen: [0.5, 20, 0.5], highlighter: [6, 60, 1], eraser: [6, 100, 2], text: [10, 64, 1] };
const OPACITY_RANGE = { pen: [0.2, 1], highlighter: [0.1, 0.8] };
const PRESET_TOOLS = ['pen', 'highlighter', 'text'];

/** Upgrade older preferences (single colour per tool) to presets. */
export function migratePrefs(prefs) {
  if (!prefs.presets) {
    prefs.presets = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
    if (prefs.pen && prefs.pen.color) Object.assign(prefs.presets.pen[0], { c: prefs.pen.color, s: prefs.pen.size });
    if (prefs.highlighter && prefs.highlighter.color) Object.assign(prefs.presets.highlighter[0], { c: prefs.highlighter.color, s: prefs.highlighter.size });
    if (prefs.text && prefs.text.color) Object.assign(prefs.presets.text[0], { c: prefs.text.color, s: prefs.text.size });
  }
  prefs.active = { pen: 0, highlighter: 0, text: 0, ...(prefs.active || {}) };
  const oldEraser = prefs.eraser || {};
  prefs.eraser = { size: oldEraser.size || 24, mode: oldEraser.mode || 'stroke', hlOnly: !!oldEraser.hlOnly };
  prefs.recentColors = Array.isArray(prefs.recentColors) ? prefs.recentColors : [];
  delete prefs.pen; delete prefs.highlighter; delete prefs.text;
  return prefs;
}

function activePreset(prefs, tool) {
  const list = prefs.presets[tool];
  if (!list || !list.length) return null;
  if (prefs.active[tool] >= list.length) prefs.active[tool] = 0;
  return list[prefs.active[tool]];
}

/** Style of the current tool: {color, size, kind, opacity, straight} or eraser {size, mode, hlOnly}. */
export function toolStyle(prefs, tool) {
  if (tool === 'eraser') return prefs.eraser;
  const p = activePreset(prefs, tool);
  if (!p) return {};
  return { color: p.c, size: p.s, kind: p.k, opacity: p.o, straight: !!p.straight };
}

// ---------- toolbar ----------

function dotSize(tool, s) {
  if (tool === 'pen') return Math.max(8, Math.min(20, 7 + s * 0.9));
  if (tool === 'highlighter') return Math.max(10, Math.min(22, 8 + s * 0.25));
  return 16;
}

/**
 * opts: { prefs, savePrefs, onChange() (style changed), onClearSheet() }
 */
export function initPresets({ prefs, savePrefs, onChange, onClearSheet }) {
  const bar = $('presets');
  const pop = $('tool-popover');
  let popFor = null; // {tool, index} the popover is editing

  const changed = () => { savePrefs(); render(); onChange(); };

  function render() {
    const tool = prefs.tool;
    bar.textContent = '';
    if (PRESET_TOOLS.includes(tool)) {
      prefs.presets[tool].forEach((p, i) => {
        const b = document.createElement('button');
        b.className = 'preset' + (i === prefs.active[tool] ? ' active' : '');
        const kind = tool === 'pen' ? (PEN_KINDS.find(([k]) => k === p.k) || [, 'Pen'])[1] : tool === 'text' ? 'Text' : 'Highlighter';
        b.title = `${kind} · ${p.s}`;
        const d = dotSize(tool, p.s);
        b.innerHTML = tool === 'text'
          ? `<span class="preset-a" style="color:${p.c}">A</span><span class="chev">▾</span>`
          : `<span class="dot" style="width:${d}px;height:${d}px;background:${p.c};opacity:${tool === 'highlighter' ? 0.75 : p.o ?? 1}"></span><span class="chev">▾</span>`;
        b.onclick = (e) => {
          const onChevron = e.target.classList.contains('chev');
          if (i !== prefs.active[tool]) {
            prefs.active[tool] = i;
            changed();
            if (!onChevron) return;
          }
          openPopover(tool, i, bar.children[i]);
        };
        bar.append(b);
      });
      const add = document.createElement('button');
      add.className = 'preset add';
      add.title = 'Add a preset';
      add.textContent = '+';
      add.onclick = () => {
        const list = prefs.presets[tool];
        list.push({ ...list[prefs.active[tool]] });
        prefs.active[tool] = list.length - 1;
        changed();
        openPopover(tool, list.length - 1, bar.children[list.length - 1]);
      };
      bar.append(add);
      const remove = document.createElement('button');
      remove.className = 'preset add';
      remove.title = 'Remove the selected preset';
      remove.textContent = '−';
      remove.disabled = prefs.presets[tool].length <= 1;
      remove.onclick = () => {
        const list = prefs.presets[tool];
        if (list.length <= 1) return;
        list.splice(prefs.active[tool], 1);
        prefs.active[tool] = Math.min(prefs.active[tool], list.length - 1);
        close();
        changed();
      };
      bar.append(remove);
    } else if (tool === 'eraser') {
      const e = prefs.eraser;
      const b = document.createElement('button');
      b.className = 'preset wide active';
      b.title = 'Eraser options';
      const d = Math.max(8, Math.min(20, e.size / 4));
      b.innerHTML = `<span class="dot ring" style="width:${d}px;height:${d}px"></span><span class="preset-label">${e.mode === 'partial' ? 'Precise' : 'Whole stroke'}${e.hlOnly ? ' · highlighter' : ''}</span><span class="chev">▾</span>`;
      b.onclick = () => openPopover('eraser', 0, b);
      bar.append(b);
    } else {
      const hint = { lasso: 'Draw around ink to select it', laser: 'Laser pointer: fades away', hand: 'Drag to scroll' }[tool];
      if (hint) bar.innerHTML = `<span class="muted small preset-hint">${hint}</span>`;
    }
    if (popFor && !pop.hidden) {
      // Keep the popover attached to the (re-rendered) button.
      const anchor = popFor.tool === 'eraser' ? bar.children[0] : bar.children[popFor.index];
      if (anchor) place(anchor);
    }
  }

  // ---------- popover ----------

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pw - 8, r.left))}px`;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    pop.style.top = `${top}px`;
  }

  function close() {
    pop.hidden = true;
    popFor = null;
  }

  function section(title) {
    const s = document.createElement('div');
    s.className = 'pop-section';
    if (title) {
      const h = document.createElement('div');
      h.className = 'pop-title';
      h.textContent = title;
      s.append(h);
    }
    pop.append(s);
    return s;
  }

  function slider(parent, label, min, max, step, value, fmt, oninput) {
    const row = document.createElement('label');
    row.className = 'pop-slider';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><b></b>`;
    const input = row.querySelector('input');
    const out = row.querySelector('b');
    out.textContent = fmt(value);
    input.oninput = () => { out.textContent = fmt(Number(input.value)); oninput(Number(input.value)); };
    parent.append(row);
    return input;
  }

  function colorGrid(parent, current, onpick) {
    const grid = document.createElement('div');
    grid.className = 'pop-colors';
    const add = (c, cls = '') => {
      const b = document.createElement('button');
      b.className = `pop-color ${cls}` + (c.toLowerCase() === current.toLowerCase() ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.onclick = () => onpick(c);
      grid.append(b);
    };
    PALETTE.forEach((c) => add(c));
    parent.append(grid);
    if (prefs.recentColors.length) {
      const rt = document.createElement('div');
      rt.className = 'pop-subtitle';
      rt.textContent = 'Recent';
      parent.append(rt);
      const recent = document.createElement('div');
      recent.className = 'pop-colors';
      parent.append(recent);
      for (const c of prefs.recentColors) {
        const b = document.createElement('button');
        b.className = 'pop-color' + (c.toLowerCase() === current.toLowerCase() ? ' active' : '');
        b.style.background = c;
        b.title = c;
        b.onclick = () => onpick(c);
        recent.append(b);
      }
    }
    const custom = document.createElement('label');
    custom.className = 'pop-custom';
    custom.innerHTML = `<span class="color-wheel"><input type="color" value="${current}"></span><span>Custom colour</span>`;
    const input = custom.querySelector('input');
    input.onchange = () => {
      const c = input.value;
      prefs.recentColors = [c, ...prefs.recentColors.filter((x) => x !== c)].slice(0, 10);
      onpick(c);
    };
    parent.append(custom);
  }

  function preview(parent, tool, p) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pop-preview';
    const W = 260, H = 56, dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const x = 14 + (i / 40) * (W - 28);
      const y = H / 2 + (tool === 'highlighter' && p.straight ? 0 : Math.sin(i / 6.5) * 12);
      pts.push(x, y, 0.25 + 0.7 * Math.sin((i / 40) * Math.PI));
    }
    drawItem(ctx, { id: 'preview', t: tool === 'highlighter' ? 'hl' : 'pen', c: p.c, s: p.s, k: p.k, o: p.o, pr: 1, p: pts, created: 0 });
    parent.append(canvas);
  }

  function openPopover(tool, index, anchor) {
    popFor = { tool, index };
    pop.textContent = '';
    const rebuild = () => { const a = tool === 'eraser' ? bar.children[0] : bar.children[index]; openPopover(tool, index, a || anchor); };

    if (tool === 'eraser') {
      const e = prefs.eraser;
      const s = section('Eraser');
      const seg = document.createElement('div');
      seg.className = 'segmented';
      for (const [mode, label] of [['stroke', 'Whole stroke'], ['partial', 'Precise']]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = e.mode === mode ? 'active' : '';
        b.onclick = () => { e.mode = mode; changed(); rebuild(); };
        seg.append(b);
      }
      s.append(seg);
      slider(s, 'Size', ...SIZE_RANGE.eraser, e.size, (v) => `${v}`, (v) => { e.size = v; changed(); });
      const hl = document.createElement('label');
      hl.className = 'pop-check';
      hl.innerHTML = `<input type="checkbox" ${e.hlOnly ? 'checked' : ''}> Erase highlighter only`;
      hl.querySelector('input').onchange = (ev) => { e.hlOnly = ev.target.checked; changed(); };
      s.append(hl);
      const clear = document.createElement('button');
      clear.className = 'btn small danger';
      clear.textContent = 'Clear this sheet…';
      clear.onclick = () => { close(); onClearSheet(); };
      section().append(clear);
    } else {
      const list = prefs.presets[tool];
      const p = list[index];
      const set = (patch) => { Object.assign(p, patch); changed(); rebuild(); };
      if (tool === 'pen') {
        const s = section('Pen type');
        const seg = document.createElement('div');
        seg.className = 'segmented';
        for (const [k, label] of PEN_KINDS) {
          const b = document.createElement('button');
          b.textContent = label;
          b.className = (p.k || 'fountain') === k ? 'active' : '';
          b.onclick = () => set({ k, o: k === 'pencil' ? Math.min(p.o ?? 1, 0.85) : p.o });
          seg.append(b);
        }
        s.append(seg);
      }
      colorGrid(section('Colour'), p.c, (c) => set({ c }));
      const sz = section(tool === 'text' ? 'Text size' : 'Thickness');
      slider(sz, 'Size', ...SIZE_RANGE[tool], p.s, (v) => `${v}`, (v) => { p.s = v; changed(); refreshPreview(); });
      if (OPACITY_RANGE[tool]) {
        const [min, max] = OPACITY_RANGE[tool];
        slider(sz, 'Opacity', min, max, 0.05, p.o ?? (tool === 'highlighter' ? HIGHLIGHT_ALPHA : 1),
          (v) => `${Math.round(v * 100)}%`, (v) => { p.o = v; changed(); refreshPreview(); });
      }
      if (tool === 'highlighter') {
        const st = document.createElement('label');
        st.className = 'pop-check';
        st.innerHTML = `<input type="checkbox" ${p.straight ? 'checked' : ''}> Straight lines only`;
        st.querySelector('input').onchange = (ev) => set({ straight: ev.target.checked });
        sz.append(st);
      }
      let pv = null;
      function refreshPreview() {
        if (!pv) return;
        pv.textContent = '';
        if (tool !== 'text') preview(pv, tool, p);
      }
      if (tool !== 'text') { pv = section(); refreshPreview(); }
      if (list.length > 1) {
        const del = document.createElement('button');
        del.className = 'btn small danger';
        del.textContent = 'Delete this preset';
        del.onclick = () => {
          list.splice(index, 1);
          prefs.active[tool] = Math.min(prefs.active[tool], list.length - 1);
          close();
          changed();
        };
        section().append(del);
      }
    }
    pop.hidden = false;
    place(anchor);
  }

  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !bar.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) close(); });

  return { render, close, isOpen: () => !pop.hidden };
}
