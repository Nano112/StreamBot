import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';

export interface VCEntry {
	guildId: string;
	guildName: string;
	guildIcon: string | null;
	channelId: string;
	channelName: string;
	lastUsed: string;
}

const MAX_ENTRIES = 10;
const filePath = join(process.cwd(), '.gatherr-vc-history.json');

let entries: VCEntry[] = [];

// Load on startup
try {
	if (existsSync(filePath)) {
		entries = JSON.parse(readFileSync(filePath, 'utf-8'));
	}
} catch {
	entries = [];
}

function save(): void {
	try {
		writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
	} catch (err) {
		logger.debug('Failed to save VC history:', err);
	}
}

export function recordVC(entry: Omit<VCEntry, 'lastUsed'>): void {
	// Remove existing entry for same guild+channel
	entries = entries.filter(e => !(e.guildId === entry.guildId && e.channelId === entry.channelId));

	// Add at front
	entries.unshift({ ...entry, lastUsed: new Date().toISOString() });

	// Trim
	if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);

	save();
}

export function getVCHistory(): VCEntry[] {
	return [...entries];
}

export function removeVCEntry(guildId: string, channelId: string): boolean {
	const before = entries.length;
	entries = entries.filter(e => !(e.guildId === guildId && e.channelId === channelId));
	if (entries.length < before) { save(); return true; }
	return false;
}
