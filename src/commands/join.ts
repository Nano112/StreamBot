import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import config from "../config.js";

export default class JoinCommand extends BaseCommand {
	name = "join";
	description = "Join the voice channel without playing anything";
	usage = "join";

	async execute(context: CommandContext): Promise<void> {
		const streamingService = context.streamingService;
		if (!streamingService) {
			await this.sendError(context.message, "Streaming service not available.");
			return;
		}

		try {
			const streamer = streamingService.getStreamer();

			// Patch for STT before joining
			if (config.sttEnabled) {
				streamingService.getSTTService().patchStreamer(streamer);
			}

			await streamer.joinVoice(config.guildId, config.videoChannelId);

			// Wait for connection to stabilize
			await new Promise(resolve => setTimeout(resolve, 2000));

			// Activate STT
			if (config.sttEnabled && !streamingService.getSTTService().isRunning()) {
				await streamingService.getSTTService().activate();
			}

			await this.sendSuccess(context.message, "Joined voice channel. STT is " + (config.sttEnabled ? "active" : "disabled") + ".");
		} catch (error) {
			await this.sendError(context.message, `Failed to join: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
