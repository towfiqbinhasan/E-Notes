// Data layer: every edit is written to IndexedDB immediately, queued in the
// "outbox", and the sync module pushes it to Supabase in the background.
import { getDb } from './db.js';

export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

const notebooks = new Map();      // id -> notebook (all of them, small)
let currentNotebookId = null;
let currentSheets = new Map();    // id -> sheet (only the open notebook)
let onLocalChange = () => {};

export const uid = () => crypto.randomUUID ? crypto.randomUUID() : fallbackUuid();
const nowIso = () => new Date().toISOString();
const time = (iso) => (iso ? Date.parse(iso) : 0);

function fallbackUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Called by sync.js so it hears about every local change. */
export function setChangeListener(fn) { onLocalChange = fn; }

let outboxCounter = 0;
async function enqueue(kind, id) {
  await getDb().put('outbox', { key: `${kind}:${id}`, kind, id, ts: Date.now() * 1000 + (outboxCounter++ % 1000) });
  onLocalChange();
}
export { enqueue as queueUpload };

// ---------------- merge rules ----------------

// Items (strokes and text boxes) are immutable and identified by id.
// Union by id; a tombstone (deleted_at) always wins.
function pickItem(a, b) {
  if (a.deleted_at) return a;
  if (b.deleted_at) return b;
  return (b.updated || b.created || 0) > (a.updated || a.created || 0) ? b : a;
}
export function mergeItems(a = [], b = []) {
  const map = new Map();
  for (const it of a) map.set(it.id, it);
  for (const it of b) {
    const cur = map.get(it.id);
    map.set(it.id, cur ? pickItem(cur, it) : it);
  }
  return [...map.values()].sort((x, y) => (x.created || 0) - (y.created || 0) || (x.id < y.id ? -1 : 1));
}

const SHEET_META = ['notebook_id', 'position', 'height', 'pdf_path', 'pdf_page', 'pdf_name', 'margin_side', 'margin_width', 'paper'];

function cleanSheet(row) {
  const s = {
    id: row.id,
    notebook_id: row.notebook_id,
    position: row.position ?? 0,
    height: row.height ?? 1300,
    pdf_path: row.pdf_path ?? null,
    pdf_page: row.pdf_page ?? null,
    pdf_name: row.pdf_name ?? null,
    margin_side: row.margin_side || 'right',
    margin_width: row.margin_width ?? 0.4,
    paper: row.paper || 'plain',
    strokes: Array.isArray(row.strokes) ? row.strokes : [],
    updated_at: row.updated_at || nowIso(),
    deleted_at: row.deleted_at ?? null,
  };
  return s;
}

// ---------------- notebooks ----------------

export async function loadAll() {
  notebooks.clear();
  for (const nb of await getDb().getAll('notebooks')) notebooks.set(nb.id, nb);
}

export function listNotebooks() {
  return [...notebooks.values()]
    .filter((n) => !n.deleted_at)
    .sort((a, b) => a.position - b.position || time(a.updated_at) - time(b.updated_at));
}
export const getNotebook = (id) => notebooks.get(id);

async function saveNotebook(nb) {
  notebooks.set(nb.id, nb);
  await getDb().put('notebooks', nb);
  await enqueue('notebook', nb.id);
  emit('notebooks');
}

export async function createNotebook(title = 'Untitled') {
  const max = Math.max(-1, ...listNotebooks().map((n) => n.position));
  const nb = { id: uid(), title, position: max + 1, updated_at: nowIso(), deleted_at: null };
  await saveNotebook(nb);
  return nb;
}
export async function renameNotebook(id, title) {
  const nb = notebooks.get(id);
  if (!nb || nb.title === title) return;
  await saveNotebook({ ...nb, title, updated_at: nowIso() });
}
export async function deleteNotebook(id) {
  const nb = notebooks.get(id);
  if (!nb) return;
  await saveNotebook({ ...nb, deleted_at: nowIso(), updated_at: nowIso() });
}

export async function applyRemoteNotebook(row) {
  if (!row || !row.id) return;
  const local = notebooks.get(row.id);
  const remote = { id: row.id, title: row.title, position: row.position, updated_at: row.updated_at, deleted_at: row.deleted_at };
  let next = remote;
  if (local) {
    next = time(remote.updated_at) > time(local.updated_at) ? { ...remote } : { ...local };
    next.deleted_at = local.deleted_at || remote.deleted_at || null;
    if (JSON.stringify(next) === JSON.stringify(local)) return;
  }
  notebooks.set(next.id, next);
  await getDb().put('notebooks', next);
  emit('notebooks');
}

// ---------------- sheets ----------------

export async function openNotebook(id) {
  currentNotebookId = id;
  const map = (currentSheets = new Map());
  if (id) {
    const rows = await getDb().getAllFromIndex('sheets', 'notebook_id', id);
    // Keep anything saved while we were loading (it is newer).
    for (const s of rows) if (!map.has(s.id)) map.set(s.id, s);
  }
  return listSheets();
}
export const currentNotebook = () => currentNotebookId;

export function listSheets() {
  return [...currentSheets.values()]
    .filter((s) => !s.deleted_at)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}
export const getSheet = (id) => currentSheets.get(id);

export async function getSheetsOfNotebook(notebookId) {
  const rows = await getDb().getAllFromIndex('sheets', 'notebook_id', notebookId);
  return rows.filter((s) => !s.deleted_at).sort((a, b) => a.position - b.position);
}

async function saveSheet(sheet, { quiet = false } = {}) {
  if (sheet.notebook_id === currentNotebookId) currentSheets.set(sheet.id, sheet);
  await getDb().put('sheets', sheet);
  await enqueue('sheet', sheet.id);
  if (!quiet) emit('sheet', { sheet, local: true });
}

/** Add new sheets after `afterPosition` (or at the end). `parts` are partial sheet objects. */
export async function addSheets(notebookId, parts, afterSheetId = null) {
  const existing = notebookId === currentNotebookId ? listSheets() : await getSheetsOfNotebook(notebookId);
  const STEP = 1024;
  let start, end;
  const idx = afterSheetId ? existing.findIndex((s) => s.id === afterSheetId) : -1;
  if (idx >= 0 && idx < existing.length - 1) {
    start = existing[idx].position;
    end = existing[idx + 1].position;
  } else {
    start = existing.length ? existing[existing.length - 1].position : 0;
    end = start + STEP * (parts.length + 1);
  }
  let gap = (end - start) / (parts.length + 1);
  if (gap < 1) {
    // No room between the two neighbours: renumber the whole notebook.
    for (let i = 0; i < existing.length; i++) {
      existing[i] = { ...existing[i], position: (i + 1) * STEP, updated_at: nowIso() };
      await saveSheet(existing[i], { quiet: true });
    }
    return addSheets(notebookId, parts, afterSheetId);
  }
  const created = parts.map((p, i) => cleanSheet({
    ...p,
    id: uid(),
    notebook_id: notebookId,
    position: Math.round(start + gap * (i + 1)),
    strokes: [],
    updated_at: nowIso(),
  }));
  for (const s of created) await saveSheet(s, { quiet: true });
  // Touch the notebook so it sorts as recently used on other devices too.
  emit('sheets', { notebookId });
  return created;
}

export async function deleteSheet(id) {
  const s = currentSheets.get(id);
  if (!s) return;
  await saveSheet({ ...s, deleted_at: nowIso(), updated_at: nowIso() }, { quiet: true });
  emit('sheets', { notebookId: s.notebook_id });
}

/** Move a sheet one place up (-1) or down (+1) in the notebook. */
export async function moveSheet(id, dir) {
  const list = listSheets();
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  // New position between the neighbour we jump over and the one after it.
  const a = list[j].position;
  const b = list[j + dir] ? list[j + dir].position : a + dir * 2048;
  let pos = Math.round((a + b) / 2);
  if (pos === a || pos === b) {
    // No room: renumber everything, then try again.
    for (let k = 0; k < list.length; k++) {
      await saveSheet({ ...list[k], position: (k + 1) * 1024, updated_at: nowIso() }, { quiet: true });
    }
    return moveSheet(id, dir);
  }
  await saveSheet({ ...list[i], position: pos, updated_at: nowIso() }, { quiet: true });
  emit('sheets', { notebookId: list[i].notebook_id });
  return true;
}

/** Copy a sheet (page, layout, ink and text) right after the original. */
export async function duplicateSheet(id) {
  const s = currentSheets.get(id);
  if (!s) return null;
  const { pdf_path, pdf_page, pdf_name, margin_side, margin_width, height, paper } = s;
  const [copy] = await addSheets(s.notebook_id, [{ pdf_path, pdf_page, pdf_name, margin_side, margin_width, height, paper }], id);
  const items = s.strokes.filter((it) => !it.deleted_at).map((it) => ({ ...it, id: uid() }));
  if (items.length) await changeItems(copy.id, { add: items });
  return copy;
}

export async function updateSheetMeta(id, patch) {
  const s = currentSheets.get(id);
  if (!s) return;
  await saveSheet({ ...s, ...patch, updated_at: nowIso() });
}

/** Add items and/or tombstone items (by id) on one sheet. */
export async function changeItems(sheetId, { add = [], remove = [] }) {
  const s = currentSheets.get(sheetId);
  if (!s) return;
  const removeSet = new Set(remove);
  const now = Date.now();
  // A tombstone keeps only what the merge needs, so deleted ink does not take space.
  const strokes = s.strokes.map((it) => (removeSet.has(it.id) && !it.deleted_at
    ? { id: it.id, t: it.t, created: it.created, deleted_at: now }
    : it));
  strokes.push(...add);
  await saveSheet({ ...s, strokes, updated_at: nowIso() });
}

/** Merge a sheet row that came from the server (pull, realtime or push response). */
export async function applyRemoteSheet(row) {
  if (!row || !row.id) return;
  const db = getDb();
  const local = currentSheets.get(row.id) || (await db.get('sheets', row.id));
  const remote = cleanSheet(row);
  let next = remote;
  if (local) {
    const newer = time(remote.updated_at) > time(local.updated_at) ? remote : local;
    next = { ...local };
    for (const k of SHEET_META) next[k] = newer[k];
    next.updated_at = newer.updated_at;
    next.deleted_at = local.deleted_at || remote.deleted_at || null;
    next.strokes = mergeItems(local.strokes, remote.strokes);
    if (sameSheet(next, local)) return;
  }
  await db.put('sheets', next);
  if (next.notebook_id === currentNotebookId) {
    const wasVisible = local && !local.deleted_at;
    currentSheets.set(next.id, next);
    const structural = !local || !wasVisible !== !!next.deleted_at || local.position !== next.position || local.height !== next.height;
    if (structural) emit('sheets', { notebookId: next.notebook_id });
    else emit('sheet', { sheet: next, local: false });
  }
}

function sameSheet(a, b) {
  for (const k of [...SHEET_META, 'deleted_at']) if (a[k] !== b[k]) return false;
  if (a.strokes.length !== b.strokes.length) return false;
  return JSON.stringify(a.strokes) === JSON.stringify(b.strokes);
}

// ---------------- search ----------------

/** Search notebook titles and text boxes. Returns [{notebook, sheet?, snippet}] */
export async function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const nb of listNotebooks()) {
    if (nb.title.toLowerCase().includes(q)) results.push({ notebook: nb, snippet: nb.title });
  }
  const live = new Set(listNotebooks().map((n) => n.id));
  const all = await getDb().getAll('sheets');
  for (const s of all) {
    if (s.deleted_at || !live.has(s.notebook_id)) continue;
    for (const it of s.strokes) {
      if (it.t === 'text' && !it.deleted_at && it.text && it.text.toLowerCase().includes(q)) {
        results.push({ notebook: notebooks.get(s.notebook_id), sheet: s, snippet: it.text.slice(0, 80) });
        break;
      }
    }
    if (results.length > 60) break;
  }
  return results;
}
