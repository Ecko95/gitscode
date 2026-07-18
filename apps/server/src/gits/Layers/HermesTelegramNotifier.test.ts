// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HermesTelegramNotifier,
  HermesTelegramNotifierError,
} from "../Services/HermesTelegramNotifier.ts";
import { makeHermesTelegramNotifier } from "./HermesTelegramNotifier.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function makeFakeHermes(exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "gits-hermes-telegram-notifier-"));
  tempDirs.push(dir);
  const argsFile = join(dir, "args");
  const hermesHome = join(dir, "hermes-home");
  const bin = join(dir, "hermes");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$GITS_TEST_HERMES_ARGS_FILE"',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(bin, 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("GITS_HERMES_HOME", hermesHome);
  vi.stubEnv("GITS_TEST_HERMES_ARGS_FILE", argsFile);
  return { argsFile };
}

const TestLayer = Layer.effect(HermesTelegramNotifier, makeHermesTelegramNotifier);

describe("HermesTelegramNotifier", () => {
  it("runs Hermes with the fixed Telegram send arguments", async () => {
    const { argsFile } = makeFakeHermes();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await Effect.runPromise(
      Effect.gen(function* () {
        const notifier = yield* HermesTelegramNotifier;
        yield* notifier.notify({ subject: "GITS", text: "hello" });
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "send",
      "--to",
      "telegram",
      "--quiet",
      "--subject",
      "GITS",
      "hello",
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a non-zero Hermes exit to HermesTelegramNotifierError", async () => {
    makeFakeHermes(1);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const notifier = yield* HermesTelegramNotifier;
        return yield* notifier.notify({ subject: "GITS", text: "hello" }).pipe(Effect.flip);
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(error).toBeInstanceOf(HermesTelegramNotifierError);
  });
});
