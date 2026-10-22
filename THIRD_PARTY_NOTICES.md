# Third-party software

PaperVoice's own code is MIT-licensed (see `LICENSE`). It ships these unmodified third-party
files, which keep their own licenses. The full license texts are in `licenses/`.

| Component | Files | License | Source |
| --- | --- | --- | --- |
| pdf.js 4.10.38 (Mozilla) | `lib/pdf.min.js`, `lib/pdf.worker.min.js` | Apache-2.0: `licenses/pdfjs-LICENSE.txt` | https://github.com/mozilla/pdf.js |
| kokoro-js 1.2.1 (hexgrad, Xenova) | `lib/kokoro/kokoro.web.js` | Apache-2.0: `licenses/kokoro-js-LICENSE.txt` | https://github.com/hexgrad/kokoro |
| Transformers.js 3.5.1 (Hugging Face), bundled inside `kokoro.web.js` | | Apache-2.0: `licenses/Apache-2.0.txt` | https://github.com/huggingface/transformers.js |
| phonemizer.js 1.2.1 (Xenova), bundled inside `kokoro.web.js` | | Apache-2.0: `licenses/Apache-2.0.txt` | https://github.com/xenova/phonemizer.js |
| eSpeak NG, compiled into phonemizer.js | | GPL-3.0-or-later: `licenses/GPL-3.0.txt` | https://github.com/espeak-ng/espeak-ng |
| ONNX Runtime Web (Microsoft) | `lib/kokoro/ort-wasm-simd-threaded.jsep.mjs`, `.wasm` | MIT: `licenses/onnxruntime-MIT.txt` | https://github.com/microsoft/onnxruntime |

## eSpeak NG (GPL-3.0)

The Kokoro voice uses eSpeak NG to turn text into pronunciations. eSpeak NG is licensed under the
GNU General Public License v3.0 or later. Its complete source code is available at
https://github.com/espeak-ng/espeak-ng, and the WebAssembly build used here comes from
https://github.com/xenova/phonemizer.js. If you redistribute PaperVoice with the Kokoro voice
included, the GPL's terms apply to that component.

## Downloaded at runtime (not included in this repository)

- **Kokoro-82M voice model** (`onnx-community/Kokoro-82M-v1.0-ONNX` on Hugging Face), Apache-2.0.
  It is downloaded the first time you use the Kokoro voice, then cached by your browser.
