// Kokoro model host, shared by the background worker (normal case) and the
// page itself (fallback when the worker isn't allowed to run WebAssembly).
// The model weights (~90 MB for CPU, ~330 MB for GPU) download from Hugging Face
// once and are then cached by the browser. All code runs locally from lib/.

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** True when this context's Content Security Policy allows compiling WebAssembly. */
export function canCompileWasm() {
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

async function hasWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

/** Returns a message handler; `post(message, transfer)` sends replies. */
export function createKokoroHost(post) {
  let lib = null;
  let tts = null;
  let loadedFor = null;
  let queue = Promise.resolve();

  async function ensureModel(device) {
    if (!canCompileWasm()) {
      const err = new Error('WebAssembly is blocked by the extension’s security policy.');
      err.code = 'csp';
      throw err;
    }
    if (!lib) {
      lib = await import('./lib/kokoro/kokoro.web.js');
      // Extensions may not load code from a CDN, so point ONNX Runtime at our own copy.
      lib.env.wasmPaths = new URL('./lib/kokoro/', import.meta.url).href;
    }
    const wantGpu = device === 'webgpu' || (device === 'auto' && (await hasWebGPU()));
    const target = wantGpu ? 'webgpu' : 'wasm';
    if (tts && loadedFor === target) return;
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) post({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    };
    try {
      tts = await lib.KokoroTTS.from_pretrained(MODEL, {
        dtype: target === 'webgpu' ? 'fp32' : 'q8', device: target, progress_callback,
      });
      loadedFor = target;
      post({ type: 'ready', device: target });
    } catch (err) {
      if (target !== 'webgpu') throw err;
      // GPU unavailable or failed: fall back to the CPU build.
      tts = await lib.KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback });
      loadedFor = 'wasm';
      post({ type: 'ready', device: 'wasm', note: `GPU failed (${err.message}), using CPU.` });
    }
  }

  const fail = (id, err) => post({ type: 'error', id, message: err?.message || String(err), code: err?.code });

  return (data) => {
    // Serialise requests: one inference session, one job at a time.
    queue = queue.then(async () => {
      if (data.type === 'load') {
        try { await ensureModel(data.device); } catch (err) { fail(null, err); }
        return;
      }
      if (data.type !== 'synth') return;
      try {
        await ensureModel(data.device);
        const audio = await tts.generate(data.text, { voice: data.voice });
        const pcm = audio.audio;
        post({ type: 'audio', id: data.id, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
      } catch (err) {
        fail(data.id, err);
      }
    });
  };
}
