// Gemini text-to-speech (Interactions API) with a small in-memory clip cache.
// Audio comes back as base64 WAV (24 kHz, mono, 16-bit).

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export const GEMINI_MODELS = [
  ['gemini-3.8-flash-tts', 'Flash TTS: best quality'],
  ['gemini-3.8-flash-lite-tts', 'Flash-Lite TTS: faster & cheaper'],
];

export const GEMINI_VOICES = [
  ['Sulafat', 'Warm'], ['Achird', 'Friendly'], ['Charon', 'Informative'], ['Sadaltager', 'Knowledgeable'],
  ['Iapetus', 'Clear'], ['Erinome', 'Clear'], ['Schedar', 'Even'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Vindemiatrix', 'Gentle'], ['Achernar', 'Soft'], ['Gacrux', 'Mature'], ['Rasalgethi', 'Informative'],
  ['Kore', 'Firm'], ['Orus', 'Firm'], ['Alnilam', 'Firm'], ['Zephyr', 'Bright'], ['Autonoe', 'Bright'],
  ['Puck', 'Upbeat'], ['Laomedeia', 'Upbeat'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'],
  ['Umbriel', 'Easy-going'], ['Zubenelgenubi', 'Casual'], ['Leda', 'Youthful'], ['Sadachbia', 'Lively'],
  ['Fenrir', 'Excitable'], ['Enceladus', 'Breathy'], ['Algenib', 'Gravelly'], ['Pulcherrima', 'Forward'],
];

export const DEFAULT_STYLE = 'calm, clear and engaging, like an audiobook narrator explaining a research paper';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isRiff = (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;

// Raw PCM (if the API ever returns headerless audio/l16) -> WAV.
function pcmToWav(pcm, rate = 24000) {
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Returns {url, duration} for an audio clip of `text`. */
export async function synthesize(text, { apiKey, model, voice, style, signal }) {
  const content = { type: 'text', text };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [content] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }),
    signal,
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
    throw new GeminiError(msg || `HTTP ${res.status}`, res.status);
  }
  const json = await res.json();
  const step = [...(json.steps || [])].reverse().find((s) => s.type === 'model_output');
  const audio = step && [...(step.content || [])].reverse().find((c) => c.type === 'audio');
  if (!audio?.data) throw new GeminiError('Gemini returned no audio.', 0);

  let bytes = base64ToBytes(audio.data);
  if (!isRiff(bytes)) bytes = pcmToWav(bytes);
  const byteRate = new DataView(bytes.buffer).getUint32(28, true) || 48000;
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })),
    duration: (bytes.length - 44) / byteRate,
  };
}

/** Caches clip promises ({url, duration}) by key so replays and seeks cost nothing. */
export class ClipCache {
  constructor(max = 60) {
    this.max = max;
    this.map = new Map();
  }

  get(key, make) {
    let p = this.map.get(key);
    if (p) {
      this.map.delete(key); // refresh LRU position
      this.map.set(key, p);
      return p;
    }
    p = make();
    p.catch(() => this.map.delete(key)); // failures may be retried later
    this.map.set(key, p);
    while (this.map.size > this.max) {
      const [oldKey, oldP] = this.map.entries().next().value;
      this.map.delete(oldKey);
      oldP.then((c) => URL.revokeObjectURL(c.url), () => {});
    }
    return p;
  }
}

export function explainError(err) {
  const s = err?.status;
  if (s === 400 && /api key/i.test(err.message)) return 'Gemini rejected the API key. Check it in Settings.';
  if (s === 401 || s === 403) return 'Gemini rejected the API key. Check it in Settings.';
  if (s === 429) return 'Gemini rate limit or quota reached.';
  if (s >= 500) return 'Gemini is having trouble right now.';
  if (err?.name === 'TypeError') return 'Couldn’t reach Gemini (offline?).';
  return `Gemini error: ${err?.message || err}`;
}
