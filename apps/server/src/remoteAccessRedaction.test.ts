// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- security boundary serialization harness.
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { BrowserPreviewManager } from "./browser-preview/browser-preview-manager.ts";
import { aggregateProcessDiagnostics } from "./diagnostics/ProcessDiagnostics.ts";
import { aggregateTraceDiagnostics } from "./diagnostics/TraceDiagnostics.ts";
import { redactSecrets } from "./provider/Layers/EventNdjsonLogger.ts";

const sensitiveMarkers = [
  "cursor_api_key_private_0123456789",
  "ghp_0123456789ABCDEFGHIJ",
  "oauth-code-private-0123456789",
  "state-private-0123456789",
] as const;

function expectSensitiveMarkersAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of sensitiveMarkers) expect(serialized).not.toContain(marker);
}

describe("remote access redaction boundaries", () => {
  it("removes auth data from logs, diagnostics, and browser responses", async () => {
    const [apiKey, githubToken, oauthCode, oauthState] = sensitiveMarkers;
    const callbackUrl = `https://gits.example.test/oauth/callback?code=${oauthCode}&state=${oauthState}`;
    const eventLogPayload = redactSecrets(
      JSON.stringify({ api_key: apiKey, token: githubToken, callbackUrl }),
    );
    const processDiagnostics = aggregateProcessDiagnostics({
      serverPid: 100,
      readAt: DateTime.makeUnsafe("2026-07-17T12:00:00.000Z"),
      rows: [
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 1_024,
          elapsed: "00:01",
          command: `CURSOR_API_KEY=${apiKey} gh auth login --token ${githubToken} ${callbackUrl}`,
        },
      ],
    });
    const traceDiagnostics = aggregateTraceDiagnostics({
      traceFilePath: "/tmp/gits.trace.ndjson",
      readAt: DateTime.makeUnsafe("2026-07-17T12:00:00.000Z"),
      files: [
        {
          path: "/tmp/gits.trace.ndjson",
          text: JSON.stringify({
            name: "provider.auth",
            traceId: "trace-auth",
            spanId: "span-auth",
            startTimeUnixNano: "1000000",
            endTimeUnixNano: "2000000",
            durationMs: 1,
            exit: { _tag: "Failure", cause: `provider rejected CURSOR_API_KEY=${apiKey}` },
            events: [
              {
                name: `callback rejected code=${oauthCode}`,
                timeUnixNano: "2000000",
                attributes: { "effect.logLevel": "Error", token: githubToken },
              },
            ],
          }),
        },
      ],
    });
    const browserManager = new BrowserPreviewManager({
      run: async (_session, command) =>
        command === "view" ? { url: `http://127.0.0.1:9222/?upstream=${apiKey}` } : {},
    });
    const browserResponse = await browserManager.open(ThreadId.make("thread-redaction"));

    expectSensitiveMarkersAbsent({
      eventLogPayload,
      processDiagnostics,
      traceDiagnostics,
      browserResponse,
    });
    await browserManager.stopAll();
  });
});
