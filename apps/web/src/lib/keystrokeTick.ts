import { shouldEmitTick } from "../components/chat/chatMascot.logic";

// Subtle synthesized keystroke tick — a short filtered noise burst, in sync with
// the pixel-ghost's typing loop. Ported from the GITS Chat design canvas. No audio
// asset: the click is generated with Web Audio so there is nothing to bundle.

let audioContext: AudioContext | null = null;
let lastTickMs = 0;

/**
 * Play one soft mechanical tick. No-ops when disabled, when the tab is hidden, or
 * when throttled by a recent tick. Safe to call on every keystroke.
 */
export function playKeystrokeTick(enabled: boolean): void {
  if (!enabled) return;
  if (typeof window === "undefined") return;
  if (typeof document !== "undefined" && document.hidden) return;

  const now = Date.now();
  if (!shouldEmitTick(lastTickMs, now)) return;
  lastTickMs = now;

  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioContext) audioContext = new Ctor();
    const ac = audioContext;
    if (ac.state === "suspended") void ac.resume();

    const t = ac.currentTime;
    const dur = 0.03;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      const env = Math.pow(1 - i / channel.length, 3); // fast decay
      channel[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ac.createBufferSource();
    source.buffer = buffer;
    const bandpass = ac.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 1400 + Math.random() * 900; // pitch variation per key
    bandpass.Q.value = 0.8;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.05, t); // subtle
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    source.connect(bandpass).connect(gain).connect(ac.destination);
    source.start(t);
    source.stop(t + dur);
  } catch {
    // Audio is best-effort; never let it break typing.
  }
}
