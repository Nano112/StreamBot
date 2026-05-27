import { BaseCommand } from './base.js';
import { CommandContext } from '../types/index.js';

export default class ResumeCommand extends BaseCommand {
	name = 'resume';
	description = 'Resume paused playback';
	usage = 'resume';
	aliases = ['unpause'];

	async execute(context: CommandContext): Promise<void> {
		try {
			await context.streamingService.resumePlayback();
			await this.sendInfo(context.message, 'Resumed', 'Playback resumed.');
		} catch (error: any) {
			await this.sendError(context.message, error.message || 'Failed to resume.');
		}
	}
}
