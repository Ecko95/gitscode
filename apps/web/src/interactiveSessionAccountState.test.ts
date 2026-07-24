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
    confirmWorkPersonalUsage("environment-a:thread-a");
    confirmWorkPersonalUsage("environment-a:thread-deleted");

    pruneWorkPersonalUsageConfirmations(new Set(["environment-a:thread-a"]));

    expect(useInteractiveSessionAccountState.getState().workPersonalConfirmedByThreadKey).toEqual({
      "environment-a:thread-a": true,
    });
  });
});
