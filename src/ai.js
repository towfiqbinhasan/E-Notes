// "AI helper" panel. Everything here is free:
//  - Offline tools run on the device, no account or key: read aloud, key points, page text.
//  - Gemini tools use the user's own free Google AI Studio key (stored only on this device):
//    handwriting -> text, summarize, explain, quiz, translate and questions about the sheet.
import { SHEET_W, pdfRect, drawItems, drawTextItems } from './canvas.js';
import { renderPageToCanvas, getPageText } from './pdf.js';
import { addSheets, getSheet, uid } from './store.js';
import { commit } from './history.js';
import { getDeviceSetting, setDeviceSetting } from './db.js';
import { isNative, openExternal } from './platform.js';

const $ = (id) => document.getElementById(id);
const AI_TEXT = { color: '#1d4ed8', size: 18 };
const KEY_PAGE = 'https://aistudio.google.com/apikey';

// =====================================================================
// Sheet content
// =====================================================================

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

/** Printed PDF text of the sheet plus its typed text boxes. */
async function sheetText(sheet) {
  const parts = [];
  if (sheet.pdf_path) {
    try { parts.push(await getPageText(sheet.pdf_path, sheet.pdf_page)); } catch { /* not downloaded yet */ }
  }
  for (const it of sheet.strokes) if (it.t === 'text' && !it.deleted_at && it.text) parts.push(it.text);
  return parts.filter(Boolean).join('\n\n').trim();
}

// =====================================================================
// Offline tools (free, on the device)
// =====================================================================

const STOP_WORDS = new Set((
  'a an the and or but if then than so of to in on at by for with from as is are was were be been being it its this that these those ' +
  'he she they we you i me my our your their his her them us not no yes do does did done can could will would shall should may might must ' +
  'have has had there here what which who whom whose when where why how all any each more most other some such only own same too very just also into over under about after before ' +
  'এবং ও বা কিন্তু যে এই সেই একটি এক করে করা হয় হয়ে তার তাদের আমি আমরা তুমি আপনি সে তারা এর থেকে জন্য সাথে মধ্যে না নয় ছিল আছে হবে'
).split(/\s+/));

/** The most informative sentences of a text, in their original order (simple extractive summary). */
function keyPoints(text, count = 5) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && s.length < 400);
  if (!sentences.length) return [];
  const freq = new Map();
  const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  for (const s of sentences) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);
  const seen = new Set();
  const scored = sentences.map((s, i) => {
    const ws = words(s);
    const score = ws.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / Math.pow(Math.max(ws.length, 1), 0.6);
    return { s, i, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ s }) => { const key = s.slice(0, 40).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map(({ s }) => s);
}

// ----- read aloud (Android: native text-to-speech; desktop/web: Web Speech API) -----
const isBangla = (text) => /[ঀ-৿]/.test(text);
let speaking = false;

export function canReadAloud() {
  return isNative || 'speechSynthesis' in window;
}

async function stopSpeaking() {
  speaking = false;
  if (isNative) {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    await TextToSpeech.stop().catch(() => {});
  } else if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
}

async function speak(text, onEnd) {
  await stopSpeaking();
  speaking = true;
  const lang = isBangla(text) ? 'bn-BD' : 'en-US';
  // Long texts are read sentence by sentence (browsers stop very long utterances).
  const chunks = text.replace(/\s+/g, ' ').match(/[^.!?।]+[.!?।]*\s*/g) || [text];
  try {
    if (isNative) {
      const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
      for (const chunk of chunks) {
        if (!speaking) break;
        await TextToSpeech.speak({ text: chunk, lang, rate: 1.0 });
      }
    } else {
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
      for (const chunk of chunks) {
        if (!speaking) break;
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.lang = lang;
          if (voice) u.voice = voice;
          u.onend = u.onerror = resolve;
          speechSynthesis.speak(u);
        });
      }
    }
  } finally {
    speaking = false;
    onEnd();
  }
}

// =====================================================================
// Gemini (free Google AI Studio key, called directly from this device)
// =====================================================================

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const SYSTEM =
  'You are the study assistant inside E-Notes, a handwriting notebook app. The user shares a picture of one ' +
  'notebook sheet: usually a PDF page on one side and their handwritten notes in the margin, or a blank page with ' +
  'handwriting. Reply in the language the user writes in (Bengali, English or Banglish). Keep answers concise and ' +
  'in plain text without Markdown headings, tables or bold markers, because the answer may be placed on the sheet ' +
  "as a text box. Simple '-' bullet lines are fine.";

const PROMPTS = {
  transcribe:
    'Transcribe all of my handwritten notes on this sheet into plain text. Keep my wording, order and line breaks. ' +
    'Do not copy the printed PDF text. If a word is unclear, give your best guess followed by (?). Reply with only the transcription.',
  summarize: "Summarize this sheet (the page and my notes) in 5 to 8 short '-' bullet points.",
  explain: 'Explain the main ideas on this page simply, like a good teacher. If my handwritten notes contain a mistake, point it out kindly.',
  quiz: 'Write 5 short quiz questions to test me on this sheet. Put the answers after all the questions.',
  translate:
    'Translate everything on this sheet (printed text and my handwriting): English into Bangla (Bengali script), ' +
    'and Bangla into English. Reply with only the translation.',
};

let modelCache = null; // models this key can use, best first

async function geminiError(res) {
  let msg = `Gemini error ${res.status}`;
  try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch { /* keep */ }
  if (res.status === 400 && /api key/i.test(msg)) return new Error('This Gemini API key is not valid. Paste a new one in the AI panel.');
  if (res.status === 403) return new Error('This Gemini key is not allowed. Create a new key at aistudio.google.com/apikey.');
  if (res.status === 429) return new Error('The free Gemini limit is used up for now. Wait a minute (or until tomorrow) and try again.');
  if (res.status >= 500) return new Error('Gemini is very busy right now. Please try again in a minute.');
  return new Error(msg);
}

/** Fast Gemini models this key can use, best first (names change over time, so ask the API). */
async function pickModels(key) {
  if (modelCache) return modelCache;
  const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw await geminiError(res);
  const { models = [] } = await res.json();
  const names = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/.test(n) && !/(image|tts|audio|live|embedding|robotics|computer)/.test(n));
  const rank = (n) => {
    if (n === 'gemini-flash-latest') return 0;
    if (n === 'gemini-flash-lite-latest') return 2;
    if (/flash/.test(n) && !/lite/.test(n)) return /preview|exp/.test(n) ? 4 : 1;
    if (/flash-lite/.test(n)) return /preview|exp/.test(n) ? 5 : 3;
    return /preview|exp/.test(n) ? 8 : 6; // pro and others: slower, last resort
  };
  modelCache = [...new Set(names)].sort((a, b) => rank(a) - rank(b) || b.localeCompare(a)).slice(0, 5);
  if (!modelCache.length) throw new Error('No Gemini model is available for this key.');
  return modelCache;
}
const pickModel = async (key) => (await pickModels(key))[0];

const plain = (t) => t.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*\*\s+/gm, '- ').trim();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask Gemini. When a model is overloaded (503) or its free quota is used up (429),
 * wait a moment and retry, then fall back to the next model. onStatus(text) shows progress.
 */
async function askGemini(key, { prompt, image, history }, onStatus = () => {}) {
  const models = await pickModels(key);
  const turns = [...history, { role: 'user', content: prompt }];
  const contents = turns.map((t, i) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: i === 0 ? [{ inlineData: { mimeType: 'image/jpeg', data: image } }, { text: t.content }] : [{ text: t.content }],
  }));
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { maxOutputTokens: 8192, temperature: 0.4 },
  });
  let res = null, lastError = null;
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${GEMINI}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        // Remember the model that answered so the next question starts there.
        modelCache = [model, ...models.filter((m) => m !== model)];
        break outer;
      }
      const busy = res.status >= 500;
      const quota = res.status === 429;
      if (res.status === 404) { modelCache = null; } // model retired: re-read the list next time
      if (!busy && !quota && res.status !== 404) throw await geminiError(res);
      lastError = await geminiError(res);
      if (busy && attempt === 0) { onStatus('Gemini is busy, trying again…'); await pause(1500); continue; }
      onStatus('Trying another Gemini model…');
      break; // next model
    }
    res = null;
  }
  if (!res) throw lastError || new Error('Gemini did not answer. Please try again.');
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(why ? `Gemini did not answer this request (${why}).` : 'Gemini returned no answer.');
  }
  const text = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  return { text: plain(text) || '(no answer)', truncated: cand.finishReason === 'MAX_TOKENS' };
}

// =====================================================================
// Putting an answer onto the sheet
// =====================================================================

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

/** Add text in the free part of the notes margin, or on a new sheet below if it doesn't fit. */
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

// =====================================================================
// Panel
// =====================================================================

/**
 * opts: { getCurrent() -> {sheet, index} | null, scrollToSheet(id), toast(msg, opts) }
 */
export function initAiPanel({ getCurrent, scrollToSheet, toast }) {
  const panel = $('ai-panel');
  const log = $('ai-log');
  const input = $('ai-input');
  let apiKey = null;
  let history = [];          // [{role, content}] for the current sheet (Gemini chat)
  let historySheet = null;
  let busy = false;

  // ----- key handling -----
  async function loadKey() {
    apiKey = (await getDeviceSetting('geminiKey')) || null;
    renderKeyState();
  }
  function renderKeyState() {
    const has = !!apiKey;
    $('ai-key-setup').hidden = has;
    $('ai-gemini-actions').hidden = !has;
    $('ai-form').hidden = !has;
    $('ai-key-status').textContent = has ? `Gemini key saved on this device (…${apiKey.slice(-4)})` : 'No Gemini key on this device';
    $('ai-key-remove').hidden = !has;
  }
  $('ai-key-link').onclick = (e) => { e.preventDefault(); openExternal(KEY_PAGE); };
  $('ai-key-form').onsubmit = async (e) => {
    e.preventDefault();
    const key = $('ai-key-input').value.trim();
    if (!key) return;
    const btn = $('ai-key-form').querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      modelCache = null;
      const model = await pickModel(key);
      await setDeviceSetting('geminiKey', key);
      apiKey = key;
      $('ai-key-input').value = '';
      renderKeyState();
      toast(`Gemini is ready (${model})`);
    } catch (err) {
      toast(err.message, { error: true, ms: 6000 });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save key';
    }
  };
  $('ai-key-input').addEventListener('keydown', (e) => e.stopPropagation());
  $('ai-key-remove').onclick = async () => {
    if (!confirm('Remove the Gemini key from this device?')) return;
    await setDeviceSetting('geminiKey', null);
    apiKey = null;
    modelCache = null;
    renderKeyState();
  };

  // ----- chat log -----
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

  function divider(sheetId, index) {
    if (historySheet === sheetId) return;
    history = [];
    historySheet = sheetId;
    const d = document.createElement('div');
    d.className = 'ai-divider';
    d.textContent = `Sheet ${index + 1}`;
    log.append(d);
  }

  function answerButtons(el, text, sheet) {
    const row = document.createElement('div');
    row.className = 'ai-buttons';
    const btn = (label, fn) => {
      const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: label });
      b.onclick = () => fn(b);
      row.append(b);
    };
    btn('Add to sheet', async (b) => {
      b.disabled = true;
      try {
        const id = await insertOnSheet(getSheet(sheet.id) || sheet, text);
        if (id !== sheet.id) toast('Added on a new sheet below (the margin was full)');
        scrollToSheet(id);
        b.textContent = 'Added ✓';
      } catch (err) {
        b.disabled = false;
        toast(`Could not add: ${err.message}`, { error: true });
      }
    });
    btn('Copy', async (b) => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; } catch { toast('Copy failed', { error: true }); }
    });
    if (canReadAloud()) btn('Read', (b) => toggleSpeak(text, b));
    el.append(row);
  }

  // ----- read aloud -----
  let speakBtn = null;
  async function toggleSpeak(text, button) {
    if (speaking) {
      await stopSpeaking();
      return;
    }
    speakBtn = button;
    const label = button.textContent;
    button.textContent = 'Stop';
    speak(text, () => { if (speakBtn === button) button.textContent = label; });
  }

  // ----- offline tools -----
  async function offline(action, button) {
    const cur = getCurrent();
    if (!cur) { toast('Open a notebook with at least one sheet first'); return; }
    const { sheet, index } = cur;
    const text = await sheetText(sheet);
    if (!text) {
      toast(apiKey
        ? 'No printed text on this sheet. Try "Handwriting → text" (Gemini).'
        : 'No printed text on this sheet. Handwriting needs the free Gemini key below.', { ms: 5000 });
      return;
    }
    if (action === 'read') { toggleSpeak(text, button); return; }
    divider(sheet.id, index);
    if (action === 'points') {
      const pts = keyPoints(text);
      bubble('user', 'Key points');
      const out = pts.length ? pts.map((p) => `- ${p}`).join('\n') : 'This page has too little text for key points.';
      const el = bubble('assistant', out);
      if (pts.length) answerButtons(el, out, sheet);
    } else if (action === 'text') {
      bubble('user', 'Page text');
      const el = bubble('assistant', text);
      answerButtons(el, text, sheet);
    }
  }

  // ----- Gemini -----
  async function ask(action, question, label) {
    if (busy || !apiKey) return;
    const cur = getCurrent();
    if (!cur) { toast('Open a notebook with at least one sheet first'); return; }
    if (!navigator.onLine) { toast('Gemini needs an internet connection', { error: true }); return; }
    const { sheet, index } = cur;
    divider(sheet.id, index);
    busy = true;
    panel.classList.add('busy');
    bubble('user', label);
    const waiting = bubble('assistant', 'Reading the sheet…', 'waiting');
    try {
      const image = await sheetPicture(sheet);
      const prompt = action === 'ask' ? question : PROMPTS[action];
      const res = await askGemini(apiKey, { prompt, image, history }, (msg) => { waiting.querySelector('.ai-text').textContent = msg; });
      waiting.remove();
      const el = bubble('assistant', res.text);
      answerButtons(el, res.text, sheet);
      if (res.truncated) bubble('assistant', 'The answer was cut off because it was very long.', 'note');
      history.push({ role: 'user', content: prompt }, { role: 'assistant', content: res.text });
      history = history.slice(-12);
    } catch (err) {
      waiting.remove();
      bubble('assistant', err.message || String(err), 'error');
    } finally {
      busy = false;
      panel.classList.remove('busy');
    }
  }

  for (const b of panel.querySelectorAll('[data-offline]')) b.onclick = () => offline(b.dataset.offline, b);
  for (const b of panel.querySelectorAll('[data-ai]')) b.onclick = () => ask(b.dataset.ai, undefined, b.textContent);
  if (!canReadAloud()) panel.querySelector('[data-offline="read"]').hidden = true;
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
    if (!open) stopSpeaking();
    if (open) refreshHeader();
  }
  // Keep the "Sheet N" label in sync while scrolling.
  $('viewport').addEventListener('scroll', () => { if (!panel.hidden) refreshHeader(); }, { passive: true });

  loadKey();
  return { toggle, isOpen: () => !panel.hidden };
}
