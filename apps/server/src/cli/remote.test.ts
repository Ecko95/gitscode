// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node filesystem boundaries.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

it.layer(NodeServices.layer)("remote cli parsing", (it) => {
  it.effect("registers the remote command group help", () =>
    runCliWithRuntime(["remote", "--help"]),
  );

  it.effect("registers each remote subcommand help", () =>
    Effect.gen(function* () {
      for (const subcommand of ["add", "list", "status", "remove"]) {
        yield* runCliWithRuntime(["remote", subcommand, "--help"]);
      }
    }),
  );

  it.effect("requires an ssh-target argument for remote add", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["remote", "add"]).pipe(Effect.flip);
      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "remote", "add"]);
    }),
  );

  it.effect("lists an empty registry as JSON without touching SSH", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-remote-list-empty-"));
      const listed = yield* captureStdout(
        runCli(["remote", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const agents = JSON.parse(listed.output) as ReadonlyArray<unknown>;
      assert.equal(agents.length, 0);
    }),
  );

  it.effect("status of an unknown agent is a clean no-op", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-remote-status-missing-"));
      const status = yield* captureStdout(
        runCli(["remote", "status", "ghost", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const parsed = JSON.parse(status.output) as { readonly found: boolean };
      assert.equal(parsed.found, false);
    }),
  );

  it.effect("remove of an unknown agent is idempotent", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-remote-remove-missing-"));
      const removed = yield* captureStdout(
        runCli(["remote", "remove", "ghost", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const parsed = JSON.parse(removed.output) as { readonly removed: boolean };
      assert.equal(parsed.removed, false);
    }),
  );

  it.effect("rejects dev-url on remote commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime([
        "remote",
        "list",
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);
      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
