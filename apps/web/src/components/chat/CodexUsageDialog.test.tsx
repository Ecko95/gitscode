import { describe, expect, it } from "vitest";

import { formatCodexResetExpiry } from "./CodexUsageDialog";

describe("CodexUsageDialog", () => {
  it("formats known and unavailable reset expiries", () => {
    expect(formatCodexResetExpiry("2026-07-18T02:38:00.000Z")).toContain("Expires");
    expect(formatCodexResetExpiry(null)).toBe("Expiry unavailable");
  });
});
