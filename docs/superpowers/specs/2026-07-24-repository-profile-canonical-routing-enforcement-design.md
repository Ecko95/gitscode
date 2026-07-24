# Canonical Repository Routing and Fallback Enforcement Design

## Goal

Make repository-profile routing independent of equivalent path spelling and require the server to validate an explicit, instance-specific acknowledgement before the first Work-to-Personal provider launch.

## Approved Approach

Automode canonicalizes a goal repository once, when the goal is enqueued, with the shared cross-platform `normalizePath` helper. The canonical value is the value persisted in Automode state and subsequently used by the policy gate, project lookup, integration-branch preparation, and Delamain spawn. Policy allowlist roots are normalized at comparison time so trailing separators, mixed slash styles, dot segments, and Windows case do not change containment.

`ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot` stops relying on raw SQL equality. It reads active projects in deterministic creation/id order, compares canonical workspace roots with the canonical lookup, and resolves repository identity only for the first match. This avoids a schema migration and makes old non-canonical persisted roots equivalent immediately. A canonical database column/index was rejected as unnecessarily broad for a low-frequency Automode dispatch lookup; SQL string transforms were rejected because they cannot safely reproduce cross-platform dot-segment and case rules.

The public `thread.turn.start` command and its `thread.turn-start-requested` event gain an optional `workPersonalFallbackAcknowledgedInstanceId`. Absence remains valid for older clients and historical events. The decider copies the optional field unchanged into the event.

Chat sends the field only on a first launch after the existing confirmation has succeeded for the currently selected instance. A cancelled confirmation dispatches no turn-start command and preserves the draft. A retry after a confirmed but failed dispatch may reuse the in-memory, instance-specific confirmation for that draft.

Before starting or binding a new provider session, `ProviderCommandReactor` independently resolves the project’s effective profile and the selected driver’s Work and Personal mappings:

- Non-Work projects retain existing provider-selection behavior.
- Work Codex/Cursor may launch the configured Work instance without acknowledgement.
- Work Codex/Cursor may launch the configured Personal instance only when the acknowledgement exactly equals the selected instance. This also permits an explicitly acknowledged Personal fallback when the Work mapping is absent.
- Other selected instances are rejected as mismatched.
- A selected Personal instance without acknowledgement, an older client with no field, or a wrong-instance acknowledgement is rejected before `startSession` and before a fallback marker can be persisted.
- An active same-instance session with the durable `workPersonalFallbackInstanceId` continues without repeated acknowledgement.
- A configured Work launch records its own durable instance marker, so changing mappings or overrides does not invalidate the pinned session. Historical unmarked Personal sessions still cannot use this bypass.
- The durable marker is written only for a server-validated acknowledged Personal fallback and is cleared by the existing instance-change lifecycle behavior.

Provider rejection uses an actionable `ProviderAdapterRequestError` explaining that the Personal account must be confirmed. Existing turn-start recovery projects the error onto the thread and appends the standard provider failure activity; no provider process starts.

## Compatibility

The new command/event property is optional, so older wire clients and persisted events decode successfully. They can continue normal Work-mapped, Personal-profile, and non-Codex/Cursor launches. They cannot silently initiate a new Work-to-Personal Codex/Cursor fallback.

Existing sessions continue only when their selected instance and durable marker match. Historical pre-marker Work-to-Personal sessions cannot prove acknowledgement and therefore do not gain an implicit bypass.

## Verification

TDD coverage will prove:

- both repository-profile override directions survive equivalent path spellings;
- canonicalization covers trailing separators, slash style, dot segments, and Windows case;
- old commands/events decode without the optional acknowledgement;
- direct and older-client first fallback launches fail before provider start;
- wrong acknowledgement fails before provider start;
- exact acknowledgement starts the provider and persists the marker;
- configured Work routing starts without acknowledgement;
- missing Work mapping plus exact Personal acknowledgement succeeds;
- a same-instance session with a durable marker does not prompt or require acknowledgement again;
- Chat includes the field after confirmation and omits the command entirely on cancellation.
