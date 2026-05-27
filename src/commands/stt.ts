import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import config from "../config.js";

export default class STTCommand extends BaseCommand {
	name = "stt";
	description = "Toggle speech-to-text transcription (Admin only)";
	usage = "stt <on|off|status>";

	async execute(context: CommandContext): Promise<void> {
		const subcommand = context.args[0]?.toLowerCase();

		switch (subcommand) {
			case "on":
				config.sttEnabled = true;
				await this.sendSuccess(context.message, "STT enabled. Will activate on next voice connection.");
				break;
			case "off":
				config.sttEnabled = false;
				// Stop the STT service if the streaming service exposes it
				if (context.streamingService?.getSTTService?.()?.isRunning()) {
					context.streamingService.getSTTService().stop();
				}
				await this.sendSuccess(context.message, "STT disabled.");
				break;
			case "status":
				const running = context.streamingService?.getSTTService?.()?.isRunning() ?? false;
				await this.sendInfo(context.message, "STT Status", [
					`Enabled: ${config.sttEnabled}`,
					`Running: ${running}`,
					`Server: ${config.sttServerUrl}`,
					`Text Channel: ${config.sttTextChannelId || config.cmdChannelId || '(not set)'}`,
					`Silence Threshold: ${config.sttSilenceThresholdMs}ms`,
				].join("\n"));
				break;
			default:
				await this.sendError(context.message, "Usage: `$stt on|off|status`");
		}
	}
}
