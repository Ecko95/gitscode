import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-env-test-" });
  });
}

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

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

const testElectronShellLayer = Layer.succeed(ElectronShell.ElectronShell, {
  openExternal: () => Effect.succeed(true),
  copyText: () => Effect.void,
});

function makeRemoteUrlHarness(input?: { readonly occupiedPorts?: ReadonlyArray<number> }) {
  const commands: Array<ReadonlyArray<string>> = [];
  const openedUrls: string[] = [];
  const events: string[] = [];
  const occupiedPorts = new Set(input?.occupiedPorts ?? []);
  let forwardedPort: number | null = null;
  let running = true;
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = commandArgs(command);
      commands.push(args);
      const forwardIndex = args.indexOf("-L");
      if (forwardIndex < 0) {
        return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
      }
      const forward = args[forwardIndex + 1] ?? "";
      forwardedPort = Number.parseInt(forward.split(":")[1] ?? "", 10);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(124),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
          finish = (exitCode) => resume(Effect.succeed(exitCode));
          return Effect.sync(() => {
            finish = null;
          });
        }),
        isRunning: Effect.sync(() => running),
        kill: () =>
          Effect.sync(() => {
            running = false;
            finish?.(ChildProcessSpawner.ExitCode(143));
          }),
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const net = NetService.NetService.of({
    canListenOnHost: (port) =>
      Effect.sync(() => {
        if (occupiedPorts.has(port)) return false;
        if (forwardedPort !== port) return true;
        if (!events.includes("ready")) events.push("ready");
        return false;
      }),
    isPortAvailableOnLoopback: (port) => Effect.sync(() => !occupiedPorts.has(port)),
    reserveLoopbackPort: () => Effect.succeed(43_001),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });
  const runtimeLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(NetService.NetService, net),
    NodeHttpClient.layerUndici,
  );
  const layer = DesktopSshEnvironment.layer().pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
        request: () => Effect.die("unexpected password prompt request"),
        resolve: () => Effect.die("unexpected password prompt resolution"),
        cancelPending: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ElectronShell.ElectronShell, {
        openExternal: (url) =>
          Effect.sync(() => {
            events.push("open");
            openedUrls.push(String(url));
            return true;
          }),
        copyText: () => Effect.void,
      }),
    ),
    Layer.provideMerge(runtimeLayer),
  );

  return { commands, events, layer, openedUrls };
}

describe("sshEnvironment", () => {
  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
              cancelPending: () => Effect.void,
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
          Layer.provideMerge(testElectronShellLayer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("wires auxiliary forward ensure and release through the desktop service", () => {
    const listeningPorts = new Set<number>();
    let killCount = 0;
    let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        const forwardIndex = args.indexOf("-L");
        if (forwardIndex < 0) {
          return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
        }
        const forward = args[forwardIndex + 1] ?? "";
        const localPort = Number.parseInt(forward.split(":")[1] ?? "", 10);
        listeningPorts.add(localPort);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(124),
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
              killCount += 1;
              listeningPorts.delete(localPort);
              finish?.(ChildProcessSpawner.ExitCode(143));
            }),
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const net = NetService.NetService.of({
      canListenOnHost: (port) => Effect.sync(() => !listeningPorts.has(port)),
      isPortAvailableOnLoopback: (port) => Effect.sync(() => !listeningPorts.has(port)),
      reserveLoopbackPort: () => Effect.succeed(43_001),
      findAvailablePort: (preferred) => Effect.succeed(preferred),
    });
    const runtimeLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(NetService.NetService, net),
      NodeHttpClient.layerUndici,
    );
    const layer = DesktopSshEnvironment.layer().pipe(
      Layer.provideMerge(
        Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("unexpected password prompt request"),
          resolve: () => Effect.die("unexpected password prompt resolution"),
          cancelPending: () => Effect.void,
        }),
      ),
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(testElectronShellLayer),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const forward = yield* sshEnvironment.ensureForward(target, {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        policy: { kind: "flexible" },
      });
      assert.deepEqual(forward, { localPort: 43_001 });

      yield* sshEnvironment.releaseForward(target, {
        remotePort: 5173,
        localPort: forward.localPort,
      });
      assert.equal(killCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("rewrites a direct loopback origin and preserves path, query, and fragment", () => {
    const harness = makeRemoteUrlHarness();

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const result = yield* sshEnvironment.openRemoteUrl({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        url: "http://localhost:5173/path/to/app?q=one#section",
      });

      assert.deepEqual(result, {
        opened: true,
        kind: "direct-forward",
        remotePort: 5173,
        localPort: 43_001,
      });
      assert.deepEqual(harness.openedUrls, ["http://127.0.0.1:43001/path/to/app?q=one#section"]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("opens a public URL unchanged without creating a forward", () => {
    const harness = makeRemoteUrlHarness();
    const url = "https://example.com/docs?q=one#section";

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const result = yield* sshEnvironment.openRemoteUrl({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        url,
      });

      assert.deepEqual(result, { opened: true, kind: "external" });
      assert.deepEqual(harness.openedUrls, [url]);
      assert.equal(harness.commands.filter((args) => args.includes("-L")).length, 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("uses the exact OAuth redirect port and preserves the authorization URL", () => {
    const harness = makeRemoteUrlHarness();
    const url =
      "https://provider.example/authorize?client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback%3Fx%3D1#provider";

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const result = yield* sshEnvironment.openRemoteUrl({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        url,
      });

      assert.deepEqual(result, {
        opened: true,
        kind: "oauth-forward",
        remotePort: 1455,
        localPort: 1455,
      });
      assert.deepEqual(harness.openedUrls, [url]);
      assert.isTrue(
        harness.commands.some((args) => args.includes("127.0.0.1:1455:127.0.0.1:1455")),
      );
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("refuses an occupied exact OAuth port without opening the browser", () => {
    const harness = makeRemoteUrlHarness({ occupiedPorts: [1455] });

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const result = yield* sshEnvironment.openRemoteUrl({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        url: "https://provider.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback",
      });

      assert.deepEqual(result, { opened: false, error: "local-port-unavailable" });
      assert.deepEqual(harness.openedUrls, []);
      assert.equal(harness.commands.filter((args) => args.includes("-L")).length, 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("does not open the browser until the local forward reports ready", () => {
    const harness = makeRemoteUrlHarness();

    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      yield* sshEnvironment.openRemoteUrl({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        url: "http://localhost:5173/",
      });

      assert.deepEqual(harness.events, ["ready", "open"]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});
