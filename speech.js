// Thin, robust wrapper around the Web Speech API.
// Chromium quirks handled here: utterances being garbage-collected mid-speech
// (onend never fires), cancel() racing the next speak(), and voices loading late.

export class Narrator {
  constructor() {
    this.synth = window.speechSynthesis;
    this.current = null; // strong ref keeps the utterance alive
  }

  get available() {
    return !!this.synth;
  }

  /** Resolves with the voice list once the browser has loaded it. */
  voices() {
    if (!this.synth) return Promise.resolve([]);
    const now = this.synth.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => resolve(this.synth.getVoices());
      this.synth.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 2000);
    });
  }

  /**
   * Speak `text`. Resolves 'end' | 'cancel' | 'error'.
   * onBoundary(charIndex, charLength) fires per word for voices that support it.
   */
  speak(text, { voice, rate = 1, pitch = 1, volume = 1 } = {}, onBoundary) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;

      let finished = false;
      const finish = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (this.current === u) this.current = null;
        resolve(r);
      };
      u.onend = () => finish('end');
      u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? 'cancel' : 'error');
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        onBoundary?.(e.charIndex, e.charLength || 0);
      };
      // Some voices never fire onend; don't let the player hang forever.
      const expectedMs = (text.length / (14 * rate)) * 1000;
      const watchdog = setTimeout(() => finish('end'), expectedMs * 2.5 + 5000);

      this.current = u;
      this.synth.speak(u);
      if (this.synth.paused) this.synth.resume();
    });
  }

  stop() {
    this.current = null;
    this.synth?.cancel();
  }
}

/** Rank voices so the clearest English ones come first. */
export function rankVoices(voices) {
  const score = (v) => {
    let s = 0;
    if (/natural|neural|online|premium|enhanced/i.test(v.name)) s += 4;
    if (/google/i.test(v.name)) s += 2;
    if (/^en[-_](US|GB)/i.test(v.lang)) s += 3;
    else if (/^en/i.test(v.lang)) s += 2;
    if (v.default) s += 1;
    return s;
  };
  return [...voices].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
