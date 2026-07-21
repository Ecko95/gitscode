/** Pure Motoko chat panel logic: scroll-position heuristics, transcript windowing,
 *  and restore-on-error bookkeeping. No DOM, no React. */

export const MOTOKO_TRANSCRIPT_RENDER_LIMIT = 80;

/** True when the scrollable region is within `thresholdPx` of its bottom edge. */
export function isNearBottom(
  metrics: {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  },
  thresholdPx = 120,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** Caps how many transcript entries render at once; the rest are summarized by a banner. */
export function visibleTranscriptWindow<T>(
  transcript: ReadonlyArray<T>,
  limit: number = MOTOKO_TRANSCRIPT_RENDER_LIMIT,
): { readonly hiddenCount: number; readonly visible: ReadonlyArray<T> } {
  const hiddenCount = Math.max(0, transcript.length - limit);
  return { hiddenCount, visible: transcript.slice(-limit) };
}

export interface RestorableTranscriptEntry {
  readonly id: string;
  readonly role: "operator" | "motoko";
  // Success replies always carry `result`; the chat-failure entry never does
  // (see hermesChatMutation.onError in GitsCockpit.tsx), which is what lets
  // this stay a pure structural check instead of depending on mutation state.
  readonly result?: unknown;
}

/**
 * After an optimistically-cleared chat send settles, decide whether to offer
 * "Restore message" on the transcript entry the failure produced.
 *
 * Relies on the caller only ever having one chat send in flight at a time
 * (the panel disables Send while pending) so the last transcript entry is
 * unambiguously the one this send produced.
 */
export function computeRestorableAfterSend(params: {
  readonly transcript: ReadonlyArray<RestorableTranscriptEntry>;
  readonly inFlightMessage: string | null;
}): { readonly entryId: string; readonly message: string } | null {
  const { transcript, inFlightMessage } = params;
  if (inFlightMessage === null) {
    return null;
  }
  const last = transcript[transcript.length - 1];
  if (!last || last.role !== "motoko" || last.result !== undefined) {
    return null;
  }
  return { entryId: last.id, message: inFlightMessage };
}
