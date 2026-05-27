# Plex Login Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static `PLEX_URL` / `PLEX_TOKEN` env-var Plex auth with an in-app PIN-based OAuth login, persisted in a new bun:sqlite store, with server auto-discovery and a dashboard UI.

**Architecture:** New `db.ts` opens a single sqlite file via `bun:sqlite`. New `plex-auth.ts` service owns the PIN flow, server discovery, and persisted auth state in one singleton row. `PlexProvider` is refactored to read its `baseUrl`/`token` through a getter so a single registered instance survives login/logout. Dashboard's existing Plex tab gains an auth panel above the existing search/browse content.

**Tech Stack:** TypeScript, Bun runtime, `bun:sqlite` (built-in, no install), Express, EJS, Bootstrap 5, vanilla JS. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-27-plex-login-design.md`

## Pre-flight notes

- **`bun:sqlite` is Bun-only.** The repo's `start:node` / `server:node` scripts run from `dist/` via Node and will fail to import `bun:sqlite`. Treat those scripts as broken-after-this-change; if Node support is required, replace `bun:sqlite` with `better-sqlite3` (~30 LOC swap inside `src/services/db.ts` only). This plan assumes Bun is the runtime.
- **No automated test framework** in this repo. Verification is manual (commands + curl + dashboard click-through) per the spec's test plan. Each task ends with explicit verify-then-commit steps.
- **File-state assumption:** Plan was written against `main` at commit `fde6f74`. If you're on a later commit, sanity-check line numbers before editing.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/db.ts` | Create | bun:sqlite singleton, opens `data/streambot.db`, runs schema migration on import |
| `src/services/plex-auth.ts` | Create | PIN flow, server discovery, persisted auth state, status state machine |
| `src/services/providers/plex.ts` | Modify | Constructor takes a `() => { baseUrl, token } \| null` getter instead of strings |
| `src/config.ts` | Modify | Add `dbPath` from `DB_PATH` env, default `data/streambot.db` |
| `src/index.ts` | Modify | Always register one PlexProvider wired to `plexAuth.getActiveConfig` |
| `src/server/routes/api.ts` | Modify | Add `/api/plex/auth/*` endpoints |
| `src/server/views/pages/dashboard.ejs` | Modify | Auth panel + status polling + handlers; remove tab-hiding |
| `.gitignore` | Modify | Add `data/` |

---

### Task 1: Add sqlite, dbPath config, and db module

**Files:**
- Create: `src/services/db.ts`
- Modify: `src/config.ts` (Plex options section, ~line ~70 of the config object)
- Modify: `.gitignore`

- [ ] **Step 1: Add `data/` to `.gitignore`**

Open `.gitignore`. Append on a new line:

```
data/
```

- [ ] **Step 2: Add `dbPath` to config**

Open `src/config.ts`. Find the `// Plex options` block (currently `plexUrl` / `plexToken`). Above it, add a `// Persistence options` block:

```ts
	// Persistence options
	dbPath: process.env.DB_PATH || 'data/streambot.db',

	// Plex options
	plexUrl: process.env.PLEX_URL || '',
	plexToken: process.env.PLEX_TOKEN || '',
```

- [ ] **Step 3: Create `src/services/db.ts`**

Create the file with this exact content:

```ts
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';

// Ensure parent directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
	fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Schema: single-row plex_auth table
db.exec(`
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
`);

// Seed singleton row with a stable client_id if missing
const existing = db.query('SELECT id FROM plex_auth WHERE id = 1').get();
if (!existing) {
	db.query(
		'INSERT INTO plex_auth (id, client_id, updated_at) VALUES (1, ?, ?)'
	).run(randomUUID(), Date.now());
	logger.info('Initialized plex_auth row with fresh client_id');
}

logger.info(`SQLite ready at ${config.dbPath}`);
```

- [ ] **Step 4: Verify the app still boots and the DB is created**

Run:

```bash
bun src/index.ts
```

Expected log lines (within the first few seconds of startup):

```
SQLite ready at data/streambot.db
```

Then Ctrl-C and confirm the file exists:

```bash
ls -la data/streambot.db
```

Expected: file exists, non-zero size. Verify schema:

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database("data/streambot.db"); console.log(db.query("SELECT id, client_id, auth_token, server_base_url FROM plex_auth WHERE id = 1").get());'
```

Expected: `{ id: 1, client_id: "<some-uuid>", auth_token: null, server_base_url: null }`.

- [ ] **Step 5: Commit**

```bash
git add .gitignore src/config.ts src/services/db.ts
git commit -m "Add bun:sqlite store with plex_auth schema"
```

---

### Task 2: PlexAuth skeleton (schema-only, no PIN flow yet)

**Files:**
- Create: `src/services/plex-auth.ts`

This task creates the service surface and the persisted-state path (`getActiveConfig` + `getStatus`) but stubs PIN-flow methods. Task 4 fills the PIN flow in.

- [ ] **Step 1: Create `src/services/plex-auth.ts`**

Create the file with this content:

```ts
import { db } from './db.js';
import config from '../config.js';
import logger from '../utils/logger.js';

export type AuthState =
	| 'idle'
	| 'awaiting-pin'
	| 'pin-expired'
	| 'linked'
	| 'ready';

export interface DiscoveredServerConnection {
	uri: string;
	local: boolean;
	https: boolean;
	relay: boolean;
}

export interface DiscoveredServer {
	id: string;
	name: string;
	owned: boolean;
	connections: DiscoveredServerConnection[];
}

export interface AuthStatus {
	state: AuthState;
	code?: string;
	codeExpiresAt?: number;
	accountUser?: string;
	serverName?: string;
	servers?: DiscoveredServer[];
	reason?: string;
}

interface Row {
	id: number;
	client_id: string;
	auth_token: string | null;
	account_user: string | null;
	server_name: string | null;
	server_base_url: string | null;
	server_id: string | null;
	updated_at: number;
}

function readRow(): Row {
	return db.query('SELECT * FROM plex_auth WHERE id = 1').get() as Row;
}

function writeRow(patch: Partial<Omit<Row, 'id'>>): void {
	const keys = Object.keys(patch);
	if (keys.length === 0) return;
	const setClause = keys.map(k => `${k} = ?`).join(', ');
	const values = keys.map(k => (patch as any)[k]);
	db.query(`UPDATE plex_auth SET ${setClause}, updated_at = ? WHERE id = 1`)
		.run(...values, Date.now());
}

// One-shot reason that clears after the next status read
let pendingReason: string | undefined;

export function getClientId(): string {
	return readRow().client_id;
}

export function getActiveConfig(): { baseUrl: string; token: string } | null {
	const row = readRow();
	if (row.auth_token && row.server_base_url) {
		return { baseUrl: row.server_base_url, token: row.auth_token };
	}
	if (config.plexUrl && config.plexToken) {
		return { baseUrl: config.plexUrl, token: config.plexToken };
	}
	return null;
}

export function getStatus(): AuthStatus {
	const row = readRow();
	const reason = pendingReason;
	pendingReason = undefined;

	if (row.auth_token && row.server_base_url) {
		return {
			state: 'ready',
			accountUser: row.account_user || undefined,
			serverName: row.server_name || undefined,
			reason,
		};
	}
	if (row.auth_token) {
		// Linked but no server picked yet — server list lives in PIN-flow memory; filled by Task 4.
		return { state: 'linked', accountUser: row.account_user || undefined, reason };
	}
	return { state: 'idle', reason };
}

// Stubs — filled in by Task 4
export async function startLogin(): Promise<{ code: string; expiresAt: number }> {
	throw new Error('startLogin not yet implemented');
}
export function cancelLogin(): void {
	throw new Error('cancelLogin not yet implemented');
}
export async function listServers(): Promise<DiscoveredServer[]> {
	throw new Error('listServers not yet implemented');
}
export async function selectServer(_serverId: string, _connectionUri?: string): Promise<void> {
	throw new Error('selectServer not yet implemented');
}
export function logout(): void {
	writeRow({
		auth_token: null,
		account_user: null,
		server_name: null,
		server_base_url: null,
		server_id: null,
	});
	logger.info('Plex auth: logged out');
}

// Internal helper exposed for the reason flag (used by Task 4 on token-rejected)
export function _setReason(r: string): void {
	pendingReason = r;
}
```

- [ ] **Step 2: Verify it type-checks and the app still boots**

Run:

```bash
bun -e 'import { getStatus, getActiveConfig } from "./src/services/plex-auth.ts"; console.log({ status: getStatus(), config: getActiveConfig() });'
```

Expected: `{ status: { state: 'idle', reason: undefined }, config: null }` if no env vars set, or `{ state: 'idle', ... }` + `{ baseUrl, token }` if `PLEX_URL` and `PLEX_TOKEN` are in `.env`.

- [ ] **Step 3: Commit**

```bash
git add src/services/plex-auth.ts
git commit -m "Add plex-auth service skeleton (state + persistence, stubs for PIN flow)"
```

---

### Task 3: Refactor PlexProvider to getter + wire into index.ts

**Files:**
- Modify: `src/services/providers/plex.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Refactor `PlexProvider` constructor + internal accessors**

Open `src/services/providers/plex.ts`. Replace the constructor and the top of the class. The change: instead of storing `baseUrl` and `token` strings, store a getter and resolve them per-call.

Replace:

```ts
export class PlexProvider implements StreamProvider {
	readonly name = 'plex';
	private baseUrl: string;
	private token: string;

	constructor(baseUrl: string, token: string) {
		// Remove trailing slash
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.token = token;
	}

	canHandle(input: string): boolean {
		return input.startsWith('plex:');
	}
```

With:

```ts
export class PlexProvider implements StreamProvider {
	readonly name = 'plex';
	private getConfig: () => { baseUrl: string; token: string } | null;

	constructor(getConfig: () => { baseUrl: string; token: string } | null) {
		this.getConfig = getConfig;
	}

	private resolveConfig(): { baseUrl: string; token: string } | null {
		const cfg = this.getConfig();
		if (!cfg) return null;
		return { baseUrl: cfg.baseUrl.replace(/\/+$/, ''), token: cfg.token };
	}

	canHandle(input: string): boolean {
		return input.startsWith('plex:');
	}
```

- [ ] **Step 2: Update every internal use of `this.baseUrl` / `this.token`**

Inside `resolve()`, `search()`, `browse()`, `browseLibraries()`, and `fetchMetadata()`, replace direct references to `this.baseUrl` and `this.token` with a local resolved config and an early-return if unconfigured.

At the top of `resolve()`, add:

```ts
		const cfg = this.resolveConfig();
		if (!cfg) return null;
```

Then inside the method, replace every `${this.baseUrl}` with `${cfg.baseUrl}` and every `${this.token}` with `${cfg.token}`.

At the top of `search()`, add:

```ts
		const cfg = this.resolveConfig();
		if (!cfg) return [];
```

Then replace `this.baseUrl` → `cfg.baseUrl`, `this.token` → `cfg.token` throughout the method.

At the top of `browse()`, add:

```ts
		const cfg = this.resolveConfig();
		if (!cfg) return { items: [], path: path || '/' };
```

Then replace `this.baseUrl` → `cfg.baseUrl`, `this.token` → `cfg.token` throughout.

`browseLibraries()` is private and called from `browse()`. Change its signature to accept the config:

Replace:

```ts
	private async browseLibraries(): Promise<BrowseResult> {
		const url = `${this.baseUrl}/library/sections?X-Plex-Token=${this.token}`;
```

With:

```ts
	private async browseLibraries(cfg: { baseUrl: string; token: string }): Promise<BrowseResult> {
		const url = `${cfg.baseUrl}/library/sections?X-Plex-Token=${cfg.token}`;
```

In `browse()`, update the call site from `await this.browseLibraries()` to `await this.browseLibraries(cfg)`.

Similarly, `fetchMetadata()`:

Replace:

```ts
	private async fetchMetadata(itemId: string): Promise<any> {
		const url = `${this.baseUrl}/library/metadata/${itemId}?X-Plex-Token=${this.token}`;
```

With:

```ts
	private async fetchMetadata(cfg: { baseUrl: string; token: string }, itemId: string): Promise<any> {
		const url = `${cfg.baseUrl}/library/metadata/${itemId}?X-Plex-Token=${cfg.token}`;
```

In `resolve()`, update the call from `await this.fetchMetadata(itemId)` to `await this.fetchMetadata(cfg, itemId)`.

- [ ] **Step 3: Rewire registration in `src/index.ts`**

Open `src/index.ts`. Replace this block (currently around line 61):

```ts
if (config.plexUrl && config.plexToken) {
	providerManager.register(new PlexProvider(config.plexUrl, config.plexToken));
	logger.info(`Plex provider enabled: ${config.plexUrl}`);
}
```

With:

```ts
providerManager.register(new PlexProvider(() => plexAuth.getActiveConfig()));
{
	const cfg = plexAuth.getActiveConfig();
	if (cfg) logger.info(`Plex provider enabled: ${cfg.baseUrl}`);
	else logger.info('Plex provider registered but not yet authenticated');
}
```

And add the import at the top of `src/index.ts` near the other service imports:

```ts
import * as plexAuth from './services/plex-auth.js';
```

- [ ] **Step 4: Verify env-fallback path still works**

If you have `PLEX_URL` and `PLEX_TOKEN` in `.env`, start the app:

```bash
bun src/index.ts
```

Expected log line:

```
Plex provider enabled: http://<your-plex-host>:32400
```

Open the dashboard, click the Plex tab, search for a known item. Expected: search results show up exactly as before this change.

If you don't have a Plex env config, set `PLEX_URL` and `PLEX_TOKEN` to dummy values; the app should still start and log "Plex provider registered but not yet authenticated" (since the dummy creds will fail any actual request — that's fine for this task, we just need the registration path verified).

- [ ] **Step 5: Commit**

```bash
git add src/services/providers/plex.ts src/index.ts
git commit -m "Refactor PlexProvider to read auth via getter; register unconditionally"
```

---

### Task 4: PIN flow + token capture in PlexAuth

**Files:**
- Modify: `src/services/plex-auth.ts`

This task fills in `startLogin`, `cancelLogin`, and the background poll that captures the auth token and account username.

- [ ] **Step 1: Add Plex.tv client header helper at the top of `plex-auth.ts`**

Open `src/services/plex-auth.ts`. After the existing `import` lines and before `export type AuthState`, add:

```ts
import pkg from '../../package.json' assert { type: 'json' };

const PLEX_PRODUCT_HEADERS: Record<string, string> = {
	'X-Plex-Product': 'StreamBot',
	'X-Plex-Version': (pkg as any).version || '0.0.0',
	'X-Plex-Device': 'server',
	'X-Plex-Device-Name': 'StreamBot',
	'X-Plex-Platform': 'Node.js',
};

function plexHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		Accept: 'application/json',
		'X-Plex-Client-Identifier': getClientId(),
		...PLEX_PRODUCT_HEADERS,
		...(extra || {}),
	};
}
```

Note: if the `import pkg from '../../package.json' assert { type: 'json' };` line errors under your TypeScript config, replace it with:

```ts
const pkg = { version: '2.0.1' };
```

and accept that the version stays hardcoded until someone wires up dynamic loading. The Plex API doesn't care about the exact value.

- [ ] **Step 2: Add pending-PIN state at module scope**

Below the `pendingReason` line, add:

```ts
interface PendingPin {
	id: number;
	code: string;
	expiresAt: number;
	pollHandle: ReturnType<typeof setInterval>;
}

let pendingPin: PendingPin | undefined;
let lastDiscoveredServers: DiscoveredServer[] | undefined;
```

- [ ] **Step 3: Update `getStatus()` to surface pending-PIN data + linked-state server list**

Replace the body of `getStatus()` with:

```ts
export function getStatus(): AuthStatus {
	const row = readRow();
	const reason = pendingReason;
	pendingReason = undefined;

	if (row.auth_token && row.server_base_url) {
		return {
			state: 'ready',
			accountUser: row.account_user || undefined,
			serverName: row.server_name || undefined,
			reason,
		};
	}
	if (row.auth_token) {
		return {
			state: 'linked',
			accountUser: row.account_user || undefined,
			servers: lastDiscoveredServers,
			reason,
		};
	}
	if (pendingPin) {
		if (Date.now() > pendingPin.expiresAt) {
			return { state: 'pin-expired', reason };
		}
		return {
			state: 'awaiting-pin',
			code: pendingPin.code,
			codeExpiresAt: pendingPin.expiresAt,
			reason,
		};
	}
	return { state: 'idle', reason };
}
```

- [ ] **Step 4: Implement `startLogin` and the background poll**

Replace the stub `startLogin` and `cancelLogin` with:

```ts
export async function startLogin(): Promise<{ code: string; expiresAt: number }> {
	// Replace any existing pending PIN
	if (pendingPin) {
		clearInterval(pendingPin.pollHandle);
		pendingPin = undefined;
	}

	const res = await fetch('https://plex.tv/api/v2/pins?strong=true', {
		method: 'POST',
		headers: plexHeaders(),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`plex.tv/pins failed: ${res.status} ${text.slice(0, 200)}`);
	}
	const data = await res.json() as { id: number; code: string; expiresAt: string };
	const expiresAt = new Date(data.expiresAt).getTime();

	const pollHandle = setInterval(() => { pollPin().catch(err => logger.error('Plex PIN poll error:', err)); }, 2000);
	pendingPin = { id: data.id, code: data.code, expiresAt, pollHandle };

	logger.info(`Plex auth: PIN ${data.code} created (id=${data.id})`);
	return { code: data.code, expiresAt };
}

export function cancelLogin(): void {
	if (!pendingPin) return;
	clearInterval(pendingPin.pollHandle);
	pendingPin = undefined;
	logger.info('Plex auth: PIN cancelled');
}

async function pollPin(): Promise<void> {
	if (!pendingPin) return;
	if (Date.now() > pendingPin.expiresAt) {
		clearInterval(pendingPin.pollHandle);
		// Leave pendingPin set so getStatus() can report `pin-expired` once.
		// Next startLogin() will replace it.
		return;
	}
	const res = await fetch(`https://plex.tv/api/v2/pins/${pendingPin.id}`, {
		headers: plexHeaders(),
	});
	if (!res.ok) return; // transient network/server hiccup; keep polling
	const data = await res.json() as { authToken: string | null };
	if (!data.authToken) return;

	// Token captured. Persist, stop poll, fetch user info, discover servers.
	const token = data.authToken;
	clearInterval(pendingPin.pollHandle);
	pendingPin = undefined;
	writeRow({ auth_token: token });

	try {
		const user = await fetchPlexUser(token);
		writeRow({ account_user: user });
	} catch (err) {
		logger.error('Plex auth: /user fetch failed:', err);
	}

	try {
		lastDiscoveredServers = await fetchPlexResources(token);
		logger.info(`Plex auth: linked; discovered ${lastDiscoveredServers.length} server(s)`);
	} catch (err) {
		logger.error('Plex auth: /resources fetch failed:', err);
		// If the token was rejected, wipe and go back to idle.
		if (err instanceof TokenRejectedError) {
			writeRow({ auth_token: null, account_user: null });
			pendingReason = 'token-rejected';
		}
	}
}

class TokenRejectedError extends Error {}

async function fetchPlexUser(token: string): Promise<string> {
	const res = await fetch('https://plex.tv/api/v2/user', {
		headers: plexHeaders({ 'X-Plex-Token': token }),
	});
	if (res.status === 401 || res.status === 403) throw new TokenRejectedError(`user ${res.status}`);
	if (!res.ok) throw new Error(`user ${res.status}`);
	const data = await res.json() as { username?: string; email?: string };
	return data.username || data.email || 'unknown';
}

async function fetchPlexResources(token: string): Promise<DiscoveredServer[]> {
	const res = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
		headers: plexHeaders({ 'X-Plex-Token': token }),
	});
	if (res.status === 401 || res.status === 403) throw new TokenRejectedError(`resources ${res.status}`);
	if (!res.ok) throw new Error(`resources ${res.status}`);
	const items = await res.json() as Array<{
		clientIdentifier: string;
		name: string;
		owned: boolean;
		provides: string;
		connections: Array<{ uri: string; local: boolean; relay: boolean; protocol: string }>;
	}>;
	return items
		.filter(item => (item.provides || '').split(',').includes('server'))
		.map(item => ({
			id: item.clientIdentifier,
			name: item.name,
			owned: item.owned,
			connections: (item.connections || []).map(c => ({
				uri: c.uri,
				local: c.local,
				https: c.protocol === 'https',
				relay: c.relay,
			})),
		}));
}
```

- [ ] **Step 5: Verify PIN creation works end-to-end up to token capture**

Add a temporary debug script (don't commit it):

```bash
bun -e '
import * as plexAuth from "./src/services/plex-auth.ts";
const { code, expiresAt } = await plexAuth.startLogin();
console.log("CODE:", code, "expires:", new Date(expiresAt).toISOString());
console.log("Visit https://plex.tv/link and enter the code.");
const start = Date.now();
while (Date.now() - start < 60000) {
  await new Promise(r => setTimeout(r, 2000));
  const s = plexAuth.getStatus();
  console.log("state:", s.state, s.accountUser ? `user=${s.accountUser}` : "");
  if (s.state === "linked" || s.state === "ready") break;
}
process.exit(0);
'
```

Expected: prints a 4-char code, then state cycles `awaiting-pin` until you approve at plex.tv/link, then becomes `linked` with your username. The `data/streambot.db` row's `auth_token` column will be populated.

Verify the persisted state:

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database("data/streambot.db"); const r = db.query("SELECT auth_token IS NOT NULL as has_token, account_user, server_base_url FROM plex_auth WHERE id = 1").get(); console.log(r);'
```

Expected: `{ has_token: 1, account_user: "<your-name>", server_base_url: null }`.

- [ ] **Step 6: Commit**

```bash
git add src/services/plex-auth.ts
git commit -m "Implement Plex PIN login flow with background poll and token capture"
```

---

### Task 5: Server selection + logout

**Files:**
- Modify: `src/services/plex-auth.ts`

- [ ] **Step 1: Implement `listServers` and `selectServer`**

Replace the `listServers` and `selectServer` stubs with:

```ts
export async function listServers(): Promise<DiscoveredServer[]> {
	const row = readRow();
	if (!row.auth_token) throw new Error('Not authenticated');
	lastDiscoveredServers = await fetchPlexResources(row.auth_token);
	return lastDiscoveredServers;
}

function pickPreferredConnection(server: DiscoveredServer): DiscoveredServerConnection | undefined {
	const conns = server.connections;
	return (
		conns.find(c => c.local && !c.relay) ||
		conns.find(c => !c.relay) ||
		conns[0]
	);
}

export async function selectServer(serverId: string, connectionUri?: string): Promise<void> {
	const row = readRow();
	if (!row.auth_token) throw new Error('Not authenticated');

	if (!lastDiscoveredServers) {
		lastDiscoveredServers = await fetchPlexResources(row.auth_token);
	}
	const server = lastDiscoveredServers.find(s => s.id === serverId);
	if (!server) {
		const err: any = new Error(`Server ${serverId} not in discovered list`);
		err.code = 'unknown-server';
		throw err;
	}

	let chosenUri: string | undefined;
	if (connectionUri) {
		if (!server.connections.some(c => c.uri === connectionUri)) {
			const err: any = new Error(`Connection ${connectionUri} not in server's list`);
			err.code = 'unknown-connection';
			throw err;
		}
		chosenUri = connectionUri;
	} else {
		chosenUri = pickPreferredConnection(server)?.uri;
	}
	if (!chosenUri) {
		const err: any = new Error('Server has no usable connection');
		err.code = 'no-connection';
		throw err;
	}

	// Smoke test
	const stripped = chosenUri.replace(/\/+$/, '');
	let testRes: Response;
	try {
		testRes = await fetch(`${stripped}/identity?X-Plex-Token=${row.auth_token}`, {
			headers: plexHeaders({ 'X-Plex-Token': row.auth_token }),
		});
	} catch (err) {
		const e: any = new Error(`Connection failed to ${chosenUri}`);
		e.code = 'unreachable';
		e.uri = chosenUri;
		throw e;
	}
	if (!testRes.ok) {
		const e: any = new Error(`Connection returned ${testRes.status} on ${chosenUri}`);
		e.code = 'unreachable';
		e.uri = chosenUri;
		throw e;
	}

	writeRow({
		server_base_url: stripped,
		server_name: server.name,
		server_id: server.id,
	});
	logger.info(`Plex auth: server selected — ${server.name} at ${stripped}`);
}
```

- [ ] **Step 2: Verify server selection works**

Re-run the debug snippet from Task 4 first to ensure you're in `linked` state. Then run:

```bash
bun -e '
import * as plexAuth from "./src/services/plex-auth.ts";
const servers = await plexAuth.listServers();
console.log("Servers:", servers.map(s => ({ id: s.id, name: s.name, conns: s.connections.length })));
if (servers.length === 0) { console.log("No servers — sign in first."); process.exit(1); }
const target = servers[0];
console.log("Picking", target.name);
await plexAuth.selectServer(target.id);
console.log("Done. Status:", plexAuth.getStatus());
'
```

Expected: lists your servers, picks the first one, smoke test passes, status becomes `{ state: "ready", accountUser, serverName }`. The `data/streambot.db` row's `server_base_url` is now populated.

Then restart the app and verify the Plex provider initializes from sqlite:

```bash
bun src/index.ts
```

Expected log:

```
Plex provider enabled: http://<the-uri-you-just-saved>
```

Search a known item in the Plex tab. Expected: works as before, sourced from the sqlite-stored token (not env vars).

- [ ] **Step 3: Verify logout works**

With the app running, in another shell:

```bash
bun -e 'import * as plexAuth from "./src/services/plex-auth.ts"; plexAuth.logout(); console.log(plexAuth.getStatus());'
```

Expected: `{ state: "idle" }`. The Plex search in the dashboard should now fail with the existing "Plex not configured" 404 — verifying that the provider's `getConfig()` correctly returns null after logout.

- [ ] **Step 4: Commit**

```bash
git add src/services/plex-auth.ts
git commit -m "Plex auth: server discovery, selection with reachability smoke test"
```

---

### Task 6: HTTP endpoints

**Files:**
- Modify: `src/server/routes/api.ts`

- [ ] **Step 1: Add import at the top of `api.ts`**

Open `src/server/routes/api.ts`. Just below the existing imports, add:

```ts
import * as plexAuth from '../../services/plex-auth.js';
```

- [ ] **Step 2: Add `/api/plex/auth/*` endpoints**

Find the `// --- Plex endpoints ---` comment block (around line 1011). Immediately above it, add:

```ts
// --- Plex auth endpoints ---

router.get('/api/plex/auth/status', (_req: Request, res: Response) => {
	res.json(plexAuth.getStatus());
});

router.post('/api/plex/auth/start', async (_req: Request, res: Response) => {
	const status = plexAuth.getStatus();
	if (status.state === 'ready') {
		res.status(409).json({ error: 'Already signed in' });
		return;
	}
	try {
		const { code, expiresAt } = await plexAuth.startLogin();
		res.json({ code, expiresAt });
	} catch (err: any) {
		logger.error('Plex auth start failed:', err);
		res.status(502).json({ error: err.message || 'Failed to start login' });
	}
});

router.post('/api/plex/auth/cancel', (_req: Request, res: Response) => {
	const status = plexAuth.getStatus();
	if (status.state !== 'awaiting-pin') {
		res.status(409).json({ error: 'No pending PIN' });
		return;
	}
	plexAuth.cancelLogin();
	res.json({ ok: true });
});

router.post('/api/plex/auth/select-server', async (req: Request, res: Response) => {
	const { id, connectionUri } = req.body || {};
	if (!id || typeof id !== 'string') {
		res.status(400).json({ error: 'id is required' });
		return;
	}
	try {
		await plexAuth.selectServer(id, typeof connectionUri === 'string' ? connectionUri : undefined);
		res.json({ ok: true });
	} catch (err: any) {
		if (err.code === 'unknown-server' || err.code === 'unknown-connection') {
			res.status(400).json({ error: err.message });
			return;
		}
		if (err.code === 'unreachable' || err.code === 'no-connection') {
			res.status(502).json({ error: err.message, uri: err.uri });
			return;
		}
		logger.error('Plex auth select-server failed:', err);
		res.status(500).json({ error: err.message || 'Failed to select server' });
	}
});

router.post('/api/plex/auth/logout', (_req: Request, res: Response) => {
	plexAuth.logout();
	res.json({ ok: true });
});
```

- [ ] **Step 3: Verify the endpoints respond correctly**

Restart the app:

```bash
bun src/index.ts
```

In another shell (or via the dashboard's network tab), confirm each endpoint. We are blocked from using `curl` per the routing rules, so run the checks via Bun:

```bash
bun -e '
const base = "http://localhost:" + (process.env.SERVER_PORT || "8080");
const auth = "Basic " + Buffer.from(((process.env.SERVER_USERNAME || "admin") + ":" + (process.env.SERVER_PASSWORD || "admin"))).toString("base64");
const j = async (path, init={}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.headers||{}), Authorization: auth, "Content-Type": "application/json" } });
  const t = await r.text();
  console.log(r.status, path, t.slice(0, 200));
};
await j("/api/plex/auth/status");
await j("/api/plex/auth/start", { method: "POST" });
await j("/api/plex/auth/status");
await j("/api/plex/auth/cancel", { method: "POST" });
await j("/api/plex/auth/status");
'
```

Expected output (state names will reflect your starting state):

```
200 /api/plex/auth/status {"state":"idle"}
200 /api/plex/auth/start {"code":"XXXX","expiresAt":...}
200 /api/plex/auth/status {"state":"awaiting-pin","code":"XXXX",...}
200 /api/plex/auth/cancel {"ok":true}
200 /api/plex/auth/status {"state":"idle"}
```

If your server uses different auth or port settings, adjust the env reads. If you find your dashboard uses sessions instead of basic auth, hit these endpoints from the browser's devtools console instead.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/api.ts
git commit -m "Add /api/plex/auth/* HTTP endpoints"
```

---

### Task 7: Dashboard auth panel markup

**Files:**
- Modify: `src/server/views/pages/dashboard.ejs`

- [ ] **Step 1: Remove tab-hiding on the nav `<li>`**

Open `src/server/views/pages/dashboard.ejs`. Around line 25 you will find:

```html
		<li class="nav-item" role="presentation" id="plexTabNav">
```

Leave the `id` alone — it's still useful for tests — but we need to make sure nothing hides it. Search the JS for `plexTabNav` (search occurrences are near lines 833, 836, 839, 840). Delete the two `style.display = ''` / `style.display = 'none'` assignments inside `checkPlexAvailable()`. We'll fully remove `checkPlexAvailable` in Task 8; for now, just stop fighting visibility.

Inside `checkPlexAvailable()` body, replace the function (around line 830) temporarily with:

```js
async function checkPlexAvailable() {
	// Replaced by refreshPlexAuth() in Task 8.
}
```

- [ ] **Step 2: Add the auth panel markup at the top of the Plex tab**

Find the `<!-- Plex Tab -->` block (around line 296):

```html
		<!-- Plex Tab -->
		<div class="tab-pane fade" id="plex" role="tabpanel" aria-labelledby="plex-tab">
			<div class="card mb-3">
				<div class="card-body py-3">
					<div class="input-group">
```

Replace it with:

```html
		<!-- Plex Tab -->
		<div class="tab-pane fade" id="plex" role="tabpanel" aria-labelledby="plex-tab">

			<!-- Plex Auth Panel -->
			<div class="card mb-3" id="plexAuthPanel">
				<div class="card-body" id="plexAuthBody">
					<p class="text-muted mb-0">Loading Plex status…</p>
				</div>
			</div>

			<!-- Plex Ready Content (search + browse, only shown when authenticated) -->
			<div id="plexReadyContent" style="display:none;">
			<div class="card mb-3">
				<div class="card-body py-3">
					<div class="input-group">
```

Then find the closing of the existing Plex tab. Several `</div>`s down (around line 333, just before `<!-- Logs Tab -->`), you'll see:

```html
				</div>
			</div>
		</div>

		<!-- Logs Tab -->
```

Insert an extra closing `</div>` for the new `#plexReadyContent` wrapper:

```html
				</div>
			</div>
			</div>
		</div>

		<!-- Logs Tab -->
```

(One extra `</div>` at the matching indent level so `#plexReadyContent` closes before the tab-pane closes.)

- [ ] **Step 3: Sanity-check the markup renders without breaking the page**

Start the app, open the dashboard, click the Plex tab. Expected:
- Tab is visible (whether or not you're authenticated).
- The auth panel says "Loading Plex status…" (we haven't wired the JS yet — that's Task 8).
- The original search / browse UI is hidden (because `#plexReadyContent` has `display:none`).
- No console errors.

If the layout looks visually broken (unclosed div), inspect element on the tab content and confirm the div structure matches the spec above. Do not commit a broken layout.

- [ ] **Step 4: Commit**

```bash
git add src/server/views/pages/dashboard.ejs
git commit -m "Dashboard: add Plex auth panel container; wrap existing UI in ready container"
```

---

### Task 8: Dashboard auth JS (refreshPlexAuth + handlers)

**Files:**
- Modify: `src/server/views/pages/dashboard.ejs`

- [ ] **Step 1: Replace `checkPlexAvailable()` with `refreshPlexAuth()` + supporting helpers**

In the `<script>` section near line 827, find the `// --- Plex ---` comment. Just above `let plexBrowseHistory = [];`, insert:

```js
let plexAuthPollHandle = null;

function plexRenderAuth(status) {
	const body = document.getElementById('plexAuthBody');
	const readyContent = document.getElementById('plexReadyContent');

	switch (status.state) {
		case 'idle':
			body.innerHTML = `
				<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
					<div>
						<strong>Plex is not signed in.</strong>
						<div class="text-muted small">Click sign in to link your Plex account.</div>
					</div>
					<button class="btn btn-primary" id="plexSignInBtn">
						<i class="fas fa-sign-in-alt me-1"></i>Sign in to Plex
					</button>
				</div>
			`;
			document.getElementById('plexSignInBtn').addEventListener('click', plexStartSignIn);
			readyContent.style.display = 'none';
			break;
		case 'awaiting-pin':
			body.innerHTML = `
				<div class="text-center">
					<div class="text-muted small mb-2">Go to <strong>plex.tv/link</strong> and enter:</div>
					<div class="display-4 font-monospace mb-3" style="letter-spacing:0.4em;">${escapeHtml(status.code || '')}</div>
					<a class="btn btn-primary me-2" href="https://plex.tv/link" target="_blank" rel="noopener">
						<i class="fas fa-external-link-alt me-1"></i>Open plex.tv/link
					</a>
					<button class="btn btn-outline-secondary" id="plexCancelBtn">Cancel</button>
				</div>
			`;
			document.getElementById('plexCancelBtn').addEventListener('click', plexCancelSignIn);
			readyContent.style.display = 'none';
			break;
		case 'pin-expired':
			body.innerHTML = `
				<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
					<div class="text-danger"><strong>Code expired.</strong> Start a new sign-in to try again.</div>
					<button class="btn btn-primary" id="plexSignInBtn">Sign in to Plex</button>
				</div>
			`;
			document.getElementById('plexSignInBtn').addEventListener('click', plexStartSignIn);
			readyContent.style.display = 'none';
			break;
		case 'linked':
			plexRenderServerPicker(status);
			readyContent.style.display = 'none';
			break;
		case 'ready':
			body.innerHTML = `
				<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
					<div>
						<i class="fas fa-check-circle text-success me-1"></i>
						Signed in as <strong>${escapeHtml(status.accountUser || 'unknown')}</strong>
						<span class="text-muted"> &middot; ${escapeHtml(status.serverName || 'server')}</span>
					</div>
					<button class="btn btn-outline-danger btn-sm" id="plexSignOutBtn">Sign out</button>
				</div>
			`;
			document.getElementById('plexSignOutBtn').addEventListener('click', plexSignOut);
			readyContent.style.display = '';
			break;
		default:
			body.innerHTML = `<div class="text-muted">Unknown state: ${escapeHtml(status.state)}</div>`;
			readyContent.style.display = 'none';
	}

	if (status.reason === 'token-rejected') {
		showErrorToast('Plex rejected the stored token. Please sign in again.');
	}
}

function plexRenderServerPicker(status) {
	const body = document.getElementById('plexAuthBody');
	const servers = status.servers || [];
	if (servers.length === 0) {
		body.innerHTML = `
			<div>
				<strong>Signed in</strong> — no servers discovered yet.
				<button class="btn btn-outline-secondary btn-sm ms-2" id="plexRefreshSrvBtn">Retry</button>
			</div>
		`;
		document.getElementById('plexRefreshSrvBtn').addEventListener('click', refreshPlexAuth);
		return;
	}
	const opts = servers.map((s, i) =>
		`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}${s.owned ? '' : ' (shared)'}</option>`
	).join('');
	body.innerHTML = `
		<div class="row g-2 align-items-end">
			<div class="col-md">
				<label class="form-label small mb-1">Server</label>
				<select class="form-select" id="plexServerSelect">${opts}</select>
			</div>
			<div class="col-md">
				<label class="form-label small mb-1">Connection</label>
				<select class="form-select" id="plexConnectionSelect"></select>
			</div>
			<div class="col-md-auto">
				<button class="btn btn-primary" id="plexUseServerBtn">Use this server</button>
			</div>
		</div>
		<div class="text-muted small mt-2">Picked automatically if you don't change the connection.</div>
	`;
	const serverSel = document.getElementById('plexServerSelect');
	const connSel = document.getElementById('plexConnectionSelect');
	function refreshConns() {
		const srv = servers.find(s => s.id === serverSel.value);
		const conns = srv ? srv.connections : [];
		connSel.innerHTML = conns.map(c =>
			`<option value="${escapeHtml(c.uri)}">${escapeHtml(c.uri)}${c.local ? ' (local)' : ''}${c.relay ? ' (relay)' : ''}</option>`
		).join('');
	}
	serverSel.addEventListener('change', refreshConns);
	refreshConns();
	document.getElementById('plexUseServerBtn').addEventListener('click', async () => {
		const id = serverSel.value;
		const connectionUri = connSel.value || undefined;
		try {
			const r = await fetch('/api/plex/auth/select-server', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, connectionUri }),
			});
			if (!r.ok) {
				const data = await r.json().catch(() => ({}));
				showErrorToast(data.error || `Failed (${r.status})`);
				return;
			}
			refreshPlexAuth();
		} catch (e) {
			showErrorToast('Failed to select server');
		}
	});
}

async function refreshPlexAuth() {
	try {
		const r = await fetch('/api/plex/auth/status');
		if (!r.ok) return;
		const status = await r.json();
		plexRenderAuth(status);
		if (status.state === 'awaiting-pin') {
			if (!plexAuthPollHandle) {
				plexAuthPollHandle = setInterval(() => {
					if (document.hidden) return;
					refreshPlexAuth();
				}, 2000);
			}
		} else if (plexAuthPollHandle) {
			clearInterval(plexAuthPollHandle);
			plexAuthPollHandle = null;
		}
	} catch (e) {
		// Network blip — try again on next refresh
	}
}

async function plexStartSignIn() {
	try {
		const r = await fetch('/api/plex/auth/start', { method: 'POST' });
		if (!r.ok) {
			const data = await r.json().catch(() => ({}));
			showErrorToast(data.error || `Failed (${r.status})`);
			return;
		}
		refreshPlexAuth();
	} catch (e) {
		showErrorToast('Failed to start sign in');
	}
}

async function plexCancelSignIn() {
	try {
		await fetch('/api/plex/auth/cancel', { method: 'POST' });
		refreshPlexAuth();
	} catch (e) {
		// ignore
	}
}

async function plexSignOut() {
	try {
		await fetch('/api/plex/auth/logout', { method: 'POST' });
		refreshPlexAuth();
	} catch (e) {
		// ignore
	}
}
```

- [ ] **Step 2: Replace the placeholder `checkPlexAvailable` and its callers**

In the `<script>` section, delete the now-stub `checkPlexAvailable` (added in Task 7 Step 1) entirely. Then find the `DOMContentLoaded` listener at the bottom (around line 1083):

```js
document.addEventListener('DOMContentLoaded', () => {
	startPolling();
	checkPlexAvailable();
	loadVCHistory();
});
```

Replace with:

```js
document.addEventListener('DOMContentLoaded', () => {
	startPolling();
	refreshPlexAuth();
	loadVCHistory();
});
```

Also find the Plex tab `shown.bs.tab` handler around line 985:

```js
document.getElementById('plex-tab')?.addEventListener('shown.bs.tab', () => browsePlex());
```

Update to also refresh auth status when the tab is shown, and only call `browsePlex()` if `#plexReadyContent` is visible:

```js
document.getElementById('plex-tab')?.addEventListener('shown.bs.tab', () => {
	refreshPlexAuth();
	if (document.getElementById('plexReadyContent').style.display !== 'none') {
		browsePlex();
	}
});
```

- [ ] **Step 3: Manual click-through verification**

This task touches the most user-visible surface. Run the full happy-path:

1. With no auth in sqlite and no env vars: open dashboard → Plex tab. Expected: panel shows "Plex is not signed in" + "Sign in to Plex" button.
2. Click "Sign in to Plex". Panel switches to a 4-character code + "Open plex.tv/link" button.
3. Open plex.tv/link in another tab (the button opens it) and enter the code. Within ~2s the dashboard auto-flips to the server picker.
4. Pick a server, leave the connection default, click "Use this server". The panel switches to "Signed in as X — Server Y — Sign out", and the search/browse UI appears below.
5. Click into a Plex library, queue an item — confirms the path you used pre-refactor still works.
6. Click "Sign out". Panel returns to "Plex is not signed in"; search/browse UI hides.

If anything in steps 1–6 fails, fix and re-verify before committing — this is the user-facing surface that earns the work.

- [ ] **Step 4: Commit**

```bash
git add src/server/views/pages/dashboard.ejs
git commit -m "Dashboard: Plex auth UI with PIN polling, server picker, sign-out"
```

---

### Task 9: Full manual test pass against the spec

This task runs through every scenario in the spec's "Manual test plan" section. Some you already exercised piecemeal in Tasks 4–8; this is the consolidated verification. Don't commit anything; if something fails, file a fix as a new task.

- [ ] **Step 1: Fresh login (no env, empty DB)**

```bash
rm -f data/streambot.db
# Comment out PLEX_URL / PLEX_TOKEN in .env, or set them empty
bun src/index.ts
```

Walk through Task 8 steps 1–4. Expected: end state is `ready`; `data/streambot.db` row has `auth_token` and `server_base_url` populated.

- [ ] **Step 2: Multi-connection server**

If any of your Plex servers expose >1 connection, repeat Step 1 but pick a different connection in the dropdown. Confirm it persists. Then pick a known-unreachable connection (e.g., a local-IP connection from outside that network). Expected: 502 toast, no persistence change.

- [ ] **Step 3: Restart persists**

Restart the app (`Ctrl-C`, `bun src/index.ts`). Open dashboard. Expected: Plex tab immediately in `ready` state, search/browse works. The startup log line reads `Plex provider enabled: <your-server-uri>`.

- [ ] **Step 4: Sign out**

Click "Sign out". Expected: panel returns to `idle`. `/api/plex/browse` returns 404. Sign in again → returns to `ready`.

- [ ] **Step 5: Env fallback**

```bash
rm -f data/streambot.db
# Set PLEX_URL and PLEX_TOKEN in .env to a valid token+url
bun src/index.ts
```

Open Plex tab. Expected: directly in `ready` state, search/browse works. The displayed username may be missing (env fallback doesn't fetch user info) — that's acceptable, the spec only commits to server functionality.

- [ ] **Step 6: Revoked-token recovery**

While in `ready` state (sqlite-sourced), externally invalidate the token by signing out from plex.tv on a different device. The next Plex search will fail at the provider level. User clicks "Sign out" → "Sign in to Plex" → completes flow again. Expected: returns to `ready` with new token.

- [ ] **Step 7: PIN expiry**

Click "Sign in to Plex". Don't approve at plex.tv/link. Wait >15 minutes. Expected: panel transitions to "Code expired" with a fresh-sign-in button. Clicking it starts a new code immediately.

- [ ] **Step 8: Concurrent re-start**

Click "Sign in to Plex". Note the code. Click "Sign in to Plex" again immediately. Expected: code changes; the first code, if entered at plex.tv/link, has no effect on this app.

If all eight pass, the feature is done. Update the spec's status from "Draft, pending user review" to "Implemented" in a final commit.

```bash
# In docs/superpowers/specs/2026-05-27-plex-login-design.md:
# Change "**Status:** Draft, pending user review" → "**Status:** Implemented"
git add docs/superpowers/specs/2026-05-27-plex-login-design.md
git commit -m "Mark Plex login spec as implemented"
```

---

## Self-review summary

- **Spec coverage:** Tasks 1–8 each map to spec sections:
  - Spec "Architecture / new files" → Tasks 1 (`db.ts`), 2+4+5 (`plex-auth.ts`)
  - Spec "Architecture / touched files" → Task 3 (provider + index), 6 (api routes), 7+8 (dashboard)
  - Spec "Data: SQLite schema" → Task 1 Step 3
  - Spec "Auth precedence" → Task 2 Step 1 (`getActiveConfig`)
  - Spec "Auth state machine" → Task 4 Step 3 (`getStatus`)
  - Spec "HTTP endpoints" → Task 6
  - Spec "Plex.tv calls used by the server" → Task 4 (`plexHeaders`, `fetchPlexUser`, `fetchPlexResources`, PIN flow), Task 5 (smoke test)
  - Spec "Server / connection selection" → Task 5 Step 1 (`pickPreferredConnection`)
  - Spec "Frontend flow" → Tasks 7 (markup), 8 (JS)
  - Spec "Error handling" → Tasks 4 (token-rejected), 5 (smoke-test error codes), 6 (endpoint error mapping), 8 (UI toast on reason)
  - Spec "Manual test plan" → Task 9
- **Placeholder scan:** No `TBD` / `TODO` / "add appropriate handling" phrases remain. Every code block contains real code.
- **Type consistency:** `getStatus`, `startLogin`, `cancelLogin`, `listServers`, `selectServer`, `logout`, `getActiveConfig`, `getClientId` are spelled identically across Tasks 2–8. `AuthStatus`, `DiscoveredServer`, `DiscoveredServerConnection` are defined once in Task 2 and referenced consistently. Error codes (`unknown-server`, `unknown-connection`, `unreachable`, `no-connection`) match between Task 5 (throw site) and Task 6 (mapping).
- **Caveats called out:** `bun:sqlite` breaks `start:node`; `package.json` JSON import may need a fallback line; no automated tests.
