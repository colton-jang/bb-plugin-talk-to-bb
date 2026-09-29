// Created: 2026-09-27. A soft "still working" sound played on the device, never by the voice model.
//
// A user asked for a subtle cue ("like a bubbling sound") during silent backend work. GPT-Live is
// a speech model and has no documented way to make non-speech sounds, so the panel synthesizes
// it: short, quiet, slightly varied bubbles with a gentle upward glide, one every ~0.65 s. It is
// deliberately low (peak gain 0.03) and pitched away from the speech band's centre so echo
// cancellation and the voice model's turn detection are unlikely to treat it as the user. The
// server decides WHEN (cues.mjs onEarcon); this file only makes the sound. Browser-safe: no
// Node imports.
// GPT-Live streams silence continuously; only audible audio means the manager is speaking.
// Same rule and threshold as cues.mjs isAudible (kept separate: this file must stay browser-only).
export function isAudible(buffer, peak = 256) {
  const s = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  for (let i = 0; i < s.length; i++) if (s[i] > peak || s[i] < -peak) return true;
  return false;
}

export const EARCON = Object.freeze({ intervalMs: 650, peakGain: 0.03, lengthMs: 120, lowHz: 420, highHz: 560, glideHz: 140 });

export class Earcon {
  /** @param {AudioContext|null|undefined} context @param {{random?:()=>number}} [options] */
  constructor(context, { random = Math.random } = {}) { this.context = context; this.random = random; this.timer = null; }
  get playing() { return this.timer !== null; }
  start() {
    if (this.timer !== null || !this.context || typeof this.context.createOscillator !== 'function') return false;
    this.bubble();
    this.timer = setInterval(() => this.bubble(), EARCON.intervalMs);
    return true;
  }
  stop() { if (this.timer !== null) { clearInterval(this.timer); this.timer = null; } }
  bubble() {
    const ctx = this.context;
    if (!ctx || ctx.state === 'closed') { this.stop(); return; }
    try {
      const t = ctx.currentTime ?? 0, len = EARCON.lengthMs / 1000;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const f = EARCON.lowHz + this.random() * (EARCON.highHz - EARCON.lowHz);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f + EARCON.glideHz, t + len * 0.6);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(EARCON.peakGain, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + len + 0.02);
    } catch { this.stop(); }
  }
}
