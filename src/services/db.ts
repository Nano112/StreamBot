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
