import { BaseCommand } from './base.js';
import { CommandContext } from '../types/index.js';

export default class SeekCommand extends BaseCommand {
	name = 'seek';
	description = 'Seek to a specific time in the current video';
	usage = 'seek <time> (e.g. 1:30, 90, 1:30:00)';

	async execute(context: CommandContext): Promise<void> {
		if (!context.streamStatus.playing) {
			await this.sendError(context.message, 'Nothing is currently playing.');
			return;
		}

		const timeArg = context.args.join(' ').trim();
		if (!timeArg) {
			await this.sendError(context.message, 'Please provide a time. Usage: seek 1:30 or seek 90');
			return;
		}

		const seconds = parseTime(timeArg);
		if (seconds === null || seconds < 0) {
			await this.sendError(context.message, 'Invalid time format. Use seconds (90) or colon notation (1:30, 1:30:00).');
			return;
		}

		try {
			const actualPosition = await context.streamingService.seekTo(seconds);
			const timeStr = formatTime(actualPosition);
			await this.sendInfo(context.message, 'Seeking', `Seeking to ${timeStr}...`);
		} catch (error: any) {
			await this.sendError(context.message, error.message || 'Failed to seek.');
		}
	}
}

function parseTime(input: string): number | null {
	// Try pure number (seconds)
	if (/^\d+(\.\d+)?$/.test(input)) {
		return parseFloat(input);
	}

	// Try colon-separated (H:MM:SS, M:SS, or MM:SS)
	const parts = input.split(':').map(p => parseInt(p, 10));
	if (parts.some(isNaN)) return null;

	if (parts.length === 2) {
		return parts[0] * 60 + parts[1];
	}
	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	}

	return null;
}

function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}
