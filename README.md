# PaperVoice — PDF read-aloud for Vivaldi

Reads research papers out loud like an audio player, in the order a person would read them:
down the left column, then the right, with titles, abstracts and wide figures handled correctly.

## Install (Vivaldi, also works in Chrome / Edge / Brave)

1. Download `papervoice-vX.Y.Z.zip` from the [latest release](https://github.com/AIsmail17/papervoice/releases/latest)
2. Unzip it to a folder you'll keep (the browser loads it from there, so don't delete it)
3. Go to `vivaldi://extensions` (or `chrome://extensions`) and turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the unzipped folder, the one that contains `manifest.json`
5. Optional: open the extension's **Details** and turn on **Allow access to file URLs** so it can read PDFs you open from your disk

**To update:** download the new release, unzip it over the same folder, then press the reload (↻)
button on PaperVoice in `vivaldi://extensions`. Your settings and reading positions are kept.

## Use

- On any PDF tab, click the PaperVoice toolbar button (or press **Alt+Shift+R**)
- Or right-click a PDF link and choose **Read PDF aloud with PaperVoice**
- Or open the reader and drag a PDF onto it
- Turn on **Open every PDF in PaperVoice automatically** in Settings if you want that. Add `#noreader` to a URL to skip it once.

| Action | How |
| --- | --- |
| Play / pause | Space or the yellow button |
| Previous / next sentence | ← / → |
| Previous / next paragraph | Shift + ← / → |
| Speed (0.5× to 3×) | − / = keys, the ± buttons, or click the speed label for presets |
| Read from a paragraph | Click it |
| Read only some paragraphs | Ctrl+Click each one, or Shift+Click for a range, then Play |
| Read only some sections | Open **Sections** (☰) and tick them |
| Clear selection | Esc |

It remembers where you stopped in each paper, plus your speed and voice.

## What it skips (each can be changed in Settings)

Page headers, footers and numbers, equations, tables and figure labels, the reference list,
author names and affiliations, footnotes, and inline citations like `[12]` or `(Smith et al., 2020)`.
Common abbreviations are read in full: "e.g." is read as "for example" and "Fig. 3" as "Figure 3".

## Voices

Choose the engine under Settings (⚙) → **Voice engine**.

**Kokoro natural voices (default: free, unlimited, private).** Kokoro is an open-source voice
model that runs on your own computer.

- The first time you use it, it downloads the model from Hugging Face once and the browser caches it.
  On the graphics card (WebGPU) it's about 330 MB and fast. On the processor it's about 90 MB and slower.
  **Run on → Auto** picks the graphics card when one is available.
- After that it works offline, and your papers never leave your computer.
- The best voices are **Heart** and **Bella** (US) and **Emma** (UK).
- It generates the next two paragraphs while the current one plays, so there are no gaps.
- It never switches voices mid-paper. If a passage fails, it retries (restarting the model once),
  skips that passage only if it still fails, and pauses with a message if failures repeat.

**Gemini natural voices.** These are Google's Gemini text-to-speech voices, the
same family NotebookLM uses.

1. Get an API key at https://aistudio.google.com/apikey
2. In PaperVoice, open Settings (⚙), set **Voice engine** to *Gemini natural voices*, and paste the key
3. Pick a voice (Sulafat is warm, Charon informative, Achird friendly; there are 30) and press **Test voice**

Notes:

- It reads a paragraph per request, so the delivery sounds natural, and it fetches the next two
  paragraphs ahead of time so there's no gap between them.
- **Speaking style** tells the voice how to read, for example "slow and calm" or
  "enthusiastic podcast host".
- The speed control speeds up the audio without changing the pitch.
- If Gemini fails (bad key, quota used up, offline), the reader pauses and says why. It doesn't switch
  to another voice.
- The key is stored only in this browser (`chrome.storage.local`) and only sent to Google.
  Usage counts against your Gemini API quota or billing.
- The highlighted word is an estimate, since Gemini doesn't report word timings. The sentence
  highlight is accurate.

**Built-in system voices** are free and work offline. On Windows you can add more under
**Settings → Time & language → Speech → Add voices**, then restart Vivaldi.

## How the column detection works

`layout.js` groups the text runs from pdf.js into lines and never joins two runs across a gap wider
than about one character height, so a line never runs across the gutter between columns. It then
runs a recursive XY-cut: it splits the page at the widest empty vertical strip (a column gutter) or
the widest empty horizontal band. It prefers to cut next to content that spans both columns (title,
abstract, wide figures), so the columns aren't sliced into interleaved strips. The results are
grouped into paragraphs using indentation, spacing and font size.

Scanned PDFs that are just images have no text layer, so they can't be read. That would need OCR.

## Files

- `manifest.json`, `background.js`: toolbar button, right-click menus, auto-open
- `viewer.html`, `viewer.css`, `viewer.js`: the reader and player UI
- `layout.js`: reading order and paragraph detection
- `text.js`: sentence splitting and the text sent to the voice
- `speech.js`: the built-in speech engine wrapper
- `gemini.js`: Gemini text-to-speech client and audio cache
- `kokoro.js`, `kokoro-worker.js`, `kokoro-core.js`: the Kokoro voice, run in a background worker
- `lib/`: pdf.js 4.10.38 (Mozilla, Apache-2.0)
- `lib/kokoro/`: kokoro-js 1.2.1 with the ONNX Runtime WebAssembly build

## Privacy

PaperVoice collects nothing and has no server. PDFs are read and laid out on your computer.

- **Kokoro:** the voice model is downloaded once from Hugging Face. After that, reading happens
  entirely on your computer.
- **Gemini:** only if you choose it, the text being read is sent to Google with your own API key.
- **Built-in voices:** reading uses your operating system's voices.

Settings, your Gemini key and reading positions are stored in your browser only.

## License

PaperVoice's own code is under the [MIT License](LICENSE). The bundled libraries keep their own
licenses, including eSpeak NG (GPL-3.0) inside the Kokoro voice. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
