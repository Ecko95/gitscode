import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type {
  PtyAdapterShape,
  PtyExitEvent,
  PtyProcess,
  PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import { logoutClaudeAccount, startClaudeGuidedLogin } from "./ClaudeGuidedLogin.ts";

class FakePtyProcess implements PtyProcess {
  readonly pid = 4_242;
  readonly writes: string[] = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

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
  pty,
  binaryPath: "/opt/claude/bin/claude",
  credentialHome: "/srv/provider-homes/claude-work",
  environment: {
    PATH: "/opt/claude/bin:/usr/bin",
    HOME: "/srv/provider-homes/claude-work",
    CLAUDE_CONFIG_DIR: "/srv/provider-homes/claude-work/.claude",
  },
});

describe("ClaudeGuidedLogin", () => {
  it.effect("extracts an ANSI-split HTTPS URL without exposing the PTY transcript", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startClaudeGuidedLogin(makeInput(pty));
      const process = pty.processes[0]!;

      process.emitData(
        "\u001b[3",
        "1mOpen https://claude.ai/oauth/author",
        "ize?state=private-state\u001b[0",
        "m\r\nTOP-SECRET-TRANSCRIPT\r\nPaste co",
        "\u001b[3",
        "2mde\u001b[0",
        "m here: ",
      );
      const ready = yield* attempt.readiness;

      expect(ready).toEqual({
        verificationUri: "https://claude.ai/oauth/authorize?state=private-state",
        sanitizedPrompt:
          "Open the Claude authorization page, then paste the code shown in your browser.",
        acceptsCode: true,
      });
      expect(Object.values(ready).join(" ")).not.toContain("TOP-SECRET-TRANSCRIPT");
      expect(pty.inputs).toEqual([
        {
          shell: "/opt/claude/bin/claude",
          args: ["auth", "login"],
          cwd: "/srv/provider-homes/claude-work",
          cols: 80,
          rows: 24,
          env: makeInput(pty).environment,
        },
      ]);

      process.emitExit(0);
      expect(yield* attempt.completion).toBe(true);
      yield* attempt.close;
    }),
  );

  it.effect("submits one manual code through stdin and never places it in argv", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startClaudeGuidedLogin(makeInput(pty));
      const process = pty.processes[0]!;
      const code = "split-private-code";

      yield* attempt.submitCode(`  ${code}  `);
      expect(process.writes).toEqual([`${code}\r`]);
      expect(pty.inputs[0]?.args).toEqual(["auth", "login"]);
      expect(
        [
          pty.inputs[0]?.shell,
          pty.inputs[0]?.cwd,
          ...(pty.inputs[0]?.args ?? []),
          ...Object.values(pty.inputs[0]?.env ?? {}),
        ].join(" "),
      ).not.toContain(code);

      const repeated = yield* attempt.submitCode("second-code").pipe(Effect.result);
      expect(repeated._tag).toBe("Failure");
      yield* attempt.cancel;
      yield* attempt.close;
    }),
  );

  it.effect("uses only process exit for completion and cancels the private PTY", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startClaudeGuidedLogin(makeInput(pty));
      const process = pty.processes[0]!;

      process.emitData("Login successful\r\nhttps://claude.ai/oauth/authorize\r\n");
      yield* attempt.cancel;
      yield* attempt.cancel;
      expect(process.kills).toEqual([undefined]);
      process.emitExit(1);
      expect(yield* attempt.completion).toBe(false);
      yield* attempt.close;
    }),
  );

  it.effect("returns redacted failures when the PTY exits before producing a URL", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const attempt = yield* startClaudeGuidedLogin(makeInput(pty));
      pty.processes[0]!.emitData("credential=never-return-this\r\n");
      pty.processes[0]!.emitExit(1);

      const result = yield* attempt.readiness.pipe(Effect.result);
      if (result._tag !== "Failure") throw new Error("expected readiness to fail");
      expect(result.failure.message).not.toContain("never-return-this");
      yield* attempt.close;
    }),
  );

  it.effect("logs out in the selected credential environment", () =>
    Effect.gen(function* () {
      const pty = new FakePtyAdapter();
      const logout = logoutClaudeAccount(makeInput(pty));
      const fiber = yield* logout.pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(pty.inputs[0]).toMatchObject({
        shell: "/opt/claude/bin/claude",
        args: ["auth", "logout"],
        cwd: "/srv/provider-homes/claude-work",
        env: makeInput(pty).environment,
      });
      pty.processes[0]!.emitExit(0);
      yield* Fiber.join(fiber);
    }),
  );
});
