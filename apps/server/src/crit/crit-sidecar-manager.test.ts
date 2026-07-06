// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect, it as vitestIt } from "vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import type { AuthSessionId } from "@t3tools/contracts";

import {
  AuthControlPlane,
  type AuthControlPlaneShape,
  type IssuedBearerSession,
} from "../auth/Services/AuthControlPlane.ts";

import {
  build_crit_spawn_spec,
  CritSidecarError,
  CritSidecarManager,
  layer,
} from "./crit-sidecar-manager.ts";

// A minimal AuthControlPlane stub used to make session lifecycle load-bearing in
// the lifecycle tests: it mints a deterministic IssuedBearerSession on every
// `issueSession` and records each revoked sessionId into a shared array so the
// tests can assert the sidecar manager revokes its token on teardown.
function makeStubAuthControlPlane() {
  let issueCount = 0;
  const issuedSessionIds: AuthSessionId[] = [];
  const revokedSessionIds: AuthSessionId[] = [];

  const stub: AuthControlPlaneShape = {
    createPairingLink: () => Effect.die("createPairingLink not implemented in stub"),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    issueSession: () =>
      Effect.gen(function* () {
        issueCount += 1;
        const sessionId = `crit-stub-session-${issueCount}` as AuthSessionId;
        issuedSessionIds.push(sessionId);
        const now = yield* DateTime.now;
        const issued: IssuedBearerSession = {
          sessionId,
          token: `tkn-${issueCount}`,
          method: "bearer-session-token",
          role: "owner",
          subject: "crit-stub",
          client: { deviceType: "unknown" },
          expiresAt: now,
        };
        return issued;
      }),
    listSessions: () => Effect.succeed([]),
    revokeSession: (sessionId) =>
      Effect.sync(() => {
        revokedSessionIds.push(sessionId);
        return true;
      }),
    revokeOtherSessionsExcept: () => Effect.succeed(0),
  };

  return {
    layer: Layer.succeed(AuthControlPlane, stub),
    issuedSessionIds,
    revokedSessionIds,
  };
}

describe("build_crit_spawn_spec", () => {
  vitestIt("uses crit's headless flags, repo cwd, and an isolated HOME", () => {
    const spec = build_crit_spawn_spec({
      binaryPath: "/opt/crit",
      repoRoot: "/work/repo",
      host: "127.0.0.1",
      port: 4321,
      origin: "http://127.0.0.1:4310",
      token: "scoped-token",
      threadId: "thread-1",
      critHome: "/tmp/gits-crit-abc",
    });

    expect(spec.command).toBe("/opt/crit");
    // Corrected crit v0.16 CLI: headless bind, no browser, quiet. The repo is
    // selected via cwd (no --repo flag) and agent_cmd via the isolated-HOME config.
    expect(spec.args).toEqual(["--host", "127.0.0.1", "--port", "4321", "--no-open", "--quiet"]);
    expect(spec.args).not.toContain("--repo");
    expect(spec.args).not.toContain("--branch");
    expect(spec.args).not.toContain("--agent-cmd");
    expect(spec.cwd).toBe("/work/repo");
    expect(spec.env.HOME).toBe("/tmp/gits-crit-abc");
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

// One shared stub for the whole lifecycle suite: `it.layer` builds the manager
// once and the manager yields AuthControlPlane at construction, so a single stub
// instance backs every test. The recorded `issuedSessionIds`/`revokedSessionIds`
// accumulate across the suite, so each test reads the arrays' length up-front and
// asserts on the newly appended entries.
const stubAuth = makeStubAuthControlPlane();

// The manager layer requires ChildProcessSpawner (from NodeServices), HttpClient
// (FetchHttpClient), and now AuthControlPlane (the stub above). NetService is
// provided inside `layer` itself.
const CritSidecarTestLayer = layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(stubAuth.layer),
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

        const issuedBefore = stubAuth.issuedSessionIds.length;
        const revokedBefore = stubAuth.revokedSessionIds.length;

        const ensureInput = {
          workspaceRoot,
          branch: "main",
          threadId: "th",
          origin: "http://127.0.0.1:1",
          wrapperCommand: "node /x",
          binaryPath: fakeBinary,
          readinessTimeoutMs: 3000,
        };

        const first = yield* manager.ensure_sidecar(ensureInput);
        expect(first.status).toBe("ready");
        expect(first.url).not.toBeNull();
        expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        // The spawn path mints exactly one owner-scoped session token.
        expect(stubAuth.issuedSessionIds.length).toBe(issuedBefore + 1);
        const sessionId = stubAuth.issuedSessionIds[issuedBefore];

        // Second ensure for the same workspace reuses the running sidecar — and,
        // crucially, the reuse path must NOT mint another token (no leak).
        const second = yield* manager.ensure_sidecar(ensureInput);
        expect(second.status).toBe("ready");
        expect(second.url).toBe(first.url);
        expect(stubAuth.issuedSessionIds.length).toBe(issuedBefore + 1);

        // Two ensures => refCount 2; release twice to fully tear down.
        yield* manager.release_sidecar(workspaceRoot);
        const afterFirstRelease = yield* manager.sidecar_status(workspaceRoot);
        expect(afterFirstRelease.status).toBe("ready");
        // Still alive at refCount 1 → token not yet revoked.
        expect(stubAuth.revokedSessionIds.length).toBe(revokedBefore);

        yield* manager.release_sidecar(workspaceRoot);
        const afterSecondRelease = yield* manager.sidecar_status(workspaceRoot);
        expect(afterSecondRelease.status).toBe("stopped");
        expect(afterSecondRelease.url).toBeNull();

        // Teardown at refCount 0 closes the per-sidecar scope, which revokes the
        // minted session token (load-bearing: this asserts no leaked owner token).
        expect(stubAuth.revokedSessionIds.slice(revokedBefore)).toContain(sessionId);
      }),
    );

    it.effect("fails with CritSidecarError when the sidecar crashes before becoming ready", () =>
      Effect.gen(function* () {
        const manager = yield* CritSidecarManager;
        const crashingBinary = writeCrashingCritBinary();
        const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-crash-ws-"));

        const issuedBefore = stubAuth.issuedSessionIds.length;
        const revokedBefore = stubAuth.revokedSessionIds.length;

        const exit = yield* Effect.exit(
          manager.ensure_sidecar({
            workspaceRoot,
            branch: "main",
            threadId: "th",
            origin: "http://127.0.0.1:1",
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

        // The crash teardown closes the scope, which revokes the token minted for
        // this spawn — the token must not survive a failed start-up.
        const issuedHere = stubAuth.issuedSessionIds.slice(issuedBefore);
        expect(issuedHere.length).toBe(1);
        expect(stubAuth.revokedSessionIds.slice(revokedBefore)).toContain(issuedHere[0]);
      }),
    );

    it.effect(
      "fails with CritSidecarError when the sidecar never listens on its port (timeout)",
      () =>
        Effect.gen(function* () {
          const manager = yield* CritSidecarManager;
          const noportBinary = writeNonListeningCritBinary();
          const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-noport-ws-"));

          const issuedBefore = stubAuth.issuedSessionIds.length;
          const revokedBefore = stubAuth.revokedSessionIds.length;

          const exit = yield* Effect.exit(
            manager.ensure_sidecar({
              workspaceRoot,
              branch: "main",
              threadId: "th",
              origin: "http://127.0.0.1:1",
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

          // The readiness-timeout teardown closes the scope, which revokes the
          // token minted for this spawn.
          const issuedHere = stubAuth.issuedSessionIds.slice(issuedBefore);
          expect(issuedHere.length).toBe(1);
          expect(stubAuth.revokedSessionIds.slice(revokedBefore)).toContain(issuedHere[0]);
        }),
    );

    it.effect("propagates a failed cold start to concurrent reusers", () =>
      Effect.gen(function* () {
        const manager = yield* CritSidecarManager;
        const noportBinary = writeNonListeningCritBinary();
        const workspaceRoot = mkdtempSync(join(tmpdir(), "crit-sidecar-concurrent-fail-ws-"));

        const issuedBefore = stubAuth.issuedSessionIds.length;

        const ensureInput = {
          workspaceRoot,
          branch: "main",
          threadId: "th",
          origin: "http://127.0.0.1:1",
          wrapperCommand: "node /x",
          binaryPath: noportBinary,
          readinessTimeoutMs: 800,
        };

        const firstFiber = yield* Effect.exit(manager.ensure_sidecar(ensureInput)).pipe(
          Effect.forkChild,
        );
        yield* Effect.sleep(50);

        const starting = yield* manager.sidecar_status(workspaceRoot);
        expect(starting.status).toBe("starting");

        const secondExit = yield* Effect.exit(manager.ensure_sidecar(ensureInput));
        const firstExit = yield* Fiber.join(firstFiber);

        for (const exit of [firstExit, secondExit]) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(CritSidecarError);
          }
        }

        expect(stubAuth.issuedSessionIds.length).toBe(issuedBefore + 1);
        const status = yield* manager.sidecar_status(workspaceRoot);
        expect(status.status).toBe("stopped");
        expect(status.url).toBeNull();
      }),
    );
  },
);
