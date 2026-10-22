import * as pdfjsLib from './lib/pdf.min.js';
import { pageLines, buildDocument } from './layout.js';
import { splitSentences, toSpeech, wordCount } from './text.js';
import { Narrator, rankVoices } from './speech.js';
import { ClipCache, GEMINI_MODELS, GEMINI_VOICES, DEFAULT_STYLE, explainError, synthesize } from './gemini.js';
import { KokoroEngine, KOKORO_VOICES, KOKORO_DEVICES } from './kokoro.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.js', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ext = globalThis.chrome?.storage?.local ? globalThis.chrome : null;

// ------------------------------------------------------------------ storage

const store = {
  async get(key, fallback) {
    try {
      if (ext) return (await ext.storage.local.get(key))[key] ?? fallback;
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  async set(key, value) {
    try {
      if (ext) await ext.storage.local.set({ [key]: value });
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  },
};

const DEFAULTS = {
  rate: 1, voice: '', pitch: 1, volume: 1,
  engine: 'kokoro', geminiKey: '', geminiModel: GEMINI_MODELS[0][0], geminiVoice: 'Sulafat', geminiStyle: DEFAULT_STYLE,
  kokoroVoice: 'af_heart', kokoroDevice: 'auto',
  skipFurniture: true, skipOther: true, skipCaptions: false, skipReferences: true, skipFront: true, skipFootnotes: true,
  skipCitations: true, readHeadings: true,
  darkPages: true, follow: true, showCaption: true, showBoxes: false,
  autoOpen: false, zoom: 'fit',
};
let settings = { ...DEFAULTS };
const saveSettings = () => store.set('settings', settings);

// ------------------------------------------------------------------ state

const narrator = new Narrator();
let voices = [];
let pdf = null;
let fileKey = '';
let pages = [];   // {num, w, h, el, canvas, blockLayer, hlLayer, renderedScale, task}
let blocks = [];
let scale = 1;

let cur = { block: -1, sent: 0, offset: 0 }; // offset = chars into the sentence
let playing = false;
let gen = 0;                                 // bumps cancel any running read loop
const selected = new Set();
let anchor = null;
let lastUserScroll = 0;
let playlistCache = null;

// ------------------------------------------------------------------ helpers

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v, total) => `${(v / total) * 100}%`;

function isSkippedKind(kind) {
  return (kind === 'furniture' && settings.skipFurniture)
    || (kind === 'other' && settings.skipOther)
    || (kind === 'caption' && settings.skipCaptions)
    || (kind === 'references' && settings.skipReferences)
    || (kind === 'front' && settings.skipFront)
    || (kind === 'footnote' && settings.skipFootnotes)
    || ((kind === 'heading' || kind === 'title') && !settings.readHeadings);
}

function included(i) {
  if (selected.size) return selected.has(i);
  return !isSkippedKind(blocks[i].kind);
}

function nextIncluded(i) {
  for (let k = i + 1; k < blocks.length; k++) if (included(k)) return k;
  return -1;
}
function prevIncluded(i) {
  for (let k = i - 1; k >= 0; k--) if (included(k)) return k;
  return -1;
}

function sentencesOf(b) {
  return (b.sents ||= splitSentences(b.text));
}

function playlist() {
  if (playlistCache) return playlistCache;
  const ids = [];
  const before = new Map();
  let total = 0;
  blocks.forEach((b, i) => {
    if (!included(i)) return;
    ids.push(i);
    before.set(i, total);
    total += b.words;
  });
  return (playlistCache = { ids, before, total });
}
function invalidatePlaylist() {
  playlistCache = null;
  refreshBlockClasses();
  updateProgress();
}

// ------------------------------------------------------------------ loading

async function openFromUrl(url) {
  showLoading('Downloading PDF…');
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'document.pdf');
    await openData(data, name, url);
  } catch (err) {
    hideLoading();
    console.error(err);
    const local = url.startsWith('file:');
    toast(local
      ? 'Can’t read local files yet: enable “Allow access to file URLs” for PaperVoice in vivaldi://extensions — or drop the file here.'
      : `Couldn’t download the PDF (${err.message}). Save it and drop it here instead.`, 8000);
    $('empty').hidden = false;
  }
}

async function openFile(file) {
  showLoading('Reading file…');
  const data = await file.arrayBuffer();
  await openData(data, file.name, `file:${file.name}:${file.size}`);
}

async function openData(data, name, key) {
  stop();
  try {
    pdf?.destroy();
    pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    hideLoading();
    toast(`This file couldn’t be opened as a PDF (${err.message}).`, 6000);
    return;
  }
  fileKey = key;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || name;
  $('doc-title').textContent = title;
  $('doc-title').title = title;
  document.title = `${title} — PaperVoice`;
  $('empty').hidden = true;

  await buildPages();
  hideLoading();
  await restorePosition();
}

function showLoading(text) {
  $('loading-text').textContent = text;
  $('loading').hidden = false;
}
function hideLoading() { $('loading').hidden = true; }

async function buildPages() {
  const container = $('pages');
  container.replaceChildren();
  pages = [];
  blocks = [];
  selected.clear();
  playlistCache = null;
  cur = { block: -1, sent: 0, offset: 0 };

  const analysed = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    showLoading(`Reading layout… page ${n} of ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    analysed.push({ lines: pageLines(tc, vp), width: vp.width, height: vp.height });

    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = n - 1;
    const canvas = document.createElement('canvas');
    const blockLayer = document.createElement('div');
    blockLayer.className = 'layer block-layer';
    const hlLayer = document.createElement('div');
    hlLayer.className = 'layer hl-layer';
    const num = document.createElement('div');
    num.className = 'page-num';
    num.textContent = `${n} / ${pdf.numPages}`;
    el.append(canvas, blockLayer, hlLayer, num);
    container.append(el);
    pages.push({ num: n, page, w: vp.width, h: vp.height, el, canvas, blockLayer, hlLayer, renderedScale: 0, task: null });
  }

  ({ blocks } = buildDocument(analysed));
  for (const b of blocks) {
    const p = pages[b.page];
    const d = document.createElement('div');
    d.className = `block kind-${b.kind}`;
    d.dataset.id = b.id;
    const pad = 2;
    Object.assign(d.style, {
      left: pct(b.x - pad, p.w), top: pct(b.y - pad, p.h),
      width: pct(b.x2 - b.x + pad * 2, p.w), height: pct(b.y2 - b.y + pad * 2, p.h),
    });
    b.el = d;
    p.blockLayer.append(d);
  }

  if (!blocks.length) toast('No text found — this PDF may be a scanned image (no text layer to read).', 7000);
  applyZoom();
  observePages();
  buildOutline();
  refreshBlockClasses();
  updateProgress();
}

// ------------------------------------------------------------------ rendering

function computeScale() {
  if (settings.zoom === 'fit') {
    const avail = $('viewer').clientWidth - 48;
    const maxW = Math.max(...pages.map((p) => p.w));
    return Math.max(0.3, Math.min(3, avail / maxW));
  }
  return settings.zoom;
}

function applyZoom() {
  if (!pages.length) return;
  scale = computeScale();
  for (const p of pages) {
    p.el.style.width = `${Math.floor(p.w * scale)}px`;
    p.el.style.height = `${Math.floor(p.h * scale)}px`;
  }
  $('zoom-label').textContent = settings.zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`;
  for (const p of visiblePages) renderPage(p);
}

const visiblePages = new Set();
let observer;
function observePages() {
  observer?.disconnect();
  visiblePages.clear();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pages[+e.target.dataset.page];
      if (e.isIntersecting) { visiblePages.add(p); renderPage(p); } else visiblePages.delete(p);
    }
  }, { root: $('viewer'), rootMargin: '1200px 0px' });
  for (const p of pages) observer.observe(p.el);
}

async function renderPage(p) {
  if (p.renderedScale === scale) return;
  const target = scale;
  p.task?.cancel();
  const dpr = window.devicePixelRatio || 1;
  const vp = p.page.getViewport({ scale: target * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  p.task = task;
  try {
    await task.promise;
    if (target !== scale) return;
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
    p.renderedScale = target;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn(err);
  } finally {
    if (p.task === task) p.task = null;
  }
}

// ------------------------------------------------------------------ highlighting

function rectsFor(b, from, to) {
  // Approximate sub-span geometry by character proportion inside each text run.
  const rects = [];
  for (const s of b.spans) {
    if (s.end <= from || s.start >= to) continue;
    const len = s.end - s.start;
    const a = Math.max(from, s.start), z = Math.min(to, s.end);
    const x = s.x + (s.w * (a - s.start)) / len;
    const w = (s.w * (z - a)) / len;
    const last = rects[rects.length - 1];
    if (last && Math.abs(last.y - s.y) < 1 && x - (last.x + last.w) < 8) {
      last.w = Math.max(last.w, x + w - last.x);
    } else rects.push({ x, y: s.y, w, h: s.y2 - s.y });
  }
  return rects;
}

function place(el, r, p) {
  Object.assign(el.style, {
    left: pct(r.x - 1, p.w), top: pct(r.y - 1, p.h), width: pct(r.w + 2, p.w), height: pct(r.h + 2, p.h),
  });
}

let wordEl = null;
let currentBlockEl = null;
function clearHighlights() {
  for (const p of pages) p.hlLayer.replaceChildren();
  wordEl = null;
  currentBlockEl?.classList.remove('reading');
  currentBlockEl = null;
}

function highlightSentence(b, sent) {
  for (const p of pages) if (p.hlLayer.firstChild) p.hlLayer.replaceChildren();
  const p = pages[b.page];
  const rects = rectsFor(b, sent.start, sent.end);
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'hl-sent';
    place(d, r, p);
    p.hlLayer.append(d);
  }
  wordEl = document.createElement('div');
  wordEl.className = 'hl-word';
  wordEl.style.display = 'none';
  p.hlLayer.append(wordEl);

  if (currentBlockEl !== b.el) {
    currentBlockEl?.classList.remove('reading');
    b.el.classList.add('reading');
    currentBlockEl = b.el;
  }
  if (rects.length) followTo(p, rects[0]);
  setCaption(b.text.slice(sent.start, sent.end), -1, 0);
  updateOutlineActive();
}

function highlightWord(b, sent, rawIndex, len) {
  if (!wordEl) return;
  const p = pages[b.page];
  const end = Math.min(rawIndex + Math.max(len, 1), sent.end);
  const r = rectsFor(b, rawIndex, end)[0];
  if (!r) return;
  wordEl.style.display = '';
  place(wordEl, r, p);
  setCaption(b.text.slice(sent.start, sent.end), rawIndex - sent.start, end - rawIndex);
  followTo(p, r);
}

function setCaption(text, wordStart, wordLen) {
  if (!settings.showCaption) return;
  if (wordStart < 0) {
    $('cap-before').textContent = text;
    $('cap-word').textContent = '';
    $('cap-after').textContent = '';
    return;
  }
  // Keep the current word visible in a single-line caption.
  const startCut = Math.max(0, wordStart - 70);
  $('cap-before').textContent = (startCut ? '… ' : '') + text.slice(startCut, wordStart);
  $('cap-word').textContent = text.slice(wordStart, wordStart + wordLen);
  $('cap-after').textContent = text.slice(wordStart + wordLen);
}

function followTo(p, r) {
  const viewer = $('viewer');
  const top = p.el.offsetTop + (r.y / p.h) * p.el.offsetHeight;
  const bottom = top + (r.h / p.h) * p.el.offsetHeight;
  const vTop = viewer.scrollTop, vBottom = vTop + viewer.clientHeight;
  const offscreen = top < vTop + 40 || bottom > vBottom - 60;
  if (!offscreen) { $('btn-jump').hidden = true; return; }
  if (!settings.follow || !playing) return;
  if (Date.now() - lastUserScroll < 5000) { $('btn-jump').hidden = false; return; }
  $('btn-jump').hidden = true;
  viewer.scrollTo({ top: top - viewer.clientHeight * 0.3, behavior: 'smooth' });
}

function jumpToReading() {
  lastUserScroll = 0;
  $('btn-jump').hidden = true;
  const b = blocks[cur.block];
  if (!b) return;
  const p = pages[b.page];
  const top = p.el.offsetTop + (b.y / p.h) * p.el.offsetHeight;
  $('viewer').scrollTo({ top: top - $('viewer').clientHeight * 0.3, behavior: 'smooth' });
}

// ------------------------------------------------------------------ reading loop

function currentVoice() {
  return voices.find((v) => v.voiceURI === settings.voice) || voices[0] || null;
}

/** 'gemini' | 'kokoro' when reading with generated audio clips, else null (built-in voices). */
function clipEngine() {
  if (settings.engine === 'kokoro') return 'kokoro';
  if (settings.engine === 'gemini' && settings.geminiKey) return 'gemini';
  return null;
}
const geminiOpts = () => ({
  apiKey: settings.geminiKey, model: settings.geminiModel, voice: settings.geminiVoice, style: settings.geminiStyle.trim(),
});

async function readFrom(blockIdx, sentIdx = 0, offset = 0) {
  if (blockIdx < 0 || blockIdx >= blocks.length) return;
  const engine = clipEngine();
  if (!engine && !narrator.available) { toast('Speech isn’t available in this browser.'); return; }
  const my = ++gen;
  narrator.stop();
  stopAudio();
  await sleep(40); // let cancel() settle before speaking again (Chromium race)
  if (my !== gen) return;
  setPlaying(true);

  const done = engine
    ? await readClips(engine, blockIdx, sentIdx, offset, my)
    : await readBrowser(blockIdx, sentIdx, offset, my);
  if (done && my === gen) {
    setPlaying(false);
    setCaption(selected.size ? 'Finished reading your selection.' : 'Finished.', -1, 0);
    toast(selected.size ? 'Finished the selected paragraphs.' : 'Reached the end of the document.');
  }
}

/** Built-in voices, one sentence per utterance. Returns true when it reached the end. */
async function readBrowser(blockIdx, sentIdx, offset, my) {
  let b = blockIdx;
  while (my === gen && b >= 0) {
    const block = blocks[b];
    const sents = sentencesOf(block);
    for (let s = sentIdx; s < sents.length; s++) {
      if (my !== gen) return false;
      const sent = sents[s];
      const startOff = s === sentIdx ? offset : 0;
      cur = { block: b, sent: s, offset: startOff };
      highlightSentence(block, sent);
      updateProgress();
      savePositionSoon();

      const rawStart = sent.start + startOff;
      const sp = toSpeech(block.text.slice(rawStart, sent.end), { skipCitations: settings.skipCitations });
      if (!sp.text.trim()) continue;
      const result = await narrator.speak(sp.text, {
        voice: currentVoice(), rate: settings.rate, pitch: settings.pitch, volume: settings.volume,
      }, (ci) => {
        if (my !== gen) return;
        const raw = rawStart + (sp.map[ci] ?? 0);
        cur.offset = raw - sent.start;
        highlightWord(block, sent, raw, wordLenAt(block.text, raw));
      });
      if (my !== gen) return false;
      if (result === 'error') { toast('The voice stopped unexpectedly — skipping ahead.'); await sleep(200); }
    }
    sentIdx = 0;
    offset = 0;
    b = nextIncluded(b);
  }
  return my === gen;
}

// ------------------------------------------------------------------ generated voices (Gemini, Kokoro)
//
// Both engines read groups of sentences per clip, which sounds far more natural
// than sentence-by-sentence (Gemini: ~900 chars per request, saving quota;
// Kokoro: ~300 chars, its comfortable input length). Neither reports word
// timings, so the highlight is estimated from playback time, proportionally to
// text length (plus a pause per sentence).

const clips = new ClipCache();
let currentAudio = null;
const SENTENCE_PAUSE = 12; // in "characters" of time
const chunkChars = () => (settings.engine === 'kokoro' ? 300 : 900);

let kokoroWaiting = false; // a sentence is waiting on the model (show download progress)
const kokoro = new KokoroEngine((st) => {
  const el = $('kokoro-status');
  if (st.kind === 'progress') {
    const pctDone = Math.round((st.loaded / st.total) * 100);
    const mb = (n) => Math.round(n / 1e6);
    const msg = `Downloading voice model (one time only)… ${pctDone}% of ${mb(st.total)} MB`;
    if (el) el.textContent = msg;
    if (kokoroWaiting) setCaption(msg, -1, 0);
  } else if (st.kind === 'ready') {
    const msg = `Voice model ready, running on your ${st.device === 'webgpu' ? 'graphics card' : 'processor'}.`;
    if (el) el.textContent = st.note ? `${st.note} ${msg}` : msg;
  } else if (st.kind === 'error') {
    if (el) el.textContent = `Couldn’t load the voice model: ${st.message}`;
  }
});

function clipFor(engine, text) {
  if (engine === 'kokoro') {
    const o = { voice: settings.kokoroVoice, device: settings.kokoroDevice };
    return clips.get(`k|${o.voice}|${text}`, () => kokoro.synthesize(text, o));
  }
  const o = geminiOpts();
  return clips.get(`g|${o.model}|${o.voice}|${o.style}|${text}`, () => synthesize(text, o));
}

function chunksOf(block) {
  const CHUNK_CHARS = chunkChars();
  const key = `${settings.skipCitations}|${CHUNK_CHARS}`;
  if (block.chunks?.key === key) return block.chunks.list;
  const sents = sentencesOf(block);
  const list = [];
  let c = null;
  sents.forEach((sent, s) => {
    const sp = toSpeech(block.text.slice(sent.start, sent.end), { skipCitations: settings.skipCitations });
    const text = sp.text.trim() ? sp.text : '';
    if (c && c.text.length + text.length > CHUNK_CHARS) { list.push(c); c = null; }
    c ||= { s0: s, s1: s, text: '', parts: [] };
    if (text) {
      if (c.text) c.text += ' ';
      c.parts.push({ sent: s, start: c.text.length, len: text.length, map: sp.map });
      c.text += text;
    }
    c.s1 = s + 1;
  });
  if (c) list.push(c);
  block.chunks = { key, list };
  return list;
}

const partWeight = (p) => p.len + SENTENCE_PAUSE;

function locate(ch, t, dur) {
  const total = ch.parts.reduce((a, p) => a + partWeight(p), 0);
  let w = Math.max(0, Math.min(1, t / dur)) * total;
  for (const p of ch.parts) {
    if (w < partWeight(p) || p === ch.parts[ch.parts.length - 1]) {
      const local = Math.max(0, Math.min(p.len - 1, Math.floor(w)));
      return { sent: p.sent, rel: p.map[local] ?? 0 };
    }
    w -= partWeight(p);
  }
  return null;
}

function timeFor(ch, sent, offset, dur) {
  const total = ch.parts.reduce((a, p) => a + partWeight(p), 0);
  let w = 0;
  for (const p of ch.parts) {
    if (p.sent >= sent) {
      if (p.sent === sent && offset > 0) w += Math.max(0, p.map.findIndex((m) => m >= offset));
      return Math.max(0, (w / total) * dur - 0.15);
    }
    w += partWeight(p);
  }
  return 0;
}

/** Up to `n` chunks after (b, ci) in reading order, for prefetching. */
function upcomingChunks(b, ci, n) {
  const out = [];
  let list = chunksOf(blocks[b]);
  while (out.length < n && b >= 0) {
    if (++ci < list.length) { if (list[ci].text) out.push(list[ci]); continue; }
    b = nextIncluded(b);
    if (b < 0) break;
    list = chunksOf(blocks[b]);
    ci = -1;
  }
  return out;
}

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

function playClip(clip, startTime, my, onTick) {
  return new Promise((resolve) => {
    const a = new Audio(clip.url);
    a.preservesPitch = true;
    a.playbackRate = settings.rate;
    a.volume = settings.volume;
    currentAudio = a;
    let finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      if (currentAudio === a) currentAudio = null;
      resolve(r);
    };
    a.onended = () => finish('end');
    a.onerror = () => finish('error');
    a.onloadedmetadata = () => {
      if (startTime > 0) a.currentTime = Math.min(startTime, a.duration - 0.05);
      a.play().catch(() => finish('error'));
    };
    const tick = () => {
      if (finished) return;
      if (my !== gen) { a.pause(); finish('cancel'); return; }
      const dur = Number.isFinite(a.duration) ? a.duration : clip.duration;
      if (!a.paused) onTick(a.currentTime, dur);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const isFatalGemini = (err) => [401, 403, 429].includes(err?.status) || (err?.status === 400 && /api key/i.test(err.message));

async function readClips(engine, blockIdx, sentIdx, offset, my) {
  let b = blockIdx, s = sentIdx, off = offset;
  let failures = 0; // consecutive passages that failed
  while (my === gen && b >= 0) {
    const block = blocks[b];
    const sents = sentencesOf(block);
    const list = chunksOf(block);
    for (let ci = list.findIndex((c) => s < c.s1); ci >= 0 && ci < list.length; ci++) {
      const ch = list[ci];
      if (!ch.text) { s = ch.s1; off = 0; continue; }
      const first = Math.max(s, ch.s0);
      cur = { block: b, sent: first, offset: off };
      highlightSentence(block, sents[first]);
      updateProgress();

      const clipP = clipFor(engine, ch.text);
      for (const next of upcomingChunks(b, ci, 2)) clipFor(engine, next.text).catch(() => {});
      const slow = setTimeout(() => {
        kokoroWaiting = engine === 'kokoro';
        setCaption(engine === 'kokoro' && !kokoro.ready ? 'Starting the Kokoro voice…' : 'Generating natural voice…', -1, 0);
      }, 400);
      // Never switch to a different voice mid-paper: retry (restarting Kokoro's
      // session once, which recovers from GPU hiccups), skip a passage that
      // still fails, and pause if failures repeat.
      let clip = null, lastErr = null;
      for (let attempt = 0; attempt < 3 && !clip; attempt++) {
        try {
          clip = await (attempt ? clipFor(engine, ch.text) : clipP);
        } catch (err) {
          lastErr = err;
          console.warn('[PaperVoice] voice failed', { engine, attempt, text: ch.text, err });
          if (my !== gen) break;
          if (engine === 'gemini' && isFatalGemini(err)) break;
          if (engine === 'kokoro' && attempt === 1) kokoro.restart(settings.kokoroDevice);
          await sleep(500 * (attempt + 1));
        }
      }
      clearTimeout(slow);
      kokoroWaiting = false;
      if (my !== gen) return false;
      if (!clip) {
        const why = engine === 'kokoro' ? `The Kokoro voice failed (${lastErr?.message}).` : explainError(lastErr);
        if (engine === 'kokoro') $('kokoro-status').textContent = `Last problem: ${lastErr?.message}`;
        if (++failures >= 2 || (engine === 'gemini' && isFatalGemini(lastErr))) {
          stop();
          cur = { block: b, sent: first, offset: off };
          setCaption('Reading paused: the voice isn’t responding.', -1, 0);
          toast(`${why} Reading paused. Press Play to try again, or pick another voice in Settings.`, 9000);
          return false;
        }
        toast(`${why} Skipped one passage.`, 5000);
        s = ch.s1;
        off = 0;
        continue;
      }
      failures = 0;
      if (my !== gen) return false;
      setCaption(block.text.slice(sents[first].start, sents[first].end), -1, 0);

      let lastSent = first, lastWord = -1;
      const start = first > ch.s0 || off > 0 ? timeFor(ch, first, off, clip.duration) : 0;
      const result = await playClip(clip, start, my, (t, dur) => {
        const pos = locate(ch, t, dur);
        if (!pos) return;
        const sent = sents[pos.sent];
        if (pos.sent !== lastSent) {
          lastSent = pos.sent;
          lastWord = -1;
          cur = { block: b, sent: pos.sent, offset: 0 };
          highlightSentence(block, sent);
          updateProgress();
          savePositionSoon();
        }
        // Snap to the start of the word under the estimate.
        let raw = sent.start + pos.rel;
        while (raw > sent.start && /\S/.test(block.text[raw - 1])) raw--;
        if (raw !== lastWord) {
          lastWord = raw;
          cur.offset = raw - sent.start;
          highlightWord(block, sent, raw, wordLenAt(block.text, raw));
        }
      });
      if (my !== gen) return false;
      if (result === 'error') toast('Couldn’t play that audio clip — skipping ahead.');
      s = ch.s1;
      off = 0;
    }
    b = nextIncluded(b);
    s = 0;
    off = 0;
  }
  return my === gen;
}

function wordLenAt(text, i) {
  const m = text.slice(i).match(/^\S+/);
  return m ? m[0].length : 1;
}

function stop() {
  gen++;
  narrator.stop();
  stopAudio();
  setPlaying(false);
}

function pause() {
  stop();
  savePosition();
}

function setPlaying(v) {
  playing = v;
  $('play').classList.toggle('playing', v);
  $('play').setAttribute('aria-label', v ? 'Pause' : 'Play');
}

function togglePlay() {
  if (playing) return pause();
  if (!blocks.length) return toast('Open a PDF first.');
  if (cur.block >= 0 && (included(cur.block) || selected.size === 0)) {
    return readFrom(cur.block, cur.sent, cur.offset);
  }
  const start = firstIncludedInView();
  if (start < 0) return toast(selected.size ? 'Nothing selected to read.' : 'Nothing to read with the current skip settings.');
  readFrom(start);
}

function firstIncludedInView() {
  const viewer = $('viewer');
  const vTop = viewer.scrollTop;
  for (let i = 0; i < blocks.length; i++) {
    if (!included(i)) continue;
    const b = blocks[i], p = pages[b.page];
    const bottom = p.el.offsetTop + (b.y2 / p.h) * p.el.offsetHeight;
    if (bottom > vTop + 10) return i;
  }
  const ids = playlist().ids;
  return ids.length ? ids[0] : -1;
}

/** Move the cursor; keeps playing if we were. */
function seek(block, sent = 0) {
  if (block < 0 || block >= blocks.length) return;
  const n = sentencesOf(blocks[block]).length;
  sent = Math.max(0, Math.min(sent, n - 1));
  if (playing) return readFrom(block, sent);
  cur = { block, sent, offset: 0 };
  const s = sentencesOf(blocks[block])[sent];
  if (s) highlightSentence(blocks[block], s);
  jumpToReading();
  updateProgress();
  savePositionSoon();
}

function nextSentence() {
  if (cur.block < 0) return togglePlay();
  const n = sentencesOf(blocks[cur.block]).length;
  if (cur.sent + 1 < n) return seek(cur.block, cur.sent + 1);
  const nb = nextIncluded(cur.block);
  if (nb >= 0) seek(nb, 0);
}
function prevSentence() {
  if (cur.block < 0) return;
  if (cur.sent > 0) return seek(cur.block, cur.sent - 1);
  const pb = prevIncluded(cur.block);
  if (pb >= 0) seek(pb, sentencesOf(blocks[pb]).length - 1);
  else seek(cur.block, 0);
}
function nextBlock() {
  if (cur.block < 0) return togglePlay();
  const nb = nextIncluded(cur.block);
  if (nb >= 0) seek(nb, 0);
}
function prevBlock() {
  if (cur.block < 0) return;
  if (cur.sent > 0 || cur.offset > 0) return seek(cur.block, 0);
  const pb = prevIncluded(cur.block);
  seek(pb >= 0 ? pb : cur.block, 0);
}

function setRate(r) {
  settings.rate = Math.round(Math.max(0.5, Math.min(3, r)) * 100) / 100;
  saveSettings();
  renderSpeed();
  updateProgress();
  // Gemini clips just play faster (pitch preserved). speechSynthesis can't change
  // rate mid-utterance, so restart at the current word.
  if (currentAudio) currentAudio.playbackRate = settings.rate;
  else if (playing) readFrom(cur.block, cur.sent, cur.offset);
}

// ------------------------------------------------------------------ position memory

let saveTimer;
function savePositionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 1500);
}
function savePosition() {
  if (!fileKey || cur.block < 0) return;
  store.set(`pos:${fileKey}`, { block: cur.block, sent: cur.sent, n: blocks.length, t: Date.now() });
}
async function restorePosition() {
  const pos = await store.get(`pos:${fileKey}`, null);
  if (!pos || pos.n !== blocks.length || pos.block <= 0 || !blocks[pos.block]) return;
  cur = { block: pos.block, sent: pos.sent || 0, offset: 0 };
  const s = sentencesOf(blocks[cur.block])[cur.sent];
  if (s) highlightSentence(blocks[cur.block], s);
  jumpToReading();
  updateProgress();
  toast(`Picked up where you left off (page ${blocks[cur.block].page + 1}). Press Play to continue.`, 4500);
}

// ------------------------------------------------------------------ progress

function updateProgress() {
  const { ids, before, total } = playlist();
  let done = 0;
  if (cur.block >= 0) {
    if (before.has(cur.block)) {
      const b = blocks[cur.block];
      const s = sentencesOf(b)[cur.sent];
      done = before.get(cur.block) + (s ? wordCount(b.text.slice(0, s.start)) : 0);
    } else {
      const prior = ids.filter((i) => i < cur.block);
      done = prior.length ? before.get(prior[prior.length - 1]) + blocks[prior[prior.length - 1]].words : 0;
    }
  }
  $('progress-fill').style.width = total ? `${(done / total) * 100}%` : '0';
  const page = cur.block >= 0 ? blocks[cur.block].page + 1 : 1;
  $('pos-label').textContent = pages.length ? `Page ${page} of ${pages.length}` : '—';
  const mins = Math.max(0, total - done) / (165 * settings.rate);
  $('time-label').textContent = total ? `${mins < 1 ? '<1' : Math.round(mins)} min left` : '';

  const chip = $('selection-chip');
  chip.hidden = !selected.size;
  if (selected.size) {
    chip.innerHTML = '';
    chip.append(`Reading ${selected.size} selected paragraph${selected.size > 1 ? 's' : ''}`);
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Clear selection (Esc)';
    x.onclick = clearSelection;
    chip.append(x);
  }
}

function seekToFraction(f) {
  const { ids, before, total } = playlist();
  if (!ids.length) return;
  const target = f * total;
  let pick = ids[0];
  for (const i of ids) { if (before.get(i) <= target) pick = i; else break; }
  seek(pick, 0);
}

// ------------------------------------------------------------------ selection

function refreshBlockClasses() {
  let order = 0;
  for (const b of blocks) {
    const sel = selected.has(b.id);
    b.el.classList.toggle('selected', sel);
    if (sel) b.el.dataset.order = ++order;
    b.el.classList.toggle('skipped', !selected.size && isSkippedKind(b.kind));
    b.el.title = isSkippedKind(b.kind) && !sel ? `Skipped (${kindLabel(b.kind)}) — click to read it anyway` : '';
  }
  $('pages').classList.toggle('boxes', settings.showBoxes);
  $('pages').classList.toggle('dark', settings.darkPages);
  syncOutlineChecks();
}

function kindLabel(kind) {
  return {
    furniture: 'page header / footer', other: 'equation, table or figure text', caption: 'caption',
    references: 'reference list', heading: 'heading', title: 'title', front: 'authors & affiliations', footnote: 'footnote',
  }[kind] || kind;
}

function clearSelection() {
  if (!selected.size) return;
  selected.clear();
  anchor = null;
  invalidatePlaylist();
  toast('Selection cleared — reading the whole paper.');
}

function onBlockClick(e) {
  const el = e.target.closest('.block');
  if (!el) return;
  const id = +el.dataset.id;
  if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchor = id;
    invalidatePlaylist();
    if (selected.size === 1) toast('Selected. Ctrl+Click more paragraphs, Shift+Click for a range, then press Play.');
    return;
  }
  if (e.shiftKey && anchor != null) {
    const [a, z] = anchor < id ? [anchor, id] : [id, anchor];
    for (let i = a; i <= z; i++) if (blocks[i].kind !== 'furniture' && blocks[i].kind !== 'other') selected.add(i);
    invalidatePlaylist();
    return;
  }
  if (selected.size && !selected.has(id)) clearSelection();
  anchor = id;
  readFrom(id);
}

// ------------------------------------------------------------------ outline

let headings = [];
function buildOutline() {
  const list = $('outline-list');
  list.replaceChildren();
  headings = blocks.filter((b) => b.kind === 'heading' || b.kind === 'title');
  if (!headings.length) {
    list.innerHTML = '<p class="ol-empty">No section headings detected in this PDF.</p>';
    return;
  }
  headings.forEach((h, idx) => {
    const lvl = h.heading?.level ?? 1;
    // A section runs until the next heading at the same or a higher level.
    let end = blocks.length;
    for (let k = idx + 1; k < headings.length; k++) {
      if ((headings[k].heading?.level ?? 1) <= lvl) { end = headings[k].id; break; }
    }
    h.sectionEnd = lvl === 0 ? (headings[idx + 1]?.id ?? blocks.length) : end;

    const row = document.createElement('div');
    row.className = 'ol-item';
    row.dataset.level = lvl;
    row.dataset.id = h.id;
    const check = document.createElement('button');
    check.className = 'ol-check';
    check.title = 'Read only this section (combine several)';
    check.setAttribute('aria-label', `Select section ${h.text}`);
    check.onclick = () => toggleSection(h);
    const title = document.createElement('button');
    title.className = 'ol-title';
    title.textContent = h.text;
    title.onclick = () => { if (selected.size && !selected.has(h.id)) clearSelection(); readFrom(h.id); };
    row.append(check, title);
    list.append(row);
  });
}

function sectionIds(h) {
  const ids = [];
  for (let i = h.id; i < h.sectionEnd; i++) if (!['furniture', 'other'].includes(blocks[i].kind)) ids.push(i);
  return ids;
}

function toggleSection(h) {
  const ids = sectionIds(h);
  const all = ids.every((i) => selected.has(i));
  for (const i of ids) all ? selected.delete(i) : selected.add(i);
  invalidatePlaylist();
  if (!all) toast(`Section added — ${selected.size} paragraphs selected. Press Play.`);
}

function syncOutlineChecks() {
  for (const row of $('outline-list').querySelectorAll('.ol-item')) {
    const h = blocks[+row.dataset.id];
    const ids = sectionIds(h);
    const n = ids.filter((i) => selected.has(i)).length;
    const c = row.querySelector('.ol-check');
    c.classList.toggle('on', n > 0 && n === ids.length);
    c.classList.toggle('part', n > 0 && n < ids.length);
  }
}

function updateOutlineActive() {
  let active = null;
  for (const h of headings) if (h.id <= cur.block) active = h; else break;
  for (const row of $('outline-list').querySelectorAll('.ol-item')) {
    row.classList.toggle('active', active && +row.dataset.id === active.id);
  }
}

// ------------------------------------------------------------------ speed UI

const PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function renderSpeed() {
  const r = settings.rate;
  $('speed-label').textContent = `${r % 1 === 0 ? r.toFixed(1) : +r.toFixed(2)}×`;
  $('speed-range').value = settings.rate;
  for (const c of $('speed-pop').querySelectorAll('.chips button')) c.classList.toggle('on', +c.dataset.rate === settings.rate);
}
function setupSpeed() {
  const chips = $('speed-pop').querySelector('.chips');
  for (const r of PRESETS) {
    const b = document.createElement('button');
    b.textContent = `${r}×`;
    b.dataset.rate = r;
    b.onclick = () => setRate(r);
    chips.append(b);
  }
  $('speed-label').onclick = (e) => { e.stopPropagation(); $('speed-pop').hidden = !$('speed-pop').hidden; };
  $('speed-pop').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => { $('speed-pop').hidden = true; });
  let rangeTimer;
  $('speed-range').oninput = (e) => {
    clearTimeout(rangeTimer);
    const v = +e.target.value;
    $('speed-label').textContent = `${v}×`;
    rangeTimer = setTimeout(() => setRate(v), 250);
  };
  $('speed-down').onclick = () => setRate(settings.rate - 0.25);
  $('speed-up').onclick = () => setRate(settings.rate + 0.25);
  renderSpeed();
}

// ------------------------------------------------------------------ settings UI

async function setupVoices() {
  voices = rankVoices(await narrator.voices());
  const sel = $('voice');
  sel.replaceChildren();
  const groups = new Map();
  for (const v of voices) {
    const g = /^en/i.test(v.lang) ? 'English' : 'Other languages';
    if (!groups.has(g)) { const og = document.createElement('optgroup'); og.label = g; groups.set(g, og); sel.append(og); }
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name.replace(/^Microsoft\s+/, '')} — ${v.lang}${v.localService ? '' : ' (online)'}`;
    groups.get(g).append(o);
  }
  if (!voices.find((v) => v.voiceURI === settings.voice) && voices[0]) settings.voice = voices[0].voiceURI;
  sel.value = settings.voice;
  if (!voices.length) sel.innerHTML = '<option>No voices found</option>';
}

const SAMPLE = 'Deep residual networks are easier to optimize, and gain accuracy from considerably increased depth.';

async function testVoice() {
  if (playing) pause();
  narrator.stop();
  stopAudio();
  await sleep(40);
  const engine = clipEngine();
  if (!engine) {
    if (settings.engine === 'gemini') return toast('Paste your Gemini API key first.');
    narrator.speak(SAMPLE, { voice: currentVoice(), rate: settings.rate, pitch: settings.pitch, volume: settings.volume });
    return;
  }
  const btn = $('voice-test');
  btn.disabled = true;
  btn.textContent = engine === 'kokoro' && !kokoro.ready ? 'Loading model…' : 'Generating…';
  try {
    const clip = await clipFor(engine, SAMPLE);
    playClip(clip, 0, gen, () => {});
  } catch (err) {
    toast(engine === 'kokoro' ? `Kokoro voice failed: ${err.message}` : explainError(err), 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test voice';
  }
}

function setupGeminiSettings() {
  const fill = (sel, items, value) => {
    sel.replaceChildren(...items.map(([v, label]) => new Option(label, v)));
    sel.value = value;
  };
  fill($('geminiVoice'), GEMINI_VOICES.map(([n, d]) => [n, `${n} — ${d}`]), settings.geminiVoice);
  fill($('geminiModel'), GEMINI_MODELS, settings.geminiModel);
  fill($('kokoroVoice'), KOKORO_VOICES, settings.kokoroVoice);
  fill($('kokoroDevice'), KOKORO_DEVICES, settings.kokoroDevice);
  $('engine').value = settings.engine;
  $('geminiKey').value = settings.geminiKey;
  $('geminiStyle').value = settings.geminiStyle;

  const showEngine = () => {
    $('gemini-opts').hidden = settings.engine !== 'gemini';
    $('kokoro-opts').hidden = settings.engine !== 'kokoro';
    $('browser-opts').hidden = settings.engine !== 'browser';
    // Warm the model up as soon as Kokoro is picked (or on start if it already is).
    if (settings.engine === 'kokoro') kokoro.preload(settings.kokoroDevice);
  };
  showEngine();
  const restart = () => { if (playing) readFrom(cur.block, cur.sent, cur.offset); };

  $('engine').onchange = (e) => {
    settings.engine = e.target.value;
    saveSettings();
    showEngine();
    if (settings.engine === 'gemini' && !settings.geminiKey) toast('Paste a Gemini API key to use natural voices.');
    restart();
  };
  $('kokoroVoice').onchange = (e) => { settings.kokoroVoice = e.target.value; saveSettings(); restart(); };
  $('kokoroDevice').onchange = (e) => {
    settings.kokoroDevice = e.target.value;
    saveSettings();
    kokoro.reset();
    $('kokoro-status').textContent = '';
    kokoro.preload(settings.kokoroDevice);
    restart();
  };
  $('geminiKey').onchange = (e) => { settings.geminiKey = e.target.value.trim(); saveSettings(); restart(); };
  for (const k of ['geminiVoice', 'geminiModel', 'geminiStyle']) {
    $(k).onchange = (e) => { settings[k] = e.target.value; saveSettings(); restart(); };
  }
  $('style-reset').onclick = (e) => {
    e.preventDefault();
    settings.geminiStyle = DEFAULT_STYLE;
    $('geminiStyle').value = DEFAULT_STYLE;
    saveSettings();
    restart();
  };
}

function setupSettings() {
  const toggles = ['skipFurniture', 'skipOther', 'skipCaptions', 'skipReferences', 'skipFront', 'skipFootnotes', 'skipCitations', 'readHeadings',
    'darkPages', 'follow', 'showCaption', 'showBoxes', 'autoOpen'];
  for (const k of toggles) {
    const el = $(k);
    el.checked = !!settings[k];
    el.onchange = () => {
      settings[k] = el.checked;
      saveSettings();
      if (k === 'showCaption') $('caption').hidden = !settings.showCaption;
      if (k === 'skipCitations' && playing) readFrom(cur.block, cur.sent, cur.offset);
      invalidatePlaylist();
    };
  }
  $('caption').hidden = !settings.showCaption;

  $('voice').onchange = (e) => {
    settings.voice = e.target.value;
    saveSettings();
    if (playing) readFrom(cur.block, cur.sent, cur.offset);
  };
  $('voice-test').onclick = testVoice;
  setupGeminiSettings();
  for (const [k, fmt] of [['pitch', (v) => v.toFixed(2)], ['volume', (v) => `${Math.round(v * 100)}%`]]) {
    const el = $(k);
    el.value = settings[k];
    $(`${k}-val`).textContent = fmt(settings[k]);
    el.oninput = () => { settings[k] = +el.value; $(`${k}-val`).textContent = fmt(settings[k]); };
    el.onchange = () => {
      saveSettings();
      if (currentAudio) currentAudio.volume = settings.volume;
      else if (playing) readFrom(cur.block, cur.sent, cur.offset);
    };
  }

  const togglePanel = (id, btn) => {
    const el = $(id);
    el.hidden = !el.hidden;
    $(btn).classList.toggle('on', !el.hidden);
    requestAnimationFrame(() => settings.zoom === 'fit' && applyZoom());
  };
  $('btn-settings').onclick = () => togglePanel('settings', 'btn-settings');
  $('settings-close').onclick = () => togglePanel('settings', 'btn-settings');
  $('btn-outline').onclick = () => togglePanel('outline', 'btn-outline');
}

// ------------------------------------------------------------------ wiring

function setupControls() {
  $('play').onclick = togglePlay;
  $('next-sent').onclick = nextSentence;
  $('prev-sent').onclick = prevSentence;
  $('next-block').onclick = nextBlock;
  $('prev-block').onclick = prevBlock;
  $('btn-jump').onclick = jumpToReading;
  $('progress').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekToFraction((e.clientX - r.left) / r.width);
  };
  $('pages').addEventListener('click', onBlockClick);

  const zoomSteps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const stepZoom = (dir) => {
    const now = scale;
    const next = dir > 0 ? zoomSteps.find((z) => z > now + 0.01) : [...zoomSteps].reverse().find((z) => z < now - 0.01);
    if (!next) return;
    settings.zoom = next;
    saveSettings();
    applyZoom();
  };
  $('zoom-in').onclick = () => stepZoom(1);
  $('zoom-out').onclick = () => stepZoom(-1);
  $('zoom-label').onclick = () => { settings.zoom = 'fit'; saveSettings(); applyZoom(); };

  const pick = () => $('file-input').click();
  $('btn-open').onclick = pick;
  $('btn-open-2').onclick = pick;
  $('file-input').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };

  // Drag & drop anywhere.
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const f = [...e.dataTransfer.files].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
    if (f) openFile(f); else toast('That isn’t a PDF file.');
  });

  const viewer = $('viewer');
  const markScroll = () => { lastUserScroll = Date.now(); };
  viewer.addEventListener('wheel', markScroll, { passive: true });
  viewer.addEventListener('touchmove', markScroll, { passive: true });
  viewer.addEventListener('mousedown', (e) => { if (e.target === viewer) markScroll(); });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => settings.zoom === 'fit' && applyZoom(), 150);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') && e.key !== 'Escape') return;
    if (e.altKey || ((e.ctrlKey || e.metaKey) && e.key !== 'o')) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? nextBlock() : nextSentence(); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? prevBlock() : prevSentence(); break;
      case '=': case '+': setRate(settings.rate + 0.25); break;
      case '-': case '_': setRate(settings.rate - 0.25); break;
      case 'Escape': $('speed-pop').hidden = true; clearSelection(); break;
      case 'o': if (e.ctrlKey || e.metaKey) { e.preventDefault(); pick(); } else $('btn-outline').click(); break;
      case 'j': jumpToReading(); break;
      default: return;
    }
  });

  window.addEventListener('beforeunload', () => { savePosition(); narrator.stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
}

async function init() {
  settings = { ...DEFAULTS, ...(await store.get('settings', {})) };
  setupControls();
  setupSpeed();
  setupSettings();
  await setupVoices();
  refreshBlockClasses();

  const file = new URLSearchParams(location.search).get('file');
  if (file) { $('empty').hidden = true; openFromUrl(file); }
}

init();
