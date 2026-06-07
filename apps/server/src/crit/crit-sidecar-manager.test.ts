// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect, it as vitestIt } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  build_crit_spawn_spec,
  CritSidecarError,
  CritSidecarManager,
  layer,
} from "./crit-sidecar-manager.ts";

describe("build_crit_spawn_spec", () => {
  vitestIt("binds to loopback and wires agent_cmd env for the wrapper", () => {
    const spec = build_crit_spawn_spec({
      binaryPath: "/opt/crit",
      repoRoot: "/work/repo",
      branch: "feature/x",
      host: "127.0.0.1",
      port: 4321,
      origin: "http://127.0.0.1:4310",
      token: "scoped-token",
      threadId: "thread-1",
      wrapperCommand: "node /app/crit-agent-cli.js",
    });

    expect(spec.command).toBe("/opt/crit");
    expect(spec.args).toContain("127.0.0.1");
    expect(spec.args).toContain("4321");
    expect(spec.args).toContain("/work/repo");
    expect(spec.args).toContain("node /app/crit-agent-cli.js");
    expect(spec.env.GITS_ORIGIN).toBe("http://127.0.0.1:4310");
    expect(spec.env.GITS_TOKEN).toBe("scoped-token");
    expect(spec.env.GITS_THREAD_ID).toBe("thread-1");
    expect(spec.url).toBe("http://127.0.0.1:4321");
  });
});

// A fake "crit" binary: a Node script that starts an HTTP server on the
// `--port` passed in argv and answers 200 to any request. This lets the
// lifecycle test exercise the real spawn + HTTP health-check path without a
// real crit build (pending Task 0b).
function writeFakeCritBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "crit-sidecar-test-"));
  const script = join(dir, "fake-crit.js");
  const source = [
    "#!/usr/bin/env node",
    "const http = require('node:http');",
    "const argv = process.argv;",
    "const portIndex = argv.indexOf('--port');",
    "const port = Number(argv[portIndex + 1]);",
    "http.createServer((_, res) => res.end('ok')).listen(port, '127.0.0.1');",
  ].join("\n");
  writeFileSync(script, `${source}\n`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

// A fake "crit" binary that exits immediately with a non-zero code without ever
// listening — exercises the crash-before-ready path (the exit watcher must win
// the race and surface a CritSidecarError). Passing this test is impossible
// without actually spawning the child.
function writeCrashingCritBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "crit-sidecar-crash-"));
  const script = join(dir, "crash-crit.js");
  const source = ["#!/usr/bin/env node", "process.exit(1);"].join("\n");
  writeFileSync(script, `${source}\n`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

// A fake "crit" binary that stays alive but never listens on the `--port` it was
// given (it binds a DIFFERENT port), so the readiness probe never succeeds and
// the run must fail via the readiness timeout. Only reachable by spawning.
function writeNonListeningCritBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "crit-sidecar-noport-"));
  const script = join(dir, "noport-crit.js");
  const source = [
    "#!/usr/bin/env node",
    "const http = require('node:http');",
    "const argv = process.argv;",
    "const portIndex = argv.indexOf('--port');",
    "const port = Number(argv[portIndex + 1]);",
    // Listen on the wrong port so the probe against `--port` never connects.
    "http.createServer((_, res) => res.end('ok')).listen(port + 1, '127.0.0.1');",
    // Keep the process alive past the readiness window.
    "setTimeout(() => {}, 60000);",
  ].join("\n");
  writeFileSync(script, `${source}\n`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

// The manager layer requires ChildProcessSpawner (from NodeServices) and
// HttpClient (FetchHttpClient). NetService is provided inside `layer` itself.
const CritSidecarTestLayer = layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

// `excludeTestServices` swaps the default TestClock for the real clock so the
// readiness retry/`Effect.sleep`/`Effect.timeout` actually advance (under the
// TestClock they would never fire without manual clock advancement).
it.layer(CritSidecarTestLayer, { excludeTestServices: true })(
  "CritSidecarManager lifecycle",
  (it) => {
    it.effect("spawns the sidecar, health-checks it, reuses it, then tears it down", () =>
      Effect.gen(function* () {
        const manager = yield* CritSidecarManager;
        const fakeBinary = writeFakeCritBinary();
        const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-ws-"));

        const ensureInput = {
          workspaceRoot,
          branch: "main",
          threadId: "th",
          origin: "http://127.0.0.1:1",
          token: "t",
          wrapperCommand: "node /x",
          binaryPath: fakeBinary,
          readinessTimeoutMs: 3000,
        };

        const first = yield* manager.ensure_sidecar(ensureInput);
        expect(first.status).toBe("ready");
        expect(first.url).not.toBeNull();
        expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        // Second ensure for the same workspace reuses the running sidecar.
        const second = yield* manager.ensure_sidecar(ensureInput);
        expect(second.status).toBe("ready");
        expect(second.url).toBe(first.url);

        // Two ensures => refCount 2; release twice to fully tear down.
        yield* manager.release_sidecar(workspaceRoot);
        const afterFirstRelease = yield* manager.sidecar_status(workspaceRoot);
        expect(afterFirstRelease.status).toBe("ready");

        yield* manager.release_sidecar(workspaceRoot);
        const afterSecondRelease = yield* manager.sidecar_status(workspaceRoot);
        expect(afterSecondRelease.status).toBe("stopped");
        expect(afterSecondRelease.url).toBeNull();
      }),
    );

    it.effect("fails with CritSidecarError when the sidecar crashes before becoming ready", () =>
      Effect.gen(function* () {
        const manager = yield* CritSidecarManager;
        const crashingBinary = writeCrashingCritBinary();
        const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-crash-ws-"));

        const exit = yield* Effect.exit(
          manager.ensure_sidecar({
            workspaceRoot,
            branch: "main",
            threadId: "th",
            origin: "http://127.0.0.1:1",
            token: "t",
            wrapperCommand: "node /x",
            binaryPath: crashingBinary,
            readinessTimeoutMs: 3000,
          }),
        );

        // Must fail (not succeed) and flow through the typed CritSidecarError
        // channel — a thrown defect would be a Die and `Cause.squash` would not
        // yield a CritSidecarError, failing this assertion.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(CritSidecarError);
        }

        // Entry must be removed after a crash → status reports stopped/null.
        const status = yield* manager.sidecar_status(workspaceRoot);
        expect(status.status).not.toBe("ready");
        expect(status.status).toBe("stopped");
        expect(status.url).toBeNull();
      }),
    );

    it.effect(
      "fails with CritSidecarError when the sidecar never listens on its port (timeout)",
      () =>
        Effect.gen(function* () {
          const manager = yield* CritSidecarManager;
          const noportBinary = writeNonListeningCritBinary();
          const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-noport-ws-"));

          const exit = yield* Effect.exit(
            manager.ensure_sidecar({
              workspaceRoot,
              branch: "main",
              threadId: "th",
              origin: "http://127.0.0.1:1",
              token: "t",
              wrapperCommand: "node /x",
              binaryPath: noportBinary,
              readinessTimeoutMs: 800,
            }),
          );

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(CritSidecarError);
          }

          // The child must have been torn down — not left "ready".
          const status = yield* manager.sidecar_status(workspaceRoot);
          expect(status.status).not.toBe("ready");
          expect(status.status).toBe("stopped");
          expect(status.url).toBeNull();
        }),
    );
  },
);
