# Repository Workspace Profiles Design

## Goal

Keep personal and BTS repositories visually separate and route coding work through the intended provider accounts without changing the account used by the GITS control plane.

## Terminology

- A **repository profile** is either `personal` or `work`.
- A **control-plane agent** is GITS infrastructure such as Motoko, Hermes, planning, routing, or supervision.
- A **repo agent** is an interactive coding session or automated worker that reads or writes a target repository.

## User Experience

The sidebar adds a `Personal | Work` switch above the project list. It filters projects by their effective repository profile; it does not change existing or running sessions.

Repositories under configured work parent folders are classified as Work automatically. Each project also has a Personal/Work override in its project menu. Projects outside configured work roots default to Personal.

The model/provider picker always shows the selected account label. A Work repo using a personal Codex or Cursor account also shows a persistent warning badge for that session.

## Account Routing

| Activity                         | Personal repository            | Work repository                |
| -------------------------------- | ------------------------------ | ------------------------------ |
| GITS/Motoko/Hermes control plane | Dedicated Personal Codex OAuth | Dedicated Personal Codex OAuth |
| Interactive Codex coding         | Personal Codex                 | BTS Codex                      |
| Automated repo-writing worker    | Personal Codex                 | BTS Codex                      |
| Cursor worker                    | Personal Cursor                | BTS Cursor                     |
| Claude worker                    | Personal Claude                | Personal Claude                |

Routing settings reference stable provider instance IDs rather than email labels. The initial Work profile maps Codex to the BTS SSO instance, Cursor to the BTS SSO instance, and Claude to the existing personal instance.

Control-plane routing is independent of the sidebar, repository-profile mappings, and target repository. Hermes owns a dedicated OAuth chain under its `HERMES_HOME`; that chain must be authenticated with the Personal Codex account and is never populated from a repository worker's provider instance.

Repo-agent routing uses the target repository's effective profile. The resolved provider instance is pinned when a session or worker starts, so moving a repository, changing its override, or switching sidebar profiles cannot silently change an active session's account.

## Repository Classification

Work roots are configured per environment because filesystem paths belong to the machine hosting that environment. Classification uses normalized paths and path-segment containment, not string-prefix matching.

The effective profile is resolved in this order:

1. Use the project's explicit profile override when present.
2. Otherwise, classify it as Work when its normalized workspace root is inside a configured work root.
3. Otherwise, classify it as Personal.

Moving a repository into or out of a work root changes its automatic classification. An explicit override remains stable until removed.

## Fallback Behavior

GITS never switches accounts silently.

If BTS Codex or Cursor usage is exhausted, unavailable, or deliberately bypassed, the user may select a personal instance. Before launch, GITS warns that personal usage will be spent on a Work repository. Confirmation applies only to the new session or worker and does not change the repository profile or profile defaults.

When provider telemetry reports exhaustion, GITS may offer `Continue with personal account`. Telemetry is advisory: lack of reliable usage data does not prevent manual account selection.

If the dedicated Personal Codex OAuth chain for the control plane is missing or unauthenticated, GITS reports a configuration error rather than copying or falling back to a BTS provider-instance credential.

## Data and Ownership

- Shared contracts define the two repository-profile values and the minimal routing settings shape.
- Environment settings own normalized work roots and provider-instance mappings.
- Project metadata owns only an optional repository-profile override.
- Session state owns the resolved provider instance and the instance-specific acknowledged fallback warning.
- Client settings own the last selected sidebar profile because it is presentation state.

One shared resolver computes effective repository profile and account routing for interactive sessions and automated workers. UI components display its result but do not reproduce routing rules.

## Error and Edge-Case Behavior

- Invalid or missing work roots are ignored and surfaced in settings without hiding projects.
- A path that merely shares a textual prefix with a work root is not classified as Work.
- Missing profile mappings require account selection; Work sessions do not silently consume personal usage.
- Existing sessions retain their pinned account when settings change.
- The sidebar always provides access to both profiles, including when one is empty.

## Testing

- Add focused resolver tests for root matching, path boundaries, manual overrides, unknown paths, and per-environment roots.
- Add routing tests for every row in the account-routing table, including the invariant that control-plane agents always use personal Codex.
- Add a session test proving that a resolved provider instance remains pinned after profile settings change.
- Add UI coverage for sidebar filtering, account labels, and the warned Work-to-personal fallback.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before implementation is considered complete. Run `bun lint:mobile` only if native mobile code changes.

## Deliberate Omissions

- No separate GITS installation, database, or conversation store for Work.
- No automatic account fallback.
- No dependence on provider email addresses for routing.
- No fabricated quota accounting when a provider does not expose reliable telemetry.
- No additional repository categories until a real need appears beyond Personal and Work.
- No profile-routed Delamain workflows until Delamain can enforce provider identity and engine per workflow leaf. Routed peer workers remain supported; routed workflow attempts fail closed instead of inheriting ambient credentials.
