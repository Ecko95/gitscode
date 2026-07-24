import type { ProviderInstanceId } from "@t3tools/contracts";
import { create } from "zustand";

interface InteractiveSessionAccountState {
  readonly workPersonalConfirmedByThreadKey: Readonly<Record<string, ProviderInstanceId>>;
}

export const useInteractiveSessionAccountState = create<InteractiveSessionAccountState>(() => ({
  workPersonalConfirmedByThreadKey: {},
}));

export function confirmWorkPersonalUsage(threadKey: string, instanceId: ProviderInstanceId): void {
  useInteractiveSessionAccountState.setState((state) => {
    if (state.workPersonalConfirmedByThreadKey[threadKey] === instanceId) return state;
    return {
      workPersonalConfirmedByThreadKey: {
        ...state.workPersonalConfirmedByThreadKey,
        [threadKey]: instanceId,
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
