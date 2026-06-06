# Verifier-critic — live codex smoke results

Date: 2026-06-06 · `scripts/verifier-codex-smoke.sh` · codex-cli 0.136.0 · model `gpt-5.4-mini`

## Result: ✅ PASS

A real `codex exec` reviewer run against a sample diff + acceptance criterion returned a clean,
parseable verdict:

```json
{"verdict":"pass","confidence":"high","reasons":["The diff changes the implementation from subtraction to addition, so add(a,b) now computes the arithmetic sum."],"missed":[]}
```

## What the smoke found (and fixed)

1. **codex reads the prompt from STDIN, not a positional arg.** Passing the prompt positionally
   with stdin left open hangs ("Reading additional input from stdin..." → timeout). Fixed
   `GitsCodexVerifierAdapter` to send the prompt via `ProcessRunner` `stdin` and added
   `--skip-git-repo-check`. Final invocation: `codex exec --sandbox read-only --skip-git-repo-check -m <model>` with the prompt on stdin.
2. **Auth.** The isolated peer codex home (`~/.delamain/peer-codex-home`) had a **stale** token
   (HTTP 401 "refresh token already used") — it diverges from the primary once `~/.codex` refreshes.
   Since the verifier is a *trusted* server-side reviewer (not an untrusted peer), the adapter now
   defaults `CODEX_HOME` to the primary `~/.codex` (override via `GITS_VERIFIER_CODEX_HOME`). To use
   the peer home instead, refresh it: `CODEX_HOME=~/.delamain/peer-codex-home codex login`.
3. **Cost.** ~26.9k tokens for one small verification call (codex exec overhead + reasoning).
   This counts toward the codex rate-limit reserve (design Rev 2: pause auto-spawn at 80% weekly).

## Run it

```bash
scripts/verifier-codex-smoke.sh           # uses ~/.codex by default
GITS_VERIFIER_MODEL=gpt-5.5 scripts/verifier-codex-smoke.sh
```
