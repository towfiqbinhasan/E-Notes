// Background sync with Supabase.
//  push: outbox -> Supabase (debounced 800 ms). Sheets go through the upsert_sheet()
//        SQL function, which merges strokes on the server (union by id).
//  pull: everything changed since our last cursor (server-side synced_at).
//  live: Supabase Realtime pushes other devices' changes within a second or two.
import { getDb, getMeta, setMeta } from './db.js';
import { applyRemoteNotebook, applyRemoteSheet, setChangeListener } from './store.js';
import { setPdfDownloader, hashFromPath } from './pdf.js';

const PUSH_DELAY = 800;
// Supabase rejects files over 50 MB, so bigger PDFs are stored as numbered parts
// ("<hash>.pdf.0of3", "<hash>.pdf.1of3", ...) and joined again on download.
const PART_SIZE = 40 * 1024 * 1024;
const KIND_ORDER = { pdf: 0, notebook: 1, sheet: 2 };

export function startSync({ supabase, userId, onStatus }) {
  let status = '';
  let pushTimer = null;
  let retryTimer = null;
  let retryDelay = 2000;
  let pushing = false;
  let pushAgain = false;
  let channel = null;
  let liveChannel = null;         // private broadcast channel for ink that is still being drawn
  let liveHandler = () => {};
  let stopped = false;

  let lastError = '';
  const setStatus = (s) => { if (s !== status) { status = s; onStatus(s, lastError); } };

  const bucket = () => supabase.storage.from('pdfs');
  const alreadyThere = (error) => String(error.statusCode) === '409' || /exist|duplicate/i.test(error.message);

  setPdfDownloader(async (path) => {
    const { data, error } = await bucket().download(path);
    if (!error) return data;
    // Not there as one file: look for the parts of a large PDF.
    const dir = path.slice(0, path.lastIndexOf('/'));
    const file = path.slice(path.lastIndexOf('/') + 1);
    const { data: list } = await bucket().list(dir, { search: file + '.', limit: 1000 });
    const first = (list || []).map((o) => /\.(\d+)of(\d+)$/.exec(o.name)).find(Boolean);
    if (!first) throw error;
    const n = Number(first[2]);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const r = await bucket().download(`${path}.${i}of${n}`);
      if (r.error) throw r.error;
      parts.push(r.data);
    }
    return new Blob(parts, { type: 'application/pdf' });
  });

  function schedulePush(delay = PUSH_DELAY) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay);
    if (navigator.onLine) setStatus('syncing');
  }
  setChangeListener(() => schedulePush());

  async function pendingCount() {
    return getDb().count('outbox');
  }

  async function uploadPdf(hash) {
    const rec = await getDb().get('pdfs', hash);
    if (!rec) return;
    const path = `${userId}/${hash}.pdf`;
    const n = Math.ceil(rec.blob.size / PART_SIZE);
    for (let i = 0; i < n; i++) {
      const name = n === 1 ? path : `${path}.${i}of${n}`;
      const body = n === 1 ? rec.blob : rec.blob.slice(i * PART_SIZE, (i + 1) * PART_SIZE, 'application/pdf');
      const { error } = await bucket().upload(name, body, { contentType: 'application/pdf', upsert: false });
      // "already exists" means another device (or an earlier try) uploaded it: fine.
      if (error && !alreadyThere(error)) throw error;
    }
  }

  // Remove the outbox entry only if nothing changed while we were pushing.
  async function ack(entry) {
    if (!entry) return;
    const tx = getDb().transaction('outbox', 'readwrite');
    const cur = await tx.store.get(entry.key);
    if (cur && cur.ts === entry.ts) await tx.store.delete(entry.key);
    await tx.done;
  }

  async function push() {
    if (stopped) return;
    if (pushing) { pushAgain = true; return; }
    if (!navigator.onLine) { setStatus('offline'); return; }
    pushing = true;
    try {
      const db = getDb();
      const entries = (await db.getAll('outbox')).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ts - b.ts);
      if (entries.length) setStatus('syncing');
      let failed = null;
      const failedPdfs = new Set();   // don't retry the same PDF for every sheet on it
      // One item that keeps failing must not hold back everything queued after it.
      for (const e of entries) try {
        if (e.kind === 'pdf') {
          failedPdfs.add(e.id);
          await uploadPdf(e.id);
          failedPdfs.delete(e.id);
        } else if (e.kind === 'notebook') {
          const nb = await db.get('notebooks', e.id);
          if (nb) {
            const { data, error } = await supabase.rpc('upsert_notebook', { n: nb });
            if (error) throw error;
            await applyRemoteNotebook(data);
          }
        } else if (e.kind === 'sheet') {
          const s = await db.get('sheets', e.id);
          if (s) {
            // Make sure the PDF this sheet points at is uploaded first.
            const hash = s.pdf_path && hashFromPath(s.pdf_path);
            if (hash && failedPdfs.has(hash)) throw new Error('Waiting for its PDF to upload');
            if (hash && (await db.get('outbox', 'pdf:' + hash))) {
              failedPdfs.add(hash);
              await uploadPdf(hash);
              failedPdfs.delete(hash);
              await ack(await db.get('outbox', 'pdf:' + hash));
            }
            const { data, error } = await supabase.rpc('upsert_sheet', { s });
            if (error) throw error;
            await applyRemoteSheet(data);
          }
        }
        await ack(e);
      } catch (err) {
        console.warn('[sync] could not upload', e.key, err);
        failed = failed || err;
      }
      if (failed) throw failed;
      retryDelay = 2000;
      lastError = '';
      setStatus((await pendingCount()) ? 'syncing' : 'synced');
      if (await pendingCount()) pushAgain = true;
    } catch (err) {
      console.warn('[sync] push failed', err);
      lastError = err?.message || String(err);
      status = '';
      setStatus(navigator.onLine ? 'error' : 'offline');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(push, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; schedulePush(50); }
    }
  }

  async function pullTable(table, apply) {
    const cursorKey = `cursor:${table}`;
    let cursor = (await getMeta(cursorKey)) || '1970-01-01T00:00:00Z';
    const PAGE = 500;
    for (;;) {
      // gte (not gt) so rows sharing a timestamp are never skipped; merging is idempotent.
      const { data, error } = await supabase
        .from(table).select('*')
        .gte('synced_at', cursor)
        .order('synced_at', { ascending: true })
        .limit(PAGE);
      if (error) throw error;
      for (const row of data) await apply(row);
      if (!data.length) break;
      const last = data[data.length - 1].synced_at;
      const stuck = last === cursor;
      cursor = last;
      await setMeta(cursorKey, cursor);
      if (data.length < PAGE || stuck) break;
    }
  }

  async function pull() {
    if (stopped || !navigator.onLine) return;
    try {
      setStatus('syncing');
      await pullTable('notebooks', applyRemoteNotebook);
      await pullTable('sheets', applyRemoteSheet);
      setStatus((await pendingCount()) ? 'syncing' : 'synced');
    } catch (err) {
      console.warn('[sync] pull failed', err);
      lastError = err?.message || String(err);
      status = '';
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  async function onSheetChange(payload) {
    let row = payload.new;
    if (!row || !row.id) return;
    // Very large rows may arrive without the strokes column: fetch the full row.
    if (!Array.isArray(row.strokes)) {
      const { data } = await supabase.from('sheets').select('*').eq('id', row.id).maybeSingle();
      if (!data) return;
      row = data;
    }
    await applyRemoteSheet(row);
  }

  function subscribe() {
    if (channel) supabase.removeChannel(channel);
    channel = supabase
      .channel(`enotes-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks', filter: `user_id=eq.${userId}` },
        (p) => applyRemoteNotebook(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sheets', filter: `user_id=eq.${userId}` },
        onSheetChange)
      .subscribe((s) => {
        // (Re)connected: catch up on anything we missed while disconnected.
        if (s === 'SUBSCRIBED') pull().then(() => push());
      });
    subscribeLive();
  }

  // Live ink: strokes appear on your other devices while you are still writing.
  // Private channel, so only this user's signed-in devices can join (see schema.sql).
  function subscribeLive() {
    if (liveChannel) supabase.removeChannel(liveChannel);
    liveChannel = supabase
      .channel(`enotes-live-${userId}`, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'ink' }, ({ payload }) => liveHandler(payload))
      .subscribe();
  }
  function sendLiveInk(payload) {
    if (!liveChannel || stopped || !navigator.onLine || liveChannel.state !== 'joined') return;
    liveChannel.send({ type: 'broadcast', event: 'ink', payload }).catch(() => {});
  }

  const onOnline = () => { subscribe(); pull().then(() => push()); };
  const onOffline = () => setStatus('offline');
  const onVisible = () => { if (document.visibilityState === 'visible') pull().then(() => push()); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  const safetyPull = setInterval(pull, 60000);   // in case a realtime event was dropped

  if (navigator.onLine) {
    subscribe();
    pull().then(() => push());
  } else {
    setStatus('offline');
  }

  return {
    pushNow: () => push(),
    pendingCount,
    sendLiveInk,
    onLiveInk: (fn) => { liveHandler = fn; },
    stop() {
      stopped = true;
      clearTimeout(pushTimer);
      clearTimeout(retryTimer);
      clearInterval(safetyPull);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) supabase.removeChannel(channel);
      if (liveChannel) supabase.removeChannel(liveChannel);
      setChangeListener(() => {});
    },
  };
}
