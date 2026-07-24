import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmWorkPersonalUsage,
  pruneWorkPersonalUsageConfirmations,
  useInteractiveSessionAccountState,
} from "./interactiveSessionAccountState";

describe("interactiveSessionAccountState", () => {
  beforeEach(() => {
    useInteractiveSessionAccountState.setState({
      workPersonalConfirmedByThreadKey: {},
    });
  });

  it("keeps confirmation for an existing scoped thread and prunes deleted threads", () => {
    confirmWorkPersonalUsage("environment-a:thread-a", ProviderInstanceId.make("codex-personal"));
    confirmWorkPersonalUsage(
      "environment-a:thread-deleted",
      ProviderInstanceId.make("codex-personal"),
    );

    pruneWorkPersonalUsageConfirmations(new Set(["environment-a:thread-a"]));

    expect(useInteractiveSessionAccountState.getState().workPersonalConfirmedByThreadKey).toEqual({
      "environment-a:thread-a": "codex-personal",
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
});
