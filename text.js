// Sentence splitting and "speakable" text for research papers.

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'sentence' })
  : null;

// A segment ending in one of these is not really the end of a sentence.
const ABBREV = /\b(e\.g|i\.e|et al|etc|cf|vs|viz|approx|resp|fig|figs|eq|eqs|eqn|sec|secs|ref|refs|tab|no|nos|vol|pp|ch|ca|dr|mr|mrs|ms|prof|st|jr|inc|ltd|al|thm|lem|def|prop|cor)\.\s*$/i;
const INITIAL = /(^|\s)[A-Z]\.\s*$/;
const MAX_CHUNK = 220;

function rawSegments(text) {
  if (segmenter) return [...segmenter.segment(text)].map((s) => ({ start: s.index, end: s.index + s.segment.length }));
  const out = [];
  const re = /[^.!?]+[.!?]+["”')\]]*\s*|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** Split into sentence ranges [{start, end}] (offsets into `text`). */
export function splitSentences(text) {
  const merged = [];
  for (const seg of rawSegments(text)) {
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev.start, prev.end) : '';
    const segText = text.slice(seg.start, seg.end);
    if (prev && (ABBREV.test(prevText) || INITIAL.test(prevText) || /^\s*[a-z(\[,;]/.test(segText))) prev.end = seg.end;
    else merged.push({ ...seg });
  }

  // Long sentences are chunked at punctuation: shorter utterances are more
  // reliable with browser voices and make skipping finer grained.
  const out = [];
  for (const s of merged) {
    let start = s.start;
    while (s.end - start > MAX_CHUNK) {
      const piece = text.slice(start, start + MAX_CHUNK);
      let cut = -1;
      const re = /[,;:)]\s|\s[–—]\s/g;
      let m;
      while ((m = re.exec(piece))) if (m.index > 60) cut = m.index + 1;
      if (cut < 0) cut = piece.lastIndexOf(' ');
      if (cut <= 0) cut = MAX_CHUNK;
      out.push({ start, end: start + cut });
      start += cut;
    }
    out.push({ start, end: s.end });
  }

  // Trim whitespace at both ends.
  return out
    .map(({ start, end }) => {
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      return { start, end };
    })
    .filter((s) => s.end > s.start);
}

// --------------------------------------------------------------- speech text

function mappedReplace(state, re, rep) {
  const { text, map } = state;
  let out = '';
  const outMap = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index;
    out += text.slice(last, i);
    for (let k = last; k < i; k++) outMap.push(map[k]);
    const r = typeof rep === 'function' ? rep(m) : rep;
    out += r;
    for (let k = 0; k < r.length; k++) outMap.push(map[i]);
    last = i + m[0].length;
  }
  out += text.slice(last);
  for (let k = last; k < text.length; k++) outMap.push(map[k]);
  return { text: out, map: outMap };
}

const CITATION_RULES = [
  // [3], [1, 4-6], [12–15]
  [/\s*\[\s*\d+(?:\s*[,–—-]\s*\d+)*\s*\]/g, ''],
  // (Smith et al., 2020; Lee and Kim, 2019a)
  [/\s*\((?:see\s|e\.g\.,?\s)?(?:[A-Z][\p{L}'’-]+(?:\s(?:and|&)\s[A-Z][\p{L}'’-]+)?(?:\set\sal\.?)?,?\s(?:19|20)\d{2}[a-z]?(?:[;,]\s*)?)+\)/gu, ''],
];

const SPEECH_RULES = [
  [/https?:\/\/\S+|www\.\S+/g, 'link'],
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\bw\.r\.t\./gi, 'with respect to'],
  [/\bet al\./g, 'et al'],
  [/\bcf\./gi, 'compare'],
  [/\bvs\./gi, 'versus'],
  [/\bapprox\./gi, 'approximately'],
  [/\bresp\./gi, 'respectively'],
  [/\bFigs?\.(?=\s*\d)/g, (m) => (m[0].startsWith('Figs') ? 'Figures' : 'Figure')],
  [/\bEqs?\.(?=\s*\(?\d)/g, (m) => (m[0].startsWith('Eqs') ? 'Equations' : 'Equation')],
  [/\bSecs?\.(?=\s*\d)/g, 'Section'],
  [/\bTab\.(?=\s*\d)/g, 'Table'],
  [/\bRef\.(?=\s*\[?\d)/g, 'Reference'],
  [/≈/g, ' approximately '],
  [/≤/g, ' less than or equal to '],
  [/≥/g, ' greater than or equal to '],
  [/±/g, ' plus or minus '],
  [/×/g, ' times '],
  [/→/g, ' to '],
  [/[∗†‡§¶]/g, ''],
  [/\s+([.,;:!?])/g, (m) => m[1]],
  [/,\s*,/g, ','],
];

/**
 * Text to send to the voice, plus `map[i]` = index in `raw` that output char i
 * came from (so word-boundary events can be traced back to the page).
 */
export function toSpeech(raw, { skipCitations = true } = {}) {
  let state = { text: raw, map: Array.from({ length: raw.length }, (_, i) => i) };
  if (skipCitations) for (const [re, rep] of CITATION_RULES) state = mappedReplace(state, re, rep);
  for (const [re, rep] of SPEECH_RULES) state = mappedReplace(state, re, rep);
  return state;
}

export const wordCount = (s) => (s.match(/\S+/g) || []).length;
