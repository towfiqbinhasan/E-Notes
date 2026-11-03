// Undo / redo. Items are immutable and deletions are permanent tombstones (that
// is what makes sync conflict-free), so undoing a delete restores a COPY of the
// item with a new id, and undoing an add tombstones it.
import { changeItems, uid } from './store.js';

let undoStack = [];
let redoStack = [];
const LIMIT = 200;
let listener = () => {};

export const onHistoryChange = (fn) => { listener = fn; };
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function clearHistory() { undoStack = []; redoStack = []; listener(); }

/** Apply a change and remember it. added/removed are full item objects. */
export async function commit(sheetId, added = [], removed = []) {
  return commitMany([{ sheetId, added, removed }]);
}

/** Changes on several sheets that undo/redo together (e.g. a stroke drawn across two sheets). */
export async function commitMany(parts) {
  for (const p of parts) await changeItems(p.sheetId, { add: p.added || [], remove: (p.removed || []).map((i) => i.id) });
  undoStack.push({ parts: parts.map((p) => ({ sheetId: p.sheetId, added: p.added || [], removed: p.removed || [] })) });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  listener();
}

async function invert(entry) {
  const parts = [];
  for (const part of entry.parts) {
    const restored = part.removed.map((it) => ({ ...it, id: uid(), deleted_at: undefined }));
    await changeItems(part.sheetId, { add: restored, remove: part.added.map((i) => i.id) });
    parts.push({ sheetId: part.sheetId, added: restored, removed: part.added });
  }
  return { parts };
}

export async function undo() {
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(await invert(e));
  listener();
}
export async function redo() {
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(await invert(e));
  listener();
}
