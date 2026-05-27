import { BaseCommand } from './base.js';
import { CommandContext } from '../types/index.js';

export default class PauseCommand extends BaseCommand {
	name = 'pause';
	description = 'Pause the currently playing video';
	usage = 'pause';

	async execute(context: CommandContext): Promise<void> {
		if (!context.streamStatus.playing) {
			await this.sendError(context.message, 'Nothing is currently playing.');
			return;
		}

		try {
			const position = await context.streamingService.pausePlayback();
			const timeStr = formatTime(position);
			await this.sendInfo(context.message, 'Paused', `Paused at ${timeStr}`);
		} catch (error: any) {
			await this.sendError(context.message, error.message || 'Failed to pause.');
		}
	}
}

function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}
