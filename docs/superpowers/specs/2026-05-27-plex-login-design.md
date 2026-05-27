# Plex Login Flow — Design

**Date:** 2026-05-27
**Status:** Draft, pending user review
**Scope:** Replace static `PLEX_URL` / `PLEX_TOKEN` env-var auth with an in-app Plex PIN-based OAuth login, persisted in a new sqlite store, with server auto-discovery.

## Problem

Today the Plex provider only authenticates via two env vars (`src/config.ts`):

```
PLEX_URL=http://...:32400
PLEX_TOKEN=<long-lived token>
```

`src/index.ts:61` registers the provider at boot only if both are set. If the token is revoked or rotated, the user must edit `.env` and restart the process. There is no UI affordance for sign-in, no way to discover the server URL, and no way to detect or recover from a stale token from inside the app.

## Goals

- Sign in to Plex from the dashboard using the standard PIN flow (`plex.tv/link`), no password handling.
- Persist the resulting auth token + chosen server in sqlite so it survives restarts.
- Auto-discover the user's Plex servers via `plex.tv/api/v2/resources` and let the user pick one (with a fallback when there are multiple connections per server).
- Keep `PLEX_URL` / `PLEX_TOKEN` env vars working as a bootstrap fallback (so existing deploys don't break).
- Surface "Signed in as X — Server Y — Sign out" state in the existing Plex tab.

## Non-goals

- Automatic 401 detection mid-session. User logs out manually if Plex rejects the token.
- Encrypting the sqlite file at rest.
- Multi-account or per-Discord-user Plex auth — this is one bot, one Plex account.
- Migrating other config (Discord bot token, OpenRouter key, etc.) into sqlite. Out of scope; left to the future UI-rewrite spec.
- Test framework adoption. Manual test plan only (see below).
- Dashboard UI modernization (shadcn/React). Tracked as a separate future spec. The login panel built here is throwaway-friendly and will be re-styled when the dashboard is rewritten.

## Architecture

### New files

**`src/services/db.ts`**
bun:sqlite singleton. Opens `data/streambot.db` (path configurable via `DB_PATH`). On import, runs idempotent `CREATE TABLE IF NOT EXISTS` for `plex_auth` and seeds the singleton row with a freshly generated `client_id` if missing. Exports a typed `db` handle. ~30 lines.

**`src/services/plex-auth.ts`**
Owns the PIN flow and persisted auth state. Public API:

- `getStatus(): AuthStatus` — current state for the status endpoint
- `startLogin(): { code, expiresAt }` — creates PIN, starts background poll, returns 4-char code
- `cancelLogin(): void` — stops background poll, clears pending
- `listServers(): Promise<DiscoveredServer[]>` — calls `plex.tv/api/v2/resources` with stored token
- `selectServer(serverId, connectionUri?): Promise<void>` — picks a discovered server (and optionally a specific connection), runs reachability smoke test, persists
- `logout(): void` — clears `auth_token`, `server_*` columns
- `getActiveConfig(): { baseUrl, token } | null` — used by the provider getter; consults sqlite first, then env-var fallback

The pending-PIN state lives in a module-level `Map` (single entry max). Background poll is a `setInterval` with a 15-minute deadline.

### Touched files

**`src/services/providers/plex.ts`**
Refactor: constructor takes `() => { baseUrl: string; token: string } | null` (a getter) instead of two strings. All internal `${this.baseUrl}` / `${this.token}` references re-read via the getter so the provider stays valid across login/logout without re-registration. `canHandle()` continues to return true for `plex:` URLs; `resolve()` / `search()` / `browse()` return empty / null when the getter returns `null`.

**`src/index.ts`**
Replace the boot-time registration block (`src/index.ts:61`) with: always register one `PlexProvider` wired to `plexAuth.getActiveConfig`. Provider availability is now driven by the getter, not by registration.

**`src/server/routes/api.ts`**
Add the `/api/plex/auth/*` endpoints (see below). Existing `/api/plex/browse|search|queue` unchanged — they continue to 404 when no active config, which is now the right behavior.

**`src/server/views/pages/dashboard.ejs`**
- Remove the `checkPlexAvailable()` show/hide of the Plex tab nav. Tab is always visible.
- Add `#plexAuthPanel` block above the existing search/browse content. Renders one of five sub-templates based on `state` from `/api/plex/auth/status`.
- Wrap existing search/browse markup in `#plexReadyContent`, only shown in `ready` state.
- Add `refreshPlexAuth()`, status polling during `awaiting-pin`, and event handlers for sign-in / cancel / select-server / sign-out.

**`src/config.ts`**
Add `dbPath: process.env.DB_PATH || 'data/streambot.db'`. `plexUrl` / `plexToken` remain as env-var bootstrap fallback (see Auth precedence).

**`.gitignore`**
Add `data/` so `data/streambot.db` is not committed.

## Data: SQLite schema

```sql
CREATE TABLE IF NOT EXISTS plex_auth (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  client_id       TEXT    NOT NULL,
  auth_token      TEXT,
  account_user    TEXT,
  server_name     TEXT,
  server_base_url TEXT,
  server_id       TEXT,
  updated_at      INTEGER NOT NULL
);
```

Single-row design enforced by `CHECK (id = 1)`. On first `db.ts` import, if the row is missing, insert it with a freshly generated UUID `client_id` and the other columns NULL. The `client_id` is the stable `X-Plex-Client-Identifier` for the lifetime of this install — never regenerate it after first creation, since Plex ties auth tokens to it.

No migration framework. Future schema changes use `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN` guarded by a `pragma_table_info` check.

## Auth precedence

`plexAuth.getActiveConfig()` resolves in this order:
1. If `auth_token` + `server_base_url` are both set in sqlite → use those.
2. Else if `config.plexUrl` and `config.plexToken` are both non-empty → use env vars.
3. Else `null` (provider returns no-op).

This keeps existing env-based deployments working untouched, and a successful in-app login transparently takes over.

**UI note:** the env-var fallback is intentionally *silent* — `getStatus()` only reflects the sqlite-stored auth, so even when env vars are providing a working backend the dashboard shows the "Sign in to Plex" panel. This is a feature, not a bug: env vars are a bootstrap convenience, and exposing them through the auth UI would create awkward edge cases ("sign out" on env-only is meaningless because we can't unset process env from the app). Users who want a UI-visible signed-in state should complete the PIN flow once.

## Auth state machine

Computed from the sqlite row + the in-memory pending-PIN map.

| State | Condition | Dashboard shows |
|---|---|---|
| `idle` | no pending PIN, `auth_token` NULL | "Sign in to Plex" button |
| `awaiting-pin` | pending PIN exists, not expired, no token captured yet | 4-char code, "Open plex.tv/link" button, "Cancel" |
| `pin-expired` | pending PIN past 15-minute deadline | "Code expired — try again" |
| `linked` | `auth_token` set, `server_base_url` NULL | Server picker `<select>`, with nested connection picker if a server exposes >1 connection |
| `ready` | `auth_token` + `server_base_url` set | Existing search/browse content + "Signed in as `<accountUser>` — `<serverName>` — Sign out" header |

A process restart while in `awaiting-pin` drops the pending PIN — the user re-clicks "Sign in to Plex". Once `linked`, restart is safe because state is in sqlite.

## HTTP endpoints

All under `src/server/routes/api.ts`. All return JSON.

| Method | Path | Body / Query | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/plex/auth/status` | — | `{ state, code?, codeExpiresAt?, accountUser?, serverName?, servers?, reason? }` | Single source of truth for the dashboard. `reason` is set to `"token-rejected"` on the next status read after Plex rejects the stored token; cleared on the read after that. |
| `POST` | `/api/plex/auth/start` | — | `{ code, expiresAt }` | 409 if already `ready`. If `awaiting-pin`, cancels existing PIN and starts a new one |
| `POST` | `/api/plex/auth/cancel` | — | `{ ok: true }` | Only valid in `awaiting-pin` (otherwise 409) |
| `POST` | `/api/plex/auth/select-server` | `{ id, connectionUri? }` | `{ ok: true }` | 400 if `id` not in last-discovered list; 502 if reachability smoke test fails |
| `POST` | `/api/plex/auth/logout` | — | `{ ok: true }` | Clears `auth_token` + `server_*`. Idempotent |

`servers` in the status payload is populated only in `linked` state. Shape:

```ts
type DiscoveredServer = {
  id: string;            // plex.tv clientIdentifier
  name: string;          // display name
  owned: boolean;
  connections: Array<{
    uri: string;         // e.g. http://10.0.0.5:32400
    local: boolean;
    https: boolean;
    relay: boolean;
  }>;
};
```

## Plex.tv calls used by the server

Common headers on every call:

```
Accept: application/json
X-Plex-Client-Identifier: <client_id>
X-Plex-Product: StreamBot
X-Plex-Version: <package.json version>
X-Plex-Device: server
X-Plex-Device-Name: StreamBot
X-Plex-Platform: Node.js
```

Endpoints:

- `POST https://plex.tv/api/v2/pins?strong=true` → `{ id, code, expiresAt }`. Called from `startLogin()`.
- `GET https://plex.tv/api/v2/pins/<id>` → polled every 2s by background interval; `authToken` populates when the user approves at `plex.tv/link`.
- `GET https://plex.tv/api/v2/user` (with `X-Plex-Token: <authToken>`) → called once after token captured to fetch `username`/`email` for display.
- `GET https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1` → list of servers + connections, called when entering `linked` state and again if the user reloads the dashboard during `linked`.

## Server / connection selection

When the user picks a server in the dropdown:

- If no `connectionUri` provided in the request, server-side preference order:
  1. First connection with `local: true && relay: false`
  2. First connection with `relay: false` (any local/remote)
  3. First connection (last-resort relay)
- If `>1` connection exists, the dashboard exposes a nested connection picker so the user can override.
- Before persisting: smoke test `GET <chosenUri>/identity?X-Plex-Token=<token>`. On non-200 or network failure, return 502 with the failing URI and don't persist. The user picks another connection.

## Frontend flow (`dashboard.ejs`)

```
on tab shown / page load:
  refreshPlexAuth()

refreshPlexAuth():
  fetch /api/plex/auth/status
  render panel based on state
  if state === 'awaiting-pin':
    start setInterval(refreshPlexAuth, 2000)
  else:
    clear any existing interval

sign-in button click:
  POST /api/plex/auth/start → refreshPlexAuth()

cancel button click:
  POST /api/plex/auth/cancel → refreshPlexAuth()

server picker submit:
  POST /api/plex/auth/select-server { id, connectionUri? } → refreshPlexAuth()
  on 502: toast the failing URI, leave state at 'linked'

sign-out button click:
  POST /api/plex/auth/logout → refreshPlexAuth()
```

Polling pauses on `document.hidden` / tab blur to avoid background traffic.

## Error handling

| Failure | Behavior |
|---|---|
| plex.tv network error during PIN poll | Swallow; keep polling until expiry. No user-visible error until `pin-expired`. |
| plex.tv 401/403 on `/user` or `/resources` after PIN approval | Wipe `auth_token` in sqlite, transition to `idle`. `/auth/status` returns `{ state: 'idle', reason: 'token-rejected' }` so the frontend can toast once. |
| Server connectivity smoke test (`/identity`) fails on `select-server` | Return 502 with the failing URI. Nothing persisted. User retries with a different connection. |
| sqlite write failure (disk full, permissions) | Return 500. Logged. No automatic retry. User retries the click. |
| Concurrent `start` while one PIN is pending | Cancel the old PIN's background poll, create a new PIN, return the new code. Matches user intent: re-clicking "Sign in" means "give me a new code". |
| Process restart during `awaiting-pin` | Pending PIN is lost (memory-only). User re-clicks "Sign in to Plex". |
| Process restart while `ready` | No-op; state restored from sqlite at boot. |

## Manual test plan

No automated tests added. Verify manually after implementation:

1. **Fresh login (no env vars).** Unset `PLEX_URL` / `PLEX_TOKEN`. Start app. Plex tab shows "Sign in to Plex". Click → get code → approve at `plex.tv/link` → server picker appears → select server → search/browse works.
2. **Server pick with multiple connections.** Pick a server that has both local and relay connections. Confirm dropdown lets you override. Confirm reachable connection persists; confirm picking a known-unreachable connection (e.g. wrong-network local) returns 502 and doesn't persist.
3. **Restart persists.** After step 1, restart the app. Plex tab opens in `ready` state immediately; search/browse work.
4. **Sign out.** Click "Sign out". Plex tab returns to `idle`. `/api/plex/browse` now 404s. Sign in again → returns to `ready`.
5. **Env fallback still works.** With sqlite cleared (`rm data/streambot.db`) and `PLEX_URL` / `PLEX_TOKEN` set in `.env`, start app. The underlying `PlexProvider` is functional (`/api/plex/browse` and `/api/plex/search` succeed against the env-configured server). The dashboard's Plex tab still shows the "Sign in to Plex" panel — env vars are a silent bootstrap, not a UI-visible auth state. Clicking "Sign in" begins the PIN flow; on completion, the sqlite-stored token takes precedence and the dashboard transitions to the proper `ready` state with username + server name + sign-out.
6. **Revoked-token recovery.** In `ready` state, invalidate the token externally (sign out from plex.tv on a different device, or rotate the token). Next Plex search/browse request fails. User can click "Sign out" → "Sign in" to recover.
7. **PIN expiry.** Click "Sign in to Plex" and wait >15 min without approving. Panel shows `pin-expired`; new "Sign in" click starts a fresh code.
8. **Concurrent re-start.** Click "Sign in to Plex" twice in a row. Confirm the second click replaces the code and the first PIN is no longer accepted.

## Open questions

None blocking design. One minor implementation-time call:

- Whether to add a `forwardUrl` query param to the `plex.tv/link` button so the user lands back on the dashboard after approving. Nice-to-have, not required for correctness; default to omitting it unless the polling UX feels lacking during manual testing.
