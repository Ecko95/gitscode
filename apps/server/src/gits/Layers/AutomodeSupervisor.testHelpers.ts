import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const codexDriver = ProviderDriverKind.make("codex");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexInstance = {
  instanceId: codexInstanceId,
  driverKind: codexDriver,
  continuationIdentity: {
    driverKind: codexDriver,
    continuationKey: "codex:instance:codex",
  },
  displayName: "Codex",
  enabled: true,
  workerEnvironment: { CODEX_HOME: "/tmp/codex" },
  snapshot: {} as ProviderInstance["snapshot"],
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

export const AutomodeSupervisorTestRoutingLayer = Layer.merge(
  ServerSettingsService.layerTest({
    repositoryProfiles: {
      workRoots: [],
      providerInstances: {
        personal: { [codexDriver]: codexInstanceId },
        work: {},
      },
    },
  }),
  Layer.mock(ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === codexInstanceId ? codexInstance : undefined),
  }),
);
