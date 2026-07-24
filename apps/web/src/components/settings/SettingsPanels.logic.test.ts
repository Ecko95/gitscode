import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRepositoryProfileMappingPatch,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  parseWorkRoots,
} from "./SettingsPanels.logic";

describe("parseWorkRoots", () => {
  it("trims, drops empty lines, and keeps the first occurrence of each root", () => {
    expect(parseWorkRoots(" /srv/work \n\n/srv/personal\n/srv/work\n /srv/personal ")).toEqual([
      "/srv/work",
      "/srv/personal",
    ]);
  });
});

describe("buildRepositoryProfileMappingPatch", () => {
  it("updates one driver without dropping either profile's other mappings", () => {
    const codex = ProviderDriverKind.make("codex");
    const cursor = ProviderDriverKind.make("cursor");
    const claude = ProviderDriverKind.make("claudeAgent");
    const patch = buildRepositoryProfileMappingPatch({
      repositoryProfiles: {
        workRoots: ["/srv/work"],
        providerInstances: {
          personal: {
            [codex]: ProviderInstanceId.make("codex_personal"),
            [claude]: ProviderInstanceId.make("claude_personal"),
          },
          work: {
            [codex]: ProviderInstanceId.make("codex_work"),
            [cursor]: ProviderInstanceId.make("cursor_work"),
          },
        },
      },
      profile: "work",
      driver: codex,
      instanceId: ProviderInstanceId.make("codex_bts"),
    });

    expect(patch.repositoryProfiles).toEqual({
      workRoots: ["/srv/work"],
      providerInstances: {
        personal: {
          codex: "codex_personal",
          claudeAgent: "claude_personal",
        },
        work: {
          codex: "codex_bts",
          cursor: "cursor_work",
        },
      },
    });
  });

  it("clears one mapping without dropping the remaining mappings", () => {
    const codex = ProviderDriverKind.make("codex");
    const cursor = ProviderDriverKind.make("cursor");
    const patch = buildRepositoryProfileMappingPatch({
      repositoryProfiles: {
        workRoots: [],
        providerInstances: {
          personal: {},
          work: {
            [codex]: ProviderInstanceId.make("codex_work"),
            [cursor]: ProviderInstanceId.make("cursor_work"),
          },
        },
      },
      profile: "work",
      driver: codex,
    });

    expect(patch.repositoryProfiles?.providerInstances?.work).toEqual({
      cursor: "cursor_work",
    });
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
