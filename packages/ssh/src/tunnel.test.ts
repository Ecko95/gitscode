import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshReadinessError } from "./errors.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeControlledRunningProcess = (input: {
  readonly onExit?: () => void;
  readonly onKill?: () => void;
  readonly stderr?: string;
}) => {
  let completedExitCode: ChildProcessSpawner.ExitCode | null = null;
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  let running = true;
  const stderrStream = input.stderr
    ? Stream.make(new TextEncoder().encode(input.stderr))
    : Stream.empty;
  const exit = (exitCode: number) => {
    if (!running) return;
    running = false;
    completedExitCode = ChildProcessSpawner.ExitCode(exitCode);
    input.onExit?.();
    finish?.(completedExitCode);
  };

  return {
    exit,
    handle: ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: Stream.empty,
      stderr: stderrStream,
      all: stderrStream,
      exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
        if (completedExitCode !== null) {
          resume(Effect.succeed(completedExitCode));
          return;
        }
        finish = (exitCode) => resume(Effect.succeed(exitCode));
        return Effect.sync(() => {
          finish = null;
        });
      }),
      isRunning: Effect.sync(() => running),
      kill: () =>
        Effect.sync(() => {
          input.onKill?.();
          exit(143);
        }),
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  };
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

function localForwardPort(args: ReadonlyArray<string>): number | null {
  const forwardIndex = args.indexOf("-L");
  const forward = forwardIndex < 0 ? null : args[forwardIndex + 1];
  if (!forward) return null;
  const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+$/u.exec(forward);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

const auxiliaryTarget = (alias: string) => ({
  alias,
  hostname: `${alias}.example.com`,
  username: "julius",
  port: 2222,
});

function makeAuxiliaryForwardHarness(input?: {
  readonly localPorts?: ReadonlyArray<number>;
  readonly occupiedPorts?: ReadonlyArray<number>;
  readonly spawnForward?: (
    localPort: number,
    spawnIndex: number,
  ) => ChildProcessSpawner.ChildProcessHandle | null;
}) {
  const commands: Array<ReadonlyArray<string>> = [];
  const controllers: Array<ReturnType<typeof makeControlledRunningProcess>> = [];
  const listeningPorts = new Set(input?.occupiedPorts ?? []);
  const localPorts = [...(input?.localPorts ?? [41_001, 41_002, 41_003, 41_004])];
  let forwardSpawnCount = 0;
  let killCount = 0;

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = commandArgs(command);
      commands.push(args);
      const localPort = localForwardPort(args);
      if (localPort === null) {
        return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
      }

      const spawnIndex = forwardSpawnCount;
      forwardSpawnCount += 1;
      const custom = input?.spawnForward?.(localPort, spawnIndex) ?? null;
      if (custom !== null) {
        return custom;
      }

      listeningPorts.add(localPort);
      const controller = makeControlledRunningProcess({
        onExit: () => listeningPorts.delete(localPort),
        onKill: () => {
          killCount += 1;
        },
      });
      controllers.push(controller);
      return controller.handle;
    }),
  );
  const net = NetService.NetService.of({
    canListenOnHost: (port) => Effect.sync(() => !listeningPorts.has(port)),
    isPortAvailableOnLoopback: (port) => Effect.sync(() => !listeningPorts.has(port)),
    reserveLoopbackPort: () =>
      Effect.sync(() => {
        const port = localPorts.shift();
        if (port === undefined) throw new Error("No test port remains.");
        return port;
      }),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, testHttpClient),
    Layer.succeed(NetService.NetService, net),
    SshPasswordPrompt.disabledLayer,
    SshEnvironmentManager.layer(),
  );

  return {
    commands,
    controllers,
    layer,
    get forwardSpawnCount() {
      return forwardSpawnCount;
    },
    get killCount() {
      return killCount;
    },
  };
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --use-on-cd --shell sh)"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "role": "client",
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "role": "client",
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

describe("SshEnvironmentManager auxiliary forwards", () => {
  it.effect("single-flights concurrent identical forwards", () => {
    const harness = makeAuxiliaryForwardHarness();
    const target = auxiliaryTarget("devbox");

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const [first, second] = yield* Effect.all(
        [
          manager.ensureForward(target, {
            remoteHost: "127.0.0.1",
            remotePort: 5173,
            policy: { kind: "flexible" },
          }),
          manager.ensureForward(target, {
            remoteHost: "127.0.0.1",
            remotePort: 5173,
            policy: { kind: "flexible" },
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(first, { localPort: 41_001 });
      assert.deepEqual(second, first);
      assert.equal(harness.forwardSpawnCount, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("isolates forwards by target and remote port", () => {
    const harness = makeAuxiliaryForwardHarness();
    const firstTarget = auxiliaryTarget("devbox");
    const secondTarget = auxiliaryTarget("staging");

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const forwards = yield* Effect.all(
        [
          manager.ensureForward(firstTarget, {
            remoteHost: "127.0.0.1",
            remotePort: 5173,
            policy: { kind: "flexible" },
          }),
          manager.ensureForward(firstTarget, {
            remoteHost: "127.0.0.1",
            remotePort: 3000,
            policy: { kind: "flexible" },
          }),
          manager.ensureForward(secondTarget, {
            remoteHost: "127.0.0.1",
            remotePort: 5173,
            policy: { kind: "flexible" },
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(
        forwards.map((forward) => forward.localPort).toSorted((a, b) => a - b),
        [41_001, 41_002, 41_003],
      );
      assert.equal(harness.forwardSpawnCount, 3);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("retries a flexible forward after a local bind collision", () => {
    const harness = makeAuxiliaryForwardHarness({
      spawnForward: (localPort, spawnIndex) => {
        if (spawnIndex !== 0) return null;
        const controller = makeControlledRunningProcess({
          stderr: `bind [127.0.0.1]:${localPort}: Address already in use\r\n`,
        });
        controller.exit(255);
        return controller.handle;
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const forward = yield* manager.ensureForward(auxiliaryTarget("devbox"), {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        policy: { kind: "flexible" },
      });

      assert.deepEqual(forward, { localPort: 41_002 });
      assert.equal(harness.forwardSpawnCount, 2);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("fails an exact forward before spawning when its local port is occupied", () => {
    const harness = makeAuxiliaryForwardHarness({ occupiedPorts: [14_55] });

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const error = yield* manager
        .ensureForward(auxiliaryTarget("devbox"), {
          remoteHost: "127.0.0.1",
          remotePort: 14_55,
          policy: { kind: "exact", localPort: 14_55 },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, SshReadinessError);
      assert.include(error.message, "1455");
      assert.equal(harness.forwardSpawnCount, 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("removes a forward after its child exits", () => {
    const harness = makeAuxiliaryForwardHarness();
    const target = auxiliaryTarget("devbox");

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      yield* manager.ensureForward(target, {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        policy: { kind: "flexible" },
      });
      harness.controllers[0]?.exit(255);
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow;
      }

      const replacement = yield* manager.ensureForward(target, {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        policy: { kind: "flexible" },
      });

      assert.deepEqual(replacement, { localPort: 41_002 });
      assert.equal(harness.forwardSpawnCount, 2);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("releases only the requested auxiliary forward", () => {
    const harness = makeAuxiliaryForwardHarness();
    const target = auxiliaryTarget("devbox");

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const first = yield* manager.ensureForward(target, {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        policy: { kind: "flexible" },
      });
      yield* manager.ensureForward(target, {
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        policy: { kind: "flexible" },
      });

      yield* manager.releaseForward(target, {
        remotePort: 5173,
        localPort: first.localPort,
      });

      assert.equal(harness.killCount, 1);
      assert.equal(
        harness.commands.filter((args) => args.includes("sh")).length,
        0,
        "auxiliary release must not stop a remote process",
      );
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("cleans target forwards on disconnect and all forwards on application shutdown", () => {
    const harness = makeAuxiliaryForwardHarness();
    const firstTarget = auxiliaryTarget("devbox");
    const secondTarget = auxiliaryTarget("staging");

    return Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(harness.layer, scope);

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureForward(firstTarget, {
          remoteHost: "127.0.0.1",
          remotePort: 5173,
          policy: { kind: "flexible" },
        });
        yield* manager.ensureForward(firstTarget, {
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          policy: { kind: "flexible" },
        });
        yield* manager.ensureForward(secondTarget, {
          remoteHost: "127.0.0.1",
          remotePort: 5173,
          policy: { kind: "flexible" },
        });

        yield* manager.disconnectEnvironment(firstTarget);
        assert.equal(harness.killCount, 2);
      }).pipe(Effect.provide(context));

      yield* Scope.close(scope, Exit.void);
      assert.equal(harness.killCount, 3);
    });
  });
});
