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

// =====================================================================
// Sheet content
// =====================================================================

/** Picture of a sheet (PDF page + ink + text) as base64 JPEG, ~1200 px wide. */
async function sheetPicture(sheet, width = 1000) {
  const canvas = await sheetCanvas(sheet, width);
  const out = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  canvas.width = canvas.height = 0;
  return out;
}

/** Any picture (file, pasted screenshot, canvas) -> base64 JPEG, at most `max` px on its long side. */
async function toJpeg(source, max = 1600) {
  let bitmap = source;
  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
    try {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('This picture format cannot be read. Try a PNG or JPG.'));
        img.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const w = bitmap.naturalWidth || bitmap.width, h = bitmap.naturalHeight || bitmap.height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';            // transparent screenshots get a white background
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}

/** Sheet rendered to a canvas `width` px wide. */
async function sheetCanvas(sheet, width) {
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
  return canvas;
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
  'handwriting. Reply in the language the user writes in (Bengali, English or Banglish). Answer briefly (a few ' +
  'short lines) unless the user asks for more detail. ' +
  'Use plain text without Markdown headings, tables or bold markers, because the answer may be placed on the sheet ' +
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
  if (res.status === 429) return Object.assign(new Error('The free Gemini limit is used up for now. Wait a minute (or until tomorrow) and try again.'), { retryable: true });
  if (res.status >= 500) return Object.assign(new Error('Gemini is very busy right now. Please try again in a minute.'), { retryable: true });
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

const plain = (t) => t
  .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')       // hidden reasoning some models print
  .replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*\*\s+/gm, '- ').trim();

/** Read a server-sent-events stream and call onData(json) for every "data:" line. */
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* keep-alive or partial line */ }
    }
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const geminiNoThinkingCfg = new Set(); // models that refuse "thinking off"

/**
 * Ask Gemini and stream the answer (onText(textSoFar) is called as words arrive).
 * When a model is overloaded (503) or its free quota is used up (429), wait a moment and retry,
 * then fall back to the next model. onStatus(text) shows progress.
 */
async function askGemini(key, { prompt, image, history }, onStatus = () => {}, onText = () => {}) {
  const models = await pickModels(key);
  const turns = [...history, { role: 'user', content: prompt }];
  const contents = turns.map((t, i) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: i === 0 && image ? [{ inlineData: { mimeType: 'image/jpeg', data: image } }, { text: t.content }] : [{ text: t.content }],
  }));
  const bodyFor = (model) => {
    const generationConfig = { maxOutputTokens: 4096, temperature: 0.4 };
    // Notes questions don't need long "thinking": switching it off makes answers start much sooner.
    if (!geminiNoThinkingCfg.has(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig });
  };
  let res = null, lastError = null, used = null;
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${GEMINI}/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: bodyFor(model),
      });
      if (res.ok) { used = model; break outer; }
      const busy = res.status >= 500;
      const quota = res.status === 429;
      lastError = await geminiError(res);
      if (res.status === 400 && /think/i.test(lastError.message) && !geminiNoThinkingCfg.has(model)) {
        geminiNoThinkingCfg.add(model); // this model always thinks: ask again without the setting
        continue;
      }
      if (res.status === 404) { modelCache = null; } // model retired: re-read the list next time
      if (!busy && !quota && res.status !== 404) throw lastError;
      if (busy && attempt === 0) { onStatus('Gemini is busy, trying again…'); await pause(1200); continue; }
      onStatus('Trying another Gemini model…');
      break; // next model
    }
    res = null;
  }
  if (!res) throw lastError || new Error('Gemini did not answer. Please try again.');
  // Remember the model that answered so the next question starts there.
  modelCache = [used, ...models.filter((m) => m !== used)];

  let text = '', finish = null, blocked = null;
  try {
    await readSSE(res, (d) => {
      if (d.promptFeedback && d.promptFeedback.blockReason) blocked = d.promptFeedback.blockReason;
      const c = d.candidates && d.candidates[0];
      if (!c) return;
      for (const p of (c.content && c.content.parts) || []) {
        if (p.text && !p.thought) { text += p.text; onText(plain(text)); }
      }
      if (c.finishReason) finish = c.finishReason;
    });
  } catch (err) {
    if (!text) throw err; // connection dropped before anything arrived
  }
  if (!text) throw new Error(blocked ? `Gemini did not answer this request (${blocked}).` : 'Gemini returned no answer.');
  return { text: plain(text), truncated: finish === 'MAX_TOKENS', provider: 'Gemini' };
}

// =====================================================================
// Groq (second free provider: free key at console.groq.com, very fast)
// =====================================================================

const GROQ = 'https://api.groq.com/openai/v1';
let groqModels = null;        // usable chat models, best first
const groqTextOnly = new Set(); // models that turned out not to accept pictures

async function groqError(res) {
  let msg = `Groq error ${res.status}`;
  try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch { /* keep */ }
  if (res.status === 401) return new Error('This Groq API key is not valid. Paste a new one in the AI panel.');
  if (res.status === 429) return Object.assign(new Error('The free Groq limit is used up for now. Try again in a minute.'), { retryable: true });
  if (res.status >= 500) return Object.assign(new Error('Groq is busy right now. Try again in a minute.'), { retryable: true });
  return Object.assign(new Error(msg), { status: res.status });
}

/** Groq chat models this key can use, best first. Which ones can read pictures is found out by trying. */
async function pickGroqModels(key) {
  if (groqModels) return groqModels;
  const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await groqError(res);
  const ids = ((await res.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/(whisper|tts|guard|embed|playai|orpheus|compound|distil|allam|saba|arabic)/i.test(id));
  const rank = (id) =>
    /qwen|llama-4|vision|scout|maverick|gemma|kimi/i.test(id) ? 0   // likely to read pictures
      : /gpt-oss-120b/.test(id) ? 1
        : /llama-3\.3-70b|70b|120b/.test(id) ? 2
          : 3;
  groqModels = ids.sort((a, b) => rank(a) - rank(b));
  if (!groqModels.length) throw new Error('No Groq model is available for this key.');
  return groqModels;
}

async function askGroq(key, { prompt, image, pageText, history }, onStatus = () => {}, onText = () => {}) {
  const models = (await pickGroqModels(key)).slice(0, 4);
  const send = (model, withImage) => {
    const turns = [...history, { role: 'user', content: prompt }];
    const messages = [{ role: 'system', content: SYSTEM }, ...turns.map((t, i) => {
      if (i !== 0) return { role: t.role, content: t.content };
      if (withImage) {
        return { role: 'user', content: [
          { type: 'text', text: t.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
        ] };
      }
      if (pageText === undefined) return { role: 'user', content: t.content }; // general question, no sheet
      return { role: 'user', content: `${t.content}\n\nText printed on this sheet (handwriting not included):\n${pageText || '(none)'}` };
    })];
    return fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.4, max_completion_tokens: 2048, stream: true }),
    });
  };
  let lastError = null;
  // First models that can see the sheet picture; then text-only models with the printed text.
  // A question about an attached picture never goes to a model that cannot see it.
  const passes = !image ? [false] : pageText === null ? [true] : [true, false];
  for (const withImage of passes) {
    for (const m of models) {
      if (withImage && groqTextOnly.has(m)) continue;
      if (!withImage && image && !groqTextOnly.has(m)) continue; // with a picture, text-only is the fallback
      const res = await send(m, withImage);
      if (res.ok) {
        let out = '', finish = null;
        try {
          await readSSE(res, (d) => {
            const c = d.choices && d.choices[0];
            if (!c) return;
            if (c.delta && c.delta.content) { out += c.delta.content; onText(plain(out)); }
            if (c.finish_reason) finish = c.finish_reason;
          });
        } catch (err) {
          if (!out) throw err;
        }
        return { text: plain(out) || '(no answer)', truncated: finish === 'length', provider: 'Groq' };
      }
      lastError = await groqError(res);
      if (withImage && res.status === 400) { groqTextOnly.add(m); continue; } // no pictures: use it text-only later
      if (res.status === 404) { groqModels = null; continue; }                  // model retired
      if (!lastError.retryable) throw lastError;
      onStatus('Groq is busy, trying another model…');
    }
  }
  throw lastError || new Error('Groq did not answer. Please try again.');
}

// =====================================================================
// Wikipedia look-up (free, no key)
// =====================================================================

async function wikiLookup(term) {
  const lang = isBangla(term) ? 'bn' : 'en';
  const base = `https://${lang}.wikipedia.org`;
  const summary = async (title) => {
    const r = await fetch(`${base}/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/ /g, '_'))}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.type === 'disambiguation' || !d.extract ? null : d;
  };
  let d = await summary(term);
  if (!d) {
    const r = await fetch(`${base}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=1&format=json&origin=*`);
    const j = r.ok ? await r.json() : null;
    const hit = j && j.query && j.query.search && j.query.search[0];
    if (hit) d = await summary(hit.title);
  }
  if (!d) throw new Error(`Nothing found on Wikipedia for “${term}”.`);
  return { title: d.title, text: d.extract, url: d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page };
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
export function initAiPanel({ getCurrent, scrollToSheet, toast, sheetAt }) {
  const panel = $('ai-panel');
  const log = $('ai-log');
  const input = $('ai-input');
  const keys = { gemini: null, groq: null };   // the user's own free keys, stored on this device
  const LABEL = { gemini: 'Gemini', groq: 'Groq' };
  let history = [];          // [{role, content}] for the current sheet (AI chat)
  let historySheet = null;
  let busy = false;
  let managing = false;      // "Manage keys" open
  let attached = null;       // picture the user attached / pasted / snipped: base64 JPEG
  let aiOrder = 'fast';      // 'fast' = Groq first, 'best' = Gemini first
  const pictureCache = new Map(); // sheet id -> {stamp, b64}: unchanged sheets are not re-rendered

  async function cachedSheetPicture(sheet) {
    const stamp = `${sheet.updated_at}|${sheet.strokes.length}`;
    const hit = pictureCache.get(sheet.id);
    if (hit && hit.stamp === stamp) return hit.b64;
    const b64 = await sheetPicture(sheet);
    pictureCache.set(sheet.id, { stamp, b64 });
    if (pictureCache.size > 8) pictureCache.delete(pictureCache.keys().next().value);
    return b64;
  }

  // ----- keys -----
  const hasAi = () => !!(keys.gemini || keys.groq);
  async function loadKeys() {
    keys.gemini = (await getDeviceSetting('geminiKey')) || null;
    keys.groq = (await getDeviceSetting('groqKey')) || null;
    aiOrder = (await getDeviceSetting('aiOrder')) || 'fast';
    $('ai-order').value = aiOrder;
    renderKeyState();
  }
  function renderKeyState() {
    $('ai-key-setup').hidden = hasAi() && !managing;
    $('ai-gemini-actions').hidden = !hasAi();
    $('ai-form').hidden = !hasAi();
    for (const p of ['gemini', 'groq']) {
      const box = panel.querySelector(`.ai-provider[data-provider="${p}"]`);
      box.querySelector('form').hidden = !!keys[p];
      box.querySelector('.ai-key-saved').hidden = !keys[p];
      box.querySelector('.ai-key-saved span').textContent = keys[p] ? `Saved on this device (…${keys[p].slice(-4)})` : '';
    }
    const saved = ['gemini', 'groq'].filter((p) => keys[p]).map((p) => LABEL[p]);
    $('ai-key-status').textContent = saved.length ? `AI: ${saved.join(' + ')}` : 'No AI key on this device yet';
    $('ai-keys-manage').hidden = !hasAi();
    $('ai-order').hidden = !(keys.gemini && keys.groq); // the choice matters only with both keys
    $('ai-keys-manage').textContent = managing ? 'Done' : 'Manage keys';
  }
  const CHECK = {
    gemini: async (key) => { modelCache = null; return pickModel(key); },
    groq: async (key) => { groqModels = null; return (await pickGroqModels(key))[0]; },
  };
  for (const a of panel.querySelectorAll('[data-key-link]')) {
    a.onclick = (e) => { e.preventDefault(); openExternal(a.dataset.keyLink); };
  }
  for (const form of panel.querySelectorAll('form[data-key-form]')) {
    const p = form.dataset.keyForm;
    const field = form.querySelector('input');
    field.addEventListener('keydown', (e) => e.stopPropagation());
    form.onsubmit = async (e) => {
      e.preventDefault();
      const key = field.value.trim();
      if (!key) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const model = await CHECK[p](key);
        await setDeviceSetting(`${p}Key`, key);
        keys[p] = key;
        field.value = '';
        managing = false;
        renderKeyState();
        toast(`${LABEL[p]} is ready (${model})`);
      } catch (err) {
        toast(err.message, { error: true, ms: 6000 });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    };
  }
  for (const b of panel.querySelectorAll('[data-key-remove]')) {
    b.onclick = async () => {
      const p = b.dataset.keyRemove;
      if (!confirm(`Remove the ${LABEL[p]} key from this device?`)) return;
      await setDeviceSetting(`${p}Key`, null);
      keys[p] = null;
      if (p === 'gemini') modelCache = null; else groqModels = null;
      renderKeyState();
    };
  }
  $('ai-keys-manage').onclick = () => { managing = !managing; renderKeyState(); };
  $('ai-order').onchange = async (e) => { aiOrder = e.target.value; await setDeviceSetting('aiOrder', aiOrder); };

  // ----- chat log -----
  function refreshHeader() {
    const cur = getCurrent();
    $('ai-sheet').textContent = cur ? `Sheet ${cur.index + 1}` : 'No sheet';
  }

  function bubble(role, text, cls = '', imageB64 = null) {
    const el = document.createElement('div');
    el.className = `ai-msg ${role} ${cls}`;
    if (imageB64) {
      const img = document.createElement('img');
      img.className = 'ai-msg-img';
      img.src = `data:image/jpeg;base64,${imageB64}`;
      img.alt = '';
      el.append(img);
    }
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
    d.textContent = index >= 0 ? `Sheet ${index + 1}` : 'General question';
    log.append(d);
  }

  function answerButtons(el, text, sheet, source, link) {
    const row = document.createElement('div');
    row.className = 'ai-buttons';
    const btn = (label, fn) => {
      const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: label });
      b.onclick = () => fn(b);
      row.append(b);
    };
    if (sheet) btn('Add to sheet', async (b) => {
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
    if (link) btn('Open', () => openExternal(link));
    if (source) {
      const tag = document.createElement('span');
      tag.className = 'ai-source';
      tag.textContent = source;
      row.append(tag);
    }
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
      toast(hasAi()
        ? 'No printed text on this sheet. Try "Handwriting → text".'
        : 'No printed text on this sheet. Reading handwriting needs a free AI key (below).', { ms: 5000 });
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

  // ----- AI (Gemini and/or Groq: if one is busy the other answers) -----
  async function ask(action, question, label) {
    if (busy || !hasAi()) return;
    const cur = getCurrent();
    // Buttons like Summarize need something to read; a typed question works anywhere.
    if (!cur && !attached && action !== 'ask') { toast('Open a sheet, or attach a picture (📎), first'); return; }
    if (!navigator.onLine) { toast('AI needs an internet connection', { error: true }); return; }
    const sheet = cur ? cur.sheet : null;
    divider(sheet ? sheet.id : 'general', cur ? cur.index : -1);
    busy = true;
    panel.classList.add('busy');
    const pic = attached;
    if (pic) {
      // A new picture starts a new conversation about that picture.
      history = [];
      clearAttachment();
    }
    bubble('user', label, '', pic);
    const waiting = bubble('assistant', pic ? 'Looking at the picture…' : sheet ? 'Reading the sheet…' : 'Thinking…', 'waiting');
    const status = (msg) => { waiting.querySelector('.ai-text').textContent = msg; };
    try {
      const image = pic || (sheet ? await cachedSheetPicture(sheet) : null);
      // null: a picture-only question; undefined: a general question without a sheet
      const pageText = pic ? null : sheet ? await sheetText(sheet) : undefined;
      let prompt = action === 'ask' ? question : PROMPTS[action];
      if (pic && action !== 'ask') prompt = prompt.replace(/this sheet|this page|the page|my notes/gi, 'this picture');
      // "Fastest": Groq first (answers in about a second). "Best": Gemini first (better with Bangla handwriting).
      const order = (aiOrder === 'best' ? ['gemini', 'groq'] : ['groq', 'gemini']).filter((p) => keys[p]);
      // Show the answer while it is being written.
      const onText = (t) => {
        if (waiting.classList.contains('waiting')) waiting.classList.remove('waiting');
        waiting.querySelector('.ai-text').textContent = t;
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
        if (nearBottom) log.scrollTop = log.scrollHeight;
      };
      let res = null, lastError = null;
      for (let i = 0; i < order.length && !res; i++) {
        const p = order[i];
        try {
          res = p === 'gemini'
            ? await askGemini(keys.gemini, { prompt, image, history }, status, onText)
            : await askGroq(keys.groq, { prompt, image, pageText, history }, status, onText);
        } catch (err) {
          lastError = err;
          if (i < order.length - 1) status(`${LABEL[p]} did not answer, asking ${LABEL[order[i + 1]]}…`);
        }
      }
      if (!res) {
        if (order.length === 1 && lastError && lastError.retryable) {
          lastError.message += ` Tip: add a free ${order[0] === 'gemini' ? 'Groq' : 'Gemini'} key too (Manage keys), then the other one answers when this one is busy.`;
        }
        throw lastError || new Error('The AI did not answer. Please try again.');
      }
      // The streamed bubble becomes the final answer.
      waiting.classList.remove('waiting');
      waiting.querySelector('.ai-text').textContent = res.text;
      answerButtons(waiting, res.text, sheet, res.provider);
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

  // ----- pictures: attach, paste, drop, snip -----
  function setAttachment(b64) {
    attached = b64;
    $('ai-attach').hidden = false;
    $('ai-attach').querySelector('img').src = `data:image/jpeg;base64,${b64}`;
    input.focus();
  }
  function clearAttachment() {
    attached = null;
    $('ai-attach').hidden = true;
    $('ai-attach').querySelector('img').removeAttribute('src');
  }
  async function attachFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('Please choose a picture (PNG or JPG)', { error: true }); return; }
    if (!hasAi()) { toast('Add a free AI key first (below) to ask about pictures'); return; }
    try { setAttachment(await toJpeg(file)); } catch (err) { toast(err.message, { error: true }); }
  }
  $('ai-attach-btn').onclick = () => $('ai-file').click();
  $('ai-file').onchange = () => { const f = $('ai-file').files[0]; $('ai-file').value = ''; if (f) attachFile(f); };
  $('ai-attach-clear').onclick = clearAttachment;
  // Ctrl+V a screenshot anywhere in the panel.
  panel.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((it) => it.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    attachFile(item.getAsFile());
  });
  // Drop a picture onto the panel (PDFs dropped elsewhere still go to the notebook).
  panel.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer ? e.dataTransfer.items : [])].some((it) => it.type.startsWith('image/'))) {
      e.preventDefault();
      e.stopPropagation();
      panel.classList.add('drop-target');
    }
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop-target'));
  panel.addEventListener('drop', (e) => {
    const file = [...(e.dataTransfer ? e.dataTransfer.files : [])].find((f) => f.type.startsWith('image/'));
    panel.classList.remove('drop-target');
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    $('drop-overlay').hidden = true;
    attachFile(file);
  });

  // Snip: drag a rectangle over a sheet; that part becomes the attached picture.
  $('ai-snip-btn').onclick = () => {
    if (!sheetAt) return;
    const overlay = Object.assign(document.createElement('div'), { className: 'snip-overlay' });
    const hint = Object.assign(document.createElement('div'), { className: 'snip-hint', textContent: 'Drag over the part of the sheet you want to ask about · Esc to cancel' });
    const rectEl = Object.assign(document.createElement('div'), { className: 'snip-rect' });
    rectEl.hidden = true;
    document.body.append(overlay, hint, rectEl);
    const wasOpen = !panel.hidden;
    panel.hidden = true;          // show the whole sheet while snipping
    let start = null;
    const finish = () => {
      overlay.remove(); hint.remove(); rectEl.remove();
      document.removeEventListener('keydown', onKey, true);
      if (wasOpen) panel.hidden = false;
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      Object.assign(rectEl.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px` });
      rectEl.hidden = false;
    });
    overlay.addEventListener('pointerup', async (e) => {
      if (!start) return;
      const box = { x0: Math.min(start.x, e.clientX), y0: Math.min(start.y, e.clientY), x1: Math.max(start.x, e.clientX), y1: Math.max(start.y, e.clientY) };
      overlay.hidden = true; rectEl.hidden = true;   // let elementsFromPoint see the sheet
      const hit = sheetAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
      finish();
      if (box.x1 - box.x0 < 12 || box.y1 - box.y0 < 12) { toast('Drag a bigger area to snip'); return; }
      if (!hit) { toast('Snip over a sheet', { error: true }); return; }
      try {
        // Render the sheet sharply, then cut out the dragged area.
        const W = 2000, u = W / SHEET_W;
        const full = await sheetCanvas(hit.sheet, W);
        const sx = Math.max(0, ((box.x0 - hit.rect.left) / hit.zoom) * u), sy = Math.max(0, ((box.y0 - hit.rect.top) / hit.zoom) * u);
        const sw = Math.min(full.width - sx, ((box.x1 - box.x0) / hit.zoom) * u), sh = Math.min(full.height - sy, ((box.y1 - box.y0) / hit.zoom) * u);
        const cut = document.createElement('canvas');
        cut.width = Math.max(1, Math.round(sw)); cut.height = Math.max(1, Math.round(sh));
        cut.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, cut.width, cut.height);
        full.width = full.height = 0;
        if (!hasAi()) { toast('Add a free AI key first (below) to ask about pictures'); return; }
        setAttachment(await toJpeg(cut));
      } catch (err) {
        toast(`Could not snip: ${err.message}`, { error: true });
      }
    });
  };

  // ----- Wikipedia look-up (free, no key) -----
  $('ai-lookup').onsubmit = async (e) => {
    e.preventDefault();
    const field = $('ai-lookup').querySelector('input');
    const term = field.value.trim();
    if (!term) return;
    if (!navigator.onLine) { toast('Look-up needs an internet connection', { error: true }); return; }
    const cur = getCurrent();
    if (cur) divider(cur.sheet.id, cur.index);
    field.value = '';
    bubble('user', `Look up: ${term}`);
    const waiting = bubble('assistant', 'Searching Wikipedia…', 'waiting');
    try {
      const r = await wikiLookup(term);
      waiting.remove();
      const text = `${r.title}\n\n${r.text}`;
      const el = bubble('assistant', text);
      answerButtons(el, text, cur ? cur.sheet : null, 'Wikipedia', r.url);
    } catch (err) {
      waiting.remove();
      bubble('assistant', err.message, 'error');
    }
  };
  $('ai-lookup').querySelector('input').addEventListener('keydown', (e) => e.stopPropagation());

  for (const b of panel.querySelectorAll('[data-offline]')) b.onclick = () => offline(b.dataset.offline, b);
  for (const b of panel.querySelectorAll('[data-ai]')) b.onclick = () => ask(b.dataset.ai, undefined, b.textContent);
  if (!canReadAloud()) panel.querySelector('[data-offline="read"]').hidden = true;
  $('ai-form').onsubmit = (e) => {
    e.preventDefault();
    let q = input.value.trim();
    if (!q && !attached) return;
    if (!q) q = 'What is in this picture? Explain it simply.';
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

  loadKeys();
  return { toggle, isOpen: () => !panel.hidden };
}
