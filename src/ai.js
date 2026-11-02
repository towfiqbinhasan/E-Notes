// "Ask Claude" panel. The app sends a picture of the current sheet to the Supabase
// Edge Function "claude" (supabase/functions/claude), which checks the signed-in
// user and calls Claude with the server's API key.
import { supabase, isConfigured } from './supabase.js';
import { SHEET_W, pdfRect, drawItems, drawTextItems } from './canvas.js';
import { renderPageToCanvas } from './pdf.js';
import { addSheets, getSheet, uid } from './store.js';
import { commit } from './history.js';

const $ = (id) => document.getElementById(id);
const AI_TEXT = { color: '#1d4ed8', size: 18 };

/** Picture of a sheet (PDF page + ink + text) as base64 JPEG, ~1200 px wide. */
async function sheetPicture(sheet, width = 1200) {
  const k = width / SHEET_W;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(sheet.height * k);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const r = pdfRect(sheet);
  if (r) {
    const page = await renderPageToCanvas(sheet.pdf_path, sheet.pdf_page, Math.round(r.w * k));
    ctx.drawImage(page, r.x * k, 0, r.w * k, r.h * k);
    page.width = page.height = 0;
  }
  ctx.scale(k, k);
  drawItems(ctx, sheet.strokes);
  drawTextItems(ctx, sheet.strokes);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function callClaude(payload) {
  const { data, error } = await supabase.functions.invoke('claude', { body: payload });
  if (!error) return data;
  let msg = error.message;
  const res = error.context;
  if (res && typeof res.json === 'function') {
    if (res.status === 404) msg = 'The "claude" server function is not deployed yet (see README, "Claude").';
    else {
      try { const b = await res.json(); if (b && b.error) msg = b.error; } catch { /* keep message */ }
    }
  }
  throw new Error(msg);
}

// ---------- putting an answer onto the sheet ----------

function estimateHeight(text, width, size) {
  const charsPerLine = Math.max(8, Math.floor(width / (size * 0.55)));
  let lines = 0;
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / charsPerLine));
  return lines * size * 1.3 + 10;
}

function bottomOfContent(sheet, x0, x1) {
  let bottom = 0;
  for (const it of sheet.strokes) {
    if (it.deleted_at) continue;
    if (it.t === 'text') {
      const w = it.w ?? SHEET_W - it.x;
      if (it.x < x1 && it.x + w > x0) bottom = Math.max(bottom, it.y + estimateHeight(it.text || '', w, it.s));
    } else if (it.p) {
      for (let i = 0; i < it.p.length; i += 3) {
        if (it.p[i] >= x0 && it.p[i] <= x1) bottom = Math.max(bottom, it.p[i + 1] + it.s);
      }
    }
  }
  return bottom;
}

/** Add Claude's text in the free part of the notes margin, or on a new sheet below if it doesn't fit. */
async function insertOnSheet(sheet, text) {
  const r = pdfRect(sheet);
  let x0 = 40, x1 = SHEET_W - 40;
  if (r) {
    if (sheet.margin_side === 'left') { x0 = 20; x1 = r.x - 20; } else { x0 = r.w + 20; x1 = SHEET_W - 20; }
  }
  const y = bottomOfContent(sheet, x0, x1) + 30;
  const need = estimateHeight(text, x1 - x0, AI_TEXT.size);
  const item = (x, yy, w) => ({ id: uid(), t: 'text', x, y: Math.round(yy), w: Math.round(w), s: AI_TEXT.size, c: AI_TEXT.color, text, created: Date.now() });

  if (y + need <= sheet.height - 20) {
    await commit(sheet.id, [item(x0, Math.max(30, y), x1 - x0)], []);
    return sheet.id;
  }
  // Not enough room: a new blank sheet right after this one, tall enough for the text.
  const height = Math.max(1300, Math.ceil(estimateHeight(text, SHEET_W - 80, AI_TEXT.size) + 100));
  const [blank] = await addSheets(sheet.notebook_id, [{ height }], sheet.id);
  await commit(blank.id, [item(40, 40, SHEET_W - 80)], []);
  return blank.id;
}

// ---------- panel ----------

/**
 * opts: { getCurrent() -> {sheet, index} | null, enabled: boolean, scrollToSheet(id), toast(msg, opts) }
 */
export function initClaudePanel({ getCurrent, enabled, scrollToSheet, toast }) {
  const panel = $('ai-panel');
  const log = $('ai-log');
  const input = $('ai-input');
  let history = [];          // [{role, content}] for the current sheet
  let historySheet = null;
  let busy = false;

  const usable = enabled && isConfigured;
  if (!usable) {
    $('ai-foot').textContent = isConfigured
      ? 'Sign in with your email account to use Claude.'
      : 'Supabase is not configured (.env), so Claude is not available.';
  }
  for (const b of panel.querySelectorAll('[data-ai], #ai-form button')) b.disabled = !usable;
  input.disabled = !usable;

  function refreshHeader() {
    const cur = getCurrent();
    $('ai-sheet').textContent = cur ? `Sheet ${cur.index + 1}` : 'No sheet';
  }

  function bubble(role, text, cls = '') {
    const el = document.createElement('div');
    el.className = `ai-msg ${role} ${cls}`;
    const body = document.createElement('div');
    body.className = 'ai-text';
    body.textContent = text;
    el.append(body);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function addAnswerButtons(el, text, sheet) {
    const row = document.createElement('div');
    row.className = 'ai-buttons';
    const add = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Add to sheet' });
    add.onclick = async () => {
      add.disabled = true;
      try {
        const id = await insertOnSheet(getSheet(sheet.id) || sheet, text);
        if (id !== sheet.id) toast('Added on a new sheet below (the margin was full)');
        scrollToSheet(id);
        add.textContent = 'Added ✓';
      } catch (err) {
        add.disabled = false;
        toast(`Could not add: ${err.message}`, { error: true });
      }
    };
    const copy = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Copy' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied ✓'; } catch { toast('Copy failed', { error: true }); }
    };
    row.append(add, copy);
    el.append(row);
  }

  async function ask(action, question, label) {
    if (busy || !usable) return;
    const cur = getCurrent();
    if (!cur) { toast('Open a notebook with at least one sheet first'); return; }
    if (!navigator.onLine) { toast('Claude needs an internet connection', { error: true }); return; }
    const { sheet, index } = cur;
    if (historySheet !== sheet.id) {
      history = [];
      historySheet = sheet.id;
      const d = document.createElement('div');
      d.className = 'ai-divider';
      d.textContent = `Sheet ${index + 1}`;
      log.append(d);
    }
    busy = true;
    panel.classList.add('busy');
    bubble('user', label);
    const waiting = bubble('assistant', 'Claude is reading the sheet…', 'waiting');
    try {
      const image = await sheetPicture(sheet);
      const res = await callClaude({ action, question, image, history });
      waiting.remove();
      const text = res.text || '(no answer)';
      const el = bubble('assistant', text);
      addAnswerButtons(el, text, sheet);
      if (res.truncated) bubble('assistant', 'The answer was cut off because it was very long.', 'note');
      history.push({ role: 'user', content: action === 'ask' ? question : label }, { role: 'assistant', content: text });
      if (res.limit) $('ai-foot').textContent = `Today: ${res.used} of ${res.limit} Claude requests used`;
    } catch (err) {
      waiting.remove();
      bubble('assistant', err.message, 'error');
    } finally {
      busy = false;
      panel.classList.remove('busy');
    }
  }

  for (const b of panel.querySelectorAll('[data-ai]')) {
    b.onclick = () => ask(b.dataset.ai, undefined, b.textContent);
  }
  $('ai-form').onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    ask('ask', q, q);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep tool shortcuts out of the text
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ai-form').requestSubmit(); }
  });
  $('ai-close').onclick = () => toggle(false);

  function toggle(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    $('btn-ai').classList.toggle('active', open);
    if (open) { refreshHeader(); if (usable && !matchMedia('(pointer: coarse)').matches) input.focus(); }
  }
  // Keep the "Sheet N" label in sync while scrolling.
  $('viewport').addEventListener('scroll', () => { if (!panel.hidden) refreshHeader(); }, { passive: true });

  return { toggle, isOpen: () => !panel.hidden };
}
