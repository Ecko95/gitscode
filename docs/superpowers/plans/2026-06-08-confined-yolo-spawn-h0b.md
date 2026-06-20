# Autonomous Toggle — Plan 2: Confined-Yolo Spawn (H0b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the codex peer that the `AutomodeDriver` spawns run **jailed to the assigned repo's worktree** (bubblewrap, all secrets but the one provider cred invisible) while keeping **`--yolo`** (full in-repo autonomy, no approval prompts) — the "sandcastle" model from `autonomous-toggle.md` Q7/Q8. This is roadmap item **H0b**.

**Architecture:** Two repos. (1) **delamain** (`/home/joshua/dev/projects/delamain`, remote `Ecko95/delamain`) — its `run-peer` runner wraps the `codex` child in `gits-confine.sh --profile peer …` when a `--confine` flag is present. (2) **gitscode** — `scripts/gits-confine.sh` gains a `--setenv` passthrough (so the jailed codex gets `CODEX_HOME`); the spawn contract/adapter gain `confine`/`egress`; the driver requests `confine:true, yolo:true, egress:"host"` for autonomous spawns. A spike nails the exact confined-codex auth recipe before the delamain wiring encodes it.

**Tech Stack:** delamain = TypeScript/ESM, `node --test` over `dist/*.js`, `node:child_process` spawn. gitscode = effect Schema contracts, `@effect/vitest`, bash (`gits-confine.sh` + `bwrap`).

**Repos & branches:**

- gitscode: branch `feat/confined-yolo-spawn` off `origin/gits`.
- delamain: branch `feat/confine-codex-peer` off its default branch.

**Prerequisites verified on this host:** `bwrap` present (`/usr/bin/bwrap`); `passt`/`pasta` **absent** (so `--egress proxy=` is advisory-only → v1 uses `--egress host`, accepting unfiltered egress as the Q7 residual risk); `gits-confine.sh --worktree /tmp/x --profile peer -- true` runs clean (exit 0).

**Scope — excludes (later plans):** held-PR pipeline (Plan 3), ledger (Plan 4), Telegram (Plan 5), auto-answer (Plan 6), Motoko dispatch/grill (Plan 7), cockpit UI (Plan 8), full H0c egress allowlist (install `passt`), and **cursor** confinement (cursor is never auto-routed).

---

## File Structure

| Repo     | File                                                             | Responsibility                                                                                                                            | Change |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| gitscode | `scripts/gits-confine.sh`                                        | Add repeatable `--setenv KEY=VAL` passed into the bwrap env (so the jail can receive `CODEX_HOME`).                                       | Modify |
| gitscode | `spikes/h0b-confined-codex/run-spike.sh` (+ `SPIKE_FINDINGS.md`) | Empirically determine the exact confined-`codex exec` invocation that authenticates and completes a trivial task.                         | Create |
| gitscode | `packages/contracts/src/gits.ts`                                 | Add `confine`/`egress` to `DelamainSpawnPeerInput`.                                                                                       | Modify |
| gitscode | `apps/server/src/gits/Services/DelamainAdapter.ts`               | (No change — `spawnPeer` param type derives from the contract via `Parameters<…>`.)                                                       | —      |
| gitscode | `apps/server/src/gits/Layers/DelamainCliAdapter.ts`              | `spawnArgs` maps `confine`→`--confine`, `egress`→`--egress <v>`.                                                                          | Modify |
| gitscode | `apps/server/src/gits/Layers/DelamainCliAdapter.test.ts`         | First `spawnPeer`/`spawnArgs` argv test (asserts `--confine`/`--egress`/`--yolo`).                                                        | Modify |
| gitscode | `apps/server/src/gits/Layers/AutomodeSupervisor.ts`              | The driver's spawn (`dispatchGoal` → `spawnPeer`) passes `confine:true, yolo:true, egress:"host"` in autonomous mode.                     | Modify |
| gitscode | `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`         | Assert the autonomous dispatch passes confine/yolo/egress to spawn.                                                                       | Modify |
| delamain | `src/runner.ts`                                                  | Export `buildCodexArgs`; add a pure `buildConfinedCommand(...)`; wrap the codex `spawn` through `gits-confine.sh` when confinement is on. | Modify |
| delamain | `src/cli.ts` + `src/peerManager.ts` + `src/runner.ts`            | Parse `--confine`/`--egress`; thread through `spawnRunner` → `run-peer` → `parseArgs`.                                                    | Modify |
| delamain | `tests/runner.test.mjs`                                          | New: unit-test `buildConfinedCommand` (argv shape).                                                                                       | Create |

---

## Task 1 (gitscode) — `gits-confine.sh` gains `--setenv KEY=VAL`

**Why:** the jail `--clearenv`s and only sets a fixed env set, so a confined codex never receives `CODEX_HOME` and can't find its bound credential. Add a passthrough.

**Files:**

- Modify: `scripts/gits-confine.sh` (arg parser ~28-48; bwrap exec ~106-128)
- Test: `spikes/h0b-confined-codex/setenv.test.sh` (Create)

- [ ] **Step 1: Write the failing test**

Create `spikes/h0b-confined-codex/setenv.test.sh`:

```bash
#!/usr/bin/env bash
# Verifies gits-confine.sh --setenv injects a var into the jailed command's env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFINE="$HERE/../../scripts/gits-confine.sh"
WT="$(mktemp -d)"
trap 'rm -rf "$WT"' EXIT

# --setenv FOO=bar must appear in the confined process env.
out="$(bash "$CONFINE" --worktree "$WT" --profile peer --egress host \
  --setenv FOO=bar -- /usr/bin/env)"
echo "$out" | grep -qx "FOO=bar" || { echo "FAIL: FOO=bar not in confined env"; echo "$out"; exit 1; }

# Repeatable: a second --setenv also lands.
out2="$(bash "$CONFINE" --worktree "$WT" --profile peer --egress host \
  --setenv FOO=bar --setenv BAZ=qux -- /usr/bin/env)"
echo "$out2" | grep -qx "BAZ=qux" || { echo "FAIL: BAZ=qux not in confined env"; exit 1; }

echo "PASS: --setenv injects vars"
```

Make it executable: `chmod +x spikes/h0b-confined-codex/setenv.test.sh`

- [ ] **Step 2: Run it to verify it fails**

Run: `bash /home/joshua/dev/projects/gitscode-confined/spikes/h0b-confined-codex/setenv.test.sh` (adjust path to your worktree)
Expected: FAIL — `gits-confine.sh` errors `unknown arg: --setenv` (exit 70).

- [ ] **Step 3: Implement `--setenv` in `gits-confine.sh`**

In the variable init line (currently `WORKTREE="" PROFILE="verify" … CMD=()`), add an array: change the `CREDS=() EXTRA_RO=() CMD=()` line to also declare `USER_ENV=()`.

In the arg-parse `case` (after the `--ignore-scripts) … ;;` line), add:

```bash
    --setenv)   USER_ENV+=("${2:-}"); shift 2 ;;
```

Build bwrap `--setenv` pairs before the `exec bwrap` block. Immediately before `exec bwrap \`, add:

```bash
# User-supplied env (e.g. CODEX_HOME for a confined codex peer). KEY=VAL form.
user_env_args=()
for kv in "${USER_ENV[@]}"; do
  [ -n "$kv" ] || continue
  case "$kv" in
    *=*) user_env_args+=( --setenv "${kv%%=*}" "${kv#*=}" ) ;;
    *)   die "--setenv expects KEY=VAL, got: $kv" ;;
  esac
done
```

Then add `"${user_env_args[@]}"` to the `exec bwrap` argv, on its own line right after the fixed `--setenv GITS_CONFINED "$PROFILE:$LABEL" \` line:

```bash
  --setenv GITS_CONFINED "$PROFILE:$LABEL" \
  "${user_env_args[@]}" \
  "${script_env[@]}" \
```

Update the usage comment block (the `# Usage:` section) to document `[--setenv KEY=VAL ...]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash spikes/h0b-confined-codex/setenv.test.sh`
Expected: `PASS: --setenv injects vars`

- [ ] **Step 5: Re-run the existing H0 harness to confirm no regression**

Run: `./spikes/h0-confinement/run-spike.sh`
Expected: 14/14 checks pass (unchanged).

- [ ] **Step 6: Commit**

```bash
rtk git add scripts/gits-confine.sh spikes/h0b-confined-codex/setenv.test.sh
rtk git commit -m "feat(confine): add --setenv KEY=VAL passthrough to gits-confine.sh"
```

---

## Task 2 (gitscode) — SPIKE: nail the confined `codex exec` recipe

**Why:** Whether a confined codex authenticates depends on `CODEX_HOME` placement and whether codex needs to **write** to its home (sessions/rollout). The bound creds are read-only; the recipe must be proven, not assumed. This spike produces the exact, working `gits-confine.sh … -- codex exec …` invocation that Task 5 (delamain) encodes.

**Files:**

- Create: `spikes/h0b-confined-codex/run-spike.sh`, `spikes/h0b-confined-codex/SPIKE_FINDINGS.md`

- [ ] **Step 1: Write the spike script**

Create `spikes/h0b-confined-codex/run-spike.sh`. It tries candidate recipes against a throwaway git worktree and a trivial prompt, and reports which authenticates + completes. **This requires a logged-in codex peer home** (`~/.delamain/peer-codex-home/auth.json`); if absent, the spike must report SKIPPED, not fake success.

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFINE="$HERE/../../scripts/gits-confine.sh"
PEER_HOME="${CODEX_HOME:-$HOME/.delamain/peer-codex-home}"

if [ ! -f "$PEER_HOME/auth.json" ]; then
  echo "SKIPPED: no codex peer auth at $PEER_HOME/auth.json (log a peer in first)"; exit 0
fi

WT="$(mktemp -d)"; ( cd "$WT" && git init -q && git commit -q --allow-empty -m init )
trap 'rm -rf "$WT"' EXIT
PROMPT='Create a file HELLO.txt containing the word HELLO, then stop.'

try() { # $1 = label, rest = gits-confine args before `-- codex …`
  local label="$1"; shift
  echo "=== $label ==="
  printf '%s' "$PROMPT" | timeout 180 bash "$CONFINE" "$@" \
    -- codex exec --json -C "$WT" - >/tmp/h0b-$label.out 2>&1
  local rc=$?
  if [ -f "$WT/HELLO.txt" ] && grep -q HELLO "$WT/HELLO.txt"; then
    echo "  RESULT: WORKS (rc=$rc, file written)"; rm -f "$WT/HELLO.txt"; return 0
  fi
  echo "  RESULT: FAILED (rc=$rc) — see /tmp/h0b-$label.out"; return 1
}

# Recipe A: CODEX_HOME points at the bound cred dir (read-only creds).
try recipeA --worktree "$WT" --profile peer --egress host \
  --cred "$PEER_HOME/auth.json" --cred "$PEER_HOME/config.toml" \
  --setenv "CODEX_HOME=$PEER_HOME"

# Recipe B: also bind the whole peer-home dir read-only (in case codex reads siblings).
try recipeB --worktree "$WT" --profile peer --egress host \
  --ro "$PEER_HOME" --setenv "CODEX_HOME=$PEER_HOME"

# Recipe C: writable CODEX_HOME inside the jail's tmpfs HOME, seeded by codex itself
#           (CODEX_HOME defaults to $HOME/.codex=/sandbox-home/.codex which is tmpfs+writable),
#           with auth bound into place.
try recipeC --worktree "$WT" --profile peer --egress host \
  --cred "$PEER_HOME/auth.json" --setenv "CODEX_HOME=/sandbox-home/.codex" \
  || echo "  (recipeC likely needs auth at /sandbox-home/.codex/auth.json — note in findings)"

echo "DONE — record the first WORKS recipe in SPIKE_FINDINGS.md"
```

- [ ] **Step 2: Run the spike**

Run: `bash spikes/h0b-confined-codex/run-spike.sh`
Expected: either `SKIPPED` (no peer login — then you must log a peer in and re-run before continuing), or at least one recipe prints `RESULT: WORKS`.

- [ ] **Step 3: Record the finding**

Write `spikes/h0b-confined-codex/SPIKE_FINDINGS.md` capturing: which recipe WORKS, the **exact** `gits-confine.sh` flag list that authenticated + wrote the file, whether codex needed a writable home, and confirmation that secrets stay hidden inside the jail (run `bash scripts/gits-confine.sh --worktree "$WT" --profile peer --egress host --cred "$PEER_HOME/auth.json" -- sh -c 'ls -a $HOME; cat ~/.codex/auth.json 2>&1; cat ~/.gits/hermes/* 2>&1' ` and confirm the real secrets are absent). **This exact flag list is the input to Task 5.**

- [ ] **Step 4: Commit**

```bash
rtk git add spikes/h0b-confined-codex/run-spike.sh spikes/h0b-confined-codex/SPIKE_FINDINGS.md
rtk git commit -m "spike(confine): determine working confined codex exec recipe (H0b)"
```

> **If the spike is SKIPPED (no peer login available in this environment):** proceed with **Recipe A** as the default in Task 5 (CODEX_HOME → bound cred dir, `--egress host`), and mark Task 6 (integration verification) as the gate that must pass before this feature is trusted. Do not claim the confined peer works until a real run is observed.

---

## Task 3 (gitscode) — spawn contract: `confine` + `egress`

**Files:**

- Modify: `packages/contracts/src/gits.ts` (`DelamainSpawnPeerInput`, ~437-449)

- [ ] **Step 1: Add the fields**

Extend `DelamainSpawnPeerInput` (after `yolo`):

```typescript
export const DelamainSpawnPeerInput = Schema.Struct({
  repo: PathString,
  prompt: SummaryString,
  name: Schema.optional(TrimmedNonEmptyString),
  startRef: Schema.optional(TrimmedNonEmptyString),
  mergeBranch: Schema.optional(TrimmedNonEmptyString),
  targetBranch: Schema.optional(TrimmedNonEmptyString),
  engine: Schema.optional(DelamainEngine),
  model: Schema.optional(TrimmedNonEmptyString),
  sandbox: Schema.optional(Schema.Literals(["read-only", "workspace-write", "danger-full-access"])),
  yolo: Schema.optional(Schema.Boolean),
  confine: Schema.optional(Schema.Boolean),
  egress: Schema.optional(Schema.Literals(["off", "host"])),
});
export type DelamainSpawnPeerInput = typeof DelamainSpawnPeerInput.Type;
```

(`egress` is limited to `off|host` for v1 — `proxy=` is advisory-only without `passt`, so it's intentionally not offered yet.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/contracts && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
rtk git add packages/contracts/src/gits.ts
rtk git commit -m "feat(contracts): confine + egress fields on DelamainSpawnPeerInput"
```

---

## Task 4 (gitscode) — `spawnArgs` maps the new fields to delamain flags + first spawn test

**Files:**

- Modify: `apps/server/src/gits/Layers/DelamainCliAdapter.ts` (`spawnArgs`, ~290-301)
- Test: `apps/server/src/gits/Layers/DelamainCliAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/gits/Layers/DelamainCliAdapter.test.ts` (mirroring the `runMock.mockImplementationOnce` + `expect(input).toMatchObject({args})` idiom already in the file):

```typescript
it.effect("forwards confine/egress/yolo flags to `delamain spawn`", () =>
  Effect.gen(function* () {
    runMock.mockImplementationOnce((input) => {
      expect(input.command).toBe("delamain");
      expect(input.args).toEqual([
        "spawn",
        "--repo",
        "/tmp/repo",
        "--prompt",
        "do the thing",
        "--yolo",
        "--confine",
        "--egress",
        "host",
      ]);
      return Effect.succeed({
        stdout: JSON.stringify({ id: "peer-x", status: "running", engine: "codex" }),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });
    const adapter = yield* DelamainAdapter;
    const peer = yield* adapter.spawnPeer({
      repo: "/tmp/repo",
      prompt: "do the thing",
      yolo: true,
      confine: true,
      egress: "host",
    });
    expect(peer.id).toBe("peer-x");
  }).pipe(Effect.provide(TestLayer)),
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && rtk vitest run src/gits/Layers/DelamainCliAdapter.test.ts`
Expected: FAIL — argv is missing `--confine`/`--egress` (spawnArgs doesn't emit them yet).

- [ ] **Step 3: Implement the mapping**

In `spawnArgs` (`DelamainCliAdapter.ts`), after the `if (input.yolo) args.push("--yolo");` line and before `return args;`:

```typescript
if (input.confine) args.push("--confine");
if (input.egress) args.push("--egress", input.egress);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/server && rtk vitest run src/gits/Layers/DelamainCliAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/server/src/gits/Layers/DelamainCliAdapter.ts apps/server/src/gits/Layers/DelamainCliAdapter.test.ts
rtk git commit -m "feat(automode): forward confine/egress spawn flags to delamain"
```

---

## Task 5 (delamain) — wrap the codex child in `gits-confine.sh`

> Work in the **delamain** repo (`/home/joshua/dev/projects/delamain`), branch `feat/confine-codex-peer`. Encode the exact `gits-confine.sh` flag list validated in Task 2 (default to Recipe A if the spike was SKIPPED).

**Files:**

- Modify: `src/cli.ts`, `src/peerManager.ts`, `src/runner.ts`
- Test: `tests/runner.test.mjs` (Create)

- [ ] **Step 1: Thread `--confine` / `--egress` through the CLI → run-peer**

In `src/cli.ts` `spawn` handler, parse `confine` (boolean, like `--yolo`) and `egress` (string, default `"host"` when confine is on) and add them to the `spawnPeer({...})` options. In `src/peerManager.ts` `spawnRunner` (the block that re-serialises `--model`/`--sandbox`/`--yolo`/`--engine` onto the `run-peer` argv, ~383-394), append:

```ts
if (options.confine) runArgs.push("--confine");
if (options.egress) runArgs.push("--egress", options.egress);
```

(match the surrounding `runArgs.push(...)` style and the option names used there). In `src/runner.ts` `parseArgs` (~268-310), read `--confine` (boolean) and `--egress` (string) into `RunnerArgs` (add `confine?: boolean; egress?: string` to the `RunnerArgs` type).

- [ ] **Step 2: Write the failing test for the confined-command builder**

Create `tests/runner.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfinedCommand } from "../dist/runner.js";

test("buildConfinedCommand wraps codex in gits-confine.sh --profile peer with worktree+cred+CODEX_HOME+egress", () => {
  const { command, args } = buildConfinedCommand({
    confineBin: "/abs/gits-confine.sh",
    worktree: "/wt/peer-1",
    codexHome: "/home/u/.delamain/peer-codex-home",
    egress: "host",
    label: "peer-1",
    engineCmd: "codex",
    engineArgs: ["exec", "--json", "-C", "/wt/peer-1", "-"],
  });
  assert.equal(command, "/abs/gits-confine.sh");
  // confine flags come before the `--` separator, engine argv after it
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "has -- separator");
  const pre = args.slice(0, sep);
  const post = args.slice(sep + 1);
  assert.deepEqual(post, ["codex", "exec", "--json", "-C", "/wt/peer-1", "-"]);
  assert.deepEqual(pre, [
    "--worktree",
    "/wt/peer-1",
    "--profile",
    "peer",
    "--label",
    "peer-1",
    "--egress",
    "host",
    "--cred",
    "/home/u/.delamain/peer-codex-home/auth.json",
    "--cred",
    "/home/u/.delamain/peer-codex-home/config.toml",
    "--setenv",
    "CODEX_HOME=/home/u/.delamain/peer-codex-home",
  ]);
});

test("buildConfinedCommand returns the raw engine command when confineBin is empty", () => {
  const { command, args } = buildConfinedCommand({
    confineBin: "",
    worktree: "/wt",
    codexHome: "/h",
    egress: "host",
    label: "p",
    engineCmd: "codex",
    engineArgs: ["exec", "-"],
  });
  assert.equal(command, "codex");
  assert.deepEqual(args, ["exec", "-"]);
});
```

- [ ] **Step 3: Run to verify it fails**

Run (in delamain): `npm run build && node --test tests/runner.test.mjs`
Expected: FAIL — `buildConfinedCommand` is not exported / undefined.

- [ ] **Step 4: Implement `buildConfinedCommand` + export `buildCodexArgs`**

In `src/runner.ts`, export the existing `buildCodexArgs` (change `function buildCodexArgs` → `export function buildCodexArgs`), and add:

```ts
export interface ConfinedSpawnInput {
  readonly confineBin: string; // GITS_CONFINE_BIN or "" to disable
  readonly worktree: string;
  readonly codexHome: string;
  readonly egress: string; // "host" | "off"
  readonly label: string;
  readonly engineCmd: string; // "codex"
  readonly engineArgs: ReadonlyArray<string>;
}

export function buildConfinedCommand(input: ConfinedSpawnInput): {
  command: string;
  args: string[];
} {
  if (!input.confineBin) {
    return { command: input.engineCmd, args: [...input.engineArgs] };
  }
  const pre = [
    "--worktree",
    input.worktree,
    "--profile",
    "peer",
    "--label",
    input.label,
    "--egress",
    input.egress,
    "--cred",
    `${input.codexHome}/auth.json`,
    "--cred",
    `${input.codexHome}/config.toml`,
    "--setenv",
    `CODEX_HOME=${input.codexHome}`,
  ];
  return { command: input.confineBin, args: [...pre, "--", input.engineCmd, ...input.engineArgs] };
}
```

> If Task 2's spike selected a recipe other than Recipe A (e.g. it needed `--ro <codexHome>` or a writable home), adjust `pre` here to match the **validated** flag list and update the test's expected `pre` accordingly. The shape (confine flags, then `--`, then engine argv) is fixed; only the specific flags vary.

- [ ] **Step 5: Wire it into the real spawn**

In `src/runner.ts` (~46-67), replace the direct `spawn("codex", codexArgs, {...})` with the confined form. Compute the confine binary from env, gated on `args.confine`:

```ts
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".delamain", "peer-codex-home");
const confineBin = args.confine ? (process.env.GITS_CONFINE_BIN ?? "gits-confine.sh") : "";
const { command, args: spawnArgv } = buildConfinedCommand({
  confineBin,
  worktree: args.repo,
  codexHome,
  egress: args.egress ?? "host",
  label: args.peerId,
  engineCmd: "codex",
  engineArgs: codexArgs,
});
append(log, `[delamain] starting: ${command} ${spawnArgv.join(" ")}\n`);
// ... existing updatePeer(...) ...
const child = spawn(command, spawnArgv, {
  cwd: args.repo,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: codexHome },
});
```

Leave the stdin prompt write (`child.stdin.write(prompt)`) unchanged — bubblewrap passes stdin through to the confined codex, which reads the prompt from the trailing `-` argv.

- [ ] **Step 6: Run tests to verify they pass**

Run (in delamain): `npm run build && node --test tests/runner.test.mjs tests/cursorRunner.test.mjs tests/git.test.mjs`
Expected: PASS (new builder tests + existing suites unaffected).

- [ ] **Step 7: Commit (delamain repo)**

```bash
git -C /home/joshua/dev/projects/delamain add src/cli.ts src/peerManager.ts src/runner.ts tests/runner.test.mjs
git -C /home/joshua/dev/projects/delamain commit -m "feat(confine): run codex peer under gits-confine.sh when --confine (keep --yolo)"
```

---

## Task 6 (gitscode) — driver requests confine+yolo for autonomous spawns

**Files:**

- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts` (the `dispatchGoal` → `spawnPeer` call, ~562-573)
- Test: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `AutomodeSupervisor.test.ts` — extend the existing spawn spy. The `makeLayer` `onSpawn` callback receives the spawn input; assert confine/yolo/egress. (If `onSpawn`'s type doesn't expose the new fields, widen it to receive the full input object.)

```typescript
it.effect("autonomous dispatch requests a confined --yolo peer", () => {
  let spawnInput: { confine?: boolean; yolo?: boolean; egress?: string } | null = null;
  return Effect.gen(function* () {
    const supervisor = yield* AutomodeSupervisor;
    yield* supervisor.updatePolicy({
      mode: "autonomous",
      killSwitchEnabled: false,
      maxActivePeers: 1,
      allowedRepos: ["/tmp/source-repo"],
      requireApprovalForPeerSpawn: false,
    });
    const queued = yield* supervisor.enqueueGoal({
      title: "Confined goal",
      repo: "/tmp/source-repo",
      prompt: "Run a safe task.",
    });
    yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
    assert.equal(spawnInput?.confine, true);
    assert.equal(spawnInput?.yolo, true);
    assert.equal(spawnInput?.egress, "host");
  }).pipe(
    Effect.provide(
      makeLayer({
        onSpawn: (input) => {
          spawnInput = input;
        },
      }),
    ),
  );
});
```

> The existing `makeLayer` `onSpawn` is typed `(input: { repo; prompt }) => void`. Widen it to `(input: DelamainSpawnPeerInput) => void` (import the type) so the test can read `confine`/`yolo`/`egress`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && rtk vitest run src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: FAIL — `spawnInput.confine` is `undefined` (dispatch doesn't pass it yet).

- [ ] **Step 3: Implement**

In `AutomodeSupervisor.ts` `dispatchGoal`, change the `spawnPeer` call (~562-568) to request confinement + yolo:

```typescript
const peer =
  yield *
  delamainAdapter
    .spawnPeer({
      repo: goal.repo,
      prompt: goal.prompt,
      name: goal.title,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      confine: true,
      yolo: true,
      egress: "host",
    })
    .pipe(
      Effect.mapError((cause) =>
        toAutomodeError("Automode failed to spawn a Delamain peer.", cause),
      ),
    );
```

> v1 hard-codes confined+yolo+host for every automode spawn (the autonomous toggle is always confined — Q7/Q8). Making these operator-tunable `AutomodePolicy` fields is deferred; if desired later, add `peerConfine`/`peerEgress` to `AutomodePolicy` (`gits.ts:557`) + `defaultPolicy` (`AutomodeSupervisor.ts:150`) + `AutomodePolicyUpdateInput` and read them here.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/server && rtk vitest run src/gits/Layers/AutomodeSupervisor.test.ts src/gits/Layers/AutomodeDriver.test.ts`
Expected: PASS (the new case + all existing automode tests — the driver suite still green since spawn is mocked).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts
rtk git commit -m "feat(automode): autonomous dispatch spawns a confined --yolo peer (host egress)"
```

---

## Task 7 — End-to-end confinement verification (manual gate)

**Why:** unit tests prove the argv shape; only a real run proves the codex peer actually runs jailed. This is the gate before trusting the feature unattended.

**Files:** none (verification only; record results in `spikes/h0b-confined-codex/SPIKE_FINDINGS.md`).

- [ ] **Step 1: Point GITS at the modified delamain + the confine script**

In the GITS server environment set: `GITS_DELAMAIN_BIN=/home/joshua/dev/projects/delamain/dist/index.js` (after `npm run build` in delamain — or however the local `delamain` is invoked) and `GITS_CONFINE_BIN=/home/joshua/dev/projects/gitscode/scripts/gits-confine.sh`. Ensure a codex peer home is logged in at `~/.delamain/peer-codex-home`.

- [ ] **Step 2: Drive one confined autonomous spawn**

Boot the GITS server (headless harness per memory `gits-headless-verify-harness`), arm `mode:"autonomous"` (kill switch off, `requireApprovalForPeerSpawn:false`, `allowedRepos:[<throwaway repo>]`) on a throwaway git repo, enqueue one trivial goal (e.g. "create HELLO.txt"), and let the driver dispatch it.

- [ ] **Step 3: Confirm the peer is jailed**

While the peer runs (or from its log): confirm the codex process was launched via `gits-confine.sh` (the peer log line shows `starting: …/gits-confine.sh --worktree … --profile peer …`), and that `GITS_CONFINED=peer:<peerId>` is in the codex process env. Confirm the peer **cannot** see host secrets: the spike's secret-visibility check (Task 2 Step 3) reproduced through the live path shows `~/.codex`, `~/.gits/hermes`, telegram creds absent. Confirm the trivial goal completed (HELLO.txt committed on the peer branch) and the goal reconciled to `completed`.

- [ ] **Step 4: Record the result** in `SPIKE_FINDINGS.md` (works / doesn't, the observed jail evidence). If it fails, this is a real BLOCKER — do not mark Plan 2 done; debug the recipe (Task 2) and the wiring (Task 5).

---

## Self-Review

**1. Spec coverage** (`autonomous-toggle.md` Q7/Q8, H0b):

| Spec element                                                                                | Task                                                                                                                 |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Keep `--yolo` (full autonomy) for the trusted repo                                          | Task 6 (`yolo:true`) + Task 5 (passes through to codex `--dangerously-bypass-approvals-and-sandbox`)                 |
| Jail the peer to the assigned repo (bubblewrap, secrets hidden)                             | Task 5 (wrap in `gits-confine.sh --profile peer`) + Task 7 (verify)                                                  |
| Modify delamain so `delamain spawn` launches the child through `gits-confine.sh` (Option 1) | Task 5                                                                                                               |
| `CODEX_HOME` reachable inside the jail (the real gap)                                       | Task 1 (`--setenv`) + Task 2 (spike) + Task 5 (encode)                                                               |
| Egress = `host` (unfiltered, accepted v1 residual risk; `proxy=` deferred)                  | Tasks 3/4/6 (`egress:"host"`); `off/host` only in the contract                                                       |
| codex-only (cursor never auto-routed)                                                       | Scope note; Task 5 wraps codex only                                                                                  |
| GITS keeps calling `delamainAdapter.spawnPeer` (delamain stays peer manager)                | Tasks 3/4/6 (add flags, not a new path)                                                                              |
| Fail-closed if `bwrap` missing                                                              | inherited from `gits-confine.sh:47` (`die` exit 70) → spawn fails → goal reconciles `failed` + driver halts (Plan 1) |

**2. Placeholder scan:** The one genuine unknown (exact confined-codex recipe) is handled by an explicit **spike (Task 2)** with concrete candidate commands and a recorded decision, not a vague "figure it out." Task 5's code uses Recipe A concretely with an explicit instruction to adjust to the spike's validated recipe. No other placeholders.

**3. Type/flag consistency:** `confine`/`egress` field names identical across contract (Task 3), `spawnArgs` (Task 4), driver call (Task 6). `--confine`/`--egress`/`--setenv` flag spellings identical across `gits-confine.sh` (Task 1), delamain threading (Task 5), and `spawnArgs` (Task 4). `egress` literal set `["off","host"]` consistent contract↔driver. `buildConfinedCommand` signature identical in test and impl (Task 5).

**Known v1 simplifications (documented):** egress unfiltered (`host`) — Q7 residual risk, full allowlist is H0c. Confine/yolo/egress hard-coded for automode rather than policy-tunable (Task 6 note). Cursor unconfined (never auto-routed).

---

## Execution Handoff

Plan 2 spans two repos and includes a spike + a manual integration gate, so it is **not** purely mechanical. Recommended:

- Tasks 1, 3, 4, 6 (gitscode, pure TDD) → subagent-driven, isolated worktree off `origin/gits`.
- Task 5 (delamain) → its own worktree/branch; export+builder is TDD, the spawn wiring is integration.
- Tasks 2 & 7 (spike + e2e) → run by the human/controller against a real logged-in codex peer; they gate trust and cannot be faked.

Open the gitscode changes as a PR to `gits` and the delamain changes as a PR to delamain's default branch; they must land together (the `--confine` flag is produced by gitscode and consumed by delamain).

**Two execution options (per writing-plans):**

1. **Subagent-Driven (recommended)** for the TDD tasks (1,3,4,5,6); human runs the spike/e2e (2,7).
2. **Inline Execution** with checkpoints.

Which approach — and should I execute now, or is this plan for review first?
