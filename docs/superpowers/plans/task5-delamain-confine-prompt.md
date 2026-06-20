# Handoff Prompt — H0b Task 5: run the codex peer under `gits-confine.sh`

> Self-contained task prompt. Hand to a fresh agent / delamain peer / codex peer. It assumes **zero prior context**. Everything needed is below.

---

## What you're building

Make `delamain spawn` launch its **codex** child process **jailed** to the peer's worktree (bubblewrap, all host secrets but the one provider credential invisible) while keeping `--yolo` (full autonomy, no approval prompts). This is the "sandcastle" model: total freedom inside a locked box. It's **H0b Task 5** of the GITS autonomous-toggle roadmap.

You implement the wrap: when `delamain spawn --confine` is passed, the codex child runs as
`gits-confine.sh --profile peer … -- codex exec …` instead of bare `codex exec …`.

**Codex-only.** The autonomous loop only ever spawns codex peers (cursor is operator-manual and never auto-routed), so wrap **codex only** — leave `cursorRunner.ts` untouched.

## Repo, branch, workspace

- Repo: **delamain** (`/home/joshua/dev/projects/delamain`, remote `git@github.com:Ecko95/delamain.git`).
- A clean worktree is already prepped: **`/home/joshua/dev/projects/delamain-confine`** on branch **`feat/confine-codex-peer`** (off `origin/main`, `npm install` + `npm run build` done). Work there. (If it's gone: `git -C /home/joshua/dev/projects/delamain worktree add /home/joshua/dev/projects/delamain-confine -b feat/confine-codex-peer origin/main`, then `npm install`.)
- Toolchain: TypeScript/ESM → compiled to `dist/`. Tests are **`node --test`** over compiled JS: `npm run build && node --test tests/<file>.test.mjs`. Follow the **pure-function** test style already used for `buildCursorArgs` (`tests/cursorRunner.test.mjs`).
- **Do NOT touch** `/home/joshua/dev/projects/delamain` itself — it has unrelated uncommitted WIP on another branch.

## The runtime dependency (already shipped — do not re-implement)

`gits-confine.sh` lives in the **gitscode** repo and is already H0b-ready on **PR #27** (`feat/confined-yolo-spawn`): it has the `--setenv KEY=VAL` passthrough and a DNS fix (binds the `/etc/resolv.conf` symlink target so an `--egress host` peer can reach the model API). At runtime GITS sets `GITS_CONFINE_BIN` to its absolute path. **You consume it; you don't change it.**

## The VALIDATED recipe (from the spike — proven to the live-API boundary)

A confined `codex exec` that authenticates and reaches the OpenAI API on this host is:

```bash
gits-confine.sh \
  --worktree   "$WORKTREE" \           # the peer's git worktree (rw-bound, chdir'd)
  --profile    peer \
  --label      "$PEER_ID" \
  --egress     host \                  # shared net (DNS fix handles resolution); trusted-repo residual risk per Q7
  --ro         "$NODE_ROOT" \          # the node VERSION ROOT that contains codex (e.g. ~/.nvm/versions/node/v24.12.0)
  --cred       "$CODEX_HOME/auth.json" \
  --cred       "$CODEX_HOME/config.toml" \
  --setenv     "CODEX_HOME=$CODEX_HOME" \
  --setenv     "PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin" \   # $NODE_BIN = $NODE_ROOT/bin (has BOTH node and codex)
  -- codex exec --json -C "$WORKTREE" -
```

**Why `--ro $NODE_ROOT` + `--setenv PATH`:** `codex` is typically `~/.local/bin/codex` → symlink → `~/.nvm/versions/node/v<V>/bin/codex` (a node script needing `node`). The jail uses a fixed PATH and only auto-detects whatever `node` is first on the _caller's_ PATH — which may be a _different_ node version than codex's. So you must bind codex's **own** node version root (`--ro`) and put its `bin` dir (which holds both that `node` and `codex`) first on `PATH`. Full investigation + the failed/working recipes are in the gitscode repo at `spikes/h0b-confined-codex/SPIKE_FINDINGS.md` (PR #27).

`$CODEX_HOME` = `process.env.CODEX_HOME ?? ~/.delamain/peer-codex-home` (delamain already computes this — see anchor below).

## delamain code anchors (verbatim locations on `origin/main`)

- **The codex spawn to wrap** — `src/runner.ts:~46-67`:
  ```ts
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".delamain", "peer-codex-home");
  const child = spawn("codex", codexArgs, {
    cwd: args.repo,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  ```
  Prompt is piped to the child's stdin (`child.stdin.write(prompt); child.stdin.end()`) — codex reads it from the trailing `-`. **Preserve stdin passthrough** (bubblewrap forwards stdin).
- **`buildCodexArgs`** — `src/runner.ts:~223` — currently **module-private** (`function buildCodexArgs`). `buildCursorArgs` (in `cursorRunner.ts`) IS exported and unit-tested — match that pattern: **export** `buildCodexArgs` so it can be tested.
- **CLI parse** — `src/cli.ts` `spawn` handler — parses `--yolo`, `--sandbox`, `--engine`, `--model` and passes them into `spawnPeer({...})`. Add `--confine` (boolean) and `--egress` (string, default `"host"` when confine on).
- **run-peer threading** — `src/peerManager.ts` `spawnRunner` (~351-407) re-serialises `--model`/`--sandbox`/`--yolo`/`--engine` onto the detached `delamain run-peer` argv. Add `--confine`/`--egress` the same way.
- **runner arg parse** — `src/runner.ts` `parseArgs` (~268-310) reads those flags back into `RunnerArgs`. Add `confine?: boolean; egress?: string` to `RunnerArgs` and parse them.
- `args.repo` (inside the runner) **is** the peer worktree path → your `--worktree`.

## Implement (TDD)

### 1. Pure builder (testable) — `src/runner.ts`

Export `buildCodexArgs`, and add a **pure** `buildConfinedCommand` (toolchain dirs passed IN, so it's pure like `buildCursorArgs`):

```ts
export interface ConfinedSpawnInput {
  readonly confineBin: string; // GITS_CONFINE_BIN, or "" to run unconfined
  readonly worktree: string;
  readonly codexHome: string;
  readonly egress: string; // "host" | "off"
  readonly label: string;
  readonly toolchainRootDir: string; // node version root to --ro bind (contains node + codex)
  readonly toolchainBinDir: string; // node version bin dir to put first on PATH
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
    "--ro",
    input.toolchainRootDir,
    "--cred",
    `${input.codexHome}/auth.json`,
    "--cred",
    `${input.codexHome}/config.toml`,
    "--setenv",
    `CODEX_HOME=${input.codexHome}`,
    "--setenv",
    `PATH=${input.toolchainBinDir}:/usr/local/bin:/usr/bin:/bin`,
  ];
  return { command: input.confineBin, args: [...pre, "--", input.engineCmd, ...input.engineArgs] };
}
```

### 2. Toolchain resolver (impure; called at the spawn site) — `src/runner.ts`

```ts
import { execFileSync } from "node:child_process";
// Resolve the node version root + bin dir that own the `codex` executable, so the jail can
// bind them. codex is usually ~/.local/bin/codex -> ~/.nvm/versions/node/v<V>/bin/codex.
export function resolveCodexToolchain(): { rootDir: string; binDir: string } {
  let p = execFileSync("bash", ["-lc", "command -v codex"], { encoding: "utf8" }).trim();
  // follow a single symlink hop if present (the ~/.local/bin shim → the real nvm bin/codex)
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) p = resolve(dirname(p), readlinkSync(p));
  } catch {
    /* ignore */
  }
  const binDir = dirname(p); // .../v<V>/bin  (holds both node and codex)
  const rootDir = dirname(binDir); // .../v<V>      (the version root to --ro bind)
  return { rootDir, binDir };
}
```

(Import `lstatSync`, `readlinkSync` from `node:fs`; `dirname`, `resolve` from `node:path`. Use `bash -lc` so the LOGIN PATH — which has codex — is consulted, matching how delamain finds `codex` at runtime.)

### 3. Wire it into the real spawn — `src/runner.ts:~46-67`

Replace the bare `spawn("codex", codexArgs, {...})` with:

```ts
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".delamain", "peer-codex-home");
const confineBin = args.confine ? (process.env.GITS_CONFINE_BIN ?? "gits-confine.sh") : "";
const toolchain = confineBin ? resolveCodexToolchain() : { rootDir: "", binDir: "" };
const { command, args: spawnArgv } = buildConfinedCommand({
  confineBin,
  worktree: args.repo,
  codexHome,
  egress: args.egress ?? "host",
  label: args.peerId,
  toolchainRootDir: toolchain.rootDir,
  toolchainBinDir: toolchain.binDir,
  engineCmd: "codex",
  engineArgs: codexArgs,
});
append(log, `[delamain] starting: ${command} ${spawnArgv.join(" ")}\n`);
// ...keep the existing updatePeer(...) status write...
const child = spawn(command, spawnArgv, {
  cwd: args.repo,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CODEX_HOME: codexHome },
});
```

Keep the stdin write unchanged.

### 4. Thread `--confine`/`--egress` through cli.ts → spawnRunner → parseArgs

Mirror exactly how `--yolo`/`--sandbox` flow today (see anchors). `--confine` is a boolean; `--egress` is a string defaulting to `"host"` when confine is on.

### 5. Tests — `tests/runner.test.mjs` (new, `node --test`)

Unit-test `buildConfinedCommand` purely (no child process):

- With `confineBin` set: assert `command === confineBin`; the argv has the confine flags **before** a `--` separator and the exact engine argv **after** it; assert the `--ro <rootDir>`, both `--cred` paths, `--setenv CODEX_HOME=…`, and `--setenv PATH=<binDir>:…` are present and correctly ordered.
- With `confineBin === ""`: assert it returns the raw `{ command: "codex", args: [...engineArgs] }` (unconfined passthrough).
  Run: `npm run build && node --test tests/runner.test.mjs tests/cursorRunner.test.mjs` → all green.

## Commit + PR

```bash
git -C /home/joshua/dev/projects/delamain-confine add src/cli.ts src/peerManager.ts src/runner.ts tests/runner.test.mjs
git -C /home/joshua/dev/projects/delamain-confine commit -m "feat(confine): run codex peer under gits-confine.sh when --confine (keep --yolo)"
git -C /home/joshua/dev/projects/delamain-confine push -u origin feat/confine-codex-peer
gh pr create --repo Ecko95/delamain --base main --head feat/confine-codex-peer \
  --title "feat(confine): jail codex peers via gits-confine.sh (H0b)" \
  --body "delamain half of GITS H0b. When 'delamain spawn --confine', the codex child runs through gits-confine.sh --profile peer (worktree-only, single-cred jail) while keeping --yolo. Pairs with gitscode PR #27 (gits-confine.sh --setenv + DNS fix). See gitscode spikes/h0b-confined-codex/SPIKE_FINDINGS.md for the validated recipe."
```

## End-to-end validation (Task 7 — the trust gate)

Unit tests prove the argv shape; only a real run proves the jail. With `GITS_CONFINE_BIN` pointing at the PR-#27 `gits-confine.sh` and `GITS_DELAMAIN_BIN` pointing at this branch's `dist/index.js`:

1. **First, a fresh peer login** — the spike's token was stale (HTTP 401 "refresh token already used"). Run `CODEX_HOME=~/.delamain/peer-codex-home codex login` so the peer home has a valid token.
2. `delamain spawn --confine --yolo --repo <throwaway> --prompt "create HELLO.txt with HELLO"` and confirm: the peer log shows `starting: …/gits-confine.sh --worktree … --profile peer …`; the codex process env has `GITS_CONFINED=peer:<id>`; the peer **cannot** see host secrets (`~/.codex`, `~/.gits/hermes`, telegram creds absent); and HELLO.txt lands on the peer branch.
3. If it fails, debug the toolchain resolution (step 2) + the recipe in `SPIKE_FINDINGS.md` — do **not** claim done until a real confined run completes.

## Coordination / merge

- This produces a **delamain PR** (→ delamain `main`). H0b is only functional once **both** it and **gitscode PR #27** (→ `gits`) are merged — #27 ships the `gits-confine.sh` `--setenv`/DNS that this depends on at runtime.
- gitscode `origin/gits` has advanced (PR #28 merged) — **rebase PR #27 onto current `origin/gits` before merging** (it touches `AutomodeSupervisor.ts`/contracts which also overlap the open Plan-1 PR #25; whichever merges second rebases).
- Recommended merge order: delamain PR + PR #27 together, then run Task 7 e2e against the merged state.
