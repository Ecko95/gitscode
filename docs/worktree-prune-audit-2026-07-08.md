# Worktree prune audit — 2026-07-08

Audited all `~/dev/projects/gitscode-*` and `t3code-*` worktrees against `origin/gits` (`1dbaca5b9`). Merge status uses `git merge-tree --write-tree origin/gits <branch>` compared to the gits tree, which correctly detects squash-merges (two-dot diff is unreliable once `origin/gits` moves ahead).

## Safe to prune — fully merged (nothing lost)

| Worktree                              | Branch                                  | Why safe                                 |
| ------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `gitscode-resume-cmd-pi-harness-feat` | `pi-harness-feat`                       | squash-merged (#96/#97/#103)             |
| `t3code-gits-skills-intelligence`     | `feat/gits-skills-intelligence`         | squash-merged                            |
| `t3code-hermes-integration`           | `feat/hermes-first-class-module`        | ancestor of gits                         |
| `t3code-rtk-output-gateway`           | `feat/gits-rtk-output-gateway`          | ancestor of gits                         |
| `gitscode-hosted`                     | _(detached @ 1dbaca5b9)_                | exactly origin/gits                      |
| `t3code-work-main-delamain`           | `integrate/gits-delamain-split-to-main` | content in gits; **branch targets main** |
| `t3code-work-main-integrate`          | `integrate/gits-pending-to-main`        | content in gits; **branch targets main** |

## Keep — real unmerged work

`gitscode-audit-events` (`feat/audit-events`), `gitscode-headless` (`feat/gits-headless`), `gitscode-resume-cmd` (`feat/copy-resume-command`), `gitscode-visual-plan` (`feat/visual-plan`), `t3code-tailnet-hosting-refresh` (`research/hermes-motoko-integration`).

## Not touching

`gitscode-3b` (current), `t3code` (repo root), `t3code-main-integrate` (`main`), the `.delamain/*` peer worktrees (delamain-managed), and the `t3code/.claude/worktrees/agent-*` (harness auto-cleaned).

## One flag

`~/dev/projects/gitscode` (`docs/gits-vps-itx-report`) is merged (ancestor of gits) but looks like a **primary checkout**, not throwaway feature work — leave it unless intentionally retiring it.

## Proposed prune plan

- Remove all 7 worktrees in the "safe to prune" table.
- Delete branches for the 4 feature branches: `pi-harness-feat`, `feat/gits-skills-intelligence`, `feat/hermes-first-class-module`, `feat/gits-rtk-output-gateway`.
- Keep the two `integrate/*` branch pointers (they target `main`; only remove their worktrees).

Run from `gitscode-3b` (or any non-target checkout) so no in-use-worktree conflict:

```bash
git worktree remove ~/dev/projects/gitscode-resume-cmd-pi-harness-feat
git worktree remove ~/dev/projects/t3code-gits-skills-intelligence
git worktree remove ~/dev/projects/t3code-hermes-integration
git worktree remove ~/dev/projects/t3code-rtk-output-gateway
git worktree remove ~/dev/projects/gitscode-hosted
git worktree remove ~/dev/projects/t3code-work-main-delamain
git worktree remove ~/dev/projects/t3code-work-main-integrate

git branch -D pi-harness-feat feat/gits-skills-intelligence feat/hermes-first-class-module feat/gits-rtk-output-gateway
```
