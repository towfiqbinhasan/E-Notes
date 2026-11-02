// IndexedDB storage (local-first). One database per signed-in user, so two
// accounts on the same device never mix their notebooks.
import { openDB } from 'idb';

let db = null;
let globalDb = null;

// Small shared database for things that are not tied to one user (last signed-in user).
async function getGlobalDb() {
  if (!globalDb) {
    globalDb = await openDB('enotes-global', 1, {
      upgrade(d) { d.createObjectStore('kv'); },
    });
  }
  return globalDb;
}
export async function getLastUser() {
  return (await getGlobalDb()).get('kv', 'lastUser');
}
export async function setLastUser(user) {
  return (await getGlobalDb()).put('kv', user, 'lastUser');
}
export async function clearLastUser() {
  return (await getGlobalDb()).delete('kv', 'lastUser');
}

/**
 * Stores:
 *  notebooks  {id, title, position, updated_at, deleted_at}
 *  sheets     {id, notebook_id, position, height, pdf_path, pdf_page, pdf_name,
 *              margin_side, margin_width, strokes[], updated_at, deleted_at}
 *  pdfs       key = sha256 -> {hash, name, blob}          (original PDF files)
 *  pages      key = "hash:page:width" -> Blob             (rendered page images)
 *  outbox     {key: "kind:id", kind, id, ts}              (changes waiting to be pushed)
 *  meta       key -> value                                (sync cursors etc.)
 */
export async function openUserDb(userId) {
  db = await openDB(`enotes-${userId}`, 1, {
    upgrade(d) {
      d.createObjectStore('notebooks', { keyPath: 'id' });
      const sheets = d.createObjectStore('sheets', { keyPath: 'id' });
      sheets.createIndex('notebook_id', 'notebook_id');
      d.createObjectStore('pdfs');
      d.createObjectStore('pages');
      d.createObjectStore('outbox', { keyPath: 'key' });
      d.createObjectStore('meta');
    },
  });
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not opened yet');
  return db;
}

export const getMeta = (key) => getDb().get('meta', key);
export const setMeta = (key, value) => getDb().put('meta', value, key);
