import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmWorkPersonalUsage,
  useInteractiveSessionAccountState,
} from "./interactiveSessionAccountState";

describe("interactiveSessionAccountState", () => {
  beforeEach(() => {
    useInteractiveSessionAccountState.setState({
      workPersonalConfirmedByThreadKey: {},
    });
  });

  it("tracks the provider instance confirmed for a scoped thread", () => {
    confirmWorkPersonalUsage("environment-a:thread-a", ProviderInstanceId.make("codex-personal"));
    confirmWorkPersonalUsage("environment-a:thread-a", ProviderInstanceId.make("codex-work"));

    expect(
      useInteractiveSessionAccountState.getState().workPersonalConfirmedByThreadKey[
        "environment-a:thread-a"
      ],
    ).toBe("codex-work");
  });

  it("keeps pre-launch acknowledgement ephemeral", () => {
    expect("persist" in useInteractiveSessionAccountState).toBe(false);
  });
});
