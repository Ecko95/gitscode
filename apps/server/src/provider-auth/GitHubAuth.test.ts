import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type {
  PtyAdapterShape,
  PtyExitEvent,
  PtyProcess,
  PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import {
  logoutGitHubAccount,
  makeGitHubAuthAdapter,
  startGitHubDeviceLogin,
} from "./GitHubAuth.ts";

class FakePtyProcess implements PtyProcess {
  readonly pid = 7_777;
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(...chunks: ReadonlyArray<string>): void {
    for (const chunk of chunks) {
      for (const listener of this.dataListeners) listener(chunk);
    }
  }
  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly inputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];

  spawn(input: PtySpawnInput) {
    this.inputs.push(input);
    const process = new FakePtyProcess();
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const makeInput = (pty: PtyAdapterShape) => ({
  provider: ProviderDriverKind.make("github"),
  pty,
  binaryPath: "/usr/bin/gh",
  hostname: "github.com",
  credentialHome: "/srv/provider-homes/github",
  environment: {
    PATH: "/usr/bin",
    HOME: "/srv/provider-homes/github",
    GH_CONFIG_DIR: "/srv/provider-homes/github/.config/gh",
  },
});

describe("GitHubAuth", () => {
  it.effect("surfaces an ANSI-split device URL and one-time code", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startGitHubDeviceLogin(makeInput(pty));
      const process = pty.processes[0]!;

      process.emitData(
        "\u001b[33m! First copy your one-time co",
        "de: \u001b[1mABCD-EF",
        "GH\u001b[0m\r\nOpen this URL to continue in your web browser: https://github.com/login/",
        "device\r\nprivate transcript text",
      );

      expect(yield* attempt.readiness).toEqual({
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-EFGH",
        sanitizedPrompt: "Open the GitHub verification page and enter the one-time code.",
        acceptsCode: false,
      });
      expect(pty.inputs[0]).toEqual({
        shell: "/usr/bin/gh",
        args: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
        cwd: "/srv/provider-homes/github",
        cols: 80,
        rows: 24,
        env: { ...makeInput(pty).environment, GH_PROMPT_DISABLED: "1" },
      });
      expect(pty.inputs[0]?.args).not.toContain("--with-token");
      expect(attempt.submitCode).toBeUndefined();

      process.emitExit(0);
      expect(yield* attempt.completion).toBe(true);
      yield* attempt.close;
    }),
  );

  it.effect("cancels the private PTY and redacts early failures", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startGitHubDeviceLogin(makeInput(pty));
      pty.processes[0]!.emitData("token=never-return-this\r\n");

      yield* attempt.cancel;
      yield* attempt.cancel;
      expect(pty.processes[0]!.kills).toEqual([undefined]);
      expect(yield* attempt.completion).toBe(false);
      const readiness = yield* attempt.readiness.pipe(Effect.result);
      if (readiness._tag !== "Failure") throw new Error("expected cancelled readiness");
      expect(readiness.failure.message).not.toContain("never-return-this");
      yield* attempt.close;
    }),
  );

  it.effect("uses the shared provider adapter without accepting PAT input", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const adapter = makeGitHubAuthAdapter(makeInput(pty));

      expect(adapter.methods).toEqual(["device-code"]);
      const attempt = yield* adapter.start("device-code");
      expect(attempt.submitCode).toBeUndefined();
      expect(pty.inputs[0]?.args?.join(" ")).not.toContain("token");
      yield* attempt.cancel;
      yield* attempt.close;

      const unsupported = yield* adapter.start("api-key").pipe(Effect.result);
      expect(unsupported._tag).toBe("Failure");
    }),
  );

  it.effect("logs out only through the selected GitHub credential environment", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const fiber = yield* logoutGitHubAccount(makeInput(pty)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(pty.inputs[0]).toMatchObject({
        shell: "/usr/bin/gh",
        args: ["auth", "logout", "--hostname", "github.com"],
        cwd: "/srv/provider-homes/github",
        env: { ...makeInput(pty).environment, GH_PROMPT_DISABLED: "1" },
      });
      pty.processes[0]!.emitExit(0);
      yield* Fiber.join(fiber);
    }),
  );
});
