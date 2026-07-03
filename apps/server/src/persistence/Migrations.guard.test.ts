import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { assertMigrationIntegrity, migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// ── unit tests for the guard function itself (no DB needed) ──────────────────

it("assertMigrationIntegrity: duplicate number throws", () => {
  assert.throws(
    () =>
      assertMigrationIntegrity([
        [1, "Foo", {}],
        [2, "Bar", {}],
        [2, "Baz", {}],
      ]),
    /duplicate migration number 2 \(Bar, Baz\)/,
  );
});

it("assertMigrationIntegrity: gap in numbering throws", () => {
  assert.throws(
    () =>
      assertMigrationIntegrity([
        [1, "Foo", {}],
        [2, "Bar", {}],
        [4, "Gap", {}],
      ]),
    /non-contiguous migration numbers: 2 → 4/,
  );
});

it("assertMigrationIntegrity: real migration set passes", () => {
  // No throw = pass. If this explodes the guard itself is broken.
  assert.doesNotThrow(() => assertMigrationIntegrity(migrationEntries));
});

// ── integration: full migration set actually runs clean ──────────────────────

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("Migrations.guard integration", (it) => {
  it.effect("full migration set runs without error", () =>
    Effect.gen(function* () {
      const ran = yield* runMigrations();
      assert.ok(ran.length >= 32, `expected ≥32 migrations, got ${ran.length}`);
    }),
  );
});
