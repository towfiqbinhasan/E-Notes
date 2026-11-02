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
  await changeItems(sheetId, { add: added, remove: removed.map((i) => i.id) });
  undoStack.push({ sheetId, added, removed });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  listener();
}

async function invert(entry) {
  const restored = entry.removed.map((it) => ({ ...it, id: uid(), deleted_at: undefined }));
  await changeItems(entry.sheetId, { add: restored, remove: entry.added.map((i) => i.id) });
  return { sheetId: entry.sheetId, added: restored, removed: entry.added };
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
