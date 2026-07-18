// Pure timing predicates shared by the pixel-ghost mascot and the keystroke tick.
// The mascot animates while the user is actively typing and pauses when idle;
// the keystroke tick is throttled so fast typing does not machine-gun the audio.

export const MASCOT_TYPING_WINDOW_MS = 900;
export const KEYSTROKE_TICK_THROTTLE_MS = 45;

/** True while the last keystroke is recent enough that the ghost should keep playing. */
export function isMascotTyping(lastTypeMs: number, nowMs: number): boolean {
  return lastTypeMs > 0 && nowMs - lastTypeMs < MASCOT_TYPING_WINDOW_MS;
}

/** True when enough time has passed since the last tick to emit another one. */
export function shouldEmitTick(lastTickMs: number, nowMs: number): boolean {
  return nowMs - lastTickMs >= KEYSTROKE_TICK_THROTTLE_MS;
}
