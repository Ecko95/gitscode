import type { AutomodePolicy } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  formStateToPolicyUpdate,
  formatGateDecision,
  modelTierOf,
  nextPolicyFormState,
  parseVerificationCommands,
  policyToFormState,
  reposNotAllowed,
  stringifyVerificationCommands,
  verdictTone,
} from "./autopilot.logic";

const BASE_POLICY: AutomodePolicy = {
  mode: "manual",
  killSwitchEnabled: true,
  maxActivePeers: 2,
  allowedRepos: ["/repos/a", "/repos/b"],
  allowedModels: ["gpt-5.6-luna", "custom-model"],
  defaultModel: "gpt-5.6-sol",
  maxBudgetUsd: 50,
  maxRuntimeMinutes: 60,
  requireApprovalForPeerSpawn: true,
  requireApprovalBeforeIntegrate: true,
  requireApprovalBeforeDestructiveAction: true,
  autoEnqueueApprovedProposals: false,
  nightlyProposalSweep: false,
  proposalRepos: [],
  verificationCommands: [{ label: "test", cmd: ["bun", "test"] }],
  integrationBranch: "gits",
  motokoAuthority: "observe",
  telegramDigestEnabled: true,
  sweepRequiresConfirmation: true,
  updatedAt: "2026-07-20T00:00:00.000Z",
};

describe("modelTierOf", () => {
  it("maps known tier slugs", () => {
    expect(modelTierOf("gpt-5.6-luna")).toBe("light");
    expect(modelTierOf("gpt-5.6-terra")).toBe("medium");
    expect(modelTierOf("gpt-5.6-sol")).toBe("high");
  });

  it("returns null for a custom or missing model", () => {
    expect(modelTierOf("custom-model")).toBeNull();
    expect(modelTierOf(null)).toBeNull();
    expect(modelTierOf(undefined)).toBeNull();
  });
});

describe("policyToFormState", () => {
  it("splits allowedModels into recognized tiers and free-text extras", () => {
    const form = policyToFormState(BASE_POLICY);
    expect(form.allowedModelTiers).toEqual(["light"]);
    expect(form.allowedModelsExtra).toBe("custom-model");
  });

  it("marks a tier-matching defaultModel and leaves the custom field empty", () => {
    const form = policyToFormState(BASE_POLICY);
    expect(form.defaultModelTier).toBe("high");
    expect(form.defaultModelCustom).toBe("");
  });

  it("falls back to custom for a non-tier defaultModel", () => {
    const form = policyToFormState({ ...BASE_POLICY, defaultModel: "gpt-5.9-experimental" });
    expect(form.defaultModelTier).toBe("custom");
    expect(form.defaultModelCustom).toBe("gpt-5.9-experimental");
  });

  it("round-trips verificationCommands through JSON text", () => {
    const form = policyToFormState(BASE_POLICY);
    expect(JSON.parse(form.verificationCommandsText)).toEqual(BASE_POLICY.verificationCommands);
  });
});

describe("nextPolicyFormState", () => {
  it("reseeds from the incoming policy when the form is pristine", () => {
    const stale = policyToFormState({ ...BASE_POLICY, maxActivePeers: 1 });
    const next = nextPolicyFormState(stale, BASE_POLICY, false);
    expect(next.maxActivePeers).toBe("2");
  });

  it("ignores the incoming policy while the form is dirty (the clobber-bug fix)", () => {
    const edited = { ...policyToFormState(BASE_POLICY), maxActivePeers: "9" };
    const next = nextPolicyFormState(edited, BASE_POLICY, true);
    expect(next).toBe(edited);
    expect(next.maxActivePeers).toBe("9");
  });
});

describe("formStateToPolicyUpdate", () => {
  it("builds a full update input from a valid form", () => {
    const form = policyToFormState(BASE_POLICY);
    const result = formStateToPolicyUpdate(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.maxActivePeers).toBe(2);
    expect(result.input.defaultModel).toBe("gpt-5.6-sol");
    expect(result.input.allowedModels).toEqual(["gpt-5.6-luna", "custom-model"]);
    expect(result.input.verificationCommands).toEqual(BASE_POLICY.verificationCommands);
  });

  it("rejects invalid JSON in the verification commands field", () => {
    const form = { ...policyToFormState(BASE_POLICY), verificationCommandsText: "{not json" };
    const result = formStateToPolicyUpdate(form);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric budget", () => {
    const form = { ...policyToFormState(BASE_POLICY), maxBudgetUsd: "lots" };
    const result = formStateToPolicyUpdate(form);
    expect(result.ok).toBe(false);
  });

  it("treats an empty budget as uncapped (null)", () => {
    const form = { ...policyToFormState(BASE_POLICY), maxBudgetUsd: "" };
    const result = formStateToPolicyUpdate(form);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.maxBudgetUsd).toBeNull();
  });
});

describe("parseVerificationCommands / stringifyVerificationCommands", () => {
  it("round-trips a command list", () => {
    const text = stringifyVerificationCommands(BASE_POLICY.verificationCommands);
    const parsed = parseVerificationCommands(text);
    expect(parsed).toEqual({ ok: true, commands: BASE_POLICY.verificationCommands });
  });

  it("accepts empty text as an empty list", () => {
    expect(parseVerificationCommands("  ")).toEqual({ ok: true, commands: [] });
  });

  it("rejects a command missing cmd", () => {
    const result = parseVerificationCommands(JSON.stringify([{ label: "x" }]));
    expect(result.ok).toBe(false);
  });
});

describe("reposNotAllowed", () => {
  it("flags repos outside the allowlist", () => {
    expect(reposNotAllowed(["/repos/a", "/repos/c"], ["/repos/a", "/repos/b"])).toEqual([
      "/repos/c",
    ]);
  });

  it("allows exact matches and path-prefixed matches", () => {
    expect(reposNotAllowed(["/repos/a", "/repos/b/sub"], ["/repos/a", "/repos/b"])).toEqual([]);
  });

  it("flags nothing when allowedRepos is empty (server treats empty as allow-all)", () => {
    expect(reposNotAllowed(["/repos/a", "/repos/c"], [])).toEqual([]);
  });
});

describe("verdictTone", () => {
  it("maps verifier verdicts to status tones", () => {
    expect(verdictTone("pass")).toBe("success");
    expect(verdictTone("fail")).toBe("danger");
    expect(verdictTone("uncertain")).toBe("warning");
  });
});

describe("formatGateDecision", () => {
  it("returns null when there is no decision yet", () => {
    expect(formatGateDecision(null)).toBeNull();
  });

  it("formats an allowed decision without a reason", () => {
    expect(
      formatGateDecision({ at: "2026-07-20T00:00:00.000Z", allowed: true, reason: null }),
    ).toBe("allowed");
  });

  it("formats a denied decision with its reason", () => {
    expect(
      formatGateDecision({
        at: "2026-07-20T00:00:00.000Z",
        allowed: false,
        reason: "outside night slot",
      }),
    ).toBe("denied — outside night slot");
  });
});
