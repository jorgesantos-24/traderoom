import type { Direction } from '@traderoom/shared';

let ctx: AudioContext | null = null;

/**
 * Creates/resumes the AudioContext. Browsers only allow audio that starts from a
 * user gesture, so this runs on the first click/key anywhere on the page and
 * again inside the order click handler.
 */
export function unlockSound(): void {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

if (typeof window !== 'undefined') {
  const once = () => {
    unlockSound();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}

interface Note {
  freq: number;
  at: number; // seconds after start
  dur: number;
  vol: number;
  type?: OscillatorType;
}

const MUTE_KEY = 'traderoom.muted';
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

export function isSoundMuted(): boolean {
  return muted;
}

/** Footer speaker button: turns every sound off or back on; remembered in this browser. */
export function setSoundMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // Private mode: only for this visit.
  }
}

function play(notes: readonly Note[]): void {
  if (!ctx || muted) return;
  try {
    const c = ctx;
    const start = c.currentTime + 0.01;
    for (const n of notes) {
      const t = start + n.at;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.setValueAtTime(n.freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(n.vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    }
  } catch {
    // Sound is a nicety; never let it break the UI.
  }
}

/** Short two-note blip: rising for call (Compra), falling for put (Venda). */
export function playOrderSound(direction: Direction): void {
  const [a, b] = direction === 'call' ? [660, 880] : [880, 660];
  play([
    { freq: a, at: 0, dur: 0.12, vol: 0.18 },
    { freq: b, at: 0.08, dur: 0.12, vol: 0.18 },
  ]);
}

/** Win: bright rising arpeggio (C–E–G–C) with a shimmer on top. */
export function playWinSound(): void {
  const arp = [523.25, 659.25, 783.99, 1046.5];
  play([
    ...arp.map((freq, i) => ({ freq, at: i * 0.07, dur: 0.18, vol: 0.2, type: 'triangle' as const })),
    { freq: 1046.5, at: 0.28, dur: 0.5, vol: 0.16, type: 'triangle' },
    { freq: 1568, at: 0.3, dur: 0.45, vol: 0.06 },
    { freq: 2093, at: 0.36, dur: 0.35, vol: 0.04 },
  ]);
}

/** Loss: soft, low two-note fall — clear but not harsh. */
export function playLossSound(): void {
  play([
    { freq: 392, at: 0, dur: 0.2, vol: 0.14 },
    { freq: 311.13, at: 0.16, dur: 0.35, vol: 0.12 },
  ]);
}
