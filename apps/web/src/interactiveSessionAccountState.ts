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
