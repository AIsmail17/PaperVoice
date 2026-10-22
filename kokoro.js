// Main-thread side of the Kokoro voice: talks to kokoro-worker.js and turns
// the raw samples it returns into playable WAV clips.

export const KOKORO_VOICES = [
  ['af_heart', 'Heart: US female, best quality'],
  ['af_bella', 'Bella: US female, very good'],
  ['af_nicole', 'Nicole: US female, soft'],
  ['af_aoede', 'Aoede: US female'],
  ['af_kore', 'Kore: US female'],
  ['af_sarah', 'Sarah: US female'],
  ['am_michael', 'Michael: US male'],
  ['am_fenrir', 'Fenrir: US male'],
  ['am_puck', 'Puck: US male'],
  ['bf_emma', 'Emma: UK female'],
  ['bf_isabella', 'Isabella: UK female'],
  ['bm_george', 'George: UK male'],
  ['bm_fable', 'Fable: UK male'],
];

export const KOKORO_DEVICES = [
  ['auto', 'Auto: graphics card if available'],
  ['webgpu', 'Graphics card (WebGPU): fastest, ~330 MB download'],
  ['wasm', 'Processor (CPU): ~90 MB download, slower'],
];

function floatToWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const RELOAD_HINT = 'PaperVoice isn’t allowed to run the voice model yet. Open vivaldi://extensions and press the reload (↻) button on PaperVoice, then reopen this tab.';

export class KokoroEngine {
  /** onStatus({kind: 'progress'|'ready'|'error', ...}) */
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.worker = null;
    this.inPage = null;     // fallback host when the worker can't run WebAssembly
    this.pending = new Map(); // id -> {resolve, reject, msg}
    this.nextId = 1;
    this.ready = false;
    this.lastLoad = null;
    this.hostGen = 0;
    this.files = new Map(); // download progress per model file
  }

  send(msg) {
    if (this.inPage) { this.inPage(msg); return; }
    if (!this.worker) {
      this.worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.handle(data);
      this.worker.onerror = (e) => {
        this.failAll(new Error(e.message || 'Kokoro worker failed to start.'));
        this.worker = null;
      };
    }
    this.worker.postMessage(msg);
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onStatus?.({ kind: 'error', message: err.message });
  }

  // Some browsers don't apply the extension's WebAssembly permission to
  // workers. If the page itself may run WebAssembly, host the model here.
  async fallbackToPage() {
    if (this.inPage) return;
    const core = await import('./kokoro-core.js');
    if (!core.canCompileWasm()) { this.failAll(new Error(RELOAD_HINT)); return; }
    this.worker?.terminate();
    this.worker = null;
    const host = ++this.hostGen; // ignore a replaced host that is still finishing a download
    this.inPage = core.createKokoroHost((msg) => { if (host === this.hostGen) this.handle(msg); });
    if (this.lastLoad) this.inPage(this.lastLoad);
    for (const p of this.pending.values()) this.inPage(p.msg);
  }

  handle(d) {
    if (d.type === 'progress') {
      this.files.set(d.file, d);
      let loaded = 0, total = 0;
      for (const f of this.files.values()) { loaded += f.loaded; total += f.total; }
      this.onStatus?.({ kind: 'progress', loaded, total });
    } else if (d.type === 'ready') {
      this.ready = true;
      this.onStatus?.({ kind: 'ready', device: d.device, note: d.note });
    } else if (d.type === 'audio') {
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      p?.resolve({ url: URL.createObjectURL(floatToWav(d.pcm, d.rate)), duration: d.pcm.length / d.rate });
    } else if (d.type === 'error') {
      if (d.code === 'csp') {
        if (this.inPage) this.failAll(new Error(RELOAD_HINT));
        else this.fallbackToPage();
        return;
      }
      if (d.id == null) { this.onStatus?.({ kind: 'error', message: d.message }); return; }
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      p?.reject(new Error(d.message));
    }
  }

  /** Start downloading/compiling the model ahead of the first sentence. */
  preload(device) {
    this.lastLoad = { type: 'load', device };
    this.send(this.lastLoad);
  }

  synthesize(text, { voice, device }) {
    const id = this.nextId++;
    const msg = { type: 'synth', id, text, voice, device };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, msg });
      this.send(msg);
    });
  }

  /** Fresh inference session (recovers from a lost GPU device and similar errors). */
  restart(device) {
    this.reset();
    this.preload(device);
  }

  /** Changing the processor needs a fresh inference session. */
  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.inPage = null;
    this.hostGen++;
    this.ready = false;
    this.files.clear();
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
