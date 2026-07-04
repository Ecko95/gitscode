# Plan 24 — Git Command Confinement for Agent Sessions (W2.6c)

**Status: PENDING OPERATOR APPROVAL**

**Workstream:** W2 — Worktree lifecycle / session isolation  
**Task:** W2.6c — design note only. No production code, no contract changes. Gates on operator sign-off before any implementation.

**Predecessor context:**

- `.plans/19-version-control-phase-1-vcs-driver-foundation.md` — VcsDriver foundation (policy library)
- `.plans/21-worktree-graveyard.md` — worktree lifecycle and session scoping
- `.plans/23-actor-identity.md` — actor kinds (`operator/supervisor/delamain`) and deny matrix; observability relationship
- W2.6b investigation (merged, PR #84) — established the enforcement gap this plan closes

---

## 1. Problem Statement (W2.6b Evidence)

`SessionScopedVcsDriver` (code: `apps/server/src/vcs/SessionScopedVcsDriver.ts`) is a correct policy library. It guards:

1. **cwd containment** — every `cwd` must `path.resolve()` inside `allowedRoot` (`SessionScopedVcsDriver.ts:53–55`)
2. **force-push to protected branches** — `PROTECTED_BRANCHES = new Set(["main", "master", "gits"])`, rejected without `supervisorOverride` (`SessionScopedVcsDriver.ts:8`, `65–96`)
3. **merge/rebase deny** — from session context only, routes to supervisor AutomodeLanding machinery (`SessionScopedVcsDriver.ts:98–114`)

**It has zero enforcement point.** Each provider spawns an external subprocess whose AI agent invokes `git` directly as a CLI binary in its shell. The call chain is:

- **Codex** (`CodexSessionRuntime.ts:764–782`): `spawner.spawn(ChildProcess.make(options.binaryPath, ["app-server"], { cwd, env }))` — Codex app-server runs in the worktree; the AI agent inside runs shell commands including `git` directly.
- **Claude** (`ClaudeAdapter.ts:2992`): `query({ ..., env: claudeEnvironment, ... })` passes `env` to the Agent SDK which spawns `claude --run` or equivalent; the claude process then spawns subcommands (bash, git) as children.
- **Cursor** (`CursorAdapter.ts:540–558`): `makeCursorAcpRuntime({ ..., cwd, environment })` — ACP child process launched in the worktree; agent runs arbitrary shell.
- **OpenCode** (`OpenCodeAdapter.ts:1051–1060`): `connectToOpenCodeServer({ binaryPath, serverUrl, environment })` — OpenCode server runs; AI agent inside executes git.

None of these call paths route through `SessionScopedVcsDriver`. The env for each child is built by `buildChildEnv` / `mergeProviderInstanceEnvironment` (`ProviderInstanceEnvironment.ts:78–109`), which filters credentials but **does not inject any git policy enforcement**.

The gap: `SessionScopedVcsDriver` is called by server-side VCS service methods (status broadcaster, checkpoint reactor, automode landing). It is never in the path of a `git` binary executed by the AI agent inside the provider subprocess.

---

## 2. Primary Approach: PATH-Injected Git Shim

### 2a. Injection Point

`buildChildEnv` (`apps/server/src/provider/ProviderInstanceEnvironment.ts:78`) is the single place that constructs the environment passed to every provider child process. `PATH` is in `ALLOWED_EXACT` (line 15) and passes through from the server environment.

The shim is injected by modifying how callers of `buildChildEnv`/`mergeProviderInstanceEnvironment` prepend a session-scoped directory to `PATH`:

```
/tmp/gits-shims/<sessionId>/git    ← the shim executable
/tmp/gits-shims/<sessionId>/       ← prepended to PATH in child env
… rest of PATH: /usr/local/bin:/usr/bin:/bin …
```

This is the only required change to the production env-build path. The shim directory contains a single executable named `git`. When the AI agent runs `git status`, the shell resolves to the shim first.

**Where the injection happens:** The session-start code paths that call `mergeProviderInstanceEnvironment` and then pass `processEnv` into the adapter/runtime:

- `CodexDriver.create` (`CodexDriver.ts:117`): `const processEnv = mergeProviderInstanceEnvironment(environment)`
- `ClaudeDriver.create` (`ClaudeDriver.ts:120`): same call
- `CursorDriver.create` (`CursorDriver.ts:105`): same call
- `OpenCodeDriver.create`: same call (confirmed present in `OpenCodeAdapter`)

The injection is at driver `create()` time, before the processEnv is closed over by adapter closures. One line per driver: prepend `GITS_GIT_SHIM_DIR` to `PATH` in `processEnv`.

### 2b. Policy-Sharing Mechanism: Option (b) — Env-Param + Inlined Pure Check

Three options evaluated:

| Option | Mechanism | Latency | Complexity | Trust |
|--------|-----------|---------|------------|-------|
| (a) Shared pure TS module | Shim imports policy from `SessionScopedVcsDriver`'s extracted pure module | Zero | Medium — shim must be a TS/Node binary, complicates deployment | High — same code path |
| (b) Env-var params + inlined check | Server sets `GITS_ALLOWED_ROOT`, `GITS_PROTECTED_BRANCHES`, `GITS_SUPERVISOR_OVERRIDE` at spawn; shim reads them and runs an equivalent inlined pure check | Zero | Low — shim is a small standalone script | High — params come from server; no IPC |
| (c) UNIX socket callback | Shim calls back to server per git invocation to authorize | ~1ms per call | High — server must expose socket, shim must locate it | High — server is authoritative |

**Recommendation: Option (b).**

Rationale: The policy is three simple predicates (path containment, force-push branch check, merge/rebase block). They can be faithfully reproduced in ~40 lines of shell or Node without any shared import. The policy params (allowedRoot, protected branches) are known at session-start and do not change mid-session. Option (c) adds IPC round-trip latency on every git call and a new failure mode (socket unavailable → shim blocks). Option (a) requires the shim to be a compiled TypeScript binary, which complicates the deployment artifact; shell or simple Node is sufficient.

**Env vars the server sets at shim-dir creation time:**

```
GITS_ALLOWED_ROOT=/path/to/session/worktree
GITS_PROTECTED_BRANCHES=main,master,gits
GITS_SUPERVISOR_OVERRIDE=0
GITS_REAL_GIT=/usr/bin/git          # resolved once at shim-dir creation
```

These are added to `processEnv` alongside the `PATH` prepend, scoped to the child's env (they do not affect the server process itself).

### 2c. Shim Behaviour

The shim is a single executable (shell script or minimal Node script, ~50–80 lines). Logic:

1. Parse `argv[1]` (the git subcommand).
2. Classify the command (see table below).
3. For `PASS_THROUGH`: exec the real git immediately (`exec $GITS_REAL_GIT "$@"`).
4. For `POLICY_CHECK`: apply the relevant guard. On allow, exec real git. On deny, print a structured denial message to stderr and exit non-zero.

**Command classification:**

| Category | Commands | Action |
|----------|----------|--------|
| Read-only pass-through | `status`, `log`, `diff`, `show`, `branch -l`, `branch --list`, `remote -v`, `ls-files`, `rev-parse`, `describe`, `shortlog`, `stash list`, `tag -l`, `blame`, `cat-file` | `PASS_THROUGH` |
| Write with cwd check | `add`, `commit`, `restore`, `checkout`, `switch`, `stash push`, `stash pop`, `stash drop`, `clean`, `apply`, `cherry-pick`, `tag` (create) | `POLICY_CHECK` (allowedRoot containment; `cwd` is the process working directory, resolved via `realpath`) |
| Protected write | `push` (with `--force` / `-f` / `--force-with-lease`) to protected branch | `POLICY_CHECK` (force-push guard + protected-branch check) |
| Merge/rebase deny | `merge`, `rebase` | `DENY` unconditionally from session context |
| Worktree ops | `worktree add`, `worktree remove`, `worktree prune` | `DENY` — sessions must not manipulate the worktree graph |
| Remote mutation | `remote add`, `remote remove`, `remote set-url` | `DENY` — sessions must not alter remote config |
| Config mutation | `config --global`, `config --system` | `DENY` — only local config (`config --local`) allowed, and only inside allowedRoot |
| Unknown/unclassified | anything not above | `PASS_THROUGH` with a logged warning — deny-by-default is NOT chosen here because it would break legitimate agent workflows; real isolation requires OS-level confinement (see §5) |

**CWD containment check in the shim:**

```sh
resolved=$(realpath "$(pwd)" 2>/dev/null || pwd)
case "$resolved" in
  "$GITS_ALLOWED_ROOT"|"$GITS_ALLOWED_ROOT"/*) : ;;
  *) echo "gits-git-shim: denied: cwd '$resolved' outside allowed root '$GITS_ALLOWED_ROOT'" >&2; exit 128 ;;
esac
```

`realpath` resolves symlinks — equivalent to the `FileSystem.realPath` upgrade path noted in `SessionScopedVcsDriver.ts:52`.

### 2d. The Confinement Line (Which Spawn Paths Get the Shim)

**Gets the shim:** Every provider subprocess launched via `buildChildEnv` / `mergeProviderInstanceEnvironment` in a driver `create()` call. Concretely:

- Codex child (`CodexSessionRuntime.ts:764`)
- Claude Agent SDK subprocess (env passed via `query()` options at `ClaudeAdapter.ts:2992`)
- Cursor ACP runtime (`CursorAdapter.ts:542`)
- OpenCode server process (`OpenCodeAdapter.ts:1054`)

The shim PATH entry is injected by prepending to `processEnv.PATH` **inside `mergeProviderInstanceEnvironment`** when a `sessionId` / `allowedRoot` is present, or by a wrapper called from each driver `create()` before processEnv is passed to the adapter. The latter is preferred (caller is explicit, `mergeProviderInstanceEnvironment` stays a pure env-filter).

**Does NOT get the shim:** The server process's own `process.env`. The server's git operations — `AutomodeLanding` (`gits/Layers/AutomodeLanding.ts`), `GitManager` (`git/GitManager.ts`), `VcsStatusBroadcaster` (`vcs/VcsStatusBroadcaster.ts`), `CheckpointReactor` — all use `VcsDriver` methods that call the real `git` binary directly through the server's own PATH. The shim directory is never added to the server process's PATH. This is guaranteed by construction: the shim PATH prepend only exists in the env object that is closed over inside the adapter, never applied back to `process.env`.

---

## 3. Honesty Section — What This Is and Isn't

A PATH shim is **defense-in-depth, not a security sandbox.**

A determined or malicious agent bypasses it trivially:

- `git` by absolute path: `/usr/bin/git commit -m "escape"` — shim never invoked.
- Dynamically find git: `which git | tail -1` after unsetting PATH, then call it.
- libgit2 bindings (Rust, Python, Node): `git2` crate, `pygit2`, `nodegit` — no exec, no PATH resolution.
- Any other tool that writes to the filesystem: `jj`, `gh`, `hub`, or simply `echo > file`.
- Rewrite PATH inside the shell: `export PATH=/usr/bin:$PATH` before running git.

**The shim's real value is stopping honest-agent accidents:**

- Wrong-repo commits when a tool's cwd drifts outside the worktree.
- Force-push to `gits` or `main` from an agent session.
- Stray merges that bypass the AutomodeLanding integration machinery.
- Provides an observable policy-violation signal (see §6).

Real isolation against a determined bypass requires OS-level confinement (§5).

---

## 4. Observability

The shim runs as a subprocess; it cannot directly call Effect services. Cheapest observable path:

**Structured stderr line.** On denial, the shim writes one JSON line to stderr:

```json
{"gits_shim":"denied","cmd":"push","args":["--force","main"],"cwd":"/path/to/worktree","reason":"force-push-to-protected-branch","session_id":"<session>","ts":"2026-07-04T00:00:00Z"}
```

The provider adapters already consume their child's stderr streams (e.g., `CodexSessionRuntime` reads stderr for log lines, `ClaudeAdapter` reads the SDK's tool output). The server can detect `"gits_shim":"denied"` in stderr and:

1. Emit a structured log event (cheapest — zero new infrastructure).
2. Surface it as a provider runtime event so the UI can display "git operation blocked by session policy" (requires a new `ProviderEvent` variant — defer to implementation).

**Relation to actor-identity (plan 23):** A shim denial is a `delamain`-actor action (the AI agent inside the session is the delamain actor). The denial conceptually maps to the deny matrix row for `delamain` actor × `git write outside worktree` operation. Full integration with the actor-identity envelope (plan 23) requires that plan to be implemented first; for now the shim's stderr log establishes the observable signal independently.

---

## 5. Shim vs OS-Level Confinement

| Dimension | PATH Shim (v1 proposal) | OS-Level (Linux namespaces / `bwrap` / seccomp) |
|-----------|------------------------|--------------------------------------------------|
| Bypass resistance | Trivial bypass (absolute path, libgit2, rewrite PATH) | Strong — process cannot see filesystem outside the mount namespace; syscalls restricted by seccomp filter |
| Implementation complexity | Low — ~60 lines shell/Node + 5-line env injection | Medium-High — bwrap invocation, seccomp filter, UID mapping; interacts with any tools the provider binary needs (Node, npm caches, etc.) |
| Portability | Works everywhere PATH resolution works (Linux, macOS, WSL) | Linux namespaces: Linux only. `bwrap` available on most distros; not available in all container environments. WSL2 host: kernel namespaces available. macOS: sandboxd/Seatbelt (different API), not standardized |
| VPS target compatibility | Full | Check: VPS typically Linux; need `bwrap` installed or kernel cap for user namespaces |
| WSL2 host compatibility | Full | User namespaces available on WSL2 Linux kernel 5.15+; the host reports kernel 6.6.87.2 — compatible |
| Per-session overhead | ~0ms (env var injection, no process overhead) | ~2–5ms per session spawn (bwrap setup); negligible at session cadence |
| Developer ergonomics | Transparent — agents see normal git errors | Agents see "permission denied" at the syscall level; harder to diagnose without the shim's structured message |
| Implementation risk | Low — shim is standalone, easily tested | Medium — incorrect seccomp filter can crash the provider binary; bwrap bind mounts must cover everything the provider needs |

**Recommendation: ship the shim as pragmatic v1, document OS-level as the future hardening path.**

Rationale: The honest bypass caveat (§3) means the shim's security value is limited to honest-agent accident prevention and observability — both of which it delivers cheaply. The engineering cost of bwrap/seccomp on four heterogeneous provider binaries (Codex Node binary, Claude SDK Node subprocess, Cursor Electron-derived binary, OpenCode binary) is significant, and portability to macOS development hosts would require a separate sandbox mechanism. The correct sequencing is: shim first (weeks, low risk), OS-level later if the threat model escalates to adversarial agents (months, medium risk, Linux-only first). A `ponytail:` marker in the shim code documents the ceiling and the upgrade path.

---

## 6. Failure Modes

| Failure | Behaviour | Mitigation |
|---------|-----------|------------|
| Real git not found on PATH | Shim's `exec $GITS_REAL_GIT` fails; git operation errors with "command not found" | Server resolves and stores `GITS_REAL_GIT` at shim-dir creation time by probing the server's own PATH before injecting the shim dir |
| Shim can't resolve `realpath` (symlink resolution fails) | Fall back to `pwd` without realpath; log a warning. Does not abort the operation. | Accept the weaker non-symlink check rather than hard-failing; log warns the operator |
| `cwd` outside allowedRoot at spawn | Shim denies write ops immediately. Read ops still pass through (agent can still inspect the repo). | Expected correct behaviour — the agent is operating outside its worktree boundary |
| Shim dir not cleaned up after session end | Stale shim dirs accumulate in `/tmp/gits-shims/` | Session teardown deletes the shim dir (tied to the session `Scope`); add a startup sweep for dirs older than 24 h |
| Two sessions share a shim dir (name collision) | Wrong policy params applied | Use a collision-resistant `sessionId` in the dir path (already a UUID in the system) |
| Shim executable not executable (wrong permissions) | Provider's shell cannot invoke the shim; git resolves to real binary — silently bypassed | Shim creation writes with `chmod 755`; test in integration test (see §8) |

---

## 7. Deliberately Cut

- **Option (a) shared pure TS module:** Rejected — requires a compiled Node binary artifact in the shim dir; shell is sufficient for the policy predicates.
- **Option (c) UNIX socket callback:** Rejected — IPC latency, new failure mode, significant complexity for what amounts to three simple predicates.
- **OS-level confinement (bwrap/seccomp):** Deferred — documented in §5; ship when the threat model demands it.
- **New `ProviderEvent` variant for shim denials:** Deferred — structured stderr log is sufficient observability for v1; surface as an event in a follow-up if operators need it in the UI.
- **Per-command allowlisting (deny-by-default):** Not chosen — would break legitimate agent git workflows in ways that are hard to predict; the shim's value is in stopping specific dangerous operations, not in being a whitelist gate.
- **Shim for the server's own git ops:** Explicitly excluded — server git runs via `VcsDriver` which already has the right policy; adding a shim to server PATH would create unnecessary complexity and a potential double-policy conflict.

---

## 8. Test Strategy (for Implementation Phase)

The shim is a small standalone executable — test it independently of the Effect runtime.

1. **Policy unit tests** (shell `bats` or Node `assert`-based `__main__` self-check):
   - `git commit` inside allowedRoot → allow
   - `git commit` outside allowedRoot → deny with exit 128
   - `git push --force main` → deny
   - `git push --force feature/my-branch` → allow
   - `git merge other` → deny
   - `git rebase main` → deny
   - `git worktree add ...` → deny
   - `git status` (read-only) → pass-through unconditionally
   - `git config --global ...` → deny; `git config --local ...` inside root → allow

2. **Integration test** (spawns a real child process with the shim on PATH):
   - Create a temp dir as the "allowed root"; create a shim dir with the env vars set.
   - Spawn a shell subprocess with `PATH=<shim_dir>:$PATH`.
   - Verify `git commit` inside root exits 0 (proxied to real git or faked).
   - Verify `git push --force main` exits 128.
   - Verify `/usr/bin/git status` (absolute path bypass) succeeds — confirming the shim does NOT protect against this, matching the documented honest limitation.

3. **Observability test:**
   - Verify the denial JSON line appears on stderr with expected fields.

No framework needed — `assert`-based self-check or a single `test_git_shim.sh` with `bats`.

---

## 9. Open Questions for the Operator

1. **Shim language:** Shell script is simplest for a posix-only target (Linux/WSL2); a Node script shares the runtime already present for Codex/Claude. Preference?
2. **Shim dir location:** `/tmp/gits-shims/<sessionId>/` is standard for transient session state. Alternative: inside the server's `T3CODE_HOME`. Which is preferable?
3. **`GITS_SUPERVISOR_OVERRIDE` policy:** Should supervisor-mode sessions (`supervisorOverride: true`) receive a shim at all, or skip it entirely? Current design: they receive the shim but with `GITS_SUPERVISOR_OVERRIDE=1` which passes force-push checks through. Operators may prefer the supervisor to bypass the shim entirely (simpler, already trusted).
4. **Deny vs warn for unclassified commands:** The current design passes through unclassified git subcommands with a logged warning rather than denying. Operators who prefer a stricter deny-unknown posture should say so; this changes the classification strategy.
5. **OS-level confinement priority:** Is the threat model limited to honest-agent accidents (shim is sufficient) or does it include adversarial agent behaviour (OS-level required sooner)?
6. **Integration with plan 23 (actor identity):** Should shim denials emit a `denied_command` receipt into the actor-identity event stream, or is structured stderr sufficient for the audit trail?

---

## Appendix: Files Read to Ground This Plan

| File | Relevance |
|------|-----------|
| `apps/server/src/vcs/SessionScopedVcsDriver.ts` | Policy library; predicates to replicate in shim |
| `apps/server/src/provider/ProviderInstanceEnvironment.ts` | `buildChildEnv` / `mergeProviderInstanceEnvironment` — injection point |
| `apps/server/src/provider/Drivers/CodexDriver.ts:117` | `processEnv = mergeProviderInstanceEnvironment(environment)` — driver spawn |
| `apps/server/src/provider/Drivers/ClaudeDriver.ts:120` | Same call for Claude |
| `apps/server/src/provider/Drivers/CursorDriver.ts:105` | Same call for Cursor |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts:760–768` | Codex child spawn: `env` + `cwd` passed to `ChildProcess.make` |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts:2992` | Claude: `env: claudeEnvironment` passed to `query()` |
| `apps/server/src/provider/Layers/CursorAdapter.ts:540–544` | Cursor ACP runtime spawn: `environment`, `cwd` |
| `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1051–1060` | OpenCode: `environment` to `connectToOpenCodeServer` |
| `apps/server/src/provider/Drivers/ClaudeHome.ts` | `makeClaudeEnvironment` — how Claude's HOME override works |
| `apps/server/src/gits/Layers/AutomodeLanding.ts` | Server-side git consumer (does NOT get the shim) |
| `apps/server/src/git/GitManager.ts` | Server-side git consumer (does NOT get the shim) |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts` | Server-side git consumer (does NOT get the shim) |
| `.plans/21-worktree-graveyard.md` | Worktree lifecycle context |
| `.plans/23-actor-identity.md` | Actor kinds + deny matrix; observability relationship |
