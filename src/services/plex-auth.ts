import { db } from './db.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const pkg = { version: '2.0.1' };

const PLEX_PRODUCT_HEADERS: Record<string, string> = {
	'X-Plex-Product': 'Gatherr',
	'X-Plex-Version': (pkg as any).version || '0.0.0',
	'X-Plex-Device': 'server',
	'X-Plex-Device-Name': 'Gatherr',
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
	// Per-server access token issued by plex.tv. Required to query non-owned
	// (shared) servers — the account token alone returns 401. Stripped from the
	// payload returned by `getStatus()` so it never reaches the browser.
	accessToken?: string;
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
	server_access_token: string | null;
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

interface PendingPin {
	id: number;
	code: string;
	expiresAt: number;
	pollHandle: ReturnType<typeof setInterval>;
}

let pendingPin: PendingPin | undefined;
let lastDiscoveredServers: DiscoveredServer[] | undefined;

export function getClientId(): string {
	return readRow().client_id;
}

export function getActiveConfig(): { baseUrl: string; token: string } | null {
	const row = readRow();
	if (row.auth_token && row.server_base_url) {
		// Per-server token (from /resources `accessToken`) is required for shared
		// servers; fall back to the account token for owned servers and legacy rows.
		return { baseUrl: row.server_base_url, token: row.server_access_token || row.auth_token };
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
		// Strip per-server accessTokens before sending to the client — they are secrets.
		const safeServers = lastDiscoveredServers?.map(({ accessToken: _t, ...rest }) => rest);
		return {
			state: 'linked',
			accountUser: row.account_user || undefined,
			servers: safeServers,
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

export async function startLogin(): Promise<{ code: string; expiresAt: number }> {
	if (pendingPin) {
		clearInterval(pendingPin.pollHandle);
		pendingPin = undefined;
	}

	const res = await fetch('https://plex.tv/api/v2/pins', {
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
		return;
	}
	const res = await fetch(`https://plex.tv/api/v2/pins/${pendingPin.id}`, {
		headers: plexHeaders(),
	});
	if (!res.ok) return;
	const data = await res.json() as { authToken: string | null };
	if (!data.authToken) return;

	// Race guard: another concurrent pollPin invocation may have already captured.
	if (!pendingPin) return;

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
		accessToken?: string;
		connections: Array<{ uri: string; local: boolean; relay: boolean; protocol: string }>;
	}>;
	return items
		.filter(item => (item.provides || '').split(',').includes('server'))
		.map(item => ({
			id: item.clientIdentifier,
			name: item.name,
			owned: item.owned,
			accessToken: item.accessToken,
			connections: (item.connections || []).map(c => ({
				uri: c.uri,
				local: c.local,
				https: c.protocol === 'https',
				relay: c.relay,
			})),
		}));
}

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

	// Smoke test — use the per-server access token if available (required for
	// shared servers; owned servers accept either). /identity is public, but we
	// also verify auth works by checking /library/sections returns non-401.
	const stripped = chosenUri.replace(/\/+$/, '');
	const probeToken = server.accessToken || row.auth_token;
	let testRes: Response;
	try {
		testRes = await fetch(`${stripped}/library/sections?X-Plex-Token=${probeToken}`, {
			headers: plexHeaders({ 'X-Plex-Token': probeToken }),
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
		server_access_token: server.accessToken || null,
	});
	logger.info(`Plex auth: server selected — ${server.name} at ${stripped} (${server.accessToken ? 'per-server' : 'account'} token)`);
}

export function logout(): void {
	cancelLogin();
	lastDiscoveredServers = undefined;
	writeRow({
		auth_token: null,
		account_user: null,
		server_name: null,
		server_base_url: null,
		server_id: null,
		server_access_token: null,
	});
	logger.info('Plex auth: logged out');
}

// Internal helper exposed for the reason flag (used by Task 4 on token-rejected)
export function _setReason(r: string): void {
	pendingReason = r;
}
