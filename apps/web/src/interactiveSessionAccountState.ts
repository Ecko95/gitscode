import { create } from "zustand";

interface InteractiveSessionAccountState {
  readonly workPersonalConfirmedByThreadKey: Readonly<Record<string, true>>;
}

export const useInteractiveSessionAccountState = create<InteractiveSessionAccountState>(() => ({
  workPersonalConfirmedByThreadKey: {},
}));

export function confirmWorkPersonalUsage(threadKey: string): void {
  useInteractiveSessionAccountState.setState((state) => {
    if (state.workPersonalConfirmedByThreadKey[threadKey]) return state;
    return {
      workPersonalConfirmedByThreadKey: {
        ...state.workPersonalConfirmedByThreadKey,
        [threadKey]: true,
      },
    };
  });
}

export function pruneWorkPersonalUsageConfirmations(existingThreadKeys: ReadonlySet<string>): void {
  useInteractiveSessionAccountState.setState((state) => {
    const entries = Object.entries(state.workPersonalConfirmedByThreadKey);
    const retainedEntries = entries.filter(([threadKey]) => existingThreadKeys.has(threadKey));
    if (retainedEntries.length === entries.length) return state;
    return {
      workPersonalConfirmedByThreadKey: Object.fromEntries(retainedEntries),
    };
  });
}
