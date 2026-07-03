# Plan 18 Policy-Surface Gap Audit (W5.1)

**Date:** 2026-07-03  
**Auditor:** Sonnet execution agent (W5.1 task)  
**Branch:** `docs/plan18-gap-audit`  
**Baseline:** `origin/gits`  
**Reference plan:** `.plans/18-server-auth-model.md`

---

## 1. Surface Inventory

Every HTTP route, WebSocket upgrade, and RPC surface exposed by the server, enumerated by reading `makeRoutesLayer` in `apps/server/src/server.ts` and tracing each route's handler back to its auth call site.

| #   | Surface                                  | File:Line                      | Auth Mechanism                                                                           | Verdict                                            |
| --- | ---------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `GET /.well-known/t3/environment`        | `src/http.ts:80`               | None — intentionally public                                                              | **COVERED** (public)                               |
| 2   | `GET /api/auth/session`                  | `src/auth/http.ts:35`          | `getSessionState` — returns unauthenticated state; never 401s                            | **COVERED** (public bootstrap UX)                  |
| 3   | `POST /api/auth/bootstrap`               | `src/auth/http.ts:66`          | Consumes bootstrap credential via `exchangeBootstrapCredential`                          | **COVERED** (bootstrap)                            |
| 4   | `POST /api/auth/bootstrap/bearer`        | `src/auth/http.ts:102`         | Consumes bootstrap credential via `exchangeBootstrapCredentialForBearerSession`          | **COVERED** (bootstrap)                            |
| 5   | `POST /api/auth/ws-token`                | `src/auth/http.ts:129`         | `authenticateHttpRequest` — requires valid session                                       | **COVERED** (authenticated)                        |
| 6   | `POST /api/auth/pairing-token`           | `src/auth/http.ts:144`         | `authenticateHttpRequest` + owner-role check                                             | **COVERED** (authenticated/owner)                  |
| 7   | `GET /api/auth/pairing-links`            | `src/auth/http.ts:197`         | `authenticateOwnerSession` (local helper)                                                | **COVERED** (authenticated/owner)                  |
| 8   | `POST /api/auth/pairing-links/revoke`    | `src/auth/http.ts:207`         | `authenticateOwnerSession`                                                               | **COVERED** (authenticated/owner)                  |
| 9   | `GET /api/auth/clients`                  | `src/auth/http.ts:227`         | `authenticateOwnerSession`                                                               | **COVERED** (authenticated/owner)                  |
| 10  | `POST /api/auth/clients/revoke`          | `src/auth/http.ts:237`         | `authenticateOwnerSession`                                                               | **COVERED** (authenticated/owner)                  |
| 11  | `POST /api/auth/clients/revoke-others`   | `src/auth/http.ts:257`         | `authenticateOwnerSession`                                                               | **COVERED** (authenticated/owner)                  |
| 12  | `GET /api/attachments/*`                 | `src/http.ts:148`              | `authenticateHttpRequest` + thread-scoped deny                                           | **COVERED** (authenticated)                        |
| 13  | `GET /api/project-favicon`               | `src/http.ts:212`              | `requireAuthenticatedRequest` helper (+ thread-scoped deny)                              | **COVERED** (authenticated)                        |
| 14  | `POST /api/observability/v1/traces`      | `src/http.ts:99`               | `requireAuthenticatedRequest` helper (+ thread-scoped deny)                              | **COVERED** (authenticated)                        |
| 15  | `GET /api/orchestration/snapshot`        | `src/orchestration/http.ts:42` | `authenticateOwnerSession` (local helper)                                                | **COVERED** (authenticated/owner)                  |
| 16  | `POST /api/orchestration/dispatch`       | `src/orchestration/http.ts:68` | `authenticateOwnerSession`                                                               | **COVERED** (authenticated/owner)                  |
| 17  | `POST /api/crit/turn`                    | `src/crit/critHttp.ts:143`     | `authorize(threadId)` — `authenticateHttpRequest` + subject binding                      | **COVERED** (thread-scoped bearer)                 |
| 18  | `GET /api/crit/turn-status`              | `src/crit/critHttp.ts:224`     | `authorize(threadId)` — `authenticateHttpRequest` + subject binding                      | **COVERED** (thread-scoped bearer)                 |
| 19  | `GET /api/gits/build-info`               | `src/gits/http.ts:32`          | None — no `authenticateHttpRequest` call                                                 | **UNCOVERED**                                      |
| 20  | `GET /api/gits/skills`                   | `src/gits/http.ts:62`          | None — no `authenticateHttpRequest` call                                                 | **UNCOVERED**                                      |
| 21  | `GET /api/gits/mcp`                      | `src/gits/http.ts:92`          | None — no `authenticateHttpRequest` call                                                 | **UNCOVERED**                                      |
| 22  | `POST /api/gits/visual-plan/mcp`         | `src/gits/mcp/http.ts:139`     | Per-thread bearer token via `VisualPlanMcpRegistry` (module-level map, not `ServerAuth`) | **PARTIALLY COVERED**                              |
| 23  | `GET /ws` (WebSocket upgrade)            | `src/ws.ts:1693`               | `authenticateWebSocketUpgrade` via `ServerAuth` (cookie, bearer, or pre-minted ws-token) | **COVERED** (authenticated)                        |
| 24  | All WS RPC methods (entire `WsRpcGroup`) | `src/ws.ts:197–1690`           | Gated by upgrade auth at `#23`; `currentSessionId` threaded through                      | **COVERED** (authenticated, inherits from upgrade) |
| 25  | `GET *` (static/SPA fallback)            | `src/http.ts:253`              | None — intentionally public                                                              | **COVERED** (public, serves login/pair UI)         |

### Counts

- **Covered:** 19
- **Partially covered:** 1
- **Uncovered:** 3
- **Total:** 23 distinct route surfaces (WS RPC methods counted as one surface since they are gated by the upgrade)

---

## 2. Non-Loopback Bind Finding

### What the plan requires

> `.plans/18-server-auth-model.md` §"Exposure level changes defaults":  
> **non-loopback bind → auth required**  
> `.plans/18-server-auth-model.md` §"Acceptance criteria":  
> **Non-loopback or published environments require explicit authenticated pairing by default.**

### What happens today

**Policy selection** (`src/auth/Layers/ServerAuthPolicy.ts:12–21`):

```ts
const isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);
const policy =
  config.mode === "desktop"
    ? isRemoteReachable
      ? "remote-reachable"
      : "desktop-managed-local"
    : isRemoteReachable
      ? "remote-reachable"
      : "loopback-browser";
```

The `remote-reachable` policy is correctly selected when `host` is `0.0.0.0`, `::`, or a non-loopback address. Under this policy the bootstrap methods are `["one-time-token"]` (or `["desktop-bootstrap", "one-time-token"]` in desktop mode), meaning only explicit pairing is allowed.

**Startup enforcement gap** (`src/serverRuntimeStartup.ts:447`):

```ts
if (serverConfig.mode !== "desktop") {
  yield *
    Effect.logInfo("Authentication required. Open GITS using the pairing URL.").pipe(
      Effect.annotateLogs({ pairingUrl: startupBrowserTarget }),
    );
}
```

This log fires for all non-desktop modes, but:

1. It is a **log message only**, not a startup failure. If the server starts on `0.0.0.0` with `mode=web` but `desktopBootstrapToken` is absent and the pairing URL is never distributed, access is simply unauthenticated by policy — but the process starts and binds without error.
2. The `UnsafeNoAuthPolicy` escape hatch described in the plan **does not exist** in code at all. There is no explicit `--unsafe-no-auth` flag. This means the only way to start with no auth is to use `desktopBootstrapToken: undefined` + a `remote-reachable` policy, which only permits `one-time-token` bootstrap — effectively auth is enforced, but only because the policy enum rejects unknown methods, not because there is an explicit guard.
3. **The critical missing check:** There is no code that **fails startup** (via `Effect.fail` / `Effect.die`) if the server is bound to a non-loopback address and has no signing key, unconfigured secret store, or any other condition that would render auth inoperable.

### Verdict

Non-loopback bind **does not cause a hard startup error** today. The policy engine is wired and selects `remote-reachable`, making the server require a `one-time-token` bootstrap — so auth enforcement is functionally present. But the plan's acceptance criterion requires this to be **hard** (a startup error, not a log), and there is no guard.

### PROPOSED DIFF (PENDING OPERATOR APPROVAL — do not apply)

Add a startup-phase check that confirms the server can issue credentials before listening. Insert this into the `startup` Effect in `apps/server/src/serverRuntimeStartup.ts`, immediately after the config is read and before `commandGate.signalCommandReady`:

```ts
// In makeServerRuntimeStartup, inside the `startup` Effect gen block,
// after existing log lines and before signalCommandReady.

import { isLoopbackHost, isWildcardHost } from "./startupAccess.ts";
import { ServerAuthPolicy } from "./auth/Services/ServerAuthPolicy.ts";

// …inside `const startup = Effect.gen(function* () { … })`:

const serverAuthPolicy = yield * ServerAuthPolicy;
const descriptor = yield * serverAuthPolicy.getDescriptor();
const isRemoteReachable = isWildcardHost(serverConfig.host) || !isLoopbackHost(serverConfig.host);

if (isRemoteReachable && descriptor.bootstrapMethods.length === 0) {
  return (
    yield *
    Effect.fail(
      new ServerRuntimeStartupError({
        message:
          "Server is bound to a non-loopback address but has no configured bootstrap methods. " +
          "Refusing to start to prevent unauthenticated remote access.",
      }),
    )
  );
}
```

> **Note:** The current auth model always populates at least one bootstrap method for `remote-reachable` policy, so this guard would not fire today under normal conditions. Its value is as a safety net against future policy regressions that could set an empty `bootstrapMethods` array. A stronger variant would also confirm the `ServerSecretStore` can issue/retrieve the signing key before listening — that would be a Phase 2 hardening task (see W5.2 below).

---

## 3. Uncovered Surfaces — Follow-Up Task List

### W5.2 — Severity: HIGH — `GET /api/gits/build-info` (unauthenticated)

**File:** `apps/server/src/gits/http.ts:32`

The build-info route returns GITS version information. While low-sensitivity individually, it leaks server version and build metadata to unauthenticated callers.

**Minimal fix:** Add `yield* (yield* ServerAuth).authenticateHttpRequest(request)` before the resolver call. Same pattern as `otlpTracesProxyRouteLayer`.

**Classification per plan 18:** Server metadata → `authenticated`.

---

### W5.3 — Severity: HIGH — `GET /api/gits/skills` (unauthenticated)

**File:** `apps/server/src/gits/http.ts:62`

Returns the full GITS skill inventory snapshot. Exposes which skills and capabilities are installed on the server to any caller without a session.

**Minimal fix:** Same pattern as W5.2.

---

### W5.4 — Severity: HIGH — `GET /api/gits/mcp` (unauthenticated)

**File:** `apps/server/src/gits/http.ts:92`

Returns the full MCP inventory snapshot. Exposes which MCP servers are registered to unauthenticated callers.

**Minimal fix:** Same pattern as W5.2.

---

### W5.5 — Severity: MEDIUM — `POST /api/gits/visual-plan/mcp` (parallel auth system, not `ServerAuth`)

**File:** `apps/server/src/gits/mcp/http.ts:139`  
**Registry:** `apps/server/src/gits/mcp/VisualPlanMcpRegistry.ts`

The visual-plan MCP endpoint uses a **module-level singleton `Map`** (`tokensToThread`, `threadToToken`) to map per-thread bearer tokens to thread IDs. Token issuance (`issueVisualPlanToken`) is called by provider adapters. Validation (`resolveVisualPlanThread`) is called in the route handler.

This is **not wired through `SessionCredentialService` or `ServerAuth`**. The tokens are:

- Not HMAC-signed with the server signing key
- Not persisted (process-restart invalidates all tokens)
- Not revocable through the auth control plane
- Not subject to the session TTL model
- Not listed under `/api/auth/clients`

The token format (`vpmcp_<uuid>`) is strong enough to prevent guessing, but the orthogonal token store means a compromised visual-plan token is invisible to the auth management surface and cannot be revoked without restarting the server.

**Minimal fix shape:** Issue visual-plan MCP tokens through `SessionCredentialService.issue({ method: "bearer-session-token", role: "thread-scoped", subject: threadId })` and validate them through `ServerAuth.authenticateHttpRequest`. This requires passing `AuthControlPlane` into the provider adapter layer (or using a dedicated thin WS method for token issuance). This is non-trivial wiring and warrants a dedicated W5.x task with operator scoping.

**Until fixed:** The current scheme provides functional access control for the happy path but lacks revocation and central visibility.

---

### W5.6 — Severity: LOW — Non-loopback bind: no hard startup failure

**File:** `apps/server/src/serverRuntimeStartup.ts`

As described in Section 2. The policy engine correctly gates to `remote-reachable`, but there is no startup `Effect.fail` / `Effect.die` if `bootstrapMethods` were somehow empty or the secret store were unavailable.

**Minimal fix:** See proposed diff in Section 2.

---

## 4. Plan 18 Gap Analysis: Built vs. Promised

### Built (relative to plan 18)

| Plan item                                                                     | Status                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ServerAuth` service boundary                                                 | ✅ Built (`auth/Services/ServerAuth.ts`, `auth/Layers/ServerAuth.ts`) |
| `ServerAuthPolicy` service                                                    | ✅ Built — maps host/mode to policy enum                              |
| `ServerSecretStore`                                                           | ✅ Built — filesystem-based signing key, `chmod 0o700/0o600`          |
| `BootstrapCredentialService`                                                  | ✅ Built — one-time tokens + desktop-bootstrap seeded grant           |
| `SessionCredentialService`                                                    | ✅ Built — browser-session-cookie + bearer-session-token              |
| Bootstrap/session credential split                                            | ✅ Distinct types, distinct exchange endpoints                        |
| Cookie session (`browser-session-cookie`)                                     | ✅ `HttpOnly`, `sameSite: lax`, signed, TTL-bound                     |
| Bearer session (`bearer-session-token`)                                       | ✅ Built                                                              |
| `AuthControlPlane` (pairing links, session mgmt)                              | ✅ Built — list/revoke pairing links and sessions                     |
| WebSocket upgrade auth via `ServerAuth`                                       | ✅ `authenticateWebSocketUpgrade` in `/ws` handler                    |
| Pre-minted ws-token flow (`POST /api/auth/ws-token`)                          | ✅ Built — 5-minute short-lived token for browser `?wsToken=`         |
| Policy modes: `desktop-managed-local`, `loopback-browser`, `remote-reachable` | ✅ Built in `ServerAuthPolicyLive`                                    |
| Thread-scoped session role (crit sidecar)                                     | ✅ Built — `authorize(threadId)` + `denyThreadScopedRealtime`         |
| Auth capabilities surfaced in contracts                                       | ✅ `ServerAuthDescriptor` contract, `getDescriptor()`                 |

### Not built / drifted from plan 18

| Plan item                                                 | Status           | Notes                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthRouteGuards` service                                 | ❌ Not built     | Plan §"AuthRouteGuards" describes a shared layer for route guard composition. Actual code uses per-route inline calls to `serverAuth.authenticateHttpRequest`. Functionally equivalent but there is no shared `AuthRouteGuards` service type. |
| `RouteAuthClass` enum (public/bootstrap/authenticated)    | ❌ Not built     | Plan's `authenticateHttpRequest(request, routeClass)` signature takes a `routeClass`. Actual `authenticateHttpRequest` takes only `request`. Route classification is implicit from which routes call it.                                      |
| `UnsafeNoAuthPolicy` escape hatch                         | ❌ Not built     | Mentioned in plan §"UnsafeNoAuthPolicy". No `--unsafe-no-auth` flag or corresponding code exists.                                                                                                                                             |
| OS secure storage (keychain) for `ServerSecretStore`      | ❌ Not built     | Plan §"Storage decisions" lists OS secure storage as preferred. Actual implementation is filesystem-only. Non-blocking for current scope.                                                                                                     |
| Non-loopback hard startup failure                         | ❌ Not built     | Plan §"Acceptance criteria": "Non-loopback or published environments require explicit authenticated pairing by default." Enforced by policy only, not by a startup guard.                                                                     |
| Three GITS inventory routes behind auth                   | ❌ Not wired     | `/api/gits/build-info`, `/api/gits/skills`, `/api/gits/mcp` have no auth call.                                                                                                                                                                |
| Visual-plan MCP tokens through `SessionCredentialService` | ❌ Partial       | Uses a parallel module-level token registry outside `ServerAuth`.                                                                                                                                                                             |
| Phase 3 desktop bootstrap auto-pair flow                  | ❌ Not built     | `desktop-bootstrap` method seeding works, but the renderer-side auto-exchange described in plan Phase 3 is not implemented (no observable bootstrap initiation from the server side at startup beyond printing a pairing URL).                |
| `BrowserSessionCookieCodec` as a standalone service       | ❌ Not extracted | Cookie signing logic lives inline in `SessionCredentialServiceLive`. Plan describes it as a separate "focused utility service." Functionally present, not separately layered.                                                                 |

---

## 5. Methodology (Reproducibility)

**Entry points used:**

1. `apps/server/src/server.ts` — `makeRoutesLayer`: the canonical route merge. Every layer listed here was examined.
2. `apps/server/src/ws.ts:1691` — `websocketRpcRouteLayer`: the single WS upgrade point.
3. `apps/server/src/auth/Layers/ServerAuth.ts` — implementation of every `ServerAuthShape` method.
4. `apps/server/src/auth/Layers/ServerAuthPolicy.ts` — policy selection logic.
5. `apps/server/src/serverRuntimeStartup.ts` — startup sequence for non-loopback enforcement.

**Greps used:**

```bash
# All HTTP route registrations
grep -rn "HttpRouter.add" apps/server/src/ --include="*.ts" | grep -v ".test.ts"

# All non-loopback / isLoopback / isWildcard references
grep -rn "isLoopback|isWildcard|nonLoopback|remote-reachable|UnsafeNoAuth" apps/server/src/ | grep -v ".test.ts"

# Auth call sites in route handlers
grep -n "authenticateHttpRequest|authenticateWebSocketUpgrade|requireAuthenticatedRequest|authorize(" apps/server/src/{http.ts,auth/http.ts,crit/critHttp.ts,orchestration/http.ts,gits/http.ts,gits/mcp/http.ts,ws.ts}

# AuthRouteGuards / RouteAuthClass (plan promises)
grep -rn "AuthRouteGuards|RouteAuthClass" apps/server/src/
```

**Files read in full:**

- `apps/server/src/auth/Layers/ServerAuth.ts`
- `apps/server/src/auth/Layers/ServerAuthPolicy.ts`
- `apps/server/src/auth/Layers/AuthControlPlane.ts`
- `apps/server/src/auth/Layers/BootstrapCredentialService.ts`
- `apps/server/src/auth/Layers/SessionCredentialService.ts`
- `apps/server/src/auth/Layers/ServerSecretStore.ts`
- `apps/server/src/auth/Services/ServerAuth.ts`
- `apps/server/src/auth/http.ts`
- `apps/server/src/http.ts`
- `apps/server/src/ws.ts` (auth-relevant sections)
- `apps/server/src/crit/critHttp.ts`
- `apps/server/src/gits/http.ts`
- `apps/server/src/gits/mcp/http.ts`
- `apps/server/src/gits/mcp/VisualPlanMcpRegistry.ts`
- `apps/server/src/orchestration/http.ts`
- `apps/server/src/server.ts`
- `apps/server/src/serverRuntimeStartup.ts` (startup sequence)
- `apps/server/src/startupAccess.ts`
- `apps/server/src/config.ts`
- `apps/server/src/cli/config.ts`
- `.plans/18-server-auth-model.md`

---

## 6. What Could Not Be Verified

1. **Whether `issueVisualPlanToken` is called only from trusted in-process code.** The registry is a module-level singleton. The audit confirmed it is called from provider adapter code (inside the server process), but a full trace of every import path was not performed. If a future code path calls `issueVisualPlanToken` from a context reachable by user input, the token namespace widens.

2. **Whether `desktopBootstrapToken` is validated for entropy/length.** The token is read from `DesktopBackendBootstrap` (a schema-decoded bootstrap envelope). The audit did not examine the schema validation rules for this field, so it is possible a very short token is accepted.

3. **CORS policy scope.** `browserApiCorsLayer` is applied globally (outermost `Layer.provide` in `makeRoutesLayer`). The audit did not enumerate which origins are in `browserApiCorsAllowedHeaders`/`Methods` or whether `CORS` headers on public routes (`/.well-known/t3/environment`) could be tightened.

4. **Rate limiting / anti-enumeration on bootstrap endpoints.** `POST /api/auth/bootstrap` and `POST /api/auth/bootstrap/bearer` accept bootstrap credentials. The audit confirmed tokens are one-time-use and TTL-bound, but confirmed no rate-limiting layer exists on these endpoints.

5. **OS keychain integration status.** The plan lists OS secure storage as preferred over filesystem. The audit confirmed only the filesystem `ServerSecretStoreLive` exists. Whether there is a separate Electron-main-side implementation was not checked.
